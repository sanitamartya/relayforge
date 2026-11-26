import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { prisma } from "../src/db/prisma.js";
import { hashApiKey } from "../src/security/api-key.js";

test("POST /tenants creates and persists a tenant", async () => {
  const name = `relayforge-test-${randomUUID()}`;
  let tenantId;

  try {
    const response = await request(app).post("/tenants").send({ name });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.name, name);
    assert.equal(typeof response.body.data.id, "string");
    assert.match(response.body.data.apiKey, /^rf_live_[A-Za-z0-9_-]{43}$/);
    assert.equal(typeof response.body.data.createdAt, "string");

    tenantId = response.body.data.id;

    // Verify that the tenant was actually saved in PostgreSQL.
    const savedTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    assert.ok(savedTenant);
    assert.equal(savedTenant.apiKeyHash.length, 64);
    assert.notEqual(savedTenant.apiKeyHash, response.body.data.apiKey);
    assert.equal(savedTenant.apiKeyHash, hashApiKey(response.body.data.apiKey));
    assert.equal(savedTenant.name, name);
  } finally {
    // Keep the test database clean.
    if (tenantId) {
      await prisma.tenant.deleteMany({
        where: { id: tenantId },
      });
    }
  }
});

test("POST /tenants rejects an empty name", async () => {
  const response = await request(app).post("/tenants").send({ name: "   " });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("POST /tenants rejects a missing name", async () => {
  const response = await request(app).post("/tenants").send({});

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
