// ─── AI-Generated Behavior Registry ──────────────────────────────────────────
// AUTOMATICALLY MANAGED by the AI Coder engine (/build command).
// Behaviors are non-slash-command bot behaviors: event listeners, scheduled tasks, auto-responders.
//
// Types:
//   event         — Fires on a Discord.js event (guildMemberAdd, messageDelete, etc.)
//   schedule      — Fires on a cron schedule (cron expression: "0 9 * * *" = daily at 9am)
//   autoresponder — Fires when a message matches a regex pattern
//
// DO NOT EDIT MANUALLY — managed by the AI Coder engine.

import type { Client, Message, GuildMember } from "discord.js";
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { ai, generateWithFallback } from "@workspace/integrations-gemini-ai";
import { pool } from "@workspace/db";

export type BehaviorType = "event" | "schedule" | "autoresponder";

export interface AiBehavior {
  id:          string;       // unique slug e.g. "greet-new-members"
  name:        string;       // human-readable display name
  description: string;       // original user request
  type:        BehaviorType;
  event?:      string;       // discord.js event name  (type="event")
  schedule?:   string;       // cron expression        (type="schedule")
  pattern?:    string;       // regex string           (type="autoresponder")
  flags?:      string;       // regex flags e.g. "i"
  handler:     (client: Client, ...args: any[]) => Promise<void>;
}

export const aiBehaviors: AiBehavior[] = [
  // ── AI BEHAVIORS ARRAY END ───────────────────────────────────────────────
];
