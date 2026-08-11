import assert from "node:assert/strict";
import test from "node:test";

import {
  AuditUnavailableError,
  createAuditWriter,
} from "../dist/infrastructure/audit.js";

function fakeDatabase({ affectedRows = 1, executeError } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ params, sql });
      if (executeError !== undefined) throw executeError;
      return { affectedRows };
    },
    async query() {
      throw new Error("query is not used by the audit writer");
    },
  };
}

test("audit writer inserts one parameterized, five-year retained event", async () => {
  const database = fakeDatabase();
  const writeAudit = createAuditWriter({
    database,
    now: () => new Date("2026-08-11T06:00:00.000Z"),
  });

  await writeAudit({
    access: { localPreview: false, userId: 42 },
    action: "view",
    after: { visible: true },
    entityId: "latest",
    entityType: "finance_dashboard",
    exported: false,
    module: "finance",
    request: {
      headers: {
        "x-real-ip": "203.0.113.8",
        "x-topology-device-id": "device-9",
      },
    },
    sensitiveView: true,
  });

  assert.equal(database.calls.length, 1);
  const [{ params, sql }] = database.calls;
  assert.match(sql, /^INSERT INTO audit_logs/u);
  assert.equal((sql.match(/\?/gu) ?? []).length, 13);
  assert.deepEqual(params, [
    42,
    "view",
    "finance",
    "finance_dashboard",
    "latest",
    null,
    null,
    '{"visible":true}',
    "203.0.113.8",
    "device-9",
    1,
    0,
    "2031-08-11T06:00:00.000Z",
  ]);
});

test("audit writer skips preview and fails closed for missing or failed storage", async () => {
  const previewWriter = createAuditWriter({});
  await previewWriter({
    access: { localPreview: true, userId: 0 },
    action: "view",
    entityId: "latest",
    entityType: "list",
    module: "preview",
  });

  const missingWriter = createAuditWriter({});
  await assert.rejects(
    () =>
      missingWriter({
        access: { localPreview: false, userId: 1 },
        action: "view",
        entityId: "latest",
        entityType: "list",
        module: "finance",
      }),
    AuditUnavailableError,
  );

  for (const database of [
    fakeDatabase({ affectedRows: 0 }),
    fakeDatabase({ executeError: new Error("mysql://root:secret@database") }),
  ]) {
    const writer = createAuditWriter({ database });
    await assert.rejects(
      () =>
        writer({
          access: { localPreview: false, userId: 1 },
          action: "view",
          entityId: "latest",
          entityType: "list",
          module: "finance",
        }),
      (error) => {
        assert.equal(error.name, "AuditUnavailableError");
        assert.doesNotMatch(error.message, /mysql|root|secret/iu);
        return true;
      },
    );
  }
});

test("audit writer rejects malformed identities and unserializable payloads", async () => {
  const database = fakeDatabase();
  const writer = createAuditWriter({ database });

  await assert.rejects(
    () =>
      writer({
        access: { localPreview: false, userId: 0 },
        action: "view",
        entityId: "latest",
        entityType: "list",
        module: "finance",
      }),
    AuditUnavailableError,
  );
  await assert.rejects(
    () =>
      writer({
        access: { localPreview: false, userId: 1 },
        action: "view",
        after: 1n,
        entityId: "latest",
        entityType: "list",
        module: "finance",
      }),
    AuditUnavailableError,
  );
  assert.equal(database.calls.length, 0);
});
