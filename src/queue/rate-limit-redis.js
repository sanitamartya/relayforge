import Redis from "ioredis";
import { redisConnection } from "./redis-connection.js";

export const rateLimitRedis = new Redis({
  ...redisConnection,
  maxRetriesPerRequest: 1,
});

rateLimitRedis.on("ready", () => {
  rateLimitRedis.connector.stream.unref();
});
