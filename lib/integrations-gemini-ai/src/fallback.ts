/**
 * Model fallback chain with circuit breaker + dual-key round-robin.
 *
 * Priority order (fastest first):
 *   1. Groq  llama-3.3-70b   → ultra-fast inference, 14,400 req/day free
 *   2. Groq  llama-3.1-8b    → fastest Groq fallback
 *   3. gemini-1.5-flash      → 15 RPM, 1500 RPD (Gemini fallback)
 *   4. gemini-1.5-flash-8b   → 30 RPM, 1500 RPD
 *   5. gemini-2.0-flash      → 15 RPM,  200 RPD
 *   6. gemini-2.5-flash      → 10 RPM,   20 RPD  ← last resort
 *
 * With DUAL Gemini keys (GOOGLE_AI_KEY + GEMINI_KEY), effective quota doubles.
 */

import { ai, ai2 } from "./client.js";
import { generateWithGroq, GROQ_AVAILABLE } from "./groq.js";

export const FALLBACK_MODELS = [
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
] as const;

export type FallbackModel = (typeof FALLBACK_MODELS)[number];

// ── Per-model, per-key circuit breaker ────────────────────────────────────────
// Key: `${model}:${keyIndex}` → cooldown timestamp
const cooldownUntil = new Map<string, number>();

function ckKey(model: string, ki: number) { return `${model}:${ki}`; }

function isRateLimited(err: unknown): boolean {
  return (err as any)?.status === 429;
}

function isDailyExhausted(err: unknown): boolean {
  try {
    const details = (err as any)?.errorDetails as any[] | undefined;
    if (!details) return false;
    for (const d of details) {
      for (const v of (d?.violations ?? []) as any[]) {
        if (typeof v?.quotaId === "string" && v.quotaId.includes("PerDay")) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

function setCooldown(model: string, ki: number, err: unknown): void {
  let secs: number;
  if (isDailyExhausted(err)) {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    secs = Math.ceil((midnight.getTime() - now.getTime()) / 1000);
    console.warn(`[AI] ${model}:key${ki} daily quota exhausted — cooldown ${secs}s`);
  } else {
    secs = 60;
    console.warn(`[AI] ${model}:key${ki} rate-limited — cooldown 60s`);
  }
  cooldownUntil.set(ckKey(model, ki), Date.now() + secs * 1000);
}

function isCoolingDown(model: string, ki: number): boolean {
  return Date.now() < (cooldownUntil.get(ckKey(model, ki)) ?? 0);
}

// ── Core: generate with model fallback + dual-key round-robin ─────────────────
export interface FallbackOptions {
  contents: any[];
  maxOutputTokens?: number;
  models?: readonly string[];
}

const clients = [ai, ...(ai2 ? [ai2] : [])];

async function tryChainOnce(opts: FallbackOptions): Promise<{ text: string | null; lastErr: unknown }> {
  const chain = opts.models ?? FALLBACK_MODELS;
  let lastErr: unknown;

  for (const model of chain) {
    for (let ki = 0; ki < clients.length; ki++) {
      if (isCoolingDown(model, ki)) continue;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await clients[ki].models.generateContent({
            model,
            contents: opts.contents,
            config: { maxOutputTokens: opts.maxOutputTokens ?? 4096 },
          });
          return { text: res.text?.trim() ?? null, lastErr: null };
        } catch (err) {
          lastErr = err;
          if (isRateLimited(err)) {
            setCooldown(model, ki, err);
            break;
          }
          if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
  }
  return { text: null, lastErr };
}

export async function generateWithFallback(opts: FallbackOptions): Promise<string | null> {
  // ── 1. Groq first — ultra-fast inference (14,400 req/day free) ───────────────
  // Try Groq before Gemini when available; it responds 3-5× faster on average.
  // Falls through silently to Gemini if Groq is rate-limited or unavailable.
  if (GROQ_AVAILABLE) {
    const groqText = await generateWithGroq({
      contents:        opts.contents,
      maxOutputTokens: opts.maxOutputTokens,
    });
    if (groqText) return groqText;
    console.warn("[AI] Groq unavailable or rate-limited — falling back to Gemini...");
  }

  // ── 2. Gemini fallback chain ──────────────────────────────────────────────────
  const first = await tryChainOnce(opts);
  if (first.text !== null) return first.text;

  // All Gemini models hit RPM cooldown — wait 15s and retry ONCE before giving up.
  const anyRpmCooldown = (opts.models ?? FALLBACK_MODELS).some(
    (m) => clients.some((_, ki) => {
      const t = cooldownUntil.get(ckKey(m, ki)) ?? 0;
      const remaining = t - Date.now();
      return remaining > 0 && remaining < 90_000; // RPM cooldown (≤90s), not daily
    })
  );

  if (anyRpmCooldown) {
    console.warn("[AI] All Gemini models on RPM cooldown — waiting 15s before retry...");
    await new Promise((r) => setTimeout(r, 15_000));
    const second = await tryChainOnce(opts);
    if (second.text !== null) return second.text;
  }

  console.error("[AI] All models (Groq + Gemini) exhausted:", (first.lastErr as any)?.message ?? first.lastErr);
  return null;
}

// ── Convenience: single-turn text prompt ─────────────────────────────────────
export async function promptAI(
  text: string,
  opts?: { maxOutputTokens?: number; models?: readonly string[] }
): Promise<string | null> {
  return generateWithFallback({
    contents: [{ role: "user", parts: [{ text }] }],
    maxOutputTokens: opts?.maxOutputTokens ?? 1024,
    models: opts?.models,
  });
}
