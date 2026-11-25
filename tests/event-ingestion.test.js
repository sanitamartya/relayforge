import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { eventQueue } from "../src/queue/event-queue.js";

test("POST /tenants/:id/events creates, persists, and queues an event", async () => {
  const tenant = await prisma.tenant.create({
    data: {
      name: `event-test-${randomUUID()}`,
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
    const response = await request(app).post(`/tenants/${tenant.id}/events`).send(eventData);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.tenantId, tenant.id);
    assert.equal(response.body.data.eventType, eventData.eventType);
    assert.deepEqual(response.body.data.payload, eventData.payload);
    assert.equal(typeof response.body.data.id, "string");

    eventId = response.body.data.id;

    // Verify the event was persisted in PostgreSQL.
    const savedEvent = await prisma.event.findUnique({
      where: { id: eventId },
    });

    assert.ok(savedEvent);
    assert.equal(savedEvent.tenantId, tenant.id);
    assert.equal(savedEvent.eventType, eventData.eventType);
    assert.deepEqual(savedEvent.payload, eventData.payload);

    // Verify a BullMQ job was created for the event.
    const queuedJob = await eventQueue.getJob(eventId);

    assert.ok(queuedJob);
    assert.equal(queuedJob.name, "process-event");
    assert.equal(queuedJob.id, eventId);
    assert.deepEqual(queuedJob.data, {
      eventId,
      tenantId: tenant.id,
      eventType: eventData.eventType,
      payload: eventData.payload,
    });
  } finally {
    // Remove the test job if it still exists.
    if (eventId) {
      const queuedJob = await eventQueue.getJob(eventId);

      if (queuedJob) {
        await queuedJob.remove();
      }
    }

    // Tenant deletion cascades to its events.
    await prisma.tenant.deleteMany({
      where: { id: tenant.id },
    });
  }
});

test("POST /tenants/:id/events returns 404 for an unknown tenant", async () => {
  const unknownTenantId = randomUUID();

  const response = await request(app)
    .post(`/tenants/${unknownTenantId}/events`)
    .send({
      eventType: "user.created",
      payload: { userId: "user-123" },
    });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TENANT_NOT_FOUND");
});

test("POST /tenants/:id/events rejects a missing event type", async () => {
  const tenant = await prisma.tenant.create({
    data: {
      name: `event-test-${randomUUID()}`,
    },
  });

  try {
    const response = await request(app)
      .post(`/tenants/${tenant.id}/events`)
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
  const tenant = await prisma.tenant.create({
    data: {
      name: `event-test-${randomUUID()}`,
    },
  });

  try {
    const response = await request(app).post(`/tenants/${tenant.id}/events`).send({
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
  await prisma.$disconnect();
});
