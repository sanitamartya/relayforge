import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { prisma } from "../src/db/prisma.js";

test("POST /tenants creates and persists a tenant", async () => {
  const name = `relayforge-test-${randomUUID()}`;
  let tenantId;

  try {
    const response = await request(app).post("/tenants").send({ name });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.name, name);
    assert.equal(typeof response.body.data.id, "string");
    assert.equal(typeof response.body.data.createdAt, "string");

    tenantId = response.body.data.id;

    // Verify that the tenant was actually saved in PostgreSQL.
    const savedTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    assert.ok(savedTenant);
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
