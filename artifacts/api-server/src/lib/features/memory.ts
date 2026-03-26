// ─── Long-term AI Memory ───────────────────────────────────────────────────────
// Persists key facts about each user in PostgreSQL so PIXEL remembers them
// across restarts, days, and weeks.
//
// Security:
//  • Data is isolated per (user_id, guild_id) — no cross-guild leakage
//  • Field lengths are hard-capped before storage
//  • HTML/injection characters stripped from all stored strings
//  • Memory extractions rate-limited to 1 per 5 minutes per user
//  • Gemini extracts facts from content — parameterised SQL prevents injection
//  • Users can wipe their own memory; admins have no special read access

import { pool } from "@workspace/db";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";

// ── Hard limits ──────────────────────────────────────────────────────────────
const MAX_INTERESTS      = 8;
const MAX_TOPICS         = 8;
const MAX_FIELD_LEN      = 100;   // per string field
const MAX_NOTES_LEN      = 350;   // freeform notes
const UPDATE_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between DB writes per user

// In-memory rate-limit tracker (acceptable to lose on restart)
const lastUpdateTime = new Map<string, number>();

// ── Types ────────────────────────────────────────────────────────────────────
export interface UserMemory {
  nickname?:  string;
  interests:  string[];
  topics:     string[];
  notes?:     string;
}

// ── DB init ──────────────────────────────────────────────────────────────────
export async function initMemory(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_memory (
      user_id    TEXT    NOT NULL,
      guild_id   TEXT    NOT NULL,
      nickname   TEXT,
      interests  TEXT[]  NOT NULL DEFAULT '{}',
      topics     TEXT[]  NOT NULL DEFAULT '{}',
      notes      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, guild_id)
    )
  `);
}

// ── Load ─────────────────────────────────────────────────────────────────────
export async function loadMemory(userId: string, guildId: string): Promise<UserMemory> {
  try {
    const { rows } = await pool.query(
      `SELECT nickname, interests, topics, notes
         FROM user_memory
        WHERE user_id = $1 AND guild_id = $2`,
      [userId, guildId],
    );
    if (rows.length === 0) return { interests: [], topics: [] };
    return {
      nickname:  rows[0].nickname  ?? undefined,
      interests: rows[0].interests ?? [],
      topics:    rows[0].topics    ?? [],
      notes:     rows[0].notes     ?? undefined,
    };
  } catch {
    return { interests: [], topics: [] };
  }
}

// ── Clear ────────────────────────────────────────────────────────────────────
export async function clearMemory(userId: string, guildId: string): Promise<void> {
  await pool.query(
    `DELETE FROM user_memory WHERE user_id = $1 AND guild_id = $2`,
    [userId, guildId],
  );
  lastUpdateTime.delete(`${userId}:${guildId}`);
}

// ── Sanitise ─────────────────────────────────────────────────────────────────
function sanitise(s: string, maxLen: number): string {
  return s.replace(/[<>"'`\\]/g, "").trim().slice(0, maxLen);
}

// ── Extract facts from one conversation turn ─────────────────────────────────
// Lightweight Gemini call — only runs when the rate-limit window allows.
async function extractFacts(userText: string, botText: string): Promise<Partial<UserMemory> | null> {
  const prompt =
    `You are a silent fact extractor for a Discord AI bot. ` +
    `Read this single conversation turn and extract ONLY concrete personal facts ` +
    `stated BY the user about themselves.\n\n` +
    `User said: "${userText.slice(0, 400)}"\n` +
    `Bot replied: "${botText.slice(0, 300)}"\n\n` +
    `Return ONLY valid JSON (no markdown, no explanation):\n` +
    `{\n` +
    `  "nickname": "name user wants to be called (only if they explicitly stated it)",\n` +
    `  "interests": ["short phrase"], (hobbies, subjects they clearly enjoy — max 3 new items)\n` +
    `  "topics": ["short phrase"], (things they are currently working on or studying — max 3)\n` +
    `  "notes": "one short memorable sentence about this user"\n` +
    `}\n\n` +
    `Rules:\n` +
    `- Only extract facts from the USER's message\n` +
    `- Omit any field you are not confident about\n` +
    `- If nothing notable — return {}\n` +
    `- Each string must be under 80 characters\n` +
    `- interests/topics should be short phrases (1-4 words)`;

  const raw = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    maxOutputTokens: 512,
  });
  if (!raw) return null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as Partial<UserMemory>;
  } catch {
    return null;
  }
}

// ── Merge extracted facts into existing memory ────────────────────────────────
function mergeFacts(existing: UserMemory, extracted: Partial<UserMemory>): UserMemory {
  const merged: UserMemory = {
    nickname:  existing.nickname,
    interests: [...existing.interests],
    topics:    [...existing.topics],
    notes:     existing.notes,
  };

  if (extracted.nickname) {
    merged.nickname = sanitise(extracted.nickname, MAX_FIELD_LEN);
  }

  if (Array.isArray(extracted.interests)) {
    for (const item of extracted.interests) {
      const clean = sanitise(String(item), MAX_FIELD_LEN);
      if (clean && !merged.interests.includes(clean)) merged.interests.push(clean);
    }
    merged.interests = merged.interests.slice(-MAX_INTERESTS);
  }

  if (Array.isArray(extracted.topics)) {
    for (const item of extracted.topics) {
      const clean = sanitise(String(item), MAX_FIELD_LEN);
      if (clean && !merged.topics.includes(clean)) merged.topics.push(clean);
    }
    merged.topics = merged.topics.slice(-MAX_TOPICS);
  }

  if (typeof extracted.notes === "string" && extracted.notes.trim()) {
    merged.notes = sanitise(extracted.notes, MAX_NOTES_LEN);
  }

  return merged;
}

// ── Persist ───────────────────────────────────────────────────────────────────
async function saveMemory(userId: string, guildId: string, mem: UserMemory): Promise<void> {
  await pool.query(
    `INSERT INTO user_memory (user_id, guild_id, nickname, interests, topics, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, guild_id) DO UPDATE SET
       nickname   = EXCLUDED.nickname,
       interests  = EXCLUDED.interests,
       topics     = EXCLUDED.topics,
       notes      = EXCLUDED.notes,
       updated_at = NOW()`,
    [userId, guildId, mem.nickname ?? null, mem.interests, mem.topics, mem.notes ?? null],
  );
}

// ── Update (called after every PIXEL response) ────────────────────────────────
// Rate-limited and fully async — never blocks the chat response.
export async function updateMemory(
  userId:    string,
  guildId:   string,
  userText:  string,
  botText:   string,
): Promise<void> {
  const key = `${userId}:${guildId}`;
  const now = Date.now();
  if (now - (lastUpdateTime.get(key) ?? 0) < UPDATE_COOLDOWN_MS) return;
  lastUpdateTime.set(key, now);

  const extracted = await extractFacts(userText, botText);
  if (!extracted || Object.keys(extracted).length === 0) return;

  const existing = await loadMemory(userId, guildId);
  const merged   = mergeFacts(existing, extracted);
  await saveMemory(userId, guildId, merged);
}

// ── Format for system prompt ──────────────────────────────────────────────────
export function formatMemoryForPrompt(mem: UserMemory): string {
  const parts: string[] = [];
  if (mem.nickname)              parts.push(`Their preferred name is "${mem.nickname}"`);
  if (mem.interests.length > 0)  parts.push(`They enjoy: ${mem.interests.join(", ")}`);
  if (mem.topics.length > 0)     parts.push(`They've been working on / asking about: ${mem.topics.join(", ")}`);
  if (mem.notes)                 parts.push(mem.notes);
  if (parts.length === 0) return "";
  return `[MEMORY about this user: ${parts.join(". ")}. Use this to personalise your responses naturally — don't just recite it back.]`;
}
