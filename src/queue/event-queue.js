import { Queue } from "bullmq";
import { redisConnection } from "./redis-connection.js";

export const eventQueue = new Queue("relayforge-event-processing", {
  connection: redisConnection,
});
