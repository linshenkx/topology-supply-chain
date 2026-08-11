import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseClientError,
  createDatabaseClient,
  readDatabaseConfig,
} from "../dist/infrastructure/database.js";

const validEnvironment = Object.freeze({
  DATABASE_URL: "mysql://scm_app:s%40fe-password@db.internal:3307/topology_scm",
});

function createFakeConnection(overrides = {}) {
  return {
    destroy() {},
    async execute() {
      return [{ affectedRows: 0 }, []];
    },
    async ping() {},
    async query() {
      return [[], []];
    },
    release() {},
    ...overrides,
  };
}

function createFakePool(overrides = {}) {
  return {
    async end() {},
    async getConnection() {
      return createFakeConnection();
    },
    ...overrides,
  };
}

function createClient(pool, env = validEnvironment) {
  return createDatabaseClient({
    env,
    poolFactory: () => pool,
  });
}

function invokeSqlOperation(client, operation, options) {
  return operation === "query"
    ? client.query("SELECT id FROM suppliers WHERE id = ?", [1], options)
    : client.execute("UPDATE suppliers SET status = ? WHERE id = ?", [
        "active",
        1,
      ], options);
}

test("database configuration fails closed without a strict mysql URL", () => {
  for (const environment of [
    {},
    { DATABASE_URL: "postgres://user:secret@db.internal/scm" },
    { DATABASE_URL: "mysql://db.internal/scm" },
    { DATABASE_URL: "mysql://user:secret@db.internal/" },
    { DATABASE_URL: "mysql://user:secret@db.internal/one/two" },
    { DATABASE_URL: "mysql://user:secret@db.internal/scm?ssl=false" },
    { DATABASE_URL: "mysql://user:secret@db.internal/scm#fragment" },
  ]) {
    assert.throws(() => readDatabaseConfig(environment), /DATABASE_URL/);
  }
});

test("database configuration uses bounded integers and secure TLS defaults", async () => {
  let poolOptions;
  const pool = createFakePool();
  const client = createDatabaseClient({
    env: validEnvironment,
    poolFactory(options) {
      poolOptions = options;
      return pool;
    },
  });

  assert.deepEqual(readDatabaseConfig(validEnvironment), {
    connectionLimit: 10,
    connectTimeoutMs: 5_000,
    pingTimeoutMs: 2_000,
    queryTimeoutMs: 5_000,
    tls: { enabled: true, rejectUnauthorized: true },
  });
  assert.equal(poolOptions.host, "db.internal");
  assert.equal(poolOptions.port, 3307);
  assert.equal(poolOptions.database, "topology_scm");
  assert.equal(poolOptions.user, "scm_app");
  assert.equal(poolOptions.password, "s@fe-password");
  assert.deepEqual(poolOptions.ssl, { rejectUnauthorized: true });
  assert.equal(poolOptions.connectionLimit, 10);
  assert.equal(poolOptions.queueLimit, 40);
  assert.equal(poolOptions.resetOnRelease, true);

  await client.close();
});

test("database configuration accepts explicit TLS policy and rejects unsafe integer shapes", () => {
  assert.deepEqual(
    readDatabaseConfig({
      ...validEnvironment,
      DB_CONNECT_TIMEOUT_MS: "30000",
      DB_PING_TIMEOUT_MS: "4000",
      DB_POOL_SIZE: "50",
      DB_QUERY_TIMEOUT_MS: "30000",
      DB_SSL: "disabled",
      DB_SSL_REJECT_UNAUTHORIZED: "false",
    }),
    {
      connectionLimit: 50,
      connectTimeoutMs: 30_000,
      pingTimeoutMs: 4_000,
      queryTimeoutMs: 30_000,
      tls: { enabled: false, rejectUnauthorized: false },
    },
  );

  for (const environment of [
    { ...validEnvironment, DB_POOL_SIZE: "0" },
    { ...validEnvironment, DB_POOL_SIZE: "51" },
    { ...validEnvironment, DB_POOL_SIZE: "1.5" },
    { ...validEnvironment, DB_CONNECT_TIMEOUT_MS: "99" },
    { ...validEnvironment, DB_PING_TIMEOUT_MS: "9" },
    { ...validEnvironment, DB_PING_TIMEOUT_MS: "4001" },
    { ...validEnvironment, DB_QUERY_TIMEOUT_MS: "9" },
    { ...validEnvironment, DB_QUERY_TIMEOUT_MS: "30001" },
    { ...validEnvironment, DB_SSL: "sometimes" },
    { ...validEnvironment, DB_SSL_REJECT_UNAUTHORIZED: "0" },
  ]) {
    assert.throws(() => readDatabaseConfig(environment));
  }
});

test("query and execute pass parameters and normalize their results", async () => {
  const calls = [];
  let releaseCount = 0;
  const client = createClient(
    createFakePool({
      async getConnection() {
        return createFakeConnection({
          async execute(options, params) {
            calls.push({ kind: "execute", options, params });
            return [{ affectedRows: 3 }, []];
          },
          async query(options, params) {
            calls.push({ kind: "query", options, params });
            return [[{ id: "supplier-1" }], []];
          },
          release() {
            releaseCount += 1;
          },
        });
      },
    }),
  );

  assert.deepEqual(
    await client.query("SELECT id FROM suppliers WHERE status = ?", ["active"]),
    [{ id: "supplier-1" }],
  );
  assert.deepEqual(
    await client.execute("UPDATE suppliers SET status = ? WHERE id = ?", [
      "inactive",
      "supplier-1",
    ]),
    { affectedRows: 3 },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, "query");
  assert.equal(
    calls[0].options.sql,
    "SELECT id FROM suppliers WHERE status = ?",
  );
  assert.ok(calls[0].options.timeout > 0);
  assert.ok(calls[0].options.timeout <= 5_000);
  assert.deepEqual(calls[0].params, ["active"]);
  assert.equal(calls[1].kind, "execute");
  assert.equal(
    calls[1].options.sql,
    "UPDATE suppliers SET status = ? WHERE id = ?",
  );
  assert.ok(calls[1].options.timeout > 0);
  assert.ok(calls[1].options.timeout <= 5_000);
  assert.deepEqual(calls[1].params, ["inactive", "supplier-1"]);
  assert.equal(releaseCount, 2);

  await client.close();
});

test("database operation errors never expose URL, password, or SQL", async () => {
  const secret = "mysql://root:do-not-leak@private-db/internal";
  const sql = "SELECT * FROM private_customer_table";
  const client = createClient(
    createFakePool({
      async getConnection() {
        return createFakeConnection({
          async query() {
            throw new Error(
              `failed to connect to ${secret} while running ${sql}`,
            );
          },
        });
      },
    }),
  );

  await assert.rejects(client.query(sql), (error) => {
    assert.ok(error instanceof DatabaseClientError);
    assert.equal(error.code, "DATABASE_OPERATION_FAILED");
    assert.equal(error.message, "Database query failed");
    assert.doesNotMatch(error.stack ?? "", /do-not-leak|private_customer_table/);
    return true;
  });

  assert.throws(
    () =>
      createDatabaseClient({
        env: validEnvironment,
        poolFactory() {
          throw new Error(`cannot create ${secret}`);
        },
      }),
    (error) => {
      assert.ok(error instanceof DatabaseClientError);
      assert.equal(error.code, "DATABASE_POOL_CREATION_FAILED");
      assert.doesNotMatch(error.message, /do-not-leak/);
      return true;
    },
  );

  await client.close();
});

for (const operation of ["query", "execute"]) {
  test(`${operation} queue deadline is bounded and releases a late connection`, async () => {
    let provideConnection;
    let released = false;
    const queuedConnection = new Promise((resolve) => {
      provideConnection = resolve;
    });
    const client = createClient(
      createFakePool({
        getConnection() {
          return queuedConnection;
        },
      }),
    );
    const startedAt = performance.now();

    await assert.rejects(
      invokeSqlOperation(client, operation, { timeoutMs: 20 }),
      { code: "DATABASE_OPERATION_TIMED_OUT" },
    );
    assert.ok(performance.now() - startedAt < 1_000);

    provideConnection(
      createFakeConnection({
        release() {
          released = true;
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released, true);

    await client.close();
  });

  test(`${operation} execution deadline destroys the connection and absorbs its late rejection`, async () => {
    let callCount = 0;
    let destroyed = false;
    let driverTimeoutMs;
    let released = false;
    let rejectOperation;
    let notifyStarted;
    const operationStarted = new Promise((resolve) => {
      notifyStarted = resolve;
    });
    const connection = createFakeConnection({
      destroy() {
        destroyed = true;
        rejectOperation?.(
          new Error("late mysql://root:secret@private-db rejection"),
        );
      },
      [operation](options) {
        callCount += 1;
        driverTimeoutMs = options.timeout;
        notifyStarted();
        return new Promise((_resolve, reject) => {
          rejectOperation = reject;
        });
      },
      release() {
        released = true;
      },
    });
    const client = createClient(
      createFakePool({
        async getConnection() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return connection;
        },
      }),
    );
    const startedAt = performance.now();
    const pending = invokeSqlOperation(client, operation, { timeoutMs: 80 });

    await operationStarted;
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "DATABASE_OPERATION_TIMED_OUT");
      assert.doesNotMatch(error.message, /root|secret|private-db/iu);
      if (operation === "execute") {
        assert.match(error.message, /outcome is unknown/iu);
        assert.match(error.message, /must not be retried automatically/iu);
      }
      return true;
    });
    assert.equal(callCount, 1);
    assert.ok(driverTimeoutMs > 0);
    assert.ok(driverTimeoutMs < 80);
    assert.ok(performance.now() - startedAt < 500);
    assert.equal(destroyed, true);
    assert.equal(released, false);
    await new Promise((resolve) => setImmediate(resolve));

    await client.close();
  });

  test(`${operation} abort destroys a connection whose SQL has started`, async () => {
    let destroyed = false;
    let released = false;
    let notifyStarted;
    const operationStarted = new Promise((resolve) => {
      notifyStarted = resolve;
    });
    const client = createClient(
      createFakePool({
        async getConnection() {
          return createFakeConnection({
            destroy() {
              destroyed = true;
            },
            [operation]() {
              notifyStarted();
              return new Promise(() => {});
            },
            release() {
              released = true;
            },
          });
        },
      }),
    );
    const controller = new AbortController();
    const pending = invokeSqlOperation(client, operation, {
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    await operationStarted;
    controller.abort();
    await assert.rejects(pending, {
      code: "DATABASE_OPERATION_ABORTED",
    });
    assert.equal(destroyed, true);
    assert.equal(released, false);

    await client.close();
  });

  test(`${operation} destroys a PROTOCOL_SEQUENCE_TIMEOUT connection`, async () => {
    let destroyed = false;
    let released = false;
    const client = createClient(
      createFakePool({
        async getConnection() {
          return createFakeConnection({
            destroy() {
              destroyed = true;
            },
            async [operation]() {
              throw Object.assign(
                new Error("mysql://root:secret@private-db timed out"),
                { code: "PROTOCOL_SEQUENCE_TIMEOUT" },
              );
            },
            release() {
              released = true;
            },
          });
        },
      }),
    );

    await assert.rejects(invokeSqlOperation(client, operation), (error) => {
      assert.equal(error.code, "DATABASE_OPERATION_TIMED_OUT");
      assert.doesNotMatch(error.message, /root|secret|private-db/iu);
      return true;
    });
    assert.equal(destroyed, true);
    assert.equal(released, false);

    await client.close();
  });

  test(`${operation} releases the connection after an ordinary SQL error`, async () => {
    let destroyed = false;
    let released = false;
    const client = createClient(
      createFakePool({
        async getConnection() {
          return createFakeConnection({
            destroy() {
              destroyed = true;
            },
            async [operation]() {
              throw Object.assign(new Error("secret SQL syntax detail"), {
                code: "ER_PARSE_ERROR",
              });
            },
            release() {
              released = true;
            },
          });
        },
      }),
    );

    await assert.rejects(invokeSqlOperation(client, operation), (error) => {
      assert.equal(error.code, "DATABASE_OPERATION_FAILED");
      assert.doesNotMatch(error.message, /secret|syntax/iu);
      return true;
    });
    assert.equal(destroyed, false);
    assert.equal(released, true);

    await client.close();
  });
}

test("ping releases a healthy connection and close is idempotent", async () => {
  let pingCount = 0;
  let releaseCount = 0;
  let closeCount = 0;
  const connection = createFakeConnection({
    async ping() {
      pingCount += 1;
    },
    release() {
      releaseCount += 1;
    },
  });
  const client = createClient(
    createFakePool({
      async end() {
        closeCount += 1;
      },
      async getConnection() {
        return connection;
      },
    }),
  );

  await client.ping();
  await Promise.all([client.close(), client.close()]);

  assert.equal(pingCount, 1);
  assert.equal(releaseCount, 1);
  assert.equal(closeCount, 1);
  await assert.rejects(client.query("SELECT 1"), {
    code: "DATABASE_CLIENT_CLOSED",
  });
});

test("ping timeout destroys an acquired connection", async () => {
  let destroyed = false;
  let released = false;
  const client = createClient(
    createFakePool({
      async getConnection() {
        return createFakeConnection({
          destroy() {
            destroyed = true;
          },
          ping() {
            return new Promise(() => {});
          },
          release() {
            released = true;
          },
        });
      },
    }),
  );

  await assert.rejects(client.ping({ timeoutMs: 10 }), {
    code: "DATABASE_OPERATION_TIMED_OUT",
  });
  assert.equal(destroyed, true);
  assert.equal(released, false);

  await client.close();
});

test("aborted queued ping stays bounded and releases a late connection", async () => {
  let provideConnection;
  let released = false;
  const queuedConnection = new Promise((resolve) => {
    provideConnection = resolve;
  });
  const client = createClient(
    createFakePool({
      getConnection() {
        return queuedConnection;
      },
    }),
  );
  const controller = new AbortController();
  const ping = client.ping({ signal: controller.signal, timeoutMs: 1_000 });

  controller.abort();
  await assert.rejects(ping, { code: "DATABASE_OPERATION_ABORTED" });

  provideConnection(
    createFakeConnection({
      release() {
        released = true;
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, true);

  await client.close();
});
