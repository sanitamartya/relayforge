const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5:3b";
const DEFAULT_TIMEOUT_MS = 2500;

export function createOllamaProvider({
  baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL,
  model = process.env.OLLAMA_MODEL || DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.AI_OPERATIONS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
} = {}) {
  return {
    name: "ollama",
    async generate(prompt) {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are RelayForge's read-only webhook operations assistant. Summarize only the supplied operational facts. Do not invent numbers, statuses, causes, or actions. If the facts do not establish a cause, say so. Keep the answer concise and never claim to have changed anything.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          stream: false,
          options: {
            temperature: 0.1,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Local model returned HTTP ${response.status}`);
      }

      const result = await response.json();
      const content = result?.message?.content;

      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("Local model returned an empty response");
      }

      return content.trim();
    },
  };
}
