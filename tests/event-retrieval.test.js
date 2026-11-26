import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { URLSearchParams } from "node:url";

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

    const response = await request(app)
      .get(`/tenants/${tenantA.id}/events`)
      .set("authorization", authorization);

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

test("GET events returns an empty page", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "empty-tenant");

  try {
    const response = await request(app)
      .get(`/tenants/${tenant.id}/events`)
      .set("authorization", authorization);

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
  const response = await request(app)
    .get(`/tenants/${randomUUID()}/events`)
    .set("authorization", authorization);
  await prisma.tenant.deleteMany({ where: { id: tenant.id } });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TENANT_NOT_FOUND");
});

test("GET events paginates without duplicate or missing records", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "event-pagination");
  const createdEvents = [];

  try {
    for (let index = 0; index < 3; index += 1) {
      createdEvents.push(
        await prisma.event.create({
          data: {
            tenantId: tenant.id,
            eventType: "pagination.test",
            payload: { index },
            createdAt: new Date(Date.UTC(2026, 10, 26, 10, 0, index)),
          },
        }),
      );
    }

    const firstPage = await request(app)
      .get(`/tenants/${tenant.id}/events?limit=2`)
      .set("authorization", authorization);

    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.data.events.length, 2);
    assert.equal(firstPage.body.data.pagination.hasMore, true);
    assert.ok(firstPage.body.data.pagination.nextCursor);

    const nextPageQuery = new URLSearchParams({
      limit: "2",
      cursor: firstPage.body.data.pagination.nextCursor,
    });
    const path = `/tenants/${tenant.id}/events`;
    const secondPage = await request(app)
      .get(`${path}?${nextPageQuery}`)
      .set("authorization", authorization);

    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.data.events.length, 1);
    assert.equal(secondPage.body.data.pagination.hasMore, false);
    assert.equal(secondPage.body.data.pagination.nextCursor, null);

    const returnedIds = [...firstPage.body.data.events, ...secondPage.body.data.events].map(
      (event) => event.id,
    );

    assert.equal(new Set(returnedIds).size, 3);
    assert.deepEqual(
      returnedIds,
      createdEvents
        .slice()
        .reverse()
        .map((event) => event.id),
    );
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("GET events rejects an invalid pagination limit", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "event-pagination-invalid");

  try {
    const response = await request(app)
      .get(`/tenants/${tenant.id}/events?limit=101`)
      .set("authorization", authorization);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
