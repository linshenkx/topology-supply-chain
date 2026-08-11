import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerNotificationsModule } from "../dist/modules/notifications/index.js";

function notificationRow(id, recipientUserId = 7, overrides = {}) {
  return {
    id,
    recipientUserId,
    recipientRole: null,
    recipientFactoryId: null,
    recipientSupplierId: null,
    channel: "in_app",
    type: "reminder",
    severity: "normal",
    title: `Notification ${id}`,
    message: "Please review",
    entityType: "purchase_order",
    entityId: 12,
    businessNo: "PO-12",
    status: "sent",
    sentAt: "2026-08-11T08:00:00.000Z",
    readAt: null,
    errorMessage: null,
    createdAt: "2026-08-11 08:00:00.000",
    ...overrides,
  };
}

function fakeDatabase(rows = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return rows;
    },
    async execute() {
      throw new Error("Notifications GET must not execute writes");
    },
  };
}

async function createNotificationsApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerNotificationsModule(app, {
    authenticate: async () =>
      context ?? { userId: 7, localPreview: false },
    database,
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("notifications are isolated to the authenticated user with a stable top-100 query", async (t) => {
  const database = fakeDatabase([
    notificationRow(2),
    notificationRow(1, 7, {
      status: "read",
      readAt: "2026-08-11T09:00:00.000Z",
    }),
    notificationRow(3, 7, { readAt: "" }),
  ]);
  const app = await createNotificationsApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/notifications",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.equal(response.json().notifications.length, 3);
  assert.equal(response.json().unread, 2);
  assert.equal(response.json().notifications[0].recipientFactoryId, null);
  assert.equal(response.json().notifications[0].recipientSupplierId, null);
  assert.equal(response.json().notifications[0].recipientRole, null);
  assert.equal(response.json().notifications[0].businessNo, "PO-12");
  assert.match(
    database.queries[0].sql,
    /WHERE recipient_user_id = \?\s+ORDER BY created_at DESC, id DESC\s+LIMIT 100$/u,
  );
  assert.deepEqual(database.queries[0].params, [7]);

  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/notifications"]?.get);
  assert.equal(
    openapi.components.schemas.Notifications.properties.notifications.maxItems,
    100,
  );
});

test("a row for another recipient fails closed instead of crossing user scope", async (t) => {
  const database = fakeDatabase([notificationRow(1, 8)]);
  const app = await createNotificationsApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/notifications",
    headers: { "x-request-id": "notification-scope" },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().message, "Internal Server Error");
  assert.doesNotMatch(response.body, /recipient|8/u);
  assertPrivateNoStore(response);
});

test("local preview preserves the empty notification envelope without database access", async (t) => {
  const app = await createNotificationsApp({
    context: { userId: 0, localPreview: true },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/notifications",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    notifications: [],
    unread: 0,
    preview: true,
  });
  assertPrivateNoStore(response);
});

test("database errors and malformed notification rows are sanitized", async () => {
  for (const database of [
    {
      async query() {
        throw new Error("SELECT notification_messages password");
      },
      async execute() {
        throw new Error("unexpected");
      },
    },
    fakeDatabase([notificationRow(1, 7, { channel: "sms" })]),
  ]) {
    const app = await createNotificationsApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
      });
      assert.equal(response.statusCode, 503);
      assert.doesNotMatch(response.body, /password|notification_messages|sms/u);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
