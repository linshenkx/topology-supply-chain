import assert from "node:assert/strict";
import test from "node:test";

import { SUPPLY_COMMANDS } from "@topology/contracts/supply-writes";
import { OPERATIONS_COMMAND_RESOURCES } from "@topology/contracts/operations-writes";

import { RELEASE_MANIFEST } from "../../../tooling/release/release-manifest.mjs";
import { executeSupplyCommand, supplyFenceResource } from "../dist/platform/supply-command.js";
import { canonicalRequestDigest, COMMAND_WRITER_RESOURCES, executeCommand } from "../dist/platform/commands.js";
import { executeOperationsCommand } from "../dist/platform/operations-command.js";

const KEY = "adapter-parity-key-000001";
const CSRF = "ab".repeat(32);

function request(extra = {}) {
  return {
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "x-forwarded-proto": "http",
      cookie: `topology_csrf=${CSRF}`,
      "x-csrf-token": CSRF,
      "idempotency-key": KEY,
      ...extra,
    },
  };
}

function harness() {
  const state = { fences: [], row: undefined, runs: 0 };
  const transaction = {
    async execute(sql, parameters) {
      if (sql.includes("INSERT IGNORE INTO command_idempotency")) {
        if (state.row !== undefined) return { affectedRows: 0 };
        state.row = {
          requestDigest: parameters[3],
          responseJson: null,
          responseStatus: null,
          status: "pending",
        };
        return { affectedRows: 1 };
      }
      if (sql.includes("UPDATE command_idempotency")) {
        state.row = { ...state.row, responseStatus: parameters[0],
          responseJson: parameters[1], status: "completed" };
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
    async query(sql, parameters) {
      if (sql.includes("FROM writer_fences")) {
        state.fences.push({ generation: 2, owner: "fastify-v1", resource: parameters[0] });
        return [{ enabled: 1, generation: 2, owner: "fastify-v1" }];
      }
      if (sql.includes("FROM command_idempotency")) return [state.row];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return {
    state,
    transaction,
    unitOfWork: async (run) => run(transaction),
    fenceCheck: async (_transaction, requirement) => state.fences.push(requirement),
  };
}

function casesFor(probe) {
  const access = { localPreview: false, sessionId: 7, userId: 9 };
  return [
    {
      name: "platform",
      command: "notifications.mark-read",
      resource: "notifications.commands",
      execute: (payload, incoming = request()) => executeCommand({
        actorScope: "user:9",
        command: "notifications.mark-read",
        database: { transaction: probe.unitOfWork },
        payload,
        request: incoming,
        responseStatus: 201,
        run: async () => { probe.state.runs += 1; return { created: true }; },
      }),
    },
    {
      name: "supply",
      command: "supplier-performance.write",
      resource: "r2.supplier-performance.write",
      execute: (payload, incoming = request()) => executeSupplyCommand({
        actorScope: "user:9",
        command: "supplier-performance.write",
        context: { unitOfWork: probe.unitOfWork, requireWriterFence: probe.fenceCheck },
        payload,
        request: incoming,
        responseStatus: (result) => result.created ? 201 : 200,
        run: async () => { probe.state.runs += 1; return { created: true }; },
      }),
    },
    {
      name: "operations",
      command: "inventory.reserve",
      resource: "r3.inventory.commands",
      execute: (payload, incoming = request()) => executeOperationsCommand({
        command: "inventory.reserve",
        context: {
          authenticate: async () => access,
          database: {},
          unitOfWork: probe.unitOfWork,
          requireWriterFence: probe.fenceCheck,
        },
        payload,
        request: incoming,
        responseStatus: 201,
        run: async ({ access: actual }) => {
          assert.equal(actual, access);
          probe.state.runs += 1;
          return { created: true };
        },
      }),
    },
  ];
}

test("platform, supply, and operations adapters preserve one executor state machine", async (t) => {
  for (const fixtureName of ["platform", "supply", "operations"]) {
    await t.test(fixtureName, async () => {
      const probe = harness();
      const fixture = casesFor(probe).find(({ name }) => name === fixtureName);
      const payload = { nested: { b: 2, a: 1 }, value: 7 };
      const first = await fixture.execute(payload);
      const replay = await fixture.execute({ value: 7, nested: { a: 1, b: 2 } });
      assert.deepEqual(first.body, {
        command: { command: fixture.command, idempotencyKey: KEY,
          requestDigest: canonicalRequestDigest(fixture.command, payload), replayed: false },
        result: { created: true },
      });
      assert.equal(first.statusCode, 201);
      assert.equal(replay.statusCode, 201);
      assert.equal(replay.body.command.replayed, true);
      assert.equal(probe.state.runs, 1);
      assert.equal(probe.state.fences[0].resource, fixture.resource);
      await assert.rejects(fixture.execute({ value: 8 }), { code: "IDEMPOTENCY_KEY_REUSED" });
    });
  }
});

test("every supply and operations command is wired to its immutable writer resource", async (t) => {
  for (const command of SUPPLY_COMMANDS) {
    await t.test(`supply ${command}`, async () => {
      const probe = harness();
      const result = await executeSupplyCommand({
        actorScope: "user:9",
        command,
        context: { unitOfWork: probe.unitOfWork, requireWriterFence: probe.fenceCheck },
        payload: { command }, request: request(),
        run: async () => ({ command }),
      });
      assert.equal(result.body.command.command, command);
      assert.equal(probe.state.fences[0].resource, supplyFenceResource(command));
    });
  }
  for (const [command, resource] of Object.entries(OPERATIONS_COMMAND_RESOURCES)) {
    await t.test(`operations ${command}`, async () => {
      const probe = harness();
      const result = await executeOperationsCommand({
        command,
        context: {
          authenticate: async () => ({ localPreview: false, sessionId: 7, userId: 9 }),
          database: {}, unitOfWork: probe.unitOfWork, requireWriterFence: probe.fenceCheck,
        },
        payload: { command }, request: request(),
        run: async () => ({ command }),
      });
      assert.equal(result.body.command.command, command);
      assert.equal(probe.state.fences[0].resource, resource);
    });
  }
});

test("adapter identity stays byte-aligned with the 40-command release protocol", () => {
  const expected = [
    ...Object.entries(COMMAND_WRITER_RESOURCES),
    ...SUPPLY_COMMANDS.map((command) => [command, supplyFenceResource(command)]),
    ...Object.entries(OPERATIONS_COMMAND_RESOURCES),
  ].map(([command, resource]) => ({ command, generation: 2, owner: "fastify-v1", resource }))
    .sort((left, right) => left.command.localeCompare(right.command));
  assert.equal(expected.length, 40);
  assert.deepEqual([...RELEASE_MANIFEST.writer.commands]
    .sort((left, right) => left.command.localeCompare(right.command)), expected);
  assert.equal(RELEASE_MANIFEST.writer.resources.length, 30);
});

test("documented header compatibility differences remain explicit at adapters", async () => {
  for (const fixtureName of ["platform", "supply"]) {
    const probe = harness();
    const fixture = casesFor(probe).find(({ name }) => name === fixtureName);
    await assert.rejects(fixture.execute({ value: 1 }, request({ "x-request-digest": ["bad"] })),
      { code: "BAD_REQUEST" });
  }
  const operationsProbe = harness();
  const operationsCase = casesFor(operationsProbe).find(({ name }) => name === "operations");
  assert.equal((await operationsCase.execute({ value: 1 }, request({ "x-request-digest": ["bad"] })))
    .body.command.replayed, false);
});
