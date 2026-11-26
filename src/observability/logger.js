import { stderr, stdout } from "node:process";

function normalizeFields(fields = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      normalized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

function writeLog(level, message, fields) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: "relayforge",
    message,
    ...normalizeFields(fields),
  };

  const line = `${JSON.stringify(record)}\n`;
  (level === "error" ? stderr : stdout).write(line);
}

export const logger = {
  info(message, fields) {
    writeLog("info", message, fields);
  },
  warn(message, fields) {
    writeLog("warn", message, fields);
  },
  error(message, fields) {
    writeLog("error", message, fields);
  },
};
