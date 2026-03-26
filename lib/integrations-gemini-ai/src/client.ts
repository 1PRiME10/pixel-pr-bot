import { GoogleGenAI } from "@google/genai";

// ── Dual-key setup: use BOTH keys in round-robin to double free-tier quota ────
// Checks multiple common variable names so either naming convention works.
// Never use the Replit proxy base URL — returns 404 for all models.

const key1 =
  process.env.GOOGLE_AI_KEY  ??
  process.env.GOOGLE_AI_KEY2 ??
  process.env.GEMINI_API_KEY;

const _k2candidate =
  process.env.GEMINI_KEY  ??
  process.env.GEMINI_KEY2 ??
  process.env.GOOGLE_AI_KEY2;

const key2 = _k2candidate && _k2candidate !== key1 ? _k2candidate : undefined;

if (!key1 && !key2) {
  throw new Error(
    "No Gemini API key available. Set GOOGLE_AI_KEY in Secrets (Google AI Studio key).",
  );
}

export const ai  = new GoogleGenAI({ apiKey: key1 ?? key2! });
export const ai2 = key2 && key2 !== key1 ? new GoogleGenAI({ apiKey: key2 }) : null;

export const DUAL_KEY = !!ai2;
