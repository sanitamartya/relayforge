import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { rateLimitRedis } from "../src/queue/rate-limit-redis.js";
import { disconnectKafkaProducer } from "../src/kafka/event-producer.js";
import { createTestTenant } from "./helpers/tenant-auth.js";

test("POST /tenants/:id/events creates an event, delivery, and outbox record", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "event-test");

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      tenantId: tenant.id,
      url: "https://customer.example.com/webhooks",
    },
  });

  const eventData = {
    eventType: "user.created",
    payload: {
      userId: "user-123",
      email: "user@example.com",
    },
  };

  let eventId;

  try {
    const response = await request(app)
      .post(`/tenants/${tenant.id}/events`)
      .set("authorization", authorization)
      .send(eventData);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.tenantId, tenant.id);
    assert.equal(response.body.data.eventType, eventData.eventType);
    assert.deepEqual(response.body.data.payload, eventData.payload);
    assert.equal(response.body.data.deliveryCount, 1);

    eventId = response.body.data.id;

    const savedEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });

    assert.ok(savedEvent);
    assert.equal(savedEvent.tenantId, tenant.id);
    assert.equal(savedEvent.eventType, eventData.eventType);
    assert.deepEqual(savedEvent.payload, eventData.payload);

    const savedDelivery = await prisma.webhookDelivery.findFirst({
      where: {
        eventId,
        endpointId: endpoint.id,
      },
    });

    assert.ok(savedDelivery);
    assert.equal(savedDelivery.status, "PENDING");
    assert.equal(savedDelivery.attemptCount, 0);

    const savedOutbox = await prisma.eventOutbox.findUnique({
      where: { eventId },
    });

    assert.ok(savedOutbox);
    assert.equal(savedOutbox.status, "PENDING");
    assert.equal(savedOutbox.attemptCount, 0);
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("POST /tenants/:id/events returns 404 for an unknown tenant", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "known-tenant");
  const response = await request(app)
    .post(`/tenants/${randomUUID()}/events`)
    .set("authorization", authorization)
    .send({
      eventType: "user.created",
      payload: { userId: "user-123" },
    });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TENANT_NOT_FOUND");
  await prisma.tenant.deleteMany({ where: { id: tenant.id } });
});

test("POST /tenants/:id/events rejects a missing event type", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "event-test");

  try {
    const response = await request(app)
      .post(`/tenants/${tenant.id}/events`)
      .set("authorization", authorization)
      .send({
        payload: { userId: "user-123" },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "VALIDATION_ERROR");
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("POST /tenants/:id/events rejects a non-object payload", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "event-test");

  try {
    const response = await request(app)
      .post(`/tenants/${tenant.id}/events`)
      .set("authorization", authorization)
      .send({
        eventType: "user.created",
        payload: "not-an-object",
      });

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
  await disconnectKafkaProducer();
  await rateLimitRedis.quit();
  await prisma.$disconnect();
});

test("POST /tenants/:id/events creates an outbox record when no enabled endpoints exist", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "event-no-endpoints");

  try {
    await prisma.webhookEndpoint.create({
      data: {
        tenantId: tenant.id,
        url: "https://customer.example.com/disabled-webhook",
        enabled: false,
      },
    });

    const response = await request(app)
      .post(`/tenants/${tenant.id}/events`)
      .set("authorization", authorization)
      .send({
        eventType: "user.created",
        payload: { userId: "user-no-endpoint" },
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.deliveryCount, 0);

    const eventId = response.body.data.id;
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { eventId },
    });
    const outbox = await prisma.eventOutbox.findUnique({
      where: { eventId },
    });

    assert.equal(deliveries.length, 0);
    assert.ok(outbox);
    assert.equal(outbox.status, "PENDING");
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("POST /tenants/:id/events creates one pending delivery per enabled endpoint", async () => {
  const { tenant, authorization } = await createTestTenant(prisma, "event-fanout");

  try {
    const enabledEndpoints = await Promise.all(
      ["https://customer.example.com/webhook-a", "https://customer.example.com/webhook-b"].map(
        (url) =>
          prisma.webhookEndpoint.create({
            data: {
              tenantId: tenant.id,
              url,
              enabled: true,
            },
          }),
      ),
    );

    await prisma.webhookEndpoint.create({
      data: {
        tenantId: tenant.id,
        url: "https://customer.example.com/disabled-webhook",
        enabled: false,
      },
    });

    const response = await request(app)
      .post(`/tenants/${tenant.id}/events`)
      .set("authorization", authorization)
      .send({
        eventType: "user.created",
        payload: { userId: "user-fanout" },
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.deliveryCount, 2);

    const eventId = response.body.data.id;
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { eventId },
      orderBy: { endpointId: "asc" },
    });

    assert.equal(deliveries.length, 2);
    assert.deepEqual(
      deliveries.map((delivery) => delivery.endpointId).sort(),
      enabledEndpoints.map((endpoint) => endpoint.id).sort(),
    );
    assert.ok(deliveries.every((delivery) => delivery.status === "PENDING"));
    assert.ok(deliveries.every((delivery) => delivery.attemptCount === 0));

    const outbox = await prisma.eventOutbox.findUnique({
      where: { eventId },
    });

    assert.ok(outbox);
    assert.equal(outbox.status, "PENDING");
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});
