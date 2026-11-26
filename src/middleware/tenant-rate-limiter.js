import "dotenv/config";

const DEFAULT_LIMIT = 100;
const DEFAULT_WINDOW_MS = 60_000;

function readPositiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const configuredLimit = readPositiveInteger("TENANT_RATE_LIMIT_MAX", DEFAULT_LIMIT);
const configuredWindowMs = readPositiveInteger("TENANT_RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS);

const incrementTenantWindowScript = `
local time = redis.call("TIME")
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local windowMs = tonumber(ARGV[2])
local bucket = math.floor(nowMs / windowMs)
local key = KEYS[1] .. ":" .. bucket
local count = redis.call("INCR", key)
if count == 1 then
  redis.call("PEXPIRE", key, windowMs * 2)
end
local resetMs = windowMs - (nowMs % windowMs)
return { count, resetMs, tonumber(time[1]) }
`;

export function createTenantRateLimiter({
  getRedisClient,
  limit = configuredLimit,
  windowMs = configuredWindowMs,
}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Rate limit must be a positive integer");
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("Rate limit window must be a positive integer");
  }

  return async function tenantRateLimiter(req, res, next) {
    const tenantId = req.authTenantId;
    if (!tenantId) {
      return res.status(401).json({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Tenant authentication is required",
        },
      });
    }

    try {
      const redis = await getRedisClient();
      const result = await redis.eval(
        incrementTenantWindowScript,
        1,
        `relayforge:rate-limit:tenant:${tenantId}`,
        limit,
        windowMs,
      );
      const [count, resetMs, nowSeconds] = result.map(Number);
      const retryAfterSeconds = Math.max(1, Math.ceil(resetMs / 1000));
      const remaining = Math.max(0, limit - count);

      res.setHeader("RateLimit-Limit", String(limit));
      res.setHeader("RateLimit-Remaining", String(remaining));
      res.setHeader("RateLimit-Reset", String(nowSeconds + retryAfterSeconds));

      if (count > limit) {
        res.setHeader("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Try again after the rate limit resets.",
          },
        });
      }
      return next();
    } catch {
      return res.status(503).json({
        error: {
          code: "RATE_LIMITER_UNAVAILABLE",
          message: "Request rate limiting is temporarily unavailable",
        },
      });
    }
  };
}
