import "dotenv/config";
import { URL } from "node:url";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

const parsedRedisUrl = new URL(redisUrl);

if (!["redis:", "rediss:"].includes(parsedRedisUrl.protocol)) {
  throw new Error("REDIS_URL must use redis:// or rediss://");
}

export const redisConnection = {
  host: parsedRedisUrl.hostname,
  port: Number(parsedRedisUrl.port || 6379),
  maxRetriesPerRequest: null,
};

if (parsedRedisUrl.username) {
  redisConnection.username = decodeURIComponent(parsedRedisUrl.username);
}

if (parsedRedisUrl.password) {
  redisConnection.password = decodeURIComponent(parsedRedisUrl.password);
}

if (parsedRedisUrl.pathname.length > 1) {
  redisConnection.db = Number(parsedRedisUrl.pathname.slice(1));
}
