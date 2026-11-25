import { Worker } from "bullmq";
import { redisConnection } from "../queue/redis-connection.js";

const worker = new Worker(
  "relayforge-event-processing",
  async (job) => {
    console.log("Processing job:", job.id);
    console.log("Job data:", job.data);

    return {
      processed: true,
      jobId: job.id,
    };
  },
  {
    connection: redisConnection,
  },
);

worker.on("completed", (job, result) => {
  console.log("Job completed:", result);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed:`, error.message);
});

console.log("RelayForge event worker is running");

async function shutdown() {
  console.log("Shutting down worker...");
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
