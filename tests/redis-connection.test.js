import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const redisConnectionModule = fileURLToPath(
  new URL("../src/queue/redis-connection.js", import.meta.url),
);

function runRedisConnectionModule(redisUrl) {
  const cwd = mkdtempSync(join(tmpdir(), "relayforge-redis-connection-"));

  try {
    const env = { ...process.env };
    delete env.REDIS_URL;

    if (redisUrl !== undefined) {
      env.REDIS_URL = redisUrl;
    }

    const script = `import(${JSON.stringify(redisConnectionModule)})
      .then(({ redisConnection }) => {
        console.log(JSON.stringify(redisConnection));
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });`;

    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env,
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("redis connection config rejects a missing REDIS_URL", () => {
  const result = runRedisConnectionModule();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /REDIS_URL is not configured/);
});

test("redis connection config rejects unsupported URL protocols", () => {
  const result = runRedisConnectionModule("http://redis.example.com");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /REDIS_URL must use redis:\/\/ or rediss:\/\//);
});

test("redis connection config rejects malformed URLs", () => {
  const result = runRedisConnectionModule("not-a-valid-url");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid URL/);
});

test("redis connection config parses host, port, credentials, and database", () => {
  const result = runRedisConnectionModule("rediss://redis%20user:p%40ss@redis.example.com:6380/4");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    host: "redis.example.com",
    port: 6380,
    maxRetriesPerRequest: null,
    username: "redis user",
    password: "p@ss",
    db: 4,
  });
});

test("redis connection config uses the default port and omits optional fields", () => {
  const result = runRedisConnectionModule("redis://redis.example.com");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    host: "redis.example.com",
    port: 6379,
    maxRetriesPerRequest: null,
  });
});
