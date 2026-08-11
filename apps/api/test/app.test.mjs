import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { buildApp } from "../dist/app.js";

async function usingApp(options, run) {
  const app = await buildApp({ logger: false, ...options });

  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function createLogCapture() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  return {
    stream,
    output: () => output,
    records: () =>
      output
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

async function withDeadline(promise, timeoutMs) {
  let timeout;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`operation exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("liveness does not execute readiness checks", async () => {
  let readinessCalls = 0;

  await usingApp(
    {
      readinessChecks: [
        {
          name: "database",
          run: () => {
            readinessCalls += 1;
          },
        },
      ],
    },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health/live",
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, "ok");
      assert.equal(readinessCalls, 0);
    },
  );
});

test("readiness returns success when every injected check passes", async () => {
  await usingApp(
    {
      readinessChecks: [
        { name: "database", run: async () => undefined },
        { name: "object-storage", run: () => undefined },
      ],
    },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health/ready",
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().checks, [
        { name: "database", status: "ok" },
        { name: "object-storage", status: "ok" },
      ]);
      assert.equal(response.json().status, "ok");
    },
  );
});

test("readiness returns a sanitized failure without throwing", async () => {
  await usingApp(
    {
      readinessChecks: [
        {
          name: "database",
          run: () => {
            throw new Error("mysql://admin:secret@database");
          },
        },
      ],
    },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health/ready",
      });

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().status, "not_ready");
      assert.deepEqual(response.json().checks, [
        { name: "database", status: "failed" },
      ]);
      assert.doesNotMatch(response.body, /admin|secret|mysql/i);
    },
  );
});

test("readiness timeout bounds a never-resolving dependency check", async () => {
  const startedAt = performance.now();

  await usingApp(
    {
      readinessChecks: [
        {
          name: "database",
          run: () => new Promise(() => undefined),
        },
      ],
      readinessTimeoutMs: 25,
    },
    async (app) => {
      const response = await withDeadline(
        app.inject({ method: "GET", url: "/api/v1/health/ready" }),
        500,
      );

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().status, "not_ready");
      assert.deepEqual(response.json().checks, [
        { name: "database", status: "failed" },
      ]);
    },
  );

  assert.ok(performance.now() - startedAt < 500);
});

test("readiness timeout must be a positive safe integer", async () => {
  for (const readinessTimeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => buildApp({ logger: false, readinessTimeoutMs }),
      /positive safe integer/u,
    );
  }
});

test("ingress request id is stable between the header and error envelope", async () => {
  await usingApp({}, async (app) => {
    const ingressRequestId = "nginx-request-id-123";
    const response = await app.inject({
      method: "GET",
      url: "/not-found",
      headers: { "x-request-id": ingressRequestId },
    });
    const requestId = response.headers["x-request-id"];

    assert.equal(requestId, ingressRequestId);
    assert.equal(response.json().requestId, ingressRequestId);
  });
});

test("request id is generated when ingress does not supply one", async () => {
  await usingApp({}, async (app) => {
    const response = await app.inject({
      method: "GET",
      url: "/not-found",
    });
    const requestId = response.headers["x-request-id"];

    assert.equal(typeof requestId, "string");
    assert.ok(requestId.length > 0);
    assert.equal(response.json().requestId, requestId);
  });
});

test("404 and 500 responses never expose route or exception internals", async () => {
  await usingApp({}, async (app) => {
    app.get("/test/internal-error", async () => {
      throw new Error("database password is super-secret");
    });

    const notFound = await app.inject({
      method: "GET",
      url: "/missing/sensitive-customer-id",
    });
    assert.equal(notFound.statusCode, 404);
    assert.equal(notFound.json().code, "NOT_FOUND");
    assert.doesNotMatch(notFound.body, /sensitive-customer-id/);

    const internalError = await app.inject({
      method: "GET",
      url: "/test/internal-error",
    });
    assert.equal(internalError.statusCode, 500);
    assert.equal(internalError.json().message, "Internal Server Error");
    assert.doesNotMatch(internalError.body, /database|password|super-secret/i);
  });
});

test("OpenAPI document includes contract-backed health endpoints", async () => {
  await usingApp({}, async (app) => {
    await app.ready();
    const openapi = app.swagger();

    assert.ok(openapi.paths?.["/api/v1/health/live"]?.get);
    assert.ok(openapi.paths?.["/api/v1/health/ready"]?.get);
    assert.ok(openapi.components?.schemas?.HealthLive);
    assert.ok(openapi.components?.schemas?.HealthReady);
  });
});

test("structured logs keep safe diagnostics without query or error secrets", async () => {
  const capture = createLogCapture();
  const requestId = "nginx-security-audit-request-id";
  const querySecret = "QUERY_SECRET_4f0a";
  const fragmentSecret = "FRAGMENT_SECRET_80b1";
  const exceptionSecret = "EXCEPTION_SECRET_1c2d";
  const causeSecret = "CAUSE_SECRET_95ee";
  const clientErrorSecret = "CLIENT_ERROR_SECRET_37ad";

  await usingApp(
    { logger: { level: "info", stream: capture.stream } },
    async (app) => {
      app.get("/test/log-error", async () => {
        throw new Error(exceptionSecret, {
          cause: new Error(causeSecret),
        });
      });
      app.get("/test/log-client-error", async () => {
        const error = new Error(clientErrorSecret);
        error.statusCode = 400;
        throw error;
      });

      const serverError = await app.inject({
        method: "GET",
        url: `/test/log-error?token=${querySecret}#${fragmentSecret}`,
        headers: { "x-request-id": requestId },
      });
      assert.equal(serverError.statusCode, 500);

      const clientError = await app.inject({
        method: "GET",
        url: `/test/log-client-error?token=${querySecret}`,
        headers: { "x-request-id": `${requestId}-4xx` },
      });
      assert.equal(clientError.statusCode, 400);
    },
  );

  const output = capture.output();
  for (const secret of [
    querySecret,
    fragmentSecret,
    exceptionSecret,
    causeSecret,
    clientErrorSecret,
  ]) {
    assert.doesNotMatch(output, new RegExp(secret, "u"));
  }

  const records = capture.records();
  const requestStarted = records.find(
    (record) =>
      record.event === "request_started" && record.requestId === requestId,
  );
  assert.ok(requestStarted);
  assert.equal(requestStarted.pathname, "/test/log-error");
  assert.equal(requestStarted.method, "GET");
  assert.equal("url" in requestStarted, false);

  const serverError = records.find(
    (record) =>
      record.event === "unhandled_request_error" &&
      record.requestId === requestId,
  );
  assert.ok(serverError);
  assert.equal(serverError.statusCode, 500);
  assert.equal(serverError.errorName, "Error");
  assert.equal("err" in serverError, false);
  assert.equal("stack" in serverError, false);
  assert.equal("cause" in serverError, false);

  const clientError = records.find(
    (record) =>
      record.event === "request_rejected" &&
      record.requestId === `${requestId}-4xx`,
  );
  assert.ok(clientError);
  assert.equal(clientError.statusCode, 400);
  assert.equal(clientError.errorName, "Error");
});

test("logger overrides cannot expose cookies, request URLs, or errors", async () => {
  const capture = createLogCapture();
  const cookieSecret = "COOKIE_SECRET_a72f";
  const querySecret = "OVERRIDE_QUERY_SECRET_39c1";
  const errorSecret = "OVERRIDE_ERROR_SECRET_81ee";

  await usingApp(
    {
      logger: {
        level: "info",
        stream: capture.stream,
        redact: [],
        serializers: {
          req: (request) => ({ url: request.raw?.url ?? request.url }),
          err: (error) => ({
            type: error.name,
            message: error.message,
            stack: error.stack,
            cause: error.cause,
          }),
          res: (response) => ({ headers: response.getHeaders() }),
        },
      },
    },
    async (app) => {
      app.addHook("onResponse", async (request, reply) => {
        request.log.info(
          { event: "response_cookie_probe", res: reply.raw },
          "Response cookie probe",
        );
      });
      app.get("/test/logger-overrides", async (request, reply) => {
        reply.header("set-cookie", `session=${cookieSecret}; HttpOnly`);
        request.log.info(
          {
            event: "serializer_override_probe",
            req: request,
            err: new Error(errorSecret),
          },
          "Serializer override probe",
        );
        return { ok: true };
      });

      const response = await app.inject({
        method: "GET",
        url: `/test/logger-overrides?token=${querySecret}`,
      });
      assert.equal(response.statusCode, 200);
    },
  );

  const output = capture.output();
  assert.doesNotMatch(output, new RegExp(cookieSecret, "u"));
  assert.doesNotMatch(output, new RegExp(querySecret, "u"));
  assert.doesNotMatch(output, new RegExp(errorSecret, "u"));

  const records = capture.records();
  const serializerProbe = records.find(
    (record) => record.event === "serializer_override_probe",
  );
  assert.ok(serializerProbe);
  assert.equal(serializerProbe.req.pathname, "/test/logger-overrides");
  assert.equal("url" in serializerProbe.req, false);
  assert.equal(serializerProbe.err.type, "Error");
  assert.equal(serializerProbe.err.message, "[REDACTED]");
  assert.equal(serializerProbe.err.stack, "[REDACTED]");
  assert.equal("cause" in serializerProbe.err, false);

  const responseProbe = records.find(
    (record) => record.event === "response_cookie_probe",
  );
  assert.ok(responseProbe);
  assert.deepEqual(responseProbe.res, { statusCode: 200 });
});

test("mandatory redaction safely retains simple caller paths and censor", async () => {
  const capture = createLogCapture();
  const customSecret = "CALLER_REDACT_SECRET_b44e";

  await usingApp(
    {
      logger: {
        level: "info",
        stream: capture.stream,
        redact: {
          paths: ["customSecretField"],
          censor: "[CALLER_MASK]",
        },
      },
    },
    async (app) => {
      app.get("/test/caller-redaction", async (request) => {
        request.log.info(
          {
            event: "caller_redaction_probe",
            customSecretField: customSecret,
            safeField: "retained",
          },
          "Caller redaction probe",
        );
        return { ok: true };
      });

      const response = await app.inject({
        method: "GET",
        url: "/test/caller-redaction",
      });
      assert.equal(response.statusCode, 200);
    },
  );

  assert.doesNotMatch(capture.output(), new RegExp(customSecret, "u"));
  const record = capture
    .records()
    .find((entry) => entry.event === "caller_redaction_probe");
  assert.ok(record);
  assert.equal(record.customSecretField, "[CALLER_MASK]");
  assert.equal(record.safeField, "retained");
});
