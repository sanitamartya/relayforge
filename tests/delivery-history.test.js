import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import app from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { createTestTenant } from "./helpers/tenant-auth.js";

test("GET delivery history returns delivery status for an event", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "delivery-history");

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      tenantId: tenant.id,
      url: "https://customer.example.com/webhooks",
    },
  });

  const event = await prisma.event.create({
    data: {
      tenantId: tenant.id,
      eventType: "invoice.created",
      payload: {
        invoiceId: "invoice-123",
      },
    },
  });

  const delivery = await prisma.webhookDelivery.create({
    data: {
      eventId: event.id,
      endpointId: endpoint.id,
      status: "DELIVERED",
      attemptCount: 1,
      lastStatusCode: 200,
      deliveredAt: new Date(),
    },
  });

  try {
    const response = await request(app)
      .get(`/tenants/${tenant.id}/events/${event.id}/deliveries`)
      .set("authorization", authorization);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.deliveries.length, 1);

    const result = response.body.data.deliveries[0];

    assert.equal(result.id, delivery.id);
    assert.equal(result.eventId, event.id);
    assert.equal(result.endpointId, endpoint.id);
    assert.equal(result.endpointUrl, endpoint.url);
    assert.equal(result.status, "DELIVERED");
    assert.equal(result.attemptCount, 1);
    assert.equal(result.lastStatusCode, 200);
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("GET delivery history returns 404 for an event owned by another tenant", async () => {
  const { tenant: tenantA } = await createTestTenant(prisma, "tenant-a");

  const { tenant: tenantB, authorization } = await createTestTenant(prisma, "tenant-b");

  const event = await prisma.event.create({
    data: {
      tenantId: tenantA.id,
      eventType: "invoice.created",
      payload: {},
    },
  });

  try {
    const response = await request(app)
      .get(`/tenants/${tenantB.id}/events/${event.id}/deliveries`)
      .set("authorization", authorization);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "EVENT_NOT_FOUND");
  } finally {
    await prisma.tenant.deleteMany({
      where: {
        id: {
          in: [tenantA.id, tenantB.id],
        },
      },
    });
  }
});

test("GET delivery history paginates records in stable order", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "delivery-pagination");

  try {
    const event = await prisma.event.create({
      data: {
        tenantId: tenant.id,
        eventType: "delivery.pagination",
        payload: {},
      },
    });

    const deliveries = [];

    for (let index = 0; index < 3; index += 1) {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          tenantId: tenant.id,
          url: `https://customer.example.com/pagination-${index}`,
        },
      });

      deliveries.push(
        await prisma.webhookDelivery.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            createdAt: new Date(Date.UTC(2026, 10, 26, 11, 0, index)),
          },
        }),
      );
    }

    const firstPage = await request(app)
      .get(`/tenants/${tenant.id}/events/${event.id}/deliveries?limit=2`)
      .set("authorization", authorization);

    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.data.deliveries.length, 2);
    assert.equal(firstPage.body.data.pagination.hasMore, true);

    const secondPage = await request(app)
      .get(
        `/tenants/${tenant.id}/events/${event.id}/deliveries?limit=2&cursor=${encodeURIComponent(firstPage.body.data.pagination.nextCursor)}`,
      )
      .set("authorization", authorization);

    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.data.deliveries.length, 1);
    assert.equal(secondPage.body.data.pagination.hasMore, false);

    const returnedIds = [
      ...firstPage.body.data.deliveries,
      ...secondPage.body.data.deliveries,
    ].map((delivery) => delivery.id);

    assert.equal(new Set(returnedIds).size, 3);
    assert.deepEqual(returnedIds, deliveries.map((delivery) => delivery.id));
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
