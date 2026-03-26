// ─── Events & Reminders System ────────────────────────────────────────────────
// Full-featured event scheduler with automatic Discord reminders.
// Supports games, tournaments, watch parties, and custom events.
//
// Reminder schedule per event:
//   • 24 hours before
//   • 1 hour before
//   • 10 minutes before
//   • At start (with ping)
//
// Recurring options: daily | weekly | monthly | none

import {
  Client,
  EmbedBuilder,
  TextChannel,
  ColorResolvable,
} from "discord.js";
import { pool } from "@workspace/db";

// ── Types ─────────────────────────────────────────────────────────────────────
export type EventType   = "event" | "game" | "tournament" | "watch" | "other";
export type RecurType   = "none"  | "daily" | "weekly"    | "monthly";

export interface BotEvent {
  id:             number;
  guild_id:       string;
  channel_id:     string;
  title:          string;
  description:    string | null;
  event_at:       Date;
  created_by:     string;
  ping_role_id:   string | null;
  banner_url:     string | null;
  type:           EventType;
  recurring:      RecurType;
  reminded_24h:   boolean;
  reminded_1h:    boolean;
  reminded_10m:   boolean;
  reminded_start: boolean;
  ended:          boolean;
  created_at:     Date;
}

// ── Color map per event type ───────────────────────────────────────────────────
const TYPE_COLOR: Record<EventType, number> = {
  event:      0x9b59b6,
  game:       0x00b894,
  tournament: 0xe17055,
  watch:      0x0984e3,
  other:      0x636e72,
};

const TYPE_EMOJI: Record<EventType, string> = {
  event:      "📅",
  game:       "🎮",
  tournament: "🏆",
  watch:      "📺",
  other:      "📌",
};

// ── Cached client reference ───────────────────────────────────────────────────
let activeClient: Client | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── DB helpers ────────────────────────────────────────────────────────────────
async function initDB(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_events (
      id              SERIAL PRIMARY KEY,
      guild_id        TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      event_at        TIMESTAMPTZ NOT NULL,
      created_by      TEXT NOT NULL,
      ping_role_id    TEXT,
      banner_url      TEXT,
      type            TEXT NOT NULL DEFAULT 'event',
      recurring       TEXT NOT NULL DEFAULT 'none',
      reminded_24h    BOOLEAN NOT NULL DEFAULT FALSE,
      reminded_1h     BOOLEAN NOT NULL DEFAULT FALSE,
      reminded_10m    BOOLEAN NOT NULL DEFAULT FALSE,
      reminded_start  BOOLEAN NOT NULL DEFAULT FALSE,
      ended           BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Public: Create event ─────────────────────────────────────────────────────
export async function createEvent(opts: {
  guildId:     string;
  channelId:   string;
  title:       string;
  description: string | null;
  eventAt:     Date;
  createdBy:   string;
  pingRoleId:  string | null;
  bannerUrl:   string | null;
  type:        EventType;
  recurring:   RecurType;
}): Promise<BotEvent> {
  const { rows } = await pool.query<BotEvent>(
    `INSERT INTO bot_events
      (guild_id, channel_id, title, description, event_at, created_by, ping_role_id, banner_url, type, recurring)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [opts.guildId, opts.channelId, opts.title, opts.description,
     opts.eventAt.toISOString(), opts.createdBy, opts.pingRoleId,
     opts.bannerUrl, opts.type, opts.recurring],
  );
  return rows[0];
}

// ── Public: List upcoming events for a guild ──────────────────────────────────
export async function listEvents(guildId: string, page = 0): Promise<BotEvent[]> {
  const { rows } = await pool.query<BotEvent>(
    `SELECT * FROM bot_events
     WHERE guild_id = $1 AND ended = FALSE AND event_at > NOW() - INTERVAL '1 hour'
     ORDER BY event_at ASC
     LIMIT 10 OFFSET $2`,
    [guildId, page * 10],
  );
  return rows;
}

// ── Public: Get single event ──────────────────────────────────────────────────
export async function getEvent(id: number, guildId: string): Promise<BotEvent | null> {
  const { rows } = await pool.query<BotEvent>(
    `SELECT * FROM bot_events WHERE id = $1 AND guild_id = $2`,
    [id, guildId],
  );
  return rows[0] ?? null;
}

// ── Public: Delete event ──────────────────────────────────────────────────────
export async function deleteEvent(id: number, guildId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM bot_events WHERE id = $1 AND guild_id = $2`,
    [id, guildId],
  );
  return (rowCount ?? 0) > 0;
}

// ── Public: Edit event field ──────────────────────────────────────────────────
export async function editEvent(id: number, guildId: string, updates: {
  title?:       string;
  description?: string | null;
  eventAt?:     Date;
  channelId?:   string;
  pingRoleId?:  string | null;
  type?:        EventType;
  recurring?:   RecurType;
}): Promise<BotEvent | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (updates.title       !== undefined) { sets.push(`title=$${i++}`);         vals.push(updates.title); }
  if (updates.description !== undefined) { sets.push(`description=$${i++}`);   vals.push(updates.description); }
  if (updates.eventAt     !== undefined) { sets.push(`event_at=$${i++}`);      vals.push(updates.eventAt.toISOString());
    sets.push(`reminded_24h=FALSE`);
    sets.push(`reminded_1h=FALSE`);
    sets.push(`reminded_10m=FALSE`);
    sets.push(`reminded_start=FALSE`);
  }
  if (updates.channelId   !== undefined) { sets.push(`channel_id=$${i++}`);    vals.push(updates.channelId); }
  if (updates.pingRoleId  !== undefined) { sets.push(`ping_role_id=$${i++}`);  vals.push(updates.pingRoleId); }
  if (updates.type        !== undefined) { sets.push(`type=$${i++}`);          vals.push(updates.type); }
  if (updates.recurring   !== undefined) { sets.push(`recurring=$${i++}`);     vals.push(updates.recurring); }

  if (!sets.length) return getEvent(id, guildId);

  vals.push(id, guildId);
  const { rows } = await pool.query<BotEvent>(
    `UPDATE bot_events SET ${sets.join(",")} WHERE id=$${i++} AND guild_id=$${i++} RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

// ── Build reminder embed ──────────────────────────────────────────────────────
function buildReminderEmbed(ev: BotEvent, level: "24h" | "1h" | "10m" | "start"): EmbedBuilder {
  const emoji = TYPE_EMOJI[ev.type as EventType] ?? "📅";
  const color = TYPE_COLOR[ev.type as EventType] ?? 0x9b59b6;

  const timeStr = `<t:${Math.floor(ev.event_at.getTime() / 1000)}:F>`;
  const relStr  = `<t:${Math.floor(ev.event_at.getTime() / 1000)}:R>`;

  const headerMap = {
    "24h":   `⏰ **24 hours** until the event!`,
    "1h":    `🔔 **1 hour** to go — get ready!`,
    "10m":   `🚨 **10 minutes** left — be there!`,
    "start": `🎉 **It's starting NOW!**`,
  };

  const embed = new EmbedBuilder()
    .setColor(color as ColorResolvable)
    .setTitle(`${emoji} ${ev.title}`)
    .setDescription(headerMap[level])
    .addFields(
      { name: "📅 When", value: `${timeStr}\n${relStr}`, inline: true },
      { name: "🔁 Type", value: `${emoji} ${ev.type.charAt(0).toUpperCase() + ev.type.slice(1)}`, inline: true },
    );

  if (ev.description) embed.addFields({ name: "📋 Description", value: ev.description, inline: false });
  if (ev.banner_url)  embed.setImage(ev.banner_url);
  if (ev.recurring !== "none") embed.addFields({ name: "🔄 Recurring", value: ev.recurring, inline: true });
  embed.setFooter({ text: `Event ID: ${ev.id} • Created by <@${ev.created_by}>` });

  return embed;
}

// ── Advance recurring event date ──────────────────────────────────────────────
function nextRecurDate(date: Date, recurring: RecurType): Date {
  const next = new Date(date);
  switch (recurring) {
    case "daily":   next.setDate(next.getDate() + 1); break;
    case "weekly":  next.setDate(next.getDate() + 7); break;
    case "monthly": next.setMonth(next.getMonth() + 1); break;
    default: break;
  }
  return next;
}

// ── Poll: check and fire reminders ────────────────────────────────────────────
async function pollReminders(): Promise<void> {
  if (!activeClient) return;

  const now = Date.now();

  const { rows } = await pool.query<BotEvent>(
    `SELECT * FROM bot_events
     WHERE ended = FALSE
       AND event_at > NOW() - INTERVAL '2 minutes'
       AND event_at < NOW() + INTERVAL '25 hours'
     ORDER BY event_at ASC`,
  );

  for (const ev of rows) {
    const t   = ev.event_at.getTime();
    const diff = t - now; // ms until event (negative if past)

    const ch = activeClient.channels.cache.get(ev.channel_id) as TextChannel | undefined;
    if (!ch) continue;

    const ping = ev.ping_role_id ? `<@&${ev.ping_role_id}> ` : "";

    // 24h reminder (between 23h55m and 24h5m before)
    if (!ev.reminded_24h && diff >= 23 * 3600000 + 55 * 60000 && diff <= 24 * 3600000 + 5 * 60000) {
      const embed = buildReminderEmbed(ev, "24h");
      await ch.send({ content: `${ping}📅 Reminder for **${ev.title}**!`, embeds: [embed] }).catch(() => {});
      await pool.query(`UPDATE bot_events SET reminded_24h=TRUE WHERE id=$1`, [ev.id]);
    }

    // 1h reminder (between 55m and 65m before)
    else if (!ev.reminded_1h && diff >= 55 * 60000 && diff <= 65 * 60000) {
      const embed = buildReminderEmbed(ev, "1h");
      await ch.send({ content: `${ping}🔔 1 hour until **${ev.title}**!`, embeds: [embed] }).catch(() => {});
      await pool.query(`UPDATE bot_events SET reminded_1h=TRUE WHERE id=$1`, [ev.id]);
    }

    // 10m reminder (between 5m and 15m before)
    else if (!ev.reminded_10m && diff >= 5 * 60000 && diff <= 15 * 60000) {
      const embed = buildReminderEmbed(ev, "10m");
      await ch.send({ content: `${ping}🚨 **${ev.title}** starts in 10 minutes!`, embeds: [embed] }).catch(() => {});
      await pool.query(`UPDATE bot_events SET reminded_10m=TRUE WHERE id=$1`, [ev.id]);
    }

    // Start reminder (within ±2 minutes of event_at)
    else if (!ev.reminded_start && diff >= -2 * 60000 && diff <= 2 * 60000) {
      const embed = buildReminderEmbed(ev, "start");
      await ch.send({ content: `${ping}🎉 **${ev.title}** is starting NOW!`, embeds: [embed] }).catch(() => {});

      if (ev.recurring !== "none") {
        const nextAt = nextRecurDate(ev.event_at, ev.recurring as RecurType);
        await pool.query(
          `UPDATE bot_events
           SET reminded_start=TRUE, reminded_24h=FALSE, reminded_1h=FALSE,
               reminded_10m=FALSE, reminded_start=TRUE, event_at=$2
           WHERE id=$1`,
          [ev.id, nextAt.toISOString()],
        );
      } else {
        await pool.query(`UPDATE bot_events SET reminded_start=TRUE, ended=TRUE WHERE id=$1`, [ev.id]);
      }
    }
  }
}

// ── Build event info embed ─────────────────────────────────────────────────────
export function buildEventEmbed(ev: BotEvent, showId = true): EmbedBuilder {
  const emoji = TYPE_EMOJI[ev.type as EventType] ?? "📅";
  const color = TYPE_COLOR[ev.type as EventType] ?? 0x9b59b6;
  const timeStr = `<t:${Math.floor(ev.event_at.getTime() / 1000)}:F>`;
  const relStr  = `<t:${Math.floor(ev.event_at.getTime() / 1000)}:R>`;

  const embed = new EmbedBuilder()
    .setColor(color as ColorResolvable)
    .setTitle(`${emoji} ${ev.title}`)
    .addFields(
      { name: "📅 Date & Time", value: `${timeStr}\n${relStr}`, inline: true },
      { name: "📌 Channel",     value: `<#${ev.channel_id}>`, inline: true },
      { name: "🔁 Type",        value: `${emoji} ${ev.type.charAt(0).toUpperCase() + ev.type.slice(1)}`, inline: true },
    );

  if (ev.description)    embed.setDescription(ev.description);
  if (ev.ping_role_id)   embed.addFields({ name: "🔔 Ping", value: `<@&${ev.ping_role_id}>`, inline: true });
  if (ev.recurring !== "none") embed.addFields({ name: "🔄 Recurring", value: ev.recurring, inline: true });
  if (ev.banner_url)     embed.setImage(ev.banner_url);
  if (showId)            embed.setFooter({ text: `Event ID: ${ev.id} • Use /event delete ${ev.id} to remove` });

  return embed;
}

// ── Parse datetime string → Date ──────────────────────────────────────────────
// Accepted formats: "YYYY-MM-DD HH:MM" | "DD/MM/YYYY HH:MM" | "DD-MM-YYYY HH:MM"
export function parseEventDate(str: string): Date | null {
  str = str.trim();

  // ISO-like: 2026-03-25 18:30
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}T${m[4].padStart(2,"0")}:${m[5]}:00`);
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY HH:MM or DD-MM-YYYY HH:MM
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[T\s](\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}T${m[4].padStart(2,"0")}:${m[5]}:00`);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

// ── Register (start polling) ──────────────────────────────────────────────────
export async function registerEvents(client: Client): Promise<void> {
  activeClient = client;
  await initDB();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollReminders().catch(e => console.error("[Events] Poll error:", e)); }, 60_000);
  console.log("[Events] ✅ Event reminder system started");
}
