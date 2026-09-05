// Generic LLM client — backed by Groq's free-tier, OpenAI-compatible chat
// completions API (console.groq.com). Every customer-facing text generation
// call in this codebase goes through here, and a missing key, a timeout, a
// rate limit, or a malformed response all resolve the same way: return
// `null`. Callers always keep their deterministic template as a fallback
// (see voiceScript.ts, actions/index.ts), so an LLM outage can never break a
// recovery cycle or block a payment reminder from going out.
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// Groq's lineup shifts over time — verified against /v1/models for this key
// at integration time. compound-mini returns clean final text (no leaked
// <think> tags or truncated-by-reasoning-budget empty replies, unlike the
// raw gpt-oss/qwen reasoning models also available), which is what every
// caller here actually needs.
const DEFAULT_MODEL = "groq/compound-mini";
const TIMEOUT_MS = 8000;

export async function generateText(params: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.prompt },
        ],
        max_tokens: params.maxTokens ?? 220,
        temperature: 0.6,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
