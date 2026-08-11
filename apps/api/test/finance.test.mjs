import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerFinanceModule } from "../dist/modules/finance/index.js";

const baseContext = {
  userId: 17,
  roles: ["admin"],
  factoryId: null,
  supplierId: null,
  organizationName: "广州拓扑睡眠科技有限公司",
  localPreview: false,
};

const financeRows = {
  factory_invoices: [
    {
      id: 11,
      invoiceNo: "INV-11",
      purchaseOrderId: 101,
      amountTaxIncludedMinor: 20_000,
      expectedAmountMinor: 20_000,
      amountMatchesExpected: 1,
      status: "verified",
      issuedAt: "2026-08-01",
      fileKey: "must-not-leak-invoice-file",
      maintainedBy: 901,
    },
  ],
  factory_payment_requests: [
    {
      id: 21,
      requestNo: "PAY-21",
      factoryId: 3,
      plannedPaymentDate: "2026-08-15",
      totalAmountMinor: 20_000,
      invoiceCoveredAmountMinor: 20_000,
      status: "submitted_to_finance",
      paymentNote: "must-not-leak-payment-note",
    },
  ],
  payment_records: [
    {
      id: 31,
      paymentRequestId: 21,
      amountMinor: 10_000,
      paidAt: "2026-08-11",
      bankReference: "BANK-REFERENCE-31",
      recordType: "payment",
      invoiceExceptionId: null,
      recordedBy: 902,
    },
  ],
  invoice_verifications: [
    {
      id: 41,
      invoiceId: 11,
      verifierRole: "finance",
      decision: "approved",
      rejectionReason: null,
      verifiedBy: 903,
    },
  ],
  invoice_payment_allocations: [
    {
      id: 51,
      invoiceId: 11,
      paymentRequestId: 21,
      allocatedAmountMinor: 20_000,
      status: "active",
      createdBy: 904,
    },
  ],
  invoice_exceptions: [
    {
      id: 61,
      invoiceId: 11,
      exceptionType: "voided",
      affectedAmountMinor: 20_000,
      replacementDeadline: "2026-08-31",
      replacementCoveredAmountMinor: 5_000,
      refundedAmountMinor: 1_000,
      status: "awaiting_remediation",
      reason: "supplier voided invoice",
      riskReleaseEvidenceFileKey: "must-not-leak-risk-file",
    },
  ],
  replacement_invoice_links: [
    {
      id: 71,
      invoiceExceptionId: 61,
      replacementInvoiceId: 12,
      coveredAmountMinor: 5_000,
      status: "verified",
    },
  ],
  factory_payment_request_items: [
    {
      id: 81,
      paymentRequestId: 21,
      paymentScheduleId: 201,
      purchaseOrderId: 101,
      triggeredByDeliveryBatchId: 301,
      amountMinor: 20_000,
    },
  ],
  purchase_orders: [
    {
      id: 101,
      orderNo: "PO-101",
      totalTaxIncludedMinor: 20_000,
      sourceFileKey: "must-not-leak-purchase-file",
    },
  ],
};

function tableName(sql) {
  return Object.keys(financeRows).find((name) =>
    sql.includes(`FROM ${name}`),
  );
}

function fakeDatabase(overrides = {}) {
  const queries = [];
  let executeCalls = 0;
  const rows = { ...financeRows, ...overrides };

  return {
    queries,
    get executeCalls() {
      return executeCalls;
    },
    async query(sql, params = []) {
      queries.push({ sql, params });
      const name = tableName(sql);
      if (name === undefined) throw new Error("Unexpected SQL");
      return rows[name];
    },
    async execute() {
      executeCalls += 1;
      throw new Error("Finance GET must never execute writes");
    },
  };
}

async function createFinanceApp({
  context = baseContext,
  database,
  audit,
  logger = false,
} = {}) {
  const auditEvents = [];
  const app = await buildApp({ logger });
  await registerFinanceModule(app, {
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

test("internal roles receive the bounded frontend-compatible finance envelope", async () => {
  for (const role of ["admin", "supply_chain", "finance"]) {
    const database = fakeDatabase();
    const { app, auditEvents } = await createFinanceApp({
      context: { ...baseContext, roles: [role] },
      database,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/finance",
      });

      assert.equal(response.statusCode, 200, role);
      assertPrivateNoStore(response);
      const body = response.json();
      assert.deepEqual(Object.keys(body), [
        "invoices",
        "paymentRequests",
        "payments",
        "verifications",
        "allocations",
        "exceptions",
        "replacementLinks",
        "requestItems",
        "purchaseOrders",
      ]);
      assert.equal(body.payments[0].bankReference, "BANK-REFERENCE-31");
      assert.equal(body.invoices[0].fileKey, undefined);
      assert.equal(body.paymentRequests[0].paymentNote, undefined);
      assert.equal(body.payments[0].recordedBy, undefined);
      assert.equal(body.exceptions[0].riskReleaseEvidenceFileKey, undefined);
      assert.equal(body.purchaseOrders[0].sourceFileKey, undefined);

      assert.equal(database.queries.length, 9);
      assert.equal(database.executeCalls, 0);
      for (const { params } of database.queries) assert.deepEqual(params, []);
      assert.match(
        database.queries[0].sql,
        /ORDER BY created_at DESC, id DESC\s+LIMIT 200$/u,
      );
      assert.match(
        database.queries[2].sql,
        /ORDER BY created_at DESC, id DESC\s+LIMIT 300$/u,
      );
      assert.match(
        database.queries[3].sql,
        /ORDER BY verified_at DESC, id DESC\s+LIMIT 400$/u,
      );
      assert.match(
        database.queries[7].sql,
        /ORDER BY id DESC\s+LIMIT 500$/u,
      );

      assert.equal(auditEvents.length, 1);
      assert.equal(auditEvents[0].access.roles[0], role);
      assert.deepEqual(
        {
          action: auditEvents[0].action,
          module: auditEvents[0].module,
          entityType: auditEvents[0].entityType,
          entityId: auditEvents[0].entityId,
          sensitiveView: auditEvents[0].sensitiveView,
        },
        {
          action: "view",
          module: "finance",
          entityType: "finance_dashboard",
          entityId: "latest",
          sensitiveView: true,
        },
      );
      assert.equal(auditEvents[0].request.method, "GET");
    } finally {
      await app.close();
    }
  }
});

test("external roles are forbidden before finance database and audit access", async () => {
  for (const role of ["factory", "supplier_qc", "receiver", "company_qc"]) {
    const database = fakeDatabase();
    const { app, auditEvents } = await createFinanceApp({
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
        url: "/api/v1/finance",
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

test("finance preview preserves the legacy empty envelope without side effects", async (t) => {
  const database = fakeDatabase();
  const { app, auditEvents } = await createFinanceApp({
    context: { ...baseContext, roles: ["finance"], localPreview: true },
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/finance",
  });
  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(response.json(), {
    invoices: [],
    paymentRequests: [],
    payments: [],
    verifications: [],
    allocations: [],
    exceptions: [],
    replacementLinks: [],
    requestItems: [],
    purchaseOrders: [],
    preview: true,
  });
  assert.equal(database.queries.length, 0);
  assert.equal(database.executeCalls, 0);
  assert.equal(auditEvents.length, 0);
});

test("finance rejects malformed and over-limit rows fail closed", async () => {
  for (const database of [
    fakeDatabase({
      payment_records: [
        { ...financeRows.payment_records[0], bankReference: null },
      ],
    }),
    fakeDatabase({
      factory_invoices: Array.from({ length: 201 }, () =>
        financeRows.factory_invoices[0],
      ),
    }),
  ]) {
    const { app, auditEvents } = await createFinanceApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/finance",
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(response.body, /BANK-REFERENCE|Finance data/u);
      assert.equal(database.executeCalls, 0);
      assert.equal(auditEvents.length, 0);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("finance database and audit failures do not leak SQL, credentials, or bank data to logs", async () => {
  const secret = "mysql://finance:password@db/BANK-REFERENCE-SECRET";
  const capture = createLogCapture();
  const database = fakeDatabase();
  database.query = async () => {
    throw new Error(`SELECT bank_reference FROM payment_records ${secret}`);
  };
  const { app } = await createFinanceApp({
    database,
    logger: { level: "info", stream: capture.stream },
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/finance?bankReference=${encodeURIComponent(secret)}`,
      headers: {
        cookie: `topology_session=${"a".repeat(64)}`,
        authorization: "Bearer finance-secret-token",
      },
    });
    assert.equal(response.statusCode, 503);
    assertPrivateNoStore(response);
    assert.doesNotMatch(response.body, /bank_reference|password|SECRET/u);
    assert.doesNotMatch(
      capture.output(),
      /bank_reference|finance-secret-token|password|BANK-REFERENCE-SECRET/u,
    );
  } finally {
    await app.close();
  }

  const auditFailure = await createFinanceApp({
    database: fakeDatabase(),
    audit: async () => {
      throw new Error("BANK-REFERENCE-AUDIT-SECRET");
    },
  });
  try {
    const response = await auditFailure.app.inject({
      method: "GET",
      url: "/api/v1/finance",
    });
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /AUDIT|BANK-REFERENCE/u);
  } finally {
    await auditFailure.app.close();
  }
});

test("finance module exposes only GET and documents its contract", async (t) => {
  const { app } = await createFinanceApp({ database: fakeDatabase() });
  t.after(() => app.close());

  await app.ready();
  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/finance"]?.get);
  assert.equal(openapi.paths["/api/v1/finance"]?.post, undefined);
  assert.equal(openapi.components.schemas.Finance.additionalProperties, false);
  assert.equal(
    openapi.components.schemas.Finance.properties.payments.maxItems,
    300,
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/finance",
    payload: { action: "record_payment", challengeNo: "must-not-consume" },
  });
  assert.equal(response.statusCode, 404);
});
