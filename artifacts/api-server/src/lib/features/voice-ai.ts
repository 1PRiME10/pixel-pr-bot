import {
  Client,
  Guild,
  Events,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { pool } from "@workspace/db";
import { logger } from "../logger.js";

// ─── State ────────────────────────────────────────────────────────────────────

export interface VoiceAIState {
  enabled:        boolean;
  voiceChannelId: string;
  textChannelId:  string;
}

export const voiceAIStates = new Map<string, VoiceAIState>();

// ─── DB helpers ───────────────────────────────────────────────────────────────

export async function initVoiceAISettings(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS voice_ai_config (
        guild_id   TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL
      )
    `);
  } catch (err) {
    logger.error({ err }, "voice-ai: failed to init DB table");
  }
}

export async function setVoiceAIChannel(guildId: string, channelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO voice_ai_config (guild_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
    [guildId, channelId],
  );
}

export async function removeVoiceAIChannel(guildId: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM voice_ai_config WHERE guild_id = $1`,
    [guildId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getVoiceAIChannel(guildId: string): Promise<string | null> {
  const { rows } = await pool.query<{ channel_id: string }>(
    `SELECT channel_id FROM voice_ai_config WHERE guild_id = $1`,
    [guildId],
  );
  return rows[0]?.channel_id ?? null;
}

// ─── Activation / Deactivation ───────────────────────────────────────────────

export function activateVoiceAI(
  client: Client,
  guild:  Guild,
  voiceChannelId: string,
  textChannelId:  string,
): void {
  // Disconnect any existing connection first
  deactivateVoiceAI(guild.id);

  voiceAIStates.set(guild.id, {
    enabled: true,
    voiceChannelId,
    textChannelId,
  });

  const voiceChannel = guild.channels.cache.get(voiceChannelId);
  if (!voiceChannel?.isVoiceBased()) {
    logger.warn({ guildId: guild.id }, "voice-ai: channel is not a voice channel");
    return;
  }

  try {
    const connection = joinVoiceChannel({
      channelId:     voiceChannelId,
      guildId:       guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:      false,
      selfMute:      false,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        connection.destroy();
        voiceAIStates.delete(guild.id);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      voiceAIStates.delete(guild.id);
    });

  } catch (err) {
    logger.error({ err, guildId: guild.id }, "voice-ai: failed to join voice channel");
    voiceAIStates.delete(guild.id);
  }
}

export function deactivateVoiceAI(guildId: string): boolean {
  const state = voiceAIStates.get(guildId);
  if (!state?.enabled) return false;

  voiceAIStates.delete(guildId);

  try {
    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();
  } catch {
    // already gone
  }

  return true;
}

// ─── Register (event listeners, if any) ──────────────────────────────────────

export function registerVoiceAI(client: Client): void {
  // Clean up state when the bot leaves a voice channel unexpectedly
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const gid = oldState.guild.id;
    const state = voiceAIStates.get(gid);
    if (!state) return;

    // Bot was disconnected from voice
    if (
      oldState.member?.id === client.user?.id &&
      oldState.channelId &&
      !newState.channelId
    ) {
      voiceAIStates.delete(gid);
      logger.info({ guildId: gid }, "voice-ai: bot left voice channel, state cleared");
    }
  });
}
