import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { prisma } from "../src/db/prisma.js";

test("GET /tenants/:id/events returns only that tenant's events", async () => {
  const tenantA = await prisma.tenant.create({
    data: { name: `tenant-a-${randomUUID()}` },
  });

  const tenantB = await prisma.tenant.create({
    data: { name: `tenant-b-${randomUUID()}` },
  });

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

    const response = await request(app).get(`/tenants/${tenantA.id}/events`);

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
  const tenant = await prisma.tenant.create({
    data: { name: `empty-tenant-${randomUUID()}` },
  });

  try {
    const response = await request(app).get(`/tenants/${tenant.id}/events`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.events, []);
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("GET /tenants/:id/events returns 404 for an unknown tenant", async () => {
  const response = await request(app).get(`/tenants/${randomUUID()}/events`);

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TENANT_NOT_FOUND");
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
