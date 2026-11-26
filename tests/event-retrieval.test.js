import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { prisma } from "../src/db/prisma.js";
import { createTestTenant } from "./helpers/tenant-auth.js";

test("GET /tenants/:id/events returns only that tenant's events", async () => {
  const { tenant: tenantA, authorization } = await createTestTenant(prisma, "tenant-a");

  const { tenant: tenantB } = await createTestTenant(prisma, "tenant-b");

  try {
    const eventA = await prisma.event.create({
      data: {
        tenantId: tenantA.id,
        eventType: "order.created",
        payload: { orderId: "order-a" },
      },
    });

    await prisma.event.create({
      data: {
        tenantId: tenantB.id,
        eventType: "order.created",
        payload: { orderId: "order-b" },
      },
    });

    const response = await request(app).get(`/tenants/${tenantA.id}/events`).set("authorization", authorization);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.events.length, 1);
    assert.equal(response.body.data.events[0].id, eventA.id);
    assert.equal(response.body.data.events[0].tenantId, tenantA.id);
    assert.deepEqual(response.body.data.events[0].payload, {
      orderId: "order-a",
    });
  } finally {
    await prisma.tenant.deleteMany({
      where: {
        id: { in: [tenantA.id, tenantB.id] },
      },
    });
  }
});

test("GET /tenants/:id/events returns an empty list for a tenant with no events", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "empty-tenant");

  try {
    const response = await request(app).get(`/tenants/${tenant.id}/events`).set("authorization", authorization);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.events, []);
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("GET /tenants/:id/events returns 404 for an unknown tenant", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "known-tenant");
  const response = await request(app).get(`/tenants/${randomUUID()}/events`).set("authorization", authorization);
  await prisma.tenant.deleteMany({ where: { id: tenant.id } });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TENANT_NOT_FOUND");
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
