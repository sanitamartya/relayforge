import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import app from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { eventQueue } from "../src/queue/event-queue.js";

test("GET /health returns a successful health response", async () => {
  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, {
    status: "ok",
    service: "relayforge",
  });
});

test("Request IDs are echoed and valid client IDs are preserved", async () => {
  const response = await request(app).get("/health").set("X-Request-Id", "test-request-123");

  assert.equal(response.headers["x-request-id"], "test-request-123");
});

test("Invalid request IDs are replaced with generated IDs", async () => {
  const response = await request(app).get("/health").set("X-Request-Id", "invalid request id");

  assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/i);
});

test("GET /ready reports database and Redis dependency status", async () => {
  const response = await request(app).get("/ready");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, {
    status: "ready",
    service: "relayforge",
    checks: {
      database: "ok",
      redis: "ok",
    },
  });
});

test("GET /metrics exposes Prometheus-compatible HTTP and process metrics", async () => {
  const response = await request(app).get("/metrics");

  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/plain/);
  assert.match(response.text, /relayforge_http_requests_total/);
  assert.match(response.text, /relayforge_http_request_duration_seconds_bucket/);
  assert.match(response.text, /relayforge_process_uptime_seconds/);
  assert.match(response.text, /relayforge_process_resident_memory_bytes/);
});

test("API responses include baseline security headers", async () => {
  const response = await request(app).get("/health");

  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-powered-by"], undefined);
});

test("Requests with JSON bodies larger than 1 MB return 413", async () => {
  const response = await request(app)
    .post("/tenants")
    .send({ name: "large-request", extra: "x".repeat(1024 * 1024) });

  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("Malformed JSON returns a structured 400 response", async () => {
  const response = await request(app)
    .post("/tenants")
    .set("Content-Type", "application/json")
    .send("{invalid json");

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_JSON",
      message: "Request body must contain valid JSON",
    },
  });
});

test("Unknown routes return a JSON 404 response", async () => {
  const response = await request(app).get("/does-not-exist");

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  });
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
