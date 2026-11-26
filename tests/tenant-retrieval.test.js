import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { prisma } from "../src/db/prisma.js";
import { createTestTenant } from "./helpers/tenant-auth.js";

test("GET /tenants/:id returns an existing tenant", async () => {
  const name = `relayforge-test-${randomUUID()}`;

  const { tenant, authorization } = await createTestTenant(prisma, name);

  try {
    const response = await request(app)
      .get(`/tenants/${tenant.id}`)
      .set("authorization", authorization);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, tenant.id);
    assert.equal(response.body.data.name, tenant.name);
    assert.equal(typeof response.body.data.createdAt, "string");
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("GET /tenants/:id returns 404 for an unknown tenant", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "known-tenant");
  const unknownId = randomUUID();

  const response = await request(app)
    .get(`/tenants/${unknownId}`)
    .set("authorization", authorization);
  await prisma.tenant.deleteMany({ where: { id: tenant.id } });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TENANT_NOT_FOUND");
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
