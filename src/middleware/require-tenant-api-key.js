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
    where: {
      apiKeyHash: hashApiKey(apiKey),
    },
    select: {
      id: true,
    },
  });

  if (!tenant) {
    return sendAuthenticationError(res);
  }

  if (tenant.id !== req.params.id) {
    return res.status(403).json({
      error: {
        code: "TENANT_ACCESS_DENIED",
        message: "This API key cannot access the requested tenant",
      },
    });
  }

  req.authTenantId = tenant.id;
  return next();
}
