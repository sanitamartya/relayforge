import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const kafkaClientModule = fileURLToPath(
  import.meta.resolve("../src/kafka/kafka-client.js"),
);

function runKafkaClientModule({ brokers, clientId } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "relayforge-kafka-client-"));

  try {
    const env = { ...process.env };
    delete env.KAFKA_BROKERS;
    delete env.KAFKA_CLIENT_ID;

    if (brokers !== undefined) {
      env.KAFKA_BROKERS = brokers;
    }

    if (clientId !== undefined) {
      env.KAFKA_CLIENT_ID = clientId;
    }

    const script = `import(${JSON.stringify(kafkaClientModule)})
      .then(() => {
        console.log("Kafka client module loaded");
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });`;

    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env,
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("Kafka client config rejects missing KAFKA_BROKERS", () => {
  const result = runKafkaClientModule({ clientId: "relayforge-test" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /KAFKA_BROKERS is not configured/);
});

test("Kafka client config rejects missing KAFKA_CLIENT_ID", () => {
  const result = runKafkaClientModule({ brokers: "localhost:9092" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /KAFKA_CLIENT_ID is not configured/);
});

test("Kafka client config rejects a broker list containing only empty entries", () => {
  const result = runKafkaClientModule({
    brokers: " , , ",
    clientId: "relayforge-test",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /KAFKA_BROKERS must contain at least one broker/);
});

test("Kafka client config accepts and normalizes a comma-separated broker list", () => {
  const result = runKafkaClientModule({
    brokers: " broker-a:9092, , broker-b:9093 ",
    clientId: "relayforge-test",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Kafka client module loaded/);
});
