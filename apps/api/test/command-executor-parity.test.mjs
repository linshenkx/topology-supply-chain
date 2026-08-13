import assert from "node:assert/strict";
import test from "node:test";

import { R2_COMMANDS } from "@topology/contracts/r2-writes";
import { R3_COMMAND_RESOURCES } from "@topology/contracts/r3-fulfillment-writes";

import { RELEASE_MANIFEST } from "../../../tooling/release/release-manifest.mjs";
import { executeR2Command, r2FenceResource } from "../dist/modules/r2-master-procurement/command.js";
import { canonicalRequestDigest, COMMAND_WRITER_RESOURCES, executeCommand } from "../dist/platform/commands.js";
import { executeR3Command } from "../dist/r3/command.js";

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
      name: "R2",
      command: "supplier-performance.write",
      resource: "r2.supplier-performance.write",
      execute: (payload, incoming = request()) => executeR2Command({
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
      name: "R3",
      command: "inventory.reserve",
      resource: "r3.inventory.commands",
      execute: (payload, incoming = request()) => executeR3Command({
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

test("platform, R2, and R3 adapters preserve one executor state machine", async (t) => {
  for (const fixtureName of ["platform", "R2", "R3"]) {
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

test("adapter identity stays byte-aligned with the 35-command release protocol", () => {
  const expected = [
    ...Object.entries(COMMAND_WRITER_RESOURCES),
    ...R2_COMMANDS.map((command) => [command, r2FenceResource(command)]),
    ...Object.entries(R3_COMMAND_RESOURCES),
  ].map(([command, resource]) => ({ command, generation: 2, owner: "fastify-v1", resource }))
    .sort((left, right) => left.command.localeCompare(right.command));
  assert.equal(expected.length, 35);
  assert.deepEqual([...RELEASE_MANIFEST.writer.commands]
    .sort((left, right) => left.command.localeCompare(right.command)), expected);
  assert.equal(RELEASE_MANIFEST.writer.resources.length, 29);
});

test("documented header compatibility differences remain explicit at adapters", async () => {
  for (const fixtureName of ["platform", "R2"]) {
    const probe = harness();
    const fixture = casesFor(probe).find(({ name }) => name === fixtureName);
    await assert.rejects(fixture.execute({ value: 1 }, request({ "x-request-digest": ["bad"] })),
      { code: "BAD_REQUEST" });
  }
  const r3Probe = harness();
  const r3 = casesFor(r3Probe).find(({ name }) => name === "R3");
  assert.equal((await r3.execute({ value: 1 }, request({ "x-request-digest": ["bad"] })))
    .body.command.replayed, false);
});
