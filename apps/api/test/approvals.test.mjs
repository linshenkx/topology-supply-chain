import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import {
  registerApprovalsModule,
} from "../dist/modules/approvals/index.js";

const baseContext = {
  userId: 27,
  roles: ["admin"],
  factoryId: null,
  supplierId: null,
  organizationName: "广州拓扑睡眠科技有限公司",
  localPreview: false,
};

const approvalRows = [
  {
    id: 101,
    requestNo: "APR-101",
    workflowType: "financial_record_correction",
    summary: "Correct payment record 31",
    highRisk: 1,
    status: "pending",
    requestedAt: "2026-08-11T08:00:00.000Z",
    approvalVersion: 1_786_435_200_000,
    resourceVersion: null,
    payloadJson: '{"proposedBankReference":"must-not-leak"}',
    requestedBy: 999,
  },
  {
    id: 100,
    requestNo: "APR-100",
    workflowType: "warehouse_transfer",
    summary: "Transfer inventory",
    highRisk: 0,
    status: "approved",
    requestedAt: "2026-08-10T08:00:00.000Z",
    approvalVersion: 1_786_348_800_000,
    resourceVersion: null,
    reviewComment: "must-not-leak-review-comment",
  },
];

function fakeDatabase(rows = approvalRows) {
  const queries = [];
  let executeCalls = 0;
  return {
    queries,
    get executeCalls() {
      return executeCalls;
    },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (!sql.includes("FROM approval_requests")) {
        throw new Error("Unexpected SQL");
      }
      return rows;
    },
    async execute() {
      executeCalls += 1;
      throw new Error("Approvals GET must never execute writes");
    },
  };
}

async function createApprovalsApp({
  context = baseContext,
  database,
  audit,
  logger = false,
} = {}) {
  const auditEvents = [];
  const app = await buildApp({ logger });
  await registerApprovalsModule(app, {
    authenticate: async () => context,
    audit: audit ?? ((event) => auditEvents.push(event)),
    ...(database === undefined ? {} : { database }),
  });
  return { app, auditEvents };
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

function createLogCapture() {
  let output = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
    output: () => output,
  };
}

test("internal roles retain the company-wide bounded approval list", async () => {
  for (const role of ["admin", "supply_chain", "finance"]) {
    const database = fakeDatabase();
    const { app, auditEvents } = await createApprovalsApp({
      context: { ...baseContext, roles: [role] },
      database,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/approvals",
      });
      assert.equal(response.statusCode, 200, role);
      assertPrivateNoStore(response);
      assert.deepEqual(response.json(), {
        approvals: approvalRows.map((row) => ({
          id: row.id,
          requestNo: row.requestNo,
          workflowType: row.workflowType,
          summary: row.summary,
          highRisk: Boolean(row.highRisk),
          status: row.status,
          requestedAt: row.requestedAt,
          objectVersion: row.approvalVersion,
          approvalOwner: "r3",
          stepUpObjectType: "approval",
        })),
      });
      assert.equal(response.json().approvals[0].payloadJson, undefined);
      assert.equal(response.json().approvals[1].reviewComment, undefined);
      assert.equal(database.queries.length, 1);
      assert.deepEqual(database.queries[0].params, []);
      assert.match(
        database.queries[0].sql,
        /ORDER BY a\.requested_at DESC, a\.id DESC\s+LIMIT 100$/u,
      );
      assert.match(database.queries[0].sql, /TIMESTAMPDIFF\(MICROSECOND/u);
      assert.equal(database.executeCalls, 0);
      assert.equal(auditEvents.length, 1);
      assert.deepEqual(
        {
          action: auditEvents[0].action,
          module: auditEvents[0].module,
          entityType: auditEvents[0].entityType,
          entityId: auditEvents[0].entityId,
        },
        {
          action: "view",
          module: "approvals",
          entityType: "approval_list",
          entityId: "latest",
        },
      );
      assert.equal(auditEvents[0].access.roles[0], role);
      assert.equal(auditEvents[0].request.method, "GET");
    } finally {
      await app.close();
    }
  }
});

test("external roles are denied before approval database and audit access", async () => {
  for (const role of ["factory", "supplier_qc", "receiver", "company_qc"]) {
    const database = fakeDatabase();
    const { app, auditEvents } = await createApprovalsApp({
      context: {
        ...baseContext,
        roles: [role],
        factoryId: role === "factory" ? 3 : null,
        supplierId: role === "supplier_qc" ? 5 : null,
      },
      database,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/approvals",
      });
      assert.equal(response.statusCode, 403, role);
      assert.equal(response.json().code, "FORBIDDEN");
      assert.equal(database.queries.length, 0);
      assert.equal(database.executeCalls, 0);
      assert.equal(auditEvents.length, 0);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("approval preview preserves the legacy empty response without side effects", async (t) => {
  const database = fakeDatabase();
  const { app, auditEvents } = await createApprovalsApp({
    context: { ...baseContext, roles: ["finance"], localPreview: true },
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/approvals",
  });
  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(response.json(), { approvals: [], preview: true });
  assert.equal(database.queries.length, 0);
  assert.equal(database.executeCalls, 0);
  assert.equal(auditEvents.length, 0);
});

test("approval malformed, over-limit, missing database, and audit failures fail closed", async () => {
  const fixtures = [
    fakeDatabase([{ ...approvalRows[0], highRisk: "yes" }]),
    fakeDatabase(Array.from({ length: 101 }, () => approvalRows[0])),
  ];

  for (const database of fixtures) {
    const { app, auditEvents } = await createApprovalsApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/approvals",
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(response.body, /must-not-leak|Approval data/u);
      assert.equal(database.executeCalls, 0);
      assert.equal(auditEvents.length, 0);
    } finally {
      await app.close();
    }
  }

  const missing = await createApprovalsApp();
  try {
    const response = await missing.app.inject({
      method: "GET",
      url: "/api/v1/approvals",
    });
    assert.equal(response.statusCode, 503);
    assertPrivateNoStore(response);
  } finally {
    await missing.app.close();
  }

  const auditFailure = await createApprovalsApp({
    database: fakeDatabase(),
    audit: async () => {
      throw new Error("APPROVAL-AUDIT-PAYLOAD-SECRET");
    },
  });
  try {
    const response = await auditFailure.app.inject({
      method: "GET",
      url: "/api/v1/approvals",
    });
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /AUDIT|PAYLOAD|SECRET/u);
  } finally {
    await auditFailure.app.close();
  }
});

test("approval database errors and request query strings do not leak to logs", async () => {
  const secret = "mysql://approvals:password@db/PAYLOAD-SECRET";
  const capture = createLogCapture();
  const database = fakeDatabase();
  database.query = async () => {
    throw new Error(`SELECT payload_json FROM approval_requests ${secret}`);
  };
  const { app } = await createApprovalsApp({
    database,
    logger: { level: "info", stream: capture.stream },
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/approvals?payload=${encodeURIComponent(secret)}`,
      headers: {
        cookie: `topology_session=${"b".repeat(64)}`,
        authorization: "Bearer approvals-secret-token",
      },
    });
    assert.equal(response.statusCode, 503);
    assertPrivateNoStore(response);
    assert.doesNotMatch(response.body, /payload_json|password|SECRET/u);
    assert.doesNotMatch(
      capture.output(),
      /payload_json|approvals-secret-token|password|PAYLOAD-SECRET/u,
    );
  } finally {
    await app.close();
  }
});

test("approvals module exposes only GET and documents its contract", async (t) => {
  const { app } = await createApprovalsApp({ database: fakeDatabase() });
  t.after(() => app.close());

  await app.ready();
  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/approvals"]?.get);
  assert.equal(openapi.paths["/api/v1/approvals"]?.post, undefined);
  assert.equal(openapi.components.schemas.Approvals.additionalProperties, false);
  assert.equal(
    openapi.components.schemas.Approvals.properties.approvals.maxItems,
    100,
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/approvals",
    payload: { id: 101, decision: "approved", challengeNo: "must-not-use" },
  });
  assert.equal(response.statusCode, 404);
});
