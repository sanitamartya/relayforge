import { createHash, randomBytes } from "node:crypto";

const API_KEY_PREFIX = "rf_live_";

export function generateApiKey() {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}
