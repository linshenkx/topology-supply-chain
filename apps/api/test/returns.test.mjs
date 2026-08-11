import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerReturnsModule } from "../dist/modules/returns/index.js";

function productReturnRow(id, sourceDeliveryBatchId = id) {
  return {
    id,
    returnNo: `RET-${id}`,
    sourceDeliveryBatchId,
    warehouseId: 1,
    sku: `SKU-${id}`,
    quantity: 10,
    batchId: id,
    status: "quarantined",
    proposedDisposition: null,
    proposedBy: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: `2026-08-${String(id).padStart(2, "0")} 10:00:00`,
    updatedAt: `2026-08-${String(id).padStart(2, "0")} 10:00:00`,
  };
}

function shipmentRow(id, executionOrderId = id) {
  return {
    id,
    executionOrderId,
    batchNo: `SHIP-${id}`,
    quantity: 10,
    plannedShipAt: "2026-08-01 10:00:00",
    shippedAt: null,
    carrier: "",
    logisticsNo: "",
    destination: "",
    requiresApproval: 0,
    deviationReason: null,
    status: "planned",
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
  };
}

function inspectionRow(id, productReturnId = id) {
  return {
    id,
    productReturnId,
    inspectedQuantity: 10,
    passedQuantity: 9,
    failedQuantity: 1,
    defectReason: "scratch",
    evidenceFileKey: `evidence-${id}`,
    inspectedBy: 7,
    inspectedAt: "2026-08-02 10:00:00",
  };
}

function dispositionRow(id, productReturnId = id) {
  return {
    id,
    productReturnId,
    type: "rework",
    quantity: 10,
    proposedBy: 8,
    status: "pending_supply_chain",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-08-03 10:00:00",
    updatedAt: "2026-08-03 10:00:00",
  };
}

function fakeDatabase({
  dispositions = [dispositionRow(1), dispositionRow(2)],
  executions = [
    { id: 1, factoryId: 1, orderItemId: 1 },
    { id: 2, factoryId: 2, orderItemId: 2 },
  ],
  inspections = [inspectionRow(1), inspectionRow(2)],
  items = [
    { id: 1, supplierId: 11 },
    { id: 2, supplierId: 22 },
  ],
  filterRelated = true,
  returns = [productReturnRow(2), productReturnRow(1)],
  shipments = [shipmentRow(1), shipmentRow(2)],
} = {}) {
  const queries = [];
  const shipmentById = new Map(shipments.map((row) => [row.id, row]));
  const executionById = new Map(executions.map((row) => [row.id, row]));
  const itemById = new Map(items.map((row) => [row.id, row]));
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM product_returns AS returns")) {
        const hasFactoryScope = sql.includes(
          "authorized_execution.factory_id = ?",
        );
        const hasSupplierScope = sql.includes(
          "authorized_item.supplier_id = ?",
        );
        const factoryId = hasFactoryScope ? params[0] : null;
        const supplierId = hasSupplierScope
          ? params[hasFactoryScope ? 1 : 0]
          : null;
        return returns
          .filter((row) => {
            if (!hasFactoryScope && !hasSupplierScope) return true;
            const shipment = shipmentById.get(row.sourceDeliveryBatchId);
            const execution = shipment
              ? executionById.get(shipment.executionOrderId)
              : undefined;
            if (execution === undefined) return false;
            if (hasFactoryScope && execution.factoryId === factoryId) {
              return true;
            }
            return (
              hasSupplierScope &&
              itemById.get(execution.orderItemId)?.supplierId === supplierId
            );
          })
          .slice(0, 200);
      }
      if (sql.includes("FROM delivery_batches AS shipments")) {
        return filterRelated
          ? shipments.filter((row) => params.includes(row.id))
          : shipments;
      }
      if (sql.includes("FROM product_return_inspections AS inspections")) {
        return filterRelated
          ? inspections.filter((row) => params.includes(row.productReturnId))
          : inspections;
      }
      if (sql.includes("FROM product_return_dispositions AS dispositions")) {
        return filterRelated
          ? dispositions.filter((row) => params.includes(row.productReturnId))
          : dispositions;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async execute() {
      throw new Error("returns GET must not write");
    },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerReturnsModule(app, {
    authenticate: async () =>
      context ?? {
        factoryId: null,
        supplierId: null,
        localPreview: false,
        roles: ["admin"],
      },
    ...(database === undefined ? {} : { database }),
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("internal roles receive stable enriched returns with bounded child SQL", async () => {
  for (const role of ["admin", "supply_chain", "company_qc"]) {
    const database = fakeDatabase();
    const app = await createApp({
      context: {
        factoryId: null,
        supplierId: null,
        localPreview: false,
        roles: [role],
      },
      database,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/returns",
      });
      assert.equal(response.statusCode, 200, role);
      assertPrivateNoStore(response);
      const openapi = app.swagger();
      assert.ok(openapi.paths["/api/v1/returns"]?.get);
      assert.equal(
        openapi.components.schemas.Returns.properties.returns.maxItems,
        200,
      );
      const body = response.json();
      assert.deepEqual(body.returns.map((row) => row.id), [2, 1]);
      assert.equal(body.returns[0].sourceShipment.id, 2);
      assert.deepEqual(body.returns[0].inspections.map((row) => row.id), [2]);
      assert.deepEqual(body.returns[0].dispositions.map((row) => row.id), [2]);
      assert.match(
        database.queries[0].sql,
        /ORDER BY returns\.created_at DESC, returns\.id DESC\s+LIMIT 200$/u,
      );
      assert.doesNotMatch(database.queries[0].sql, /authorized_execution/u);
      assert.deepEqual(database.queries[0].params, []);
      assert.match(
        database.queries.find(({ sql }) =>
          sql.includes("FROM delivery_batches AS shipments"),
        ).sql,
        /ORDER BY shipments\.id ASC\s+LIMIT 201$/u,
      );
      assert.match(
        database.queries.find(({ sql }) =>
          sql.includes("FROM product_return_inspections"),
        ).sql,
        /ORDER BY inspections\.product_return_id ASC, inspections\.id ASC\s+LIMIT 1001$/u,
      );
      assert.match(
        database.queries.find(({ sql }) =>
          sql.includes("FROM product_return_dispositions"),
        ).sql,
        /ORDER BY dispositions\.product_return_id ASC, dispositions\.id ASC\s+LIMIT 601$/u,
      );
    } finally {
      await app.close();
    }
  }
});

test("role-bound scopes ignore cross-role bindings and union valid mixed roles", async () => {
  const cases = [
    {
      context: { factoryId: 1, supplierId: 22, roles: ["factory"] },
      expected: [1],
      expectedParams: [1],
      usesItems: false,
    },
    {
      context: { factoryId: 1, supplierId: 22, roles: ["supplier_qc"] },
      expected: [2],
      expectedParams: [22],
      usesItems: true,
    },
    {
      context: {
        factoryId: 1,
        supplierId: 22,
        roles: ["factory", "supplier_qc"],
      },
      expected: [2, 1],
      expectedParams: [1, 22],
      usesItems: true,
    },
  ];

  for (const { context, expected, expectedParams, usesItems } of cases) {
    const database = fakeDatabase();
    const app = await createApp({
      context: { ...context, localPreview: false },
      database,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/returns",
      });
      assert.equal(response.statusCode, 200, JSON.stringify(context));
      assert.deepEqual(
        response.json().returns.map((row) => row.id),
        expected,
      );
      const returnQuery = database.queries[0];
      assert.match(returnQuery.sql, /WHERE EXISTS \(/u);
      assert.match(
        returnQuery.sql,
        /INNER JOIN execution_orders AS authorized_execution/u,
      );
      assert.equal(
        returnQuery.sql.includes(
          "INNER JOIN order_items AS authorized_item",
        ),
        usesItems,
      );
      assert.ok(
        returnQuery.sql.indexOf("WHERE EXISTS") <
          returnQuery.sql.indexOf("ORDER BY returns.created_at"),
      );
      assert.deepEqual(returnQuery.params, expectedParams);
    } finally {
      await app.close();
    }
  }
});

test("external roles require their own valid binding and unrelated roles cannot use spoofed bindings", async () => {
  const contexts = [
    { factoryId: null, supplierId: 22, roles: ["factory"] },
    { factoryId: 0, supplierId: 22, roles: ["factory"] },
    { factoryId: 1, supplierId: null, roles: ["supplier_qc"] },
    { factoryId: 1, supplierId: 1.5, roles: ["supplier_qc"] },
    { factoryId: 1, supplierId: 22, roles: ["receiver"] },
    { factoryId: 1, supplierId: 22, roles: ["finance"] },
  ];

  for (const context of contexts) {
    const database = fakeDatabase();
    const app = await createApp({
      context: { ...context, localPreview: false },
      database,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/returns",
      });
      assert.equal(response.statusCode, 403, JSON.stringify(context));
      assert.deepEqual(database.queries, []);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("external authorization is applied before LIMIT so global noise cannot starve visible returns", async (t) => {
  const noiseIds = Array.from({ length: 200 }, (_, index) => 201 - index);
  const database = fakeDatabase({
    executions: [
      ...noiseIds.map((id) => ({ id, factoryId: 2, orderItemId: id })),
      { id: 1, factoryId: 1, orderItemId: 1 },
    ],
    inspections: [],
    dispositions: [],
    items: [
      ...noiseIds.map((id) => ({ id, supplierId: 22 })),
      { id: 1, supplierId: 11 },
    ],
    returns: [
      ...noiseIds.map((id) => productReturnRow(id)),
      productReturnRow(1),
    ],
    shipments: [...noiseIds.map((id) => shipmentRow(id)), shipmentRow(1)],
  });
  const app = await createApp({
    context: {
      factoryId: 1,
      supplierId: 22,
      localPreview: false,
      roles: ["factory"],
    },
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/returns" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().returns.map((row) => row.id), [1]);
  const returnQuery = database.queries[0];
  assert.deepEqual(returnQuery.params, [1]);
  assert.ok(
    returnQuery.sql.indexOf("authorized_execution.factory_id = ?") <
      returnQuery.sql.indexOf("LIMIT 200"),
  );
});

test("forbidden roles and local preview stop before business queries", async () => {
  const deniedDatabase = fakeDatabase();
  const denied = await createApp({
    context: {
      factoryId: null,
      supplierId: null,
      localPreview: false,
      roles: ["finance"],
    },
    database: deniedDatabase,
  });
  try {
    const response = await denied.inject({
      method: "GET",
      url: "/api/v1/returns",
    });
    assert.equal(response.statusCode, 403);
    assert.equal(deniedDatabase.queries.length, 0);
    assertPrivateNoStore(response);
  } finally {
    await denied.close();
  }

  const preview = await createApp({
    context: {
      factoryId: null,
      supplierId: null,
      localPreview: true,
      roles: ["admin"],
    },
  });
  try {
    const response = await preview.inject({
      method: "GET",
      url: "/api/v1/returns",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { returns: [], preview: true });
    assertPrivateNoStore(response);
  } finally {
    await preview.close();
  }
});

test("real serializer preserves nullable return fields and a missing shipment as null", async (t) => {
  const database = fakeDatabase({
    returns: [{ ...productReturnRow(1), batchId: null }],
    shipments: [],
    inspections: [],
    dispositions: [dispositionRow(1)],
  });
  const app = await createApp({ database });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/returns" });
  assert.equal(response.statusCode, 200);
  const record = response.json().returns[0];
  assert.equal(record.batchId, null);
  assert.equal(record.proposedDisposition, null);
  assert.equal(record.proposedBy, null);
  assert.equal(record.reviewedBy, null);
  assert.equal(record.reviewedAt, null);
  assert.equal(record.sourceShipment, null);
  assert.equal(record.dispositions[0].reviewedBy, null);
  assert.equal(record.dispositions[0].reviewedAt, null);
});

test("source shipments and child rows fail closed when a query escapes visible returns", async () => {
  const databases = [
    fakeDatabase({
      returns: [productReturnRow(1)],
      shipments: [shipmentRow(1), shipmentRow(2)],
      inspections: [],
      dispositions: [],
      filterRelated: false,
    }),
    fakeDatabase({
      returns: [productReturnRow(1)],
      shipments: [shipmentRow(1)],
      inspections: [inspectionRow(2)],
      dispositions: [],
      filterRelated: false,
    }),
    fakeDatabase({
      returns: [productReturnRow(1)],
      shipments: [shipmentRow(1)],
      inspections: [],
      dispositions: [dispositionRow(2)],
      filterRelated: false,
    }),
  ];

  for (const database of databases) {
    const app = await createApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/returns",
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("missing database and malformed parent or child rows return sanitized 503", async () => {
  const fixtures = [
    undefined,
    fakeDatabase({
      returns: [{ ...productReturnRow(1), status: "database_password" }],
    }),
    fakeDatabase({
      inspections: [{ ...inspectionRow(9, 1), inspectedQuantity: -1 }],
    }),
  ];
  for (const [index, database] of fixtures.entries()) {
    const app = await createApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/returns",
        headers: { "x-request-id": `returns-failure-${index}` },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(
        response.body,
        /database_password|Returns unavailable|SELECT/u,
      );
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
