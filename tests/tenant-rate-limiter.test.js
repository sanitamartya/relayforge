import test from "node:test";
import assert from "node:assert/strict";
import { createTenantRateLimiter } from "../src/middleware/tenant-rate-limiter.js";

function createFakeRedis() {
  const counts = new Map();
  return {
    async eval(_script, _keyCount, key, _limit, windowMs) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return [count, windowMs, 1_800_000_000];
    },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(middleware, tenantId) {
  const req = { authTenantId: tenantId };
  const res = createResponse();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test("tenant rate limiter allows requests up to the configured limit", async () => {
  const redis = createFakeRedis();
  const middleware = createTenantRateLimiter({
    getRedisClient: async () => redis, limit: 2, windowMs: 60_000,
  });
  const first = await invoke(middleware, "tenant-one");
  const second = await invoke(middleware, "tenant-one");
  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(second.res.headers["RateLimit-Limit"], "2");
  assert.equal(second.res.headers["RateLimit-Remaining"], "0");
});

test("tenant rate limiter returns 429 and Retry-After after the limit", async () => {
  const redis = createFakeRedis();
  const middleware = createTenantRateLimiter({
    getRedisClient: async () => redis, limit: 1, windowMs: 60_000,
  });
  await invoke(middleware, "tenant-one");
  const limited = await invoke(middleware, "tenant-one");
  assert.equal(limited.nextCalled, false);
  assert.equal(limited.res.statusCode, 429);
  assert.equal(limited.res.headers["Retry-After"], "60");
  assert.equal(limited.res.body.error.code, "RATE_LIMIT_EXCEEDED");
});

test("each tenant has an independent rate limit", async () => {
  const redis = createFakeRedis();
  const middleware = createTenantRateLimiter({
    getRedisClient: async () => redis, limit: 1, windowMs: 60_000,
  });
  await invoke(middleware, "tenant-one");
  const tenantOneLimited = await invoke(middleware, "tenant-one");
  const tenantTwoAllowed = await invoke(middleware, "tenant-two");
  assert.equal(tenantOneLimited.res.statusCode, 429);
  assert.equal(tenantTwoAllowed.nextCalled, true);
});

test("tenant rate limiter fails closed when Redis is unavailable", async () => {
  const middleware = createTenantRateLimiter({
    getRedisClient: async () => { throw new Error("Redis unavailable"); },
    limit: 5, windowMs: 60_000,
  });
  const result = await invoke(middleware, "tenant-one");
  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.res.body.error.code, "RATE_LIMITER_UNAVAILABLE");
});

test("tenant rate limiter rejects requests without authenticated tenant context", async () => {
  const middleware = createTenantRateLimiter({
    getRedisClient: async () => createFakeRedis(), limit: 5, windowMs: 60_000,
  });
  const result = await invoke(middleware, undefined);
  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.res.body.error.code, "AUTHENTICATION_REQUIRED");
});
