import { createOllamaProvider } from "./ollama-provider.js";

// Keep the assistant dependent on a small provider interface so the model
// runtime can be replaced without changing operational-data retrieval.
export function createModelProvider() {
  const providerName = (process.env.AI_PROVIDER || "ollama").toLowerCase();

  if (providerName === "ollama") {
    return createOllamaProvider();
  }

  throw new Error(`Unsupported AI_PROVIDER: ${providerName}`);
}
