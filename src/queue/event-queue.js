import { Queue } from "bullmq";
import { redisConnection } from "./redis-connection.js";

export const eventQueue = new Queue("relayforge-event-processing", {
  connection: redisConnection,
});

export const deliveryJobOptions = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 1000,
  },
  removeOnComplete: {
    age: 86400,
    count: 1000,
  },
  removeOnFail: true,
};
