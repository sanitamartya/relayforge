import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import app from "../src/app.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { prisma } from "../src/db/prisma.js";
import { createTestTenant } from "./helpers/tenant-auth.js";

let tenantId;
let authorization;

before(async () => {
  const result = await createTestTenant(prisma, "webhook-endpoint-test");
  tenantId = result.tenant.id;
  authorization = result.authorization;
});

test("POST /tenants/:id/webhook-endpoints registers and persists an endpoint", async () => {
  const url = "https://customer.example.com/webhooks";

  const response = await request(app)
    .post(`/tenants/${tenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({ url });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.tenantId, tenantId);
  assert.equal(response.body.data.url, url);
  assert.equal(response.body.data.enabled, true);
  assert.equal(typeof response.body.data.id, "string");
  assert.equal(typeof response.body.data.createdAt, "string");

  const savedEndpoint = await prisma.webhookEndpoint.findUnique({
    where: { id: response.body.data.id },
  });

  assert.ok(savedEndpoint);
  assert.equal(savedEndpoint.tenantId, tenantId);
  assert.equal(savedEndpoint.url, url);
});

test("POST /tenants/:id/webhook-endpoints rejects a missing URL", async () => {
  const response = await request(app)
    .post(`/tenants/${tenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({});

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("POST /tenants/:id/webhook-endpoints rejects an invalid URL", async () => {
  const response = await request(app)
    .post(`/tenants/${tenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({ url: "not-a-valid-url" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("POST /tenants/:id/webhook-endpoints rejects unsupported protocols", async () => {
  const response = await request(app)
    .post(`/tenants/${tenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({ url: "ftp://customer.example.com/webhooks" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("POST /tenants/:id/webhook-endpoints rejects private IP destinations", async () => {
  const response = await request(app)
    .post(`/tenants/${tenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({ url: "http://169.254.169.254/latest/meta-data/" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("POST /tenants/:id/webhook-endpoints rejects localhost destinations", async () => {
  const response = await request(app)
    .post(`/tenants/${tenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({ url: "http://localhost:8080/webhook" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("POST /tenants/:id/webhook-endpoints rejects URLs with credentials", async () => {
  const response = await request(app)
    .post(`/tenants/${tenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({ url: "https://user:password@customer.example.com/webhooks" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("POST /tenants/:id/webhook-endpoints returns 404 for an unknown tenant", async () => {
  const unknownTenantId = randomUUID();

  const response = await request(app)
    .post(`/tenants/${unknownTenantId}/webhook-endpoints`)
    .set("authorization", authorization)
    .send({ url: "https://customer.example.com/webhooks" });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TENANT_NOT_FOUND");
});

after(async () => {
  if (tenantId) {
    await prisma.tenant.deleteMany({
      where: { id: tenantId },
    });
  }

  await eventQueue.close();
  await prisma.$disconnect();
});
