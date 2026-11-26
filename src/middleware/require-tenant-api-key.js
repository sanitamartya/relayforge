import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { hashApiKey } from "../security/api-key.js";

function sendAuthenticationError(res) {
  return res.status(401).json({
    error: {
      code: "AUTHENTICATION_REQUIRED",
      message: "A valid tenant API key is required",
    },
  });
}

export async function requireTenantApiKey(req, res, next) {
  const authorization = req.get("authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  const apiKey = match?.[1];

  if (!apiKey || apiKey.length > 200) {
    return sendAuthenticationError(res);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      apiKeyHash: true,
    },
  });

  if (!tenant) {
    return res.status(404).json({
      error: {
        code: "TENANT_NOT_FOUND",
        message: "Tenant not found",
      },
    });
  }

  if (!tenant.apiKeyHash) {
    return sendAuthenticationError(res);
  }

  const expectedHash = Buffer.from(tenant.apiKeyHash, "hex");
  const providedHash = Buffer.from(hashApiKey(apiKey), "hex");

  if (expectedHash.length !== providedHash.length || !timingSafeEqual(expectedHash, providedHash)) {
    return sendAuthenticationError(res);
  }

  req.authTenantId = tenant.id;
  return next();
}
