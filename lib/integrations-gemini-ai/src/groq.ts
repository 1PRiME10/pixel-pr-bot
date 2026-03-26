/**
 * Groq AI fallback — free tier: 14,400 req/day, ultra-fast inference.
 * Uses Groq's OpenAI-compatible REST API (no extra npm package needed).
 * Models used (both free):
 *   llama-3.3-70b-versatile  → high quality, main choice
 *   llama-3.1-8b-instant     → fast fallback if 70b rate-limited
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS  = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] as const;

const groqKey = process.env.GROQ_API_KEY;

export const GROQ_AVAILABLE = !!groqKey;

// Per-model cooldown (ms timestamp)
const groqCooldown = new Map<string, number>();

function groqCooling(model: string): boolean {
  return Date.now() < (groqCooldown.get(model) ?? 0);
}

/** Convert Gemini-style contents array → OpenAI messages array */
function toOpenAIMessages(contents: any[]): { role: string; content: string }[] {
  return contents.map((c) => {
    const role   = c.role === "model" ? "assistant" : (c.role ?? "user");
    const text   = Array.isArray(c.parts)
      ? c.parts.map((p: any) => p.text ?? "").join("")
      : String(c.content ?? "");
    return { role, content: text };
  });
}

/**
 * Try Groq as a fallback when all Gemini models are exhausted.
 * Accepts the same `contents` format as Gemini so callers don't need to change.
 */
export async function generateWithGroq(opts: {
  contents: any[];
  maxOutputTokens?: number;
}): Promise<string | null> {
  if (!groqKey) return null;

  const messages = toOpenAIMessages(opts.contents);
  const maxTokens = Math.min(opts.maxOutputTokens ?? 4096, 8192);

  for (const model of GROQ_MODELS) {
    if (groqCooling(model)) continue;

    try {
      const res = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${groqKey}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 429) {
        // Rate limited — cool this model down for 60s
        groqCooldown.set(model, Date.now() + 60_000);
        console.warn(`[Groq] ${model} rate-limited — cooldown 60s`);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[Groq] ${model} error ${res.status}: ${body.slice(0, 200)}`);
        continue;
      }

      const data = await res.json() as any;
      const text  = data?.choices?.[0]?.message?.content?.trim() ?? null;
      if (text) {
        console.log(`[Groq] Response from ${model} (${text.length} chars)`);
        return text;
      }
    } catch (err) {
      console.warn(`[Groq] ${model} fetch error:`, err);
    }
  }

  console.error("[Groq] All Groq models failed — no response");
  return null;
}
