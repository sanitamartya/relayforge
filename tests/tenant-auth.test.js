import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import app from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { hashApiKey } from "../src/security/api-key.js";

test("tenant API routes require a valid tenant bearer key", async () => {
  const created = await request(app).post("/tenants").send({
    name: "api-key-auth-test",
  });

  assert.equal(created.status, 201);
  const tenantId = created.body.data.id;
  const apiKey = created.body.data.apiKey;

  try {
    const missingKey = await request(app).get(`/tenants/${tenantId}`);
    assert.equal(missingKey.status, 401);
    assert.equal(missingKey.body.error.code, "AUTHENTICATION_REQUIRED");

    const invalidKey = await request(app)
      .get(`/tenants/${tenantId}`)
      .set("authorization", "Bearer rf_live_invalid");
    assert.equal(invalidKey.status, 401);

    const authenticated = await request(app)
      .get(`/tenants/${tenantId}`)
      .set("authorization", `Bearer ${apiKey}`);

    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.body.data.id, tenantId);
    assert.equal("apiKey" in authenticated.body.data, false);

    const savedTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    assert.equal(savedTenant.apiKeyHash, hashApiKey(apiKey));
    assert.notEqual(savedTenant.apiKeyHash, apiKey);
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: tenantId },
    });
  }
});

test("tenant API key cannot authenticate against a different tenant", async () => {
  const first = await request(app).post("/tenants").send({ name: "tenant-auth-first" });
  const second = await request(app).post("/tenants").send({ name: "tenant-auth-second" });

  try {
    const response = await request(app)
      .get(`/tenants/${second.body.data.id}`)
      .set("authorization", `Bearer ${first.body.data.apiKey}`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
  } finally {
    await prisma.tenant.deleteMany({
      where: {
        id: {
          in: [first.body.data.id, second.body.data.id],
        },
      },
    });
  }
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
