import { GoogleGenAI } from "@google/genai";

// ── Dual-key setup: use BOTH keys in round-robin to double free-tier quota ────
// Checks multiple common variable names so either naming convention works.
// Lazy init: does NOT throw at import time — the server still starts even if
// GOOGLE_AI_KEY is absent (e.g. local dev without secrets).  The error is only
// raised when a Gemini call is actually attempted.

const key1 =
  process.env.GOOGLE_AI_KEY  ??
  process.env.GOOGLE_AI_KEY2 ??
  process.env.GEMINI_API_KEY;

const _k2candidate =
  process.env.GEMINI_KEY  ??
  process.env.GEMINI_KEY2 ??
  process.env.GOOGLE_AI_KEY2;

const key2 = _k2candidate && _k2candidate !== key1 ? _k2candidate : undefined;

export const DUAL_KEY = !!(key2 && key2 !== key1);

// Clients are created lazily — null when no key is configured.
// Code that calls Gemini should check `ai` is not null before using it.
export const ai:  GoogleGenAI | null = key1 ?? key2
  ? new GoogleGenAI({ apiKey: (key1 ?? key2)! })
  : null;

export const ai2: GoogleGenAI | null = key2 && key2 !== key1
  ? new GoogleGenAI({ apiKey: key2 })
  : null;
