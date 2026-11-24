import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db/prisma.js";

test("database connection works", async () => {
  const result = await prisma.$queryRaw`SELECT 1 AS connected`;

  assert.equal(result[0].connected, 1);
});

after(async () => {
  await prisma.$disconnect();
});
