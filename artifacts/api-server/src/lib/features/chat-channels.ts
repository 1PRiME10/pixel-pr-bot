// ─── Chat Channels ─────────────────────────────────────────────────────────────
// Manages the list of channels where PIXEL responds to ALL messages (not just
// @mentions or commands). Settings are persisted in PostgreSQL and cached in
// memory for fast per-message lookups.
//
// Commands (admin only, handled via exported helpers called from discord-bot.ts):
//   !chat    — enable chat mode for the current channel
//   !unchat  — disable chat mode for the current channel

import { pool } from "@workspace/db";

// ─── In-memory Set for fast per-message lookups ───────────────────────────────
const chatChannels = new Set<string>();

// ─── DB init + load ───────────────────────────────────────────────────────────
export async function initChatChannels(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_channels (
      channel_id TEXT PRIMARY KEY,
      enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { rows } = await pool.query(`SELECT channel_id FROM chat_channels`);
  for (const row of rows) chatChannels.add(row.channel_id);
  console.log(`Loaded ${rows.length} chat channel(s) from DB`);
}

// ─── Runtime check (called on every message) ──────────────────────────────────
export function isChatChannel(channelId: string): boolean {
  return chatChannels.has(channelId);
}

// ─── Add a channel ────────────────────────────────────────────────────────────
export async function addChatChannel(channelId: string): Promise<void> {
  chatChannels.add(channelId);
  await pool.query(
    `INSERT INTO chat_channels (channel_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [channelId]
  );
}

// ─── Remove a channel ─────────────────────────────────────────────────────────
export async function removeChatChannel(channelId: string): Promise<void> {
  chatChannels.delete(channelId);
  await pool.query(`DELETE FROM chat_channels WHERE channel_id = $1`, [channelId]);
}
