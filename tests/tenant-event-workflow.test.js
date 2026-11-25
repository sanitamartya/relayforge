import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { prisma } from "../src/db/prisma.js";

test("tenant can create and retrieve an event through the API", async () => {
  const tenantName = `workflow-test-${randomUUID()}`;
  let tenantId;

  try {
    // Step 1: Create a tenant through the API.
    const tenantResponse = await request(app).post("/tenants").send({ name: tenantName });

    assert.equal(tenantResponse.status, 201);
    assert.equal(tenantResponse.body.data.name, tenantName);

    tenantId = tenantResponse.body.data.id;

    // Step 2: Submit an event for that tenant.
    const eventData = {
      eventType: "order.created",
      payload: {
        orderId: "order-123",
        amount: 499,
      },
    };

    const eventResponse = await request(app).post(`/tenants/${tenantId}/events`).send(eventData);

    assert.equal(eventResponse.status, 201);
    assert.equal(eventResponse.body.data.tenantId, tenantId);
    assert.equal(eventResponse.body.data.eventType, eventData.eventType);
    assert.deepEqual(eventResponse.body.data.payload, eventData.payload);

    const eventId = eventResponse.body.data.id;

    // Step 3: Retrieve the tenant's events through the API.
    const eventsResponse = await request(app).get(`/tenants/${tenantId}/events`);

    assert.equal(eventsResponse.status, 200);
    assert.equal(eventsResponse.body.data.events.length, 1);

    const retrievedEvent = eventsResponse.body.data.events[0];

    assert.equal(retrievedEvent.id, eventId);
    assert.equal(retrievedEvent.tenantId, tenantId);
    assert.equal(retrievedEvent.eventType, eventData.eventType);
    assert.deepEqual(retrievedEvent.payload, eventData.payload);
  } finally {
    // Remove test data. Tenant deletion cascades to its events.
    if (tenantId) {
      await prisma.tenant.deleteMany({
        where: { id: tenantId },
      });
    }
  }
});

after(async () => {
  await prisma.$disconnect();
});
