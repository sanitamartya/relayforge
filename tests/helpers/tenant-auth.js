import { randomUUID } from "node:crypto";
import { generateApiKey, hashApiKey } from "../../src/security/api-key.js";

export async function createTestTenant(prisma, namePrefix = "auth-test") {
  const apiKey = generateApiKey();

  const tenant = await prisma.tenant.create({
    data: {
      name: `${namePrefix}-${randomUUID()}`,
      apiKeyHash: hashApiKey(apiKey),
    },
  });

  return {
    tenant,
    apiKey,
    authorization: `Bearer ${apiKey}`,
  };
}
