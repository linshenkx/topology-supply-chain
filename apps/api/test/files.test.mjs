import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerFilesModule } from "../dist/modules/files/index.js";

const baseContext = {
  userId: 7,
  email: "user@example.com",
  name: "User",
  roles: ["factory"],
  factoryId: 3,
  supplierId: null,
  organizationName: "Factory 3",
  localPreview: false,
};

function fileRow(overrides = {}) {
  return {
    id: 42,
    objectKey: "invoice/2026-08-11/object.pdf",
    fileName: "发票 42.pdf",
    contentType: "application/pdf",
    sizeBytes: 12,
    category: "invoice",
    entityType: "invoice",
    entityId: "42",
    ownerUserId: 7,
    factoryId: 3,
    supplierId: null,
    sensitive: 1,
    retainUntil: "2031-08-11T00:00:00.000Z",
    createdAt: "2026-08-11 08:00:00.000",
    ...overrides,
  };
}

function fakeDatabase(rows = [fileRow()]) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return rows;
    },
    async execute() {
      throw new Error("Files GET must not execute writes");
    },
  };
}

async function createFilesApp({ audit, context, database, storage } = {}) {
  const app = await buildApp({ logger: false });
  await registerFilesModule(app, {
    authenticate: async () => context ?? baseContext,
    database,
    storage,
    audit: audit ?? (() => undefined),
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("owner, matching organization, and internal roles can download through the storage port", async () => {
  const cases = [
    { context: baseContext, row: fileRow() },
    {
      context: { ...baseContext, userId: 8 },
      row: fileRow({ ownerUserId: 7, factoryId: 3 }),
    },
    {
      context: {
        ...baseContext,
        userId: 8,
        factoryId: null,
        supplierId: 5,
        roles: ["supplier_qc"],
      },
      row: fileRow({ ownerUserId: 7, factoryId: null, supplierId: 5 }),
    },
    {
      context: {
        ...baseContext,
        userId: 8,
        factoryId: null,
        roles: ["finance"],
      },
      row: fileRow({ ownerUserId: 7, factoryId: null }),
    },
  ];

  for (const fixture of cases) {
    const database = fakeDatabase([fixture.row]);
    const storageKeys = [];
    const audits = [];
    const app = await createFilesApp({
      context: fixture.context,
      database,
      storage: {
        async readObject(key) {
          storageKeys.push(key);
          return Buffer.from("private-data");
        },
      },
      audit: async (event) => audits.push(event),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/files?id=42&ignored=value",
      });

      assert.equal(response.statusCode, 200);
      assertPrivateNoStore(response);
      assert.equal(response.headers["content-type"], "application/pdf");
      assert.equal(
        response.headers["content-disposition"],
        "inline; filename*=UTF-8''%E5%8F%91%E7%A5%A8%2042.pdf",
      );
      assert.equal(response.body, "private-data");
      assert.deepEqual(storageKeys, [fixture.row.objectKey]);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, "download");
      assert.equal(audits[0].sensitiveView, true);
      assert.deepEqual(database.queries[0].params, [42]);
      assert.match(
        database.queries[0].sql,
        /WHERE id = \?\s+ORDER BY id ASC\s+LIMIT 2$/u,
      );
      const openapi = app.swagger();
      assert.equal(
        openapi.paths["/api/v1/files"].get.responses[200].content[
          "application/pdf"
        ].schema.format,
        "binary",
      );
    } finally {
      await app.close();
    }
  }
});

test("an unrelated external user is forbidden before audit or storage access", async (t) => {
  const database = fakeDatabase([
    fileRow({ ownerUserId: 1, factoryId: 2, supplierId: 4 }),
  ]);
  let auditCalls = 0;
  let storageCalls = 0;
  const app = await createFilesApp({
    context: {
      ...baseContext,
      userId: 8,
      factoryId: 3,
      supplierId: 5,
      roles: ["supplier_qc"],
    },
    database,
    audit: () => {
      auditCalls += 1;
    },
    storage: {
      async readObject() {
        storageCalls += 1;
        return Buffer.from("must-not-leak");
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/files?id=42" });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "FORBIDDEN");
  assert.doesNotMatch(response.body, /object\.pdf|must-not-leak/u);
  assert.equal(auditCalls, 0);
  assert.equal(storageCalls, 0);
  assertPrivateNoStore(response);
});

test("preview and invalid IDs preserve not-found behavior without database access", async () => {
  for (const fixture of [
    { context: { ...baseContext, userId: 0, localPreview: true }, url: "/api/v1/files?id=42" },
    { context: baseContext, url: "/api/v1/files?id=not-a-number" },
    { context: baseContext, url: "/api/v1/files" },
  ]) {
    const app = await createFilesApp({ context: fixture.context });
    try {
      const response = await app.inject({ method: "GET", url: fixture.url });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "NOT_FOUND");
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("missing storage is explicit, while a missing object is audited then returns not found", async () => {
  const audits = [];
  const withoutStorage = await createFilesApp({
    database: fakeDatabase(),
    audit: async (event) => audits.push(event),
  });
  try {
    const response = await withoutStorage.inject({
      method: "GET",
      url: "/api/v1/files?id=42",
    });
    assert.equal(response.statusCode, 503);
    assert.equal(audits.length, 1);
  } finally {
    await withoutStorage.close();
  }

  const missingObject = await createFilesApp({
    database: fakeDatabase(),
    audit: async (event) => audits.push(event),
    storage: { async readObject() { return null; } },
  });
  try {
    const response = await missingObject.inject({
      method: "GET",
      url: "/api/v1/files?id=42",
    });
    assert.equal(response.statusCode, 404);
    assert.equal(audits.length, 2);
  } finally {
    await missingObject.close();
  }
});

test("malformed file metadata and storage errors fail closed without leaking object keys", async () => {
  for (const options of [
    {
      database: fakeDatabase([fileRow({ contentType: "text/html" })]),
      storage: { async readObject() { return Buffer.from("unused"); } },
    },
    {
      database: fakeDatabase(),
      storage: { async readObject() { throw new Error("bucket credential object.pdf"); } },
    },
  ]) {
    const app = await createFilesApp(options);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/files?id=42",
        headers: { "x-request-id": "file-fail-closed" },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(response.body, /credential|object\.pdf|text\/html/u);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("oversized metadata fails closed before audit or storage access", async (t) => {
  let auditCalls = 0;
  let storageCalls = 0;
  const app = await createFilesApp({
    database: fakeDatabase([
      fileRow({ sizeBytes: 20 * 1_024 * 1_024 + 1 }),
    ]),
    audit: () => {
      auditCalls += 1;
    },
    storage: {
      async readObject() {
        storageCalls += 1;
        return Buffer.from("must-not-read");
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/files?id=42",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().message, "Internal Server Error");
  assert.equal(auditCalls, 0);
  assert.equal(storageCalls, 0);
  assertPrivateNoStore(response);
});

test("storage body length must exactly match bounded metadata", async (t) => {
  let auditCalls = 0;
  const app = await createFilesApp({
    database: fakeDatabase([fileRow({ sizeBytes: 12 })]),
    audit: () => {
      auditCalls += 1;
    },
    storage: {
      async readObject() {
        return Buffer.from("short");
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/files?id=42",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().message, "Internal Server Error");
  assert.doesNotMatch(response.body, /short|object\.pdf/u);
  assert.equal(auditCalls, 1);
  assertPrivateNoStore(response);
});
