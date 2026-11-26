import { prisma } from "../src/db/prisma.js";
import { generateApiKey, hashApiKey } from "../src/security/api-key.js";

const tenantId = process.argv[2];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

try {
  if (!tenantId || !uuidPattern.test(tenantId)) {
    throw new Error("Usage: npm run tenant:key:rotate -- <tenant-uuid>");
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });

  if (!tenant) {
    throw new Error("Tenant not found");
  }

  const apiKey = generateApiKey();

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      apiKeyHash: hashApiKey(apiKey),
    },
  });

  console.log("Tenant API key rotated. Copy it now; it cannot be retrieved later:");
  console.log(apiKey);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
