import mysql, {
  type ExecuteValues,
  type PoolOptions,
} from "mysql2/promise";

const defaultConnectionLimit = 10;
const defaultConnectTimeoutMs = 5_000;
const defaultPingTimeoutMs = 2_000;
const defaultQueryTimeoutMs = 5_000;
const defaultTransactionTimeoutMs = 30_000;
const minimumConnectTimeoutMs = 100;
const maximumConnectTimeoutMs = 30_000;
const minimumPingTimeoutMs = 10;
const maximumPingTimeoutMs = 4_000;
const minimumQueryTimeoutMs = 10;
const maximumQueryTimeoutMs = 30_000;
const maximumTransactionTimeoutMs = 60_000;
const maximumConnectionLimit = 50;

export type QueryParameters = readonly ExecuteValues[];
export type DatabaseRow = Record<string, unknown>;

export interface ExecuteResult {
  affectedRows: number;
  insertId?: number;
}

export interface DatabaseOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type PingOptions = DatabaseOperationOptions;

export interface QueryExecutor {
  query<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    params?: QueryParameters,
    options?: DatabaseOperationOptions,
  ): Promise<readonly Row[]>;
  execute(
    sql: string,
    params?: QueryParameters,
    options?: DatabaseOperationOptions,
  ): Promise<ExecuteResult>;
}

export interface DatabaseClient extends QueryExecutor {
  transaction<Result>(
    callback: (transaction: QueryExecutor) => Promise<Result>,
    options?: DatabaseOperationOptions,
  ): Promise<Result>;
  ping(options?: PingOptions): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseConfig {
  connectionLimit: number;
  connectTimeoutMs: number;
  pingTimeoutMs: number;
  queryTimeoutMs: number;
  transactionTimeoutMs: number;
  tls: {
    enabled: boolean;
    rejectUnauthorized: boolean;
  };
}

export type DatabaseEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface DatabasePoolConnection {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  destroy(): void;
  execute(
    options: { sql: string; timeout: number },
    params: ExecuteValues[],
  ): Promise<[unknown, unknown]>;
  ping(): Promise<void>;
  query(
    options: { sql: string; timeout: number },
    params: ExecuteValues[],
  ): Promise<[unknown, unknown]>;
  release(): void;
  rollback(): Promise<void>;
}

export interface DatabasePool {
  end(): Promise<void>;
  getConnection(): Promise<DatabasePoolConnection>;
}

export type DatabasePoolFactory = (options: PoolOptions) => DatabasePool;

export interface CreateDatabaseClientOptions {
  env?: DatabaseEnvironment;
  poolFactory?: DatabasePoolFactory;
}

export type DatabaseErrorCode =
  | "DATABASE_CLIENT_CLOSED"
  | "DATABASE_OPERATION_ABORTED"
  | "DATABASE_OPERATION_FAILED"
  | "DATABASE_OPERATION_TIMED_OUT"
  | "DATABASE_POOL_CREATION_FAILED"
  | "DATABASE_TRANSACTION_OUTCOME_UNKNOWN";

export class DatabaseClientError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string) {
    super(message);
    this.name = "DatabaseClientError";
    this.code = code;
  }
}

interface ParsedDatabaseEnvironment {
  config: DatabaseConfig;
  poolOptions: PoolOptions;
}

class OperationCancellation extends Error {
  readonly reason: "aborted" | "timed_out";

  constructor(reason: "aborted" | "timed_out") {
    super(reason);
    this.reason = reason;
  }
}

function configurationError(variable: string, requirement: string): Error {
  return new Error(`${variable} ${requirement}`);
}

function parseInteger(
  env: DatabaseEnvironment,
  variable: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = env[variable]?.trim();
  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configurationError(
      variable,
      `must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

function parseEnum<T extends string>(
  env: DatabaseEnvironment,
  variable: string,
  allowedValues: readonly T[],
  defaultValue: T,
): T {
  const rawValue = env[variable]?.trim();
  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  if (!allowedValues.includes(rawValue as T)) {
    throw configurationError(
      variable,
      `must be one of: ${allowedValues.join(", ")}`,
    );
  }

  return rawValue as T;
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw configurationError(
      "DATABASE_URL",
      "must contain valid percent-encoding",
    );
  }
}

function parseDatabaseUrl(rawValue: string | undefined): {
  database: string;
  host: string;
  password: string;
  port: number;
  user: string;
} {
  const databaseUrl = rawValue?.trim();
  if (!databaseUrl) {
    throw configurationError("DATABASE_URL", "is required");
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw configurationError("DATABASE_URL", "must be a valid mysql:// URL");
  }

  if (url.protocol !== "mysql:") {
    throw configurationError("DATABASE_URL", "must use the mysql:// scheme");
  }

  if (url.search !== "" || url.hash !== "") {
    throw configurationError(
      "DATABASE_URL",
      "must not contain query parameters or a fragment",
    );
  }

  const user = decodeUrlComponent(url.username);
  const password = decodeUrlComponent(url.password);
  const databasePath = url.pathname.slice(1);
  const database = decodeUrlComponent(databasePath);

  if (
    user === "" ||
    password === "" ||
    url.hostname === "" ||
    database === "" ||
    database.includes("/")
  ) {
    throw configurationError(
      "DATABASE_URL",
      "must include one database, a host, and non-empty credentials",
    );
  }

  const port = url.port === "" ? 3_306 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw configurationError(
      "DATABASE_URL",
      "must use a port between 1 and 65535",
    );
  }

  return {
    database,
    host: url.hostname,
    password,
    port,
    user,
  };
}

function parseDatabaseEnvironment(
  env: DatabaseEnvironment,
): ParsedDatabaseEnvironment {
  const connection = parseDatabaseUrl(env.DATABASE_URL);
  const connectionLimit = parseInteger(
    env,
    "DB_POOL_SIZE",
    defaultConnectionLimit,
    1,
    maximumConnectionLimit,
  );
  const connectTimeoutMs = parseInteger(
    env,
    "DB_CONNECT_TIMEOUT_MS",
    defaultConnectTimeoutMs,
    minimumConnectTimeoutMs,
    maximumConnectTimeoutMs,
  );
  const pingTimeoutMs = parseInteger(
    env,
    "DB_PING_TIMEOUT_MS",
    defaultPingTimeoutMs,
    minimumPingTimeoutMs,
    maximumPingTimeoutMs,
  );
  const queryTimeoutMs = parseInteger(
    env,
    "DB_QUERY_TIMEOUT_MS",
    defaultQueryTimeoutMs,
    minimumQueryTimeoutMs,
    maximumQueryTimeoutMs,
  );
  const transactionTimeoutMs = parseInteger(
    env,
    "DB_TRANSACTION_TIMEOUT_MS",
    defaultTransactionTimeoutMs,
    minimumConnectTimeoutMs,
    maximumTransactionTimeoutMs,
  );
  const tlsMode = parseEnum(
    env,
    "DB_SSL",
    ["enabled", "disabled"] as const,
    "enabled",
  );
  const rejectUnauthorized =
    parseEnum(
      env,
      "DB_SSL_REJECT_UNAUTHORIZED",
      ["true", "false"] as const,
      "true",
    ) === "true";
  const tls = {
    enabled: tlsMode === "enabled",
    rejectUnauthorized,
  };
  const poolOptions: PoolOptions = {
    ...connection,
    connectionLimit,
    connectTimeout: connectTimeoutMs,
    dateStrings: true,
    decimalNumbers: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    maxIdle: connectionLimit,
    queueLimit: connectionLimit * 4,
    resetOnRelease: true,
    timezone: "+08:00",
    waitForConnections: true,
    ...(tls.enabled
      ? { ssl: { rejectUnauthorized: tls.rejectUnauthorized } }
      : {}),
  };

  return {
    config: {
      connectionLimit,
      connectTimeoutMs,
      pingTimeoutMs,
      queryTimeoutMs,
      transactionTimeoutMs,
      tls,
    },
    poolOptions,
  };
}

export function readDatabaseConfig(
  env: DatabaseEnvironment = process.env,
): DatabaseConfig {
  return parseDatabaseEnvironment(env).config;
}

function operationError(
  operation: "close" | "execute" | "ping" | "query",
): Error {
  return new DatabaseClientError(
    "DATABASE_OPERATION_FAILED",
    `Database ${operation} failed`,
  );
}

function transactionOutcomeUnknown(): DatabaseClientError {
  return new DatabaseClientError(
    "DATABASE_TRANSACTION_OUTCOME_UNKNOWN",
    "Database transaction outcome is unknown and must not be retried automatically",
  );
}

function assertSql(sql: string): void {
  if (sql.trim() === "") {
    throw new TypeError("SQL must not be empty");
  }
}

function resolveTimeoutMs(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `timeoutMs must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

function createCancellation(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  cleanup: () => void;
  remainingMs: () => number;
  promise: Promise<never>;
} {
  const deadline = performance.now() + timeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const promise = new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationCancellation("aborted"));
      return;
    }

    if (signal !== undefined) {
      abortListener = () => reject(new OperationCancellation("aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    }

    timeout = setTimeout(
      () => reject(new OperationCancellation("timed_out")),
      timeoutMs,
    );
  });

  return {
    cleanup: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (abortListener !== undefined) {
        signal?.removeEventListener("abort", abortListener);
      }
    },
    remainingMs: () => Math.ceil(deadline - performance.now()),
    promise,
  };
}

function cancellationError(
  operation: "execute" | "ping" | "query",
  error: OperationCancellation,
  executionStarted = false,
): Error {
  const uncertainSuffix =
    operation === "execute" && executionStarted
      ? "; outcome is unknown and must not be retried automatically"
      : "";

  if (error.reason === "aborted") {
    return new DatabaseClientError(
      "DATABASE_OPERATION_ABORTED",
      `Database ${operation} was aborted${uncertainSuffix}`,
    );
  }

  return new DatabaseClientError(
    "DATABASE_OPERATION_TIMED_OUT",
    `Database ${operation} timed out${uncertainSuffix}`,
  );
}

function isProtocolSequenceTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PROTOCOL_SEQUENCE_TIMEOUT"
  );
}

function safelyDisposeConnection(
  connection: DatabasePoolConnection,
  destroy: boolean,
): void {
  try {
    if (destroy) {
      connection.destroy();
    } else {
      connection.release();
    }
  } catch {
    // Cleanup errors may contain connection metadata. The operation result is
    // already decided, so keep cleanup best-effort and fully sanitized.
  }
}

function releaseLateConnection(
  connectionPromise: Promise<DatabasePoolConnection>,
): void {
  void connectionPromise.then(
    (connection) => safelyDisposeConnection(connection, false),
    () => undefined,
  );
}

async function runSqlOperation(
  pool: DatabasePool,
  operation: "execute" | "query",
  sql: string,
  params: QueryParameters,
  options: DatabaseOperationOptions,
  defaultTimeoutMs: number,
): Promise<unknown> {
  const timeoutMs = resolveTimeoutMs(
    options.timeoutMs,
    defaultTimeoutMs,
    minimumQueryTimeoutMs,
    maximumQueryTimeoutMs,
  );
  if (options.signal?.aborted) {
    throw cancellationError(
      operation,
      new OperationCancellation("aborted"),
    );
  }

  const cancellation = createCancellation(options.signal, timeoutMs);
  const connectionPromise = Promise.resolve().then(() => pool.getConnection());
  let connection: DatabasePoolConnection | undefined;
  let destroyConnection = false;
  let operationPromise: Promise<[unknown, unknown]> | undefined;

  try {
    try {
      connection = await Promise.race([
        connectionPromise,
        cancellation.promise,
      ]);
    } catch (error) {
      if (error instanceof OperationCancellation) {
        releaseLateConnection(connectionPromise);
        throw cancellationError(operation, error);
      }
      throw operationError(operation);
    }

    if (options.signal?.aborted) {
      throw cancellationError(
        operation,
        new OperationCancellation("aborted"),
      );
    }
    const remainingMs = cancellation.remainingMs();
    if (remainingMs <= 0) {
      throw cancellationError(
        operation,
        new OperationCancellation("timed_out"),
      );
    }

    try {
      const driverOptions = {
        sql,
        timeout: remainingMs,
      };
      operationPromise = connection[operation](driverOptions, [...params]);
      const [result] = await Promise.race([
        operationPromise,
        cancellation.promise,
      ]);
      return result;
    } catch (error) {
      if (error instanceof OperationCancellation) {
        destroyConnection = true;
        void operationPromise?.then(
          () => undefined,
          () => undefined,
        );
        throw cancellationError(operation, error, true);
      }
      if (isProtocolSequenceTimeout(error)) {
        destroyConnection = true;
        throw cancellationError(
          operation,
          new OperationCancellation("timed_out"),
          true,
        );
      }
      throw operationError(operation);
    }
  } finally {
    cancellation.cleanup();
    if (connection !== undefined) {
      safelyDisposeConnection(connection, destroyConnection);
    }
  }
}

function createMysqlPool(options: PoolOptions): DatabasePool {
  const pool = mysql.createPool(options);

  return {
    end: () => pool.end(),
    getConnection: async () => {
      const connection = await pool.getConnection();
      return {
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        destroy: () => connection.destroy(),
        execute: (queryOptions, params) =>
          connection.execute(queryOptions, params),
        ping: () => connection.ping(),
        query: (queryOptions, params) => connection.query(queryOptions, params),
        release: () => connection.release(),
        rollback: () => connection.rollback(),
      };
    },
  };
}

export function createDatabaseClient(
  options: CreateDatabaseClientOptions = {},
): DatabaseClient {
  const { config, poolOptions } = parseDatabaseEnvironment(
    options.env ?? process.env,
  );
  const poolFactory = options.poolFactory ?? createMysqlPool;
  let pool: DatabasePool;

  try {
    pool = poolFactory(poolOptions);
  } catch {
    throw new DatabaseClientError(
      "DATABASE_POOL_CREATION_FAILED",
      "Database pool creation failed",
    );
  }

  let closed = false;
  let closePromise: Promise<void> | undefined;

  function assertOpen(): void {
    if (closed) {
      throw new DatabaseClientError(
        "DATABASE_CLIENT_CLOSED",
        "Database client is closed",
      );
    }
  }

  function connectionExecutor(
    connection: DatabasePoolConnection,
    transactionCancellation?: ReturnType<typeof createCancellation>,
  ): QueryExecutor {
    async function executeOnConnection(
      operation: "execute" | "query",
      sql: string,
      params: QueryParameters,
      operationOptions: DatabaseOperationOptions,
    ): Promise<unknown> {
      assertSql(sql);
      const requestedTimeoutMs = resolveTimeoutMs(
        operationOptions.timeoutMs,
        config.queryTimeoutMs,
        minimumQueryTimeoutMs,
        maximumQueryTimeoutMs,
      );
      const transactionRemainingMs = transactionCancellation?.remainingMs();
      const timeoutMs = transactionRemainingMs === undefined
        ? requestedTimeoutMs
        : Math.min(requestedTimeoutMs, transactionRemainingMs);
      if (timeoutMs <= 0) {
        throw cancellationError(operation, new OperationCancellation("timed_out"), true);
      }
      if (operationOptions.signal?.aborted) {
        throw cancellationError(operation, new OperationCancellation("aborted"));
      }
      const cancellation = createCancellation(operationOptions.signal, timeoutMs);
      let operationPromise: Promise<[unknown, unknown]> | undefined;
      try {
        operationPromise = connection[operation](
          { sql, timeout: timeoutMs },
          [...params],
        );
        const [result] = await Promise.race([
          operationPromise,
          cancellation.promise,
          ...(transactionCancellation === undefined
            ? []
            : [transactionCancellation.promise]),
        ]);
        return result;
      } catch (error) {
        if (error instanceof OperationCancellation) {
          void operationPromise?.catch(() => undefined);
          throw cancellationError(operation, error, true);
        }
        if (isProtocolSequenceTimeout(error)) {
          throw cancellationError(
            operation,
            new OperationCancellation("timed_out"),
            true,
          );
        }
        if (error instanceof DatabaseClientError) throw error;
        throw operationError(operation);
      } finally {
        cancellation.cleanup();
      }
    }

    return {
      async query<Row extends DatabaseRow = DatabaseRow>(
        sql: string,
        params: QueryParameters = [],
        operationOptions: DatabaseOperationOptions = {},
      ): Promise<readonly Row[]> {
        const rows = await executeOnConnection(
          "query",
          sql,
          params,
          operationOptions,
        );
        if (!Array.isArray(rows)) throw operationError("query");
        return rows as Row[];
      },
      async execute(
        sql: string,
        params: QueryParameters = [],
        operationOptions: DatabaseOperationOptions = {},
      ): Promise<ExecuteResult> {
        const result = await executeOnConnection(
          "execute",
          sql,
          params,
          operationOptions,
        );
        const affectedRows =
          typeof result === "object" &&
          result !== null &&
          "affectedRows" in result
            ? result.affectedRows
            : undefined;
        const insertId =
          typeof result === "object" &&
          result !== null &&
          "insertId" in result &&
          typeof result.insertId === "number" &&
          Number.isSafeInteger(result.insertId) &&
          result.insertId >= 0
            ? result.insertId
            : undefined;
        if (
          typeof affectedRows !== "number" ||
          !Number.isSafeInteger(affectedRows) ||
          affectedRows < 0
        ) {
          throw operationError("execute");
        }
        return {
          affectedRows,
          ...(insertId === undefined ? {} : { insertId }),
        };
      },
    };
  }

  return {
    async transaction<Result>(
      callback: (transaction: QueryExecutor) => Promise<Result>,
      transactionOptions: DatabaseOperationOptions = {},
    ): Promise<Result> {
      assertOpen();
      const timeoutMs = resolveTimeoutMs(
        transactionOptions.timeoutMs,
        config.transactionTimeoutMs,
        minimumConnectTimeoutMs,
        maximumTransactionTimeoutMs,
      );
      if (transactionOptions.signal?.aborted) {
        throw cancellationError("execute", new OperationCancellation("aborted"));
      }
      const cancellation = createCancellation(transactionOptions.signal, timeoutMs);
      const connectionPromise = Promise.resolve().then(() => pool.getConnection());
      let connection: DatabasePoolConnection | undefined;
      let committed = false;
      let began = false;
      let destroyed = false;
      try {
        try {
          connection = await Promise.race([connectionPromise, cancellation.promise]);
        } catch (error) {
          if (error instanceof OperationCancellation) {
            releaseLateConnection(connectionPromise);
            throw cancellationError("execute", error);
          }
          throw operationError("execute");
        }

        let lifecyclePromise: Promise<unknown> = connection.beginTransaction();
        try {
          await Promise.race([lifecyclePromise, cancellation.promise]);
        } catch (error) {
          void lifecyclePromise.catch(() => undefined);
          if (error instanceof OperationCancellation) {
            connection.destroy();
            destroyed = true;
            throw transactionOutcomeUnknown();
          }
          connection.destroy();
          destroyed = true;
          throw operationError("execute");
        }
        began = true;
        const callbackPromise = Promise.resolve().then(() =>
          callback(connectionExecutor(connection!, cancellation)),
        );
        let result: Result;
        try {
          result = await Promise.race([callbackPromise, cancellation.promise]);
        } catch (error) {
          if (error instanceof OperationCancellation) {
            void callbackPromise.catch(() => undefined);
            connection.destroy();
            destroyed = true;
            throw transactionOutcomeUnknown();
          }
          throw error;
        }
        lifecyclePromise = connection.commit();
        try {
          await Promise.race([lifecyclePromise, cancellation.promise]);
          committed = true;
        } catch {
          void lifecyclePromise.catch(() => undefined);
          connection.destroy();
          destroyed = true;
          throw transactionOutcomeUnknown();
        }
        return result;
      } catch (error) {
        if (began && !committed && !destroyed && connection !== undefined) {
          if (
            error instanceof DatabaseClientError &&
            (error.code === "DATABASE_OPERATION_ABORTED" ||
              error.code === "DATABASE_OPERATION_TIMED_OUT")
          ) {
            connection.destroy();
            destroyed = true;
            throw transactionOutcomeUnknown();
          }
          const rollbackPromise = connection.rollback();
          try {
            await Promise.race([rollbackPromise, cancellation.promise]);
          } catch {
            void rollbackPromise.catch(() => undefined);
            connection.destroy();
            destroyed = true;
            throw transactionOutcomeUnknown();
          }
        }
        throw error;
      } finally {
        cancellation.cleanup();
        if (!destroyed && connection !== undefined) safelyDisposeConnection(connection, false);
      }
    },
    async query<Row extends DatabaseRow = DatabaseRow>(
      sql: string,
      params: QueryParameters = [],
      operationOptions: DatabaseOperationOptions = {},
    ): Promise<readonly Row[]> {
      assertOpen();
      assertSql(sql);

      try {
        const rows = await runSqlOperation(
          pool,
          "query",
          sql,
          params,
          operationOptions,
          config.queryTimeoutMs,
        );
        if (!Array.isArray(rows)) {
          throw operationError("query");
        }
        return rows as Row[];
      } catch (error) {
        if (error instanceof DatabaseClientError) {
          throw error;
        }
        throw operationError("query");
      }
    },

    async execute(
      sql: string,
      params: QueryParameters = [],
      operationOptions: DatabaseOperationOptions = {},
    ): Promise<ExecuteResult> {
      assertOpen();
      assertSql(sql);

      try {
        const result = await runSqlOperation(
          pool,
          "execute",
          sql,
          params,
          operationOptions,
          config.queryTimeoutMs,
        );
        const affectedRows =
          typeof result === "object" &&
          result !== null &&
          "affectedRows" in result
            ? result.affectedRows
            : undefined;
        const insertId =
          typeof result === "object" &&
          result !== null &&
          "insertId" in result &&
          typeof result.insertId === "number" &&
          Number.isSafeInteger(result.insertId) &&
          result.insertId >= 0
            ? result.insertId
            : undefined;

        if (
          typeof affectedRows !== "number" ||
          !Number.isSafeInteger(affectedRows) ||
          affectedRows < 0
        ) {
          throw operationError("execute");
        }

        return {
          affectedRows,
          ...(insertId === undefined ? {} : { insertId }),
        };
      } catch (error) {
        if (error instanceof DatabaseClientError) {
          throw error;
        }
        throw operationError("execute");
      }
    },

    async ping(pingOptions: PingOptions = {}): Promise<void> {
      assertOpen();
      const timeoutMs = resolveTimeoutMs(
        pingOptions.timeoutMs,
        config.pingTimeoutMs,
        minimumPingTimeoutMs,
        maximumPingTimeoutMs,
      );
      if (pingOptions.signal?.aborted) {
        throw cancellationError("ping", new OperationCancellation("aborted"));
      }
      const cancellation = createCancellation(
        pingOptions.signal,
        timeoutMs,
      );
      const connectionPromise = Promise.resolve().then(() =>
        pool.getConnection(),
      );
      let connection: DatabasePoolConnection | undefined;
      let destroyConnection = false;

      try {
        try {
          connection = await Promise.race([
            connectionPromise,
            cancellation.promise,
          ]);
        } catch (error) {
          if (error instanceof OperationCancellation) {
            releaseLateConnection(connectionPromise);
            throw cancellationError("ping", error);
          }
          throw operationError("ping");
        }

        try {
          await Promise.race([connection.ping(), cancellation.promise]);
        } catch (error) {
          destroyConnection = true;
          if (error instanceof OperationCancellation) {
            throw cancellationError("ping", error, true);
          }
          throw operationError("ping");
        }
      } finally {
        cancellation.cleanup();
        if (connection !== undefined) {
          safelyDisposeConnection(connection, destroyConnection);
        }
      }
    },

    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }

      closed = true;
      closePromise = Promise.resolve()
        .then(() => pool.end())
        .catch(() => {
          throw operationError("close");
        });
      return closePromise;
    },
  };
}
