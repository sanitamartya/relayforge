import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

test("POST /tenants/:id/events creates and persists an event", async () => {
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

  try {
    const response = await request(app).post(`/tenants/${tenant.id}/events`).send(eventData);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.tenantId, tenant.id);
    assert.equal(response.body.data.eventType, eventData.eventType);
    assert.deepEqual(response.body.data.payload, eventData.payload);
    assert.equal(typeof response.body.data.id, "string");

    const savedEvent = await prisma.event.findUnique({
      where: { id: response.body.data.id },
    });

    assert.ok(savedEvent);
    assert.equal(savedEvent.tenantId, tenant.id);
    assert.equal(savedEvent.eventType, eventData.eventType);
    assert.deepEqual(savedEvent.payload, eventData.payload);
  } finally {
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
  await prisma.$disconnect();
});
