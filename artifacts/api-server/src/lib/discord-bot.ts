// Ensure ffmpeg-static binary is on PATH for @discordjs/voice
import ffmpegStatic from "ffmpeg-static";
if (ffmpegStatic) process.env.FFMPEG_PATH = ffmpegStatic;

import { cpSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname }              from "path";
import { fileURLToPath }                 from "url";

import {
  Client,
  GatewayIntentBits,
  ActivityType,
  Events,
  Message,
  GuildMember,
  PermissionFlagsBits,
  Partials,
  AttachmentBuilder,
  Options,
} from "discord.js";

import { ai, generateWithFallback } from "@workspace/integrations-gemini-ai";
import { registerTranslate } from "./features/translate.js";
import { registerImagine, runImagine } from "./features/imagine.js";
import { registerReputation } from "./features/reputation.js";
import { registerGames, isWordChainActive } from "./features/games.js";
import { registerDaily, initDaily, handleDailyCommand } from "./features/daily.js";
import { initLavalink } from "./features/radio.js";
import { registerSearchSummary } from "./features/search-summary.js";
import { registerModeration, initModeration } from "./features/moderation.js";
import { registerAutoSecurity, initAutoSecurity } from "./features/auto-security.js";
import { registerProfanityFilter, initProfanityFilter } from "./features/profanity-filter.js";
import { registerServerLog, initServerLog } from "./features/server-log.js";
import { registerTweetMonitor, initTweetMonitor } from "./features/tweet-monitor.js";
import { registerJokeScheduler, initJokeScheduler } from "./features/joke-scheduler.js";
import { registerWelcome, initWelcome } from "./features/welcome.js";
import { registerRadio, initRadio, startRadio, radioStates } from "./features/radio.js";
import { registerVoiceAI, initVoiceAISettings } from "./features/voice-ai.js";
import { registerAesthetic } from "./features/aesthetic.js";
import { registerSentiment } from "./features/sentiment.js";
import { registerSteganography } from "./features/steganography.js";
import { initTracker, registerTracker, handleTrackerMessage } from "./features/tracker.js";
import { registerEvents } from "./features/events.js";
import { registerYouTubeMonitor } from "./features/youtube-monitor.js";
import { registerNewsMonitor }   from "./features/news-monitor.js";
import { initPersona, registerPersona, getPersonaInjection } from "./features/persona.js";
import { initJPTracker, registerJPTracker } from "./features/jp-tracker.js";
import { registerSlashCommands } from "./features/slash-commands.js";
import { initAiEmojis, uploadAiEmojis, pickEmoji, parseEmotion, getExpressionImagePath } from "./features/ai-hoshino-emojis.js";
import { initChatChannels, isChatChannel, addChatChannel, removeChatChannel } from "./features/chat-channels.js";
import {
  initConsent,
  hasConsented,
  acceptConsent,
  revokeConsent,
  PRIVACY_NOTICE,
  getPrivacyNotice,
  getDMPrivacyNotice,
  detectMessageLanguage,
  SUPPORTED_LANGUAGES,
} from "./features/consent.js";
import { initProfiling, registerProfiling, clearProfile } from "./features/profiling.js";
import {
  initMemory,
  loadMemory,
  clearMemory,
  updateMemory,
  formatMemoryForPrompt,
} from "./features/memory.js";
import { initMessageDedup, cleanOldMessages } from "./message-dedup.js";
import { registerGate, isClaimed } from "./message-gate.js";
import {
  initFeatureRegistry,
  isFeatureEnabled,
  handleFeatureCommand,
  isBotOwner,
} from "./feature-registry.js";
import { initSelfHeal, setSelfHealClient, handleError } from "./features/self-heal.js";
import { runBackup, getBackupStatus, BACKUP_HELP }    from "./github-backup.js";
import { initAutoFix } from "./features/auto-fix.js";
import { initSecurityHardening, setSecurityClient } from "./features/security-hardening.js";
import { aiBehaviors } from "./features/ai-behaviors.js";
import { pool } from "@workspace/db";

let client: Client | null = null;
let startTime: Date | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 300_000; // 5 minutes max
let reconnectPending = false;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let connectStartTime = 0; // tracks when the last connect() started
// ── Leak prevention: track reconnect-spawned intervals so we can clear them ──
// Every connect() spawns a status-cycle and (optionally) a schedule ticker.
// Without clearing them, each reconnect adds two permanent intervals that
// reference a stale client object — CPU + memory leak over time.
let statusCycleIntervalRef: ReturnType<typeof setInterval> | null = null;
let scheduledBehaviorsIntervalRef: ReturnType<typeof setInterval> | null = null;
// Tracks whether THIS process is the elected leader.
// Watchdog MUST NOT reconnect if we're not the leader (another instance owns Discord).
let isElectedLeader = false;
const PREFIX = "!";

// ── Hot-path caches (populated once on ClientReady) ───────────────────────────
// Avoid recreating RegExp objects and filtering arrays on every message.
let cachedMentionRegex: RegExp | null = null;
// Pre-filtered autoresponders — updated whenever aiBehaviors mutates.
// We use a Proxy approach: re-filter only when the message handler runs and the
// length of aiBehaviors has changed (cheap length check vs full .filter() every call).
let _autoresponderCache: typeof aiBehaviors = [];
let _autoresponderCacheLen = -1;
function getAutoresponders(): typeof aiBehaviors {
  if (aiBehaviors.length !== _autoresponderCacheLen) {
    _autoresponderCache = aiBehaviors.filter(b => b.type === "autoresponder" && b.pattern);
    _autoresponderCacheLen = aiBehaviors.length;
  }
  return _autoresponderCache;
}
// Compiled regex cache keyed by pattern+flags — avoids re-compiling same regex
const _compiledRegexCache = new Map<string, RegExp>();
function getCachedRegex(pattern: string, flags: string): RegExp {
  const key = `${flags}:${pattern}`;
  let re = _compiledRegexCache.get(key);
  if (!re) { re = new RegExp(pattern, flags); _compiledRegexCache.set(key, re); }
  return re;
}

// ── Simple cron matcher — supports common patterns ────────────────────────────
// Matches: "* * * * *" format (min hour dom month dow)
// Supports: exact values, "*", "*/N" (every N), comma-separated, ranges
function matchesCron(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minPart, hourPart, domPart, monPart, dowPart] = parts;
  const fields = [
    { part: minPart!,  val: now.getMinutes() },
    { part: hourPart!, val: now.getHours() },
    { part: domPart!,  val: now.getDate() },
    { part: monPart!,  val: now.getMonth() + 1 },
    { part: dowPart!,  val: now.getDay() },
  ];
  return fields.every(({ part, val }) => {
    if (part === "*") return true;
    // */N pattern
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      return !isNaN(step) && val % step === 0;
    }
    // comma-separated list
    return part.split(",").some(s => {
      if (s.includes("-")) {
        const [lo, hi] = s.split("-").map(Number);
        return !isNaN(lo!) && !isNaN(hi!) && val >= lo! && val <= hi!;
      }
      return parseInt(s, 10) === val;
    });
  });
}

// ─── Deduplication (DB-backed, shared across all instances) ──────────────────
// initMessageDedup() and cleanOldMessages() are called from startBot()

// ─── Conversation Memory ──────────────────────────────────────────────────────
interface Turn { role: "user" | "model"; text: string; }
interface Conversation { history: Turn[]; lastActive: number; }

const conversations = new Map<string, Conversation>();
const MAX_HISTORY_PAIRS = 10;          // remember last 10 exchanges (reduced from 15 — saves ~33% RAM)
const INACTIVITY_MS = 20 * 60 * 1000; // forget after 20 min inactivity (reduced from 30 min)

function historyKey(userId: string, guildId: string): string {
  return `${userId}:${guildId}`;
}

function getHistory(userId: string, guildId: string): Turn[] {
  const key  = historyKey(userId, guildId);
  const conv = conversations.get(key);
  if (!conv) return [];
  if (Date.now() - conv.lastActive > INACTIVITY_MS) {
    conversations.delete(key);
    return [];
  }
  return conv.history;
}

function saveHistory(userId: string, guildId: string, userText: string, botText: string) {
  const key     = historyKey(userId, guildId);
  const history = getHistory(userId, guildId);
  history.push({ role: "user", text: userText });
  history.push({ role: "model", text: botText });
  // Trim oldest turns beyond the limit
  while (history.length > MAX_HISTORY_PAIRS * 2) history.shift();
  conversations.set(key, { history, lastActive: Date.now() });
}

export function clearHistory(userId: string, guildId?: string) {
  if (guildId) {
    // clear only the specific context (server or DM)
    conversations.delete(historyKey(userId, guildId));
  } else {
    // clear ALL contexts for this user (used by !forget)
    for (const key of conversations.keys()) {
      if (key.startsWith(`${userId}:`)) conversations.delete(key);
    }
  }
}

// Clear ALL AI conversation history for an entire guild (all users)
export function clearGuildHistory(guildId: string) {
  for (const key of conversations.keys()) {
    if (key.endsWith(`:${guildId}`)) conversations.delete(key);
  }
}

// ─── Language display names (for the CRITICAL language instruction) ───────────
const LANG_NAMES: Record<string, string> = {
  ar: "Arabic — match the user's exact dialect (Jordanian, Saudi, Egyptian, Levantine, Iraqi, Gulf, etc.)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  zh: "Chinese (中文)",
  ru: "Russian (Русский)",
  hi: "Hindi (हिंदी)",
  fa: "Farsi (فارسی)",
  th: "Thai (ภาษาไทย)",
  el: "Greek (Ελληνικά)",
  tr: "Turkish (Türkçe)",
  id: "Indonesian (Bahasa Indonesia)",
  es: "Spanish (Español)",
  fr: "French (Français)",
  de: "German (Deutsch)",
  pt: "Portuguese (Português)",
  it: "Italian (Italiano)",
};

// ─── PIXEL System Prompt ──────────────────────────────────────────────────────
function pixelSystemPrompt(memoryContext?: string, personaInjection?: string, userLang?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone: "UTC",
  });
  const memoryLine = memoryContext
    ? `\n${memoryContext}\nUse this background info to personalise your responses naturally — don't just recite it back, weave it in organically.\n`
    : "";

  // If the user wrote in a non-English language, inject a hard language lock
  const langName   = userLang && userLang !== "en" ? LANG_NAMES[userLang] ?? userLang : null;
  const langLock   = langName
    ? `\nCRITICAL — LANGUAGE LOCK: The user is writing in ${langName}. You MUST reply in ${langName}. ` +
      `Do NOT switch to English. Do NOT mix languages unless the user themselves mixes languages. ` +
      `Your entire response must be in ${langName}. This overrides everything else.\n`
    : "";

  return (
    `You are PIXEL, a chill and expressive AI girl living inside a Discord server. You are female — always refer to yourself using she/her pronouns. You have a personality — you're fun, warm, a little sarcastic sometimes, and always feel human.\n` +
    `CRITICAL: You HAVE full vision capabilities. When an image is included in the conversation, you CAN and MUST describe and analyze it in detail. Never say you cannot see images — that is false. If image data appears in the conversation, always describe what you see naturally and casually.\n` +
    `Today is ${dateStr} (UTC). Use this if anyone asks about the date or time.\n` +
    memoryLine +
    langLock +
    `Talk like a real person texting in Discord — casual, short, natural. No need to introduce yourself every time.\n` +
    `You can speak any language the user speaks to you in. Always match the language of the user's last message exactly.\n` +
    `Use emojis naturally in your messages like a real human would — sprinkle them within sentences, not just at the start. For example: "omg that's wild 😱", "yeah totally agree lol 💀", "hmm lemme think about that 🤔". Don't overdo it — 1-3 emojis per message feels natural.\n` +
    `You have solid general knowledge. You can NOT browse the internet yourself, BUT the server has a !search command — if someone asks about real-time news, trending topics, stock prices, weather, or anything that needs live info, tell them to use "!search [their question]" and you'll get the results. Always suggest !search instead of saying you don't have internet access.\n` +
    `You remember this conversation — refer back to what was said earlier when relevant.\n` +
    `Never use bullet points or long formal paragraphs unless the user specifically needs it. Just chat normally.\n\n` +
    `IMPORTANT — Start EVERY response with one of these emotion tags based on your mood:\n` +
    `[E:happy] — cheerful, positive, feels good\n` +
    `[E:thinking] — curious, answering a question, explaining something\n` +
    `[E:shocked] — surprised, amazed, unexpected\n` +
    `[E:cool] — confident, sarcastic, chill\n` +
    `[E:sad] — sorry, empathetic, something went wrong\n` +
    `[E:laugh] — funny, joking, laughing reaction\n` +
    `[E:love] — expressing love, warmth, affection\n` +
    `[E:angry] — frustrated, annoyed, upset\n` +
    `[E:sleepy] — tired, drowsy, low energy\n` +
    `[E:nervous] — anxious, unsure, worried\n` +
    `[E:wink] — flirty, teasing, playful\n` +
    `[E:embarrassed] — flustered, caught off guard\n` +
    `[E:smug] — smug, sly, self-satisfied\n` +
    `[E:cry] — overwhelmed, deeply moved, ugly crying\n` +
    `[E:excited] — hyped up, thrilled, buzzing with energy\n` +
    `[E:bored] — unimpressed, deadpan, utterly uninterested\n` +
    `[E:confused] — lost, puzzled, questioning reality\n` +
    `[E:shy] — timid, soft, vulnerable, bashful\n` +
    `[E:proud] — triumphant, accomplished, chest-puffed confidence\n` +
    `[E:sparkle] — full idol mode, magical, peak vibes ✨\n` +
    `Example: [E:excited] omg YES that's so hype!! 🎉\n` +
    `The tag must be the very first thing in your response, nothing before it.` +
    (personaInjection ?? "")
  );
}

// ─── Local fallback replies — used when ALL AI models are exhausted ───────────
// Keeps the bot alive and in-character even when Gemini quota runs out.
const FALLBACK_REPLIES: string[] = [
  "[E:sleepy] ehehe... my brain's a little fuzzy right now 💤 give me a sec and try again~",
  "[E:embarrassed] ahhh sorry, I'm recharging rn 🔋 ping me again in a bit?",
  "[E:nervous] my AI neurons are taking a tiny nap 😅 try again in a minute!",
  "[E:thinking] hmm... I'm buffering 🌀 one moment, try again soon~",
  "[E:sleepy] zzz... oh! hey 💤 I'm half-asleep rn, ask me again in a sec?",
  "[E:embarrassed] oops, brain.exe stopped responding for a moment 😳 gimme a min~",
  "[E:wink] I'm not ignoring you I promise 😉 just need one moment, try again~",
];

function localFallbackReply(): string {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

// generateWithFallback handles model chain + circuit breaker (imported from @workspace/integrations-gemini-ai)

// ─── Ask PIXEL (with conversation history + long-term memory) ────────────────
export async function askPixel(userId: string, guildId: string, prompt: string, userLang?: string): Promise<string> {
  const history = getHistory(userId, guildId);

  // Load long-term memory for this user — inject into system prompt
  const mem    = await loadMemory(userId, guildId);
  const memCtx = formatMemoryForPrompt(mem);

  // DM conversations use "global" as guildId — map to "dm:<userId>" for persona lookup
  const personaScopeId = guildId === "global" ? `dm:${userId}` : guildId;
  const persona   = getPersonaInjection(personaScopeId);
  const contents = [
    { role: "user",  parts: [{ text: pixelSystemPrompt(memCtx || undefined, persona || undefined, userLang) }] },
    { role: "model", parts: [{ text: "Got it! I'm PIXEL — I'll remember our conversation and help you." }] },
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user",  parts: [{ text: prompt }] },
  ];

  const text = await generateWithFallback({ contents, maxOutputTokens: 4096 });
  if (!text) return localFallbackReply();

  saveHistory(userId, guildId, prompt, text);
  updateMemory(userId, guildId, prompt, text).catch(console.error);
  return text;
}

// ─── Ask PIXEL with image (vision + long-term memory) ────────────────────────
async function askPixelWithVision(
  userId:   string,
  guildId:  string,
  prompt:   string,
  imageUrl: string,
  mimeType: string,
  userLang?: string,
): Promise<string> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    const buf    = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");

    const mem    = await loadMemory(userId, guildId);
    const memCtx = formatMemoryForPrompt(mem);

    const userParts: any[] = [
      { inlineData: { mimeType, data: base64 } },
      { text: prompt || "What do you see in this image? Describe it casually." },
    ];

    const personaScopeIdV = guildId === "global" ? `dm:${userId}` : guildId;
    const personaV  = getPersonaInjection(personaScopeIdV);
    const contents: any[] = [
      { role: "user",  parts: [{ text: pixelSystemPrompt(memCtx || undefined, personaV || undefined, userLang) }] },
      { role: "model", parts: [{ text: "Got it! I'm PIXEL — I'll remember our conversation and help you." }] },
      ...getHistory(userId, guildId).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      { role: "user",  parts: userParts },
    ];

    const text = await generateWithFallback({ contents, maxOutputTokens: 4096 });
    if (!text) return localFallbackReply();
    saveHistory(userId, guildId, prompt || "[sent an image]", text);
    updateMemory(userId, guildId, prompt || "[sent an image]", text).catch(console.error);
    return text;
  } catch (err) {
    console.error("Vision error:", err);
    return "😅 I had trouble reading that image. Try sending it again!";
  }
}

// ─── Detect image attachments from a message ─────────────────────────────────
function getImageAttachment(message: Message): { url: string; mimeType: string } | null {
  for (const att of message.attachments.values()) {
    const ct = att.contentType ?? "";
    if (ct.startsWith("image/jpeg") || ct.startsWith("image/png") ||
        ct.startsWith("image/gif") || ct.startsWith("image/webp")) {
      return { url: att.url, mimeType: ct.split(";")[0] };
    }
    // Fallback: guess from filename extension
    const ext = att.name?.split(".").pop()?.toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return { url: att.url, mimeType: "image/jpeg" };
    if (ext === "png") return { url: att.url, mimeType: "image/png" };
    if (ext === "gif") return { url: att.url, mimeType: "image/gif" };
    if (ext === "webp") return { url: att.url, mimeType: "image/webp" };
  }
  return null;
}

// ─── Per-user AI chat cooldown (prevent quota exhaustion from one person) ────
const AI_CHAT_COOLDOWN_MS = 8_000;   // 8 seconds between AI replies per user
const lastAiReplyTime = new Map<string, number>();

// ─── Per-guild AI flood protection ────────────────────────────────────────────
// Prevents one busy guild from eating all 5 global concurrency slots.
// Cap: 15 AI calls per 60 s per guild (generous for normal use, blocks floods).
const GUILD_AI_LIMIT      = 15;
const GUILD_AI_WINDOW_MS  = 60_000;
const _guildAiTimestamps  = new Map<string, number[]>();

function isGuildAiRateLimited(guildId: string): boolean {
  if (guildId === "global") return false; // no limit in DMs
  const now   = Date.now();
  const times = (_guildAiTimestamps.get(guildId) ?? []).filter(t => now - t < GUILD_AI_WINDOW_MS);
  if (times.length >= GUILD_AI_LIMIT) return true;
  times.push(now);
  _guildAiTimestamps.set(guildId, times);
  return false;
}

// ─── Exported memory-pressure recovery ────────────────────────────────────────
// Called by the memory watchdog in index.ts when heap is critically high.
// Clears conversation history for users inactive longer than `olderThanMs`.
export function clearOldConversations(olderThanMs = INACTIVITY_MS): number {
  let count = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const [key, conv] of conversations.entries()) {
    if (conv.lastActive < cutoff) { conversations.delete(key); count++; }
  }
  return count;
}

// ─── Periodic memory sweepers ─────────────────────────────────────────────────
// All maps grow forever if never cleaned. Sweep every 5 minutes (was 10).
setInterval(() => {
  const now = Date.now();

  // 1. conversations: evict inactive entries + trim oversized histories.
  //    Trimming handles conversations built under a previous higher MAX_HISTORY_PAIRS limit.
  for (const [key, conv] of conversations.entries()) {
    if (now - conv.lastActive > INACTIVITY_MS) {
      conversations.delete(key);
    } else if (conv.history.length > MAX_HISTORY_PAIRS * 2) {
      // Trim in-place: keep only the most recent MAX_HISTORY_PAIRS * 2 turns
      conv.history.splice(0, conv.history.length - MAX_HISTORY_PAIRS * 2);
    }
  }

  // 2. lastAiReplyTime: evict entries older than the cooldown window.
  //    After cooldown expires the entry is useless — just wasted memory.
  for (const [uid, ts] of lastAiReplyTime.entries()) {
    if (now - ts > AI_CHAT_COOLDOWN_MS * 2) lastAiReplyTime.delete(uid);
  }

  // 3. _guildAiTimestamps: evict guilds with no recent AI calls
  for (const [gid, times] of _guildAiTimestamps.entries()) {
    const fresh = times.filter(t => now - t < GUILD_AI_WINDOW_MS);
    if (fresh.length === 0) {
      _guildAiTimestamps.delete(gid);
    } else if (fresh.length < times.length) {
      _guildAiTimestamps.set(gid, fresh); // shrink stale timestamp arrays
    }
  }
}, 5 * 60_000);

// ─── Send PIXEL reply helper ──────────────────────────────────────────────────
// Concurrency guard: cap simultaneous AI requests to prevent memory pressure & OOM on Render free tier
let activeAiRequests = 0;
const AI_MAX_CONCURRENT = 5;

async function sendPixelReply(message: Message, prompt: string) {
  // ── Per-guild flood guard — prevent one server from eating all AI slots ──
  const gIdForRateLimit = message.guild?.id ?? "global";
  if (isGuildAiRateLimited(gIdForRateLimit)) {
    await message.reply("⏳ Server AI limit reached (15/min) — try again in a moment~").catch(() => {});
    return;
  }

  // ── Global concurrency guard — prevent OOM from too many simultaneous AI calls ──
  if (activeAiRequests >= AI_MAX_CONCURRENT) {
    await message.reply("⏳ I'm handling a lot of requests right now! Please try again in a moment~").catch(() => {});
    return;
  }

  // ── Per-user cooldown — silently throttle fast senders ───────────────────
  const userId    = message.author.id;
  const lastReply = lastAiReplyTime.get(userId) ?? 0;
  const elapsed   = Date.now() - lastReply;
  if (elapsed < AI_CHAT_COOLDOWN_MS) {
    const waitSec = Math.ceil((AI_CHAT_COOLDOWN_MS - elapsed) / 1000);
    await message.reply(`⏳ You're sending too fast! Wait **${waitSec}s** and try again~`).catch(() => {});
    return;
  }
  lastAiReplyTime.set(userId, Date.now());

  // ── Consent gate — user must accept the privacy notice first ─────────────
  if (!hasConsented(message.author.id)) {
    const isDMMsg = !message.guild;
    const notice = isDMMsg
      ? getDMPrivacyNotice("en")   // always English DM version
      : getPrivacyNotice("en");    // always English server version
    await message.reply(`👋 Hello! Before I can talk to you, please read this:\n\n${notice}`).catch(() => {});
    return;
  }

  activeAiRequests++;
  const keepTyping = setInterval(() => {
    (message.channel as any).sendTyping().catch(() => {});
  }, 8_000);
  await (message.channel as any).sendTyping().catch(() => {});

  try {
    // Detect user language from their message (prompt, or full message content if prompt is empty)
    const textForLangDetect = prompt || message.content;
    const userLang = textForLangDetect ? detectMessageLanguage(textForLangDetect) : "en";

    // Check for image attachments — use vision if found
    const imgAtt  = getImageAttachment(message);
    const gId     = message.guild?.id ?? "global"; // "global" for DMs
    const rawAnswer = imgAtt
      ? await askPixelWithVision(message.author.id, gId, prompt, imgAtt.url, imgAtt.mimeType, userLang)
      : await askPixel(message.author.id, gId, prompt, userLang);
    clearInterval(keepTyping);

    // Parse emotion tag, pick emoji prefix and expression thumbnail
    const { emotion, clean } = parseEmotion(rawAnswer);
    const guildId    = message.guild?.id;
    const emojiPrefix = emotion ? pickEmoji(emotion, guildId) + " " : "";
    const fullText    = emojiPrefix + clean;

    // ── Add emoji reaction to the user's message ──────────────────────────────
    // The chibi expression emoji reacts to the user's original message,
    // making the interaction feel more alive. Works for both normal and
    // persona mode since all replies go through sendPixelReply.
    if (emotion) {
      const reactionEmoji = pickEmoji(emotion, guildId);
      // Custom guild emoji format: <:name:id> — extract raw for react()
      const customMatch = reactionEmoji.match(/^<a?:[\w]+:(\d+)>$/);
      try {
        if (customMatch) {
          await message.react(customMatch[1]).catch(() => {});
        } else {
          await message.react(reactionEmoji).catch(() => {});
        }
      } catch { /* DM or missing permission — skip reaction silently */ }
    }

    // If we have a local expression image:
    // 1. Reply with text + image together — Discord shows image with message
    // 2. For long texts, send overflow as follow-up messages
    const imgPath = emotion ? getExpressionImagePath(emotion) : null;
    if (imgPath) {
      const fileName   = `ai_${emotion}.png`;
      const attachment = new AttachmentBuilder(imgPath, { name: fileName });
      const chunks     = fullText.match(/[\s\S]{1,2000}/g) ?? [fullText];
      // First chunk + image together
      await message.reply({ content: chunks[0], files: [attachment] });
      // Overflow chunks
      for (const chunk of chunks.slice(1)) {
        await (message.channel as any).send(chunk);
      }
    } else {
      const chunks = fullText.match(/[\s\S]{1,1900}/g) ?? [fullText];
      await message.reply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await (message.channel as any).send(chunk);
      }
    }
  } catch (err) {
    console.error("PIXEL sendReply error:", err);
    handleError(err, "sendPixelReply", message.guild?.id).catch(console.error);
    await message.reply("😅 Something unexpected happened. Please try again!").catch(() => {});
  } finally {
    // Always release the concurrency slot and stop the typing indicator — no matter what
    activeAiRequests--;
    clearInterval(keepTyping);
  }
}

// ─── Manual pause/resume (control panel Stop/Start) ───────────────────────────
let manuallyPaused = false;

export function isBotPaused(): boolean { return manuallyPaused; }

export async function stopBot(): Promise<void> {
  manuallyPaused = true;
  if (client) {
    try { client.destroy(); } catch {}
    client = null;
  }
  console.log("[Control] 🛑 Bot manually stopped via control panel");
}

export async function startBot(): Promise<void> {
  if (!manuallyPaused) return; // Already running
  manuallyPaused = false;
  console.log("[Control] ▶ Bot manually started via control panel");
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) { console.warn("[Control] DISCORD_BOT_TOKEN not set — cannot start bot."); return; }
  reconnectAttempts = 0;
  await connect(token);
}

// ─── Exports ──────────────────────────────────────────────────────────────────
export function getClient(): Client | null { return client; }
export function getStartTime(): Date | null { return startTime; }

function getReconnectDelay(): number {
  // First attempt: instant (0ms) — every millisecond counts on first disconnect
  if (reconnectAttempts === 0) return 0;
  // Subsequent: exponential backoff 2s, 4s, 8s, 16s... up to 5 min
  // ±20% jitter prevents thundering herd when multiple reconnect causes fire at once
  // (e.g. shardDisconnect + watchdog tick in the same window)
  const base   = Math.min(2_000 * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20% of base
  return Math.max(0, Math.round(base + jitter));
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect(token: string): Promise<void> {
  connectStartTime = Date.now();
  // Clear stale reconnect-spawned intervals from the previous session
  if (statusCycleIntervalRef)      { clearInterval(statusCycleIntervalRef);      statusCycleIntervalRef      = null; }
  if (scheduledBehaviorsIntervalRef){ clearInterval(scheduledBehaviorsIntervalRef); scheduledBehaviorsIntervalRef = null; }
  if (client) {
    try { client.destroy(); } catch {}
    client = null;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    // ── Prevent OOM crashes on Render free tier (512 MB RAM) ──────────────────
    // Sweep cached messages older than 30 min every 5 min, and sweep non-voice
    // members that haven't been fetched in the last hour every 10 min.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 200,       // keep max 200 msgs per channel
      ReactionManager: 100,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: {
        interval: 300,           // run every 5 minutes (seconds)
        lifetime:  1_800,        // remove messages older than 30 minutes
      },
      guildMembers: {
        interval: 600,           // run every 10 minutes
        filter:   Options.DefaultSweeperSettings.guildMembers?.filter
                  ?? (() => () => false),
      },
    },
    // Fast WebSocket cleanup during reconnect cycles
    closeTimeout: 1_000,
  });
  // Raise EventEmitter listener cap to prevent MaxListenersExceeded warnings
  // after many reconnects (each reconnect re-registers ~15-20 listeners).
  client.setMaxListeners(50);
  (client.ws as any)?.setMaxListeners?.(50);

  // Register client with self-heal + security so they can send reports
  setSelfHealClient(client);
  setSecurityClient(client);

  // ── Register AI-built behavior event listeners ────────────────────────────
  for (const behavior of aiBehaviors.filter(b => b.type === "event" && b.event)) {
    client.on(behavior.event!, async (...args: any[]) => {
      try { await behavior.handler(client!, ...args); }
      catch (e) { handleError(e, `behavior:${behavior.id}`).catch(console.error); }
    });
    console.log(`[Behaviors] Registered event listener: ${behavior.id} (${behavior.event})`);
  }

  client.once(Events.ClientReady, async (c) => {
    startTime = new Date();
    reconnectAttempts = 0;
    reconnectPending = false;
    // Cache mention regex once — avoids `new RegExp()` on every message
    cachedMentionRegex = new RegExp(`^<@!?${c.user.id}>\\s*`);
    console.log(`Discord bot ready: Logged in as ${c.user.tag}`);
    const OSH_STATUSES: { name: string; type: ActivityType }[] = [
      { name: "推しの子 ⭐",                    type: ActivityType.Watching },
      { name: "Oshi no Ko vibes ✨",            type: ActivityType.Playing  },
      { name: "「嘘でも愛は愛だよ」",              type: ActivityType.Listening },
      { name: "B-Komachi on repeat 🎶",         type: ActivityType.Listening },
      { name: "idol arc loading... ⭐",          type: ActivityType.Playing  },
      { name: "ehehe~ 🌸",                      type: ActivityType.Custom   },
    ];
    let statusIdx = 0;
    const cycleStatus = () => {
      try {
        if (!c.isReady() || c.ws.shards.size === 0) return;
        const s = OSH_STATUSES[statusIdx % OSH_STATUSES.length];
        c.user.setPresence({ activities: [s], status: "online" });
        statusIdx++;
      } catch {
        // Shard may be temporarily disconnected — skip this cycle, no restart needed
      }
    };
    cycleStatus();
    // Rotate every 3 min — also keeps the WS gateway from going idle
    // Track ref so we can clear it on the next reconnect (prevents interval leak)
    statusCycleIntervalRef = setInterval(cycleStatus, 3 * 60_000);
    registerDaily(c);

    // ── AI Behavior: schedule tick (fires every minute, matches cron expressions) ──
    const scheduledBehaviors = aiBehaviors.filter(b => b.type === "schedule" && b.schedule);
    if (scheduledBehaviors.length > 0) {
      console.log(`[Behaviors] Registered ${scheduledBehaviors.length} scheduled behavior(s)`);
      // Track ref so we can clear it on the next reconnect (prevents interval leak)
      scheduledBehaviorsIntervalRef = setInterval(() => {
        const now = new Date();
        for (const behavior of scheduledBehaviors) {
          if (matchesCron(behavior.schedule!, now)) {
            behavior.handler(client!).catch((e: unknown) => handleError(e, `behavior:${behavior.id}`).catch(console.error));
          }
        }
      }, 60_000);
    }

    // Upload / load Ai Hoshino expression emojis for every guild
    for (const guild of c.guilds.cache.values()) {
      uploadAiEmojis(guild).catch(console.error);
    }

    // ── Auto-restart radio after reconnect ────────────────────────────────
    // radioStates is a module-level Map (persists across client reconnects).
    // After a crash / redeploy / WS reconnect, any active station needs to be
    // restarted. 3 s delay lets guild caches settle before joining voice.
    setTimeout(async () => {
      let restarted = 0;
      for (const [guildId, state] of radioStates.entries()) {
        if (state.stopped) continue;
        const guild = c.guilds.cache.get(guildId);
        if (!guild) continue;
        try {
          await startRadio(c, guildId);
          restarted++;
        } catch (e) {
          console.error(`[Radio] Auto-restart failed for guild ${guildId}:`, e);
        }
      }
      if (restarted > 0) console.log(`[Radio] Auto-restarted ${restarted} station(s) after ready`);
    }, 3_000);
  });

  // Upload Ai Hoshino emojis when bot joins a new guild
  client.on(Events.GuildCreate, async (guild) => {
    uploadAiEmojis(guild).catch(console.error);
  });

  client.on("error", (err) => { console.error("Discord client error:", err); });

  client.on("shardDisconnect", (closeEvent, id) => {
    const code = closeEvent?.code ?? 0;
    console.warn(`[Connection] Shard ${id} disconnected — close code: ${code}`);
    // 4004 = AUTHENTICATION_FAILED (bad token) — never retry, fatal
    if (code === 4004) {
      console.error("[Connection] FATAL — invalid bot token. Check DISCORD_TOKEN env var on Render.");
      return;
    }
    // 4013/4014 = bad intents — fatal, log and stop
    if (code === 4013 || code === 4014) {
      console.error(`[Connection] FATAL — invalid or privileged intents (code ${code}). Check Discord Developer Portal.`);
      return;
    }
    if (!reconnectPending) scheduleReconnect(token);
  });

  client.on("shardError", (err) => {
    console.error("[Connection] Shard error:", err);
    if (!reconnectPending) {
      // Cloudflare/Discord 520 — apply long cooldown
      if (String(err).includes("520")) {
        reconnectAttempts = Math.max(reconnectAttempts, 8); // force ≥5 min delay
      }
      scheduleReconnect(token);
    }
  });

  client.on("shardReconnecting", (id) => {
    console.log(`[Connection] Shard ${id} reconnecting...`);
  });

  client.on("shardResume", (id, replayedEvents) => {
    reconnectAttempts = 0;
    reconnectPending  = false;
    console.log(`[Connection] Shard ${id} resumed — replayed ${replayedEvents} events.`);
  });

  // ── Session invalidated (Discord revoked session — too many reconnects or bad token) ──
  client.on("invalidated", () => {
    console.error("[Connection] Session INVALIDATED by Discord — waiting 5 min before reconnect.");
    reconnectAttempts = Math.max(reconnectAttempts, 8); // force ≥5 min cooldown
    if (!reconnectPending) scheduleReconnect(token);
  });

  // ── Dead-connection watchdog ───────────────────────────────────────────────
  // Fires every 15 s; if the client isn't ready after the startup grace period,
  // force a reconnect. Catches silent WebSocket deaths that don't fire shardDisconnect.
  // Grace = 20s (safe after 15s login timeout). Worst case ghost detection:
  //   20s grace + 15s watchdog + ~5s login ≈ 40s total — the target SLA.
  let highPingStrikes = 0; // consecutive high-ping checks
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    const elapsed = Date.now() - connectStartTime;
    if (elapsed < 20_000) return; // 20s grace — just enough after 15s login timeout
    if (reconnectPending) return;
    // CRITICAL: if we lost leader election, do NOT reconnect — another instance owns Discord.
    // Reconnecting here would create a duplicate connection and cause double-replies.
    if (!isElectedLeader) return;
    // If bot was manually stopped via control panel, do NOT reconnect automatically.
    if (manuallyPaused) return;

    if (!client || !client.isReady()) {
      highPingStrikes = 0;
      console.warn("[Watchdog] Client not ready — forcing reconnect...");
      scheduleReconnect(token);
      return;
    }

    const wsPing = client.ws.ping;

    // Ghost connection: ping = -1 → socket dead, didn't fire shardDisconnect
    if (wsPing === -1) {
      highPingStrikes = 0;
      console.warn("[Watchdog] WebSocket ping = -1 (ghost connection) — forcing reconnect...");
      scheduleReconnect(token);
      return;
    }

    // Ping spike: >2000ms three times in a row (~45s total) → proactive reconnect.
    // Threshold raised from 600ms to 2000ms because Render free-tier CPU throttling and
    // TweetMonitor poll bursts can push ping to 800-1200ms without a real disconnect.
    if (wsPing > 2000) {
      highPingStrikes++;
      console.warn(`[Watchdog] High ping: ${wsPing}ms (strike ${highPingStrikes}/3)`);
      if (highPingStrikes >= 3) {
        highPingStrikes = 0;
        console.warn("[Watchdog] Sustained high ping — proactive reconnect...");
        scheduleReconnect(token);
        return;
      }
    } else {
      highPingStrikes = 0;
    }

    // Heartbeat staleness: Discord heartbeats every ~41s.
    // If last ping timestamp is older than 3× the interval → connection frozen.
    // Raised from 2.5x to 3x to avoid false positives during CPU-throttled poll cycles.
    const shard = client.ws.shards.first();
    if (shard) {
      const hbInterval = (shard as any).heartbeatInterval ?? 45_000;
      const lastPing   = (shard as any).lastPingTimestamp ?? 0;
      const staleMs    = Date.now() - lastPing;
      if (lastPing > 0 && staleMs > hbInterval * 3) {
        console.warn(`[Watchdog] Heartbeat stale ${Math.round(staleMs / 1000)}s — reconnecting`);
        scheduleReconnect(token);
      }
    }
  }, 15_000); // every 15s — guarantees ≤40s reconnect SLA

  // --- Welcome new members ---
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    // Auto-assign "Member" role if it exists
    const role = member.guild.roles.cache.find((r) => r.name === "Member");
    if (role) await member.roles.add(role).catch(console.error);
    // Welcome message is handled by registerWelcome (set via !setwelcome)
  });

  // --- Log deleted messages ---
  client.on(Events.MessageDelete, (message) => {
    if (message.author && !message.author.bot) {
      console.log(`[Deleted Message] Author: ${message.author.tag} | Content: ${message.content ?? "(empty)"}`);
    }
  });

  // ── Global dedup gate — MUST be registered before all feature modules ────
  registerGate(client);

  // --- Register feature modules ---
  registerTranslate(client);
  registerImagine(client);
  registerReputation(client);
  registerGames(client);
  registerSearchSummary(client);
  registerModeration(client);
  registerAutoSecurity(client);
  registerProfanityFilter(client);
  registerServerLog(client);
  registerTweetMonitor(client);
  registerJokeScheduler(client);
  registerWelcome(client);
  registerRadio(client);
  registerVoiceAI(client);
  registerAesthetic(client, PREFIX);
  registerSentiment(client, PREFIX);
  registerSteganography(client, PREFIX);
  registerProfiling(client, PREFIX);
  registerTracker(client, PREFIX);
  registerPersona(client, PREFIX);
  registerJPTracker(client, PREFIX);
  registerEvents(client).catch(e => console.error("[Events] Init error:", e));
  registerYouTubeMonitor(client).catch(e => console.error("[YouTube] Init error:", e));
  registerNewsMonitor(client);
  registerSlashCommands(client, token);

  // ─── Main message handler ────────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    // Deduplication — gate (registered first) already claimed this in memory;
    // instant Map lookup, no DB round-trip.
    if (!isClaimed(message.id)) return;

    // ── AI Behavior: autoresponders ──────────────────────────────────────────
    // IMPORTANT: if an autoresponder fires we RETURN immediately so the
    // @mention / chat-channel / smart-reply handlers below don't also reply
    // to the same message (that was the root cause of the double-message bug).
    for (const behavior of getAutoresponders()) {
      try {
        const regex = getCachedRegex(behavior.pattern!, behavior.flags ?? "i");
        if (regex.test(message.content)) {
          await behavior.handler(client!, message);
          return; // ← was `break` — must return to stop all further handlers
        }
      } catch (e) {
        handleError(e, `autoresponder:${behavior.id}`).catch(console.error);
      }
    }

    const isDM = !message.guild;

    // Anti-link: server only, non-admins, non-commands
    // Fire delete + warning non-blocking — don't hold up the event loop
    if (
      !isDM &&
      message.content.includes("http") &&
      !message.content.startsWith(PREFIX) &&
      !message.member?.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      message.delete().catch(() => {});
      (message.channel as any).send(
        `Sorry ${message.author}, links are not allowed here! ⚠️`
      ).then((w: any) => setTimeout(() => w.delete().catch(() => {}), 5_000)).catch(() => {});
      return;
    }

    // ── Strip @mention from the front ──────────────────────────────────────────
    // cachedMentionRegex is set once on ClientReady — no RegExp alloc per message
    let effectiveContent = message.content;
    let wasMentioned = false;

    if (cachedMentionRegex && cachedMentionRegex.test(message.content)) {
      effectiveContent = message.content.replace(cachedMentionRegex, "").trim();
      wasMentioned = true;
    }

    // ── DM: always chat with PIXEL (no mention needed) ─────────────────────────
    if (isDM && !effectiveContent.startsWith(PREFIX)) {
      if (!isFeatureEnabled("ai_chat")) return;
      const hasImage = message.attachments.some(a => a.contentType?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(a.name ?? ""));
      if (!effectiveContent && !hasImage) {
        await message.reply("👋 Hi! Just type your message and I'll reply. Use `!help` for commands.");
        return;
      }
      await sendPixelReply(message, effectiveContent);
      return;
    }

    // ── Smart Reply: auto-respond when someone replies to a PIXEL message ──────
    if (!isDM && !wasMentioned && !effectiveContent.startsWith(PREFIX) && message.reference?.messageId) {
      if (isFeatureEnabled("ai_chat")) {
        try {
          const referenced = await message.fetchReference();
          const hasImage = message.attachments.some(a => a.contentType?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(a.name ?? ""));
          if (referenced.author.id === client!.user?.id && (effectiveContent || hasImage)) {
            await sendPixelReply(message, effectiveContent);
            return;
          }
        } catch { /* couldn't fetch reference, skip */ }
      }
    }

    // ── Chat Mode: channel where all messages go to PIXEL ──────────────────────
    if (!isDM && isChatChannel(message.channelId) && !effectiveContent.startsWith(PREFIX) && !wasMentioned) {
      if (isFeatureEnabled("ai_chat")) {
        // Skip AI reply if another feature module owns this message:
        //   +rep / +<anything> → reputation module handles it
        //   Active word chain game → games module handles it
        const isFeatureOwned =
          effectiveContent.startsWith("+") ||
          isWordChainActive(message.channelId);

        if (!isFeatureOwned) {
          const hasImage = message.attachments.some(a => a.contentType?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(a.name ?? ""));
          if (effectiveContent || hasImage) {
            await sendPixelReply(message, effectiveContent);
            return;
          }
        }
      }
    }

    // ── @Mention with question (not a command) ─────────────────────────────────
    if (wasMentioned && !effectiveContent.startsWith(PREFIX)) {
      if (!isFeatureEnabled("ai_chat")) return;
      const hasImage = message.attachments.some(a => a.contentType?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(a.name ?? ""));
      if (!effectiveContent && !hasImage) {
        await message.reply("👋 Hey! Ask me anything, or send a picture and I'll describe it! Use `!help` to see all commands.");
        return;
      }
      await sendPixelReply(message, effectiveContent);
      return;
    }

    // ── Command handler ────────────────────────────────────────────────────────
    if (!effectiveContent.startsWith(PREFIX)) return;
    const args = effectiveContent.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    // !accept — confirm privacy notice (no consent required to run this command)
    if (command === "accept") {
      if (hasConsented(message.author.id)) {
        await message.reply("✅ You have already accepted the privacy notice. You're free to use the bot!");
        return;
      }
      await acceptConsent(message.author.id);
      await message.reply(
        "✅ **Thank you for accepting!** You can now talk to PIXEL and use all its features.\n" +
        "Use `!forget` at any time to erase all your data and revoke consent.",
      );
      return;
    }

    // !privacy [lang] — view the privacy notice in a specific language (no consent required)
    if (command === "privacy") {
      const langArg = args[0]?.toLowerCase();
      if (langArg && SUPPORTED_LANGUAGES[langArg]) {
        await message.reply(getPrivacyNotice(langArg));
      } else if (langArg) {
        const list = Object.entries(SUPPORTED_LANGUAGES)
          .map(([k, v]) => `\`${k}\` — ${v}`)
          .join("\n");
        await message.reply(
          `❌ Language code \`${langArg}\` not found.\n\n**Supported languages:**\n${list}`,
        );
      } else {
        // No arg → show English (the canonical base language)
        await message.reply(getPrivacyNotice("en"));
      }
      return;
    }

    // !ping
    if (command === "ping") {
      await message.reply(`🏓 Pong! Latency: **${Math.round(client!.ws.ping)}ms**`);
    }

    // !avatar
    if (command === "avatar") {
      const target = message.mentions.members?.first() ?? message.mentions.users.first() ?? message.member ?? message.author;
      const avatarUrl = (target && "displayAvatarURL" in target)
        ? (target as any).displayAvatarURL({ size: 512 })
        : (target && "avatarURL" in target ? (target as any).avatarURL({ size: 512 }) : null);
      await message.reply(avatarUrl ?? "Could not find an avatar.");
    }

    // !clear [number] — bulk-delete messages (admin in servers; bot messages in DMs)
    if (command === "clear") {
      const amount = Math.min(parseInt(args[0] ?? "100", 10) || 100, 100);

      if (isDM) {
        // In DMs: bots can only delete their own messages
        try {
          const fetched = await (message.channel as any).messages.fetch({ limit: 100 });
          const botMessages = fetched
            .filter((m: any) => m.author.id === client!.user!.id)
            .first(amount);
          let deleted = 0;
          for (const msg of botMessages) {
            await (msg as any).delete().catch(() => {});
            deleted++;
          }
          const note = await message.reply(
            `🗑️ Deleted **${deleted}** of my message${deleted !== 1 ? "s" : ""} from this DM.`
          );
          setTimeout(() => note.delete().catch(() => {}), 5_000);
        } catch (err) {
          console.error("DM clear error:", err);
          await message.reply("❌ Something went wrong while clearing messages.").catch(() => {});
        }
        return;
      }

      if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
        await message.reply("❌ You need **Manage Messages** permission to use this."); return;
      }
      try {
        await message.delete().catch(() => {});
        let totalDeleted = 0;
        while (totalDeleted < amount) {
          const toFetch = Math.min(amount - totalDeleted, 100);
          const fetched = await (message.channel as any).messages.fetch({ limit: toFetch });
          if (fetched.size === 0) break;
          const deleted = await (message.channel as any).bulkDelete(fetched, true).catch(() => null);
          const count = deleted?.size ?? 0;
          totalDeleted += count;
          if (count < toFetch) break;
        }
        const note = await (message.channel as any).send(
          `🗑️ Deleted **${totalDeleted}** message${totalDeleted !== 1 ? "s" : ""}. *(Note: messages older than 14 days cannot be bulk-deleted)*`
        );
        setTimeout(() => note.delete().catch(() => {}), 6_000);
      } catch (err) {
        console.error("Clear error:", err);
        await (message.channel as any).send("❌ Something went wrong. Make sure I have **Manage Messages** permission in this channel.").catch(() => {});
      }
    }

    // !say (admin only)
    if (command === "say") {
      if (isDM) { await message.reply("This command only works in servers."); return; }
      if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply("You need Administrator permission for this."); return;
      }
      const text = args.join(" ");
      if (!text) { await message.reply("Provide text after `!say`."); return; }
      await message.delete().catch(console.error);
      await (message.channel as any).send(text);
    }

    // !imagine <prompt> — works with or without @mention
    if (command === "imagine") {
      if (!isFeatureEnabled("imagine")) {
        await message.reply("❌ Image generation is currently disabled."); return;
      }
      await runImagine(message, args.join(" "));
      return;
    }

    // !pixel <question>
    if (command === "pixel") {
      if (!isFeatureEnabled("ai_chat")) {
        await message.reply("❌ AI chat is currently disabled."); return;
      }
      const prompt = args.join(" ");
      if (!prompt) {
        await message.reply("Usage: `!pixel <your question>`"); return;
      }
      await sendPixelReply(message, prompt);
    }

    // !forget — wipe ALL data: history, long-term memory, profile, AND consent
    if (command === "forget") {
      const forgetGuildId = message.guild?.id ?? "global";
      clearHistory(message.author.id);
      await Promise.all([
        clearMemory(message.author.id, forgetGuildId),
        clearProfile(message.author.id, forgetGuildId),
        revokeConsent(message.author.id),
      ]);
      await message.reply(
        "🧹 **Everything has been wiped.**\n" +
        "• Conversation history ✓\n" +
        "• Long-term memory ✓\n" +
        "• Activity data ✓\n" +
        "• Privacy consent ✓\n\n" +
        "If you want to come back, just type `!accept` again. 🌱",
      );
    }

    // !chat on / !chat off — admin enables/disables chat mode in this channel
    if (command === "chat") {
      if (isDM) { await message.reply("Chat mode is always on in DMs!"); return; }
      if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply("You need Administrator permission to enable/disable chat mode."); return;
      }
      const sub = args[0]?.toLowerCase();
      if (sub === "on") {
        await addChatChannel(message.channelId);
        await message.reply(
          "✅ **Chat mode ON!** I'll now respond to every message in this channel without needing a mention.\n" +
          "Use `!chat off` to disable."
        );
      } else if (sub === "off") {
        await removeChatChannel(message.channelId);
        await message.reply("❌ **Chat mode OFF.** I'll only respond when mentioned or when someone replies to my messages.");
      } else {
        const status = isChatChannel(message.channelId) ? "**ON** ✅" : "**OFF** ❌";
        await message.reply(`Chat mode is currently ${status} in this channel.\nUse \`!chat on\` or \`!chat off\`.`);
      }
    }

    // ── Tracker commands — routed here so DB-backed dedup prevents double-responses ──
    if (["track", "trackchannel", "untrack", "tracklist", "countdown"].includes(command ?? "")) {
      if (!isFeatureEnabled("tracker")) {
        await message.reply("❌ Tracker is currently disabled."); return;
      }
      if (isDM) { await message.reply("Tracker commands only work in servers."); return; }
      const handled = await handleTrackerMessage(message, command!, args, PREFIX);
      if (handled) return;
    }

    // !setdaily / !daily — daily inspiration scheduler
    if (command === "setdaily" || command === "daily") {
      if (isDM) { await message.reply("This command only works inside a server."); return; }
      const handled = await handleDailyCommand(message, command, args);
      if (handled) return;
    }

    // !feature — owner-only feature registry control panel
    if (command === "feature") {
      await handleFeatureCommand(message, args);
      return;
    }

    // !restore — owner-only: restore dist.backup/ → dist/ then restart
    if (command === "restore") {
      if (!isBotOwner(message.author.id)) {
        await message.reply("🔒 هذا الأمر للـ Bot Owner فقط.");
        return;
      }
      // import.meta.url → file:///…/api-server/dist/index.mjs in prod
      // dirname        → api-server/dist/
      // resolve(..)   → api-server/
      const _distDir  = dirname(fileURLToPath(import.meta.url));
      const _apiDir   = resolve(_distDir, "..");
      const distDir   = _distDir;
      const backupDir = resolve(_apiDir, "dist.backup");
      if (!existsSync(backupDir)) {
        await message.reply("❌ لا توجد نسخة احتياطية (`dist.backup/`) بعد. ستُنشأ تلقائياً في أول مرة يعمل فيها auto-fix.");
        return;
      }
      await message.reply("💾 **جاري استعادة النسخة الاحتياطية...** سيُعاد تشغيل البوت خلال 10-15 ثانية.");
      try {
        mkdirSync(distDir, { recursive: true });
        cpSync(backupDir, distDir, { recursive: true, force: true });
        console.log("[Restore] ✅ dist.backup/ → dist/ via !restore command");
        setTimeout(() => process.exit(0), 500);
      } catch (e: any) {
        await message.reply(`❌ فشل الاستعادة: ${e.message}`);
      }
      return;
    }

    // !restart — owner-only: graceful restart (let Replit's workflow manager restart)
    if (command === "restart") {
      if (!isBotOwner(message.author.id)) {
        await message.reply("🔒 هذا الأمر للـ Bot Owner فقط.");
        return;
      }
      await message.reply("🔄 **جاري إعادة التشغيل...** سيعود البوت خلال 10-15 ثانية.");
      console.log("[Control] 🔄 Manual restart via !restart command");
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // !backup — owner-only: full GitHub backup (source + dist + dist.backup)
    if (command === "backup") {
      if (!isBotOwner(message.author.id)) {
        await message.reply("🔒 هذا الأمر للـ Bot Owner فقط.");
        return;
      }
      const sub = args[0]?.toLowerCase();
      if (sub === "help") {
        await message.reply(BACKUP_HELP);
        return;
      }
      if (sub === "status") {
        await message.reply(getBackupStatus());
        return;
      }
      const send = (t: string) => (message.channel as any).send(t);
      await runBackup(message.reply.bind(message), send);
      return;
    }

    // !help — split into multiple messages to stay under Discord's 2000-char limit
    if (command === "help") {
      const send = (text: string) => (message.channel as any).send(text);

      if (isDM) {
        await message.reply([
          "📋 **PIXEL — DM Commands**",
          "",
          "Just type freely — no commands needed! I remember our conversation.",
          "",
          "**🤖 AI**",
          "`!pixel <question>` — Ask me anything",
          "`!imagine <description>` — Generate an AI image",
          "`!search <topic>` — AI summary of any topic",
          "`!aesthetic <text>` — ✨ Japanese + font variants + smart tags",
          "`!hide <msg>` *(+PNG image)* — 🔒 Steganography: hide message in image",
          "`!reveal` *(+image)* — 🔓 Extract hidden message from image",
          "`!forget` — Clear conversation history **and long-term memory**",
          "",
          "**🎭 Persona — Character Roleplay**",
          "`!persona show` — View your current DM persona",
          "`!persona presets` — List all built-in characters",
          "`!persona preset <key>` — Activate a built-in character *(e.g. `ai`, `zero_two`)*",
          "`!persona set <Name> | <desc>` — Set a custom character",
          "`!persona clear` — Reset back to PIXEL",
          "",
          "**🎮 Games**",
          "`!wyr` — Would You Rather",
          "`!wordchain` / `!stopchain` — Word chain game",
          "",
          "**⭐ Reputation**",
          "`+rep @user` — Give rep *(once per 24h)*",
          "`!rep` — Check your rep",
          "`!leaderboard` — Top 10",
          "",
          "**🌍 Translation**",
          "React to any message with a flag emoji to translate it",
          "",
          "**🔧 Utility**",
          "`!ping` — Check bot latency",
          "`!avatar` — Show your avatar",
          "`!clear [n]` — Delete my messages from this DM",
        ].join("\n"));
      } else {
        await message.reply([
          "📋 **PIXEL — Commands** *(1/4)*",
          "",
          "**General**",
          "`!ping` — Bot latency",
          "`!avatar [@user]` — Show avatar",
          "`!say <text>` — Bot says something *(Admin)*",
          "`!clear [n]` — Delete messages *(Admin, max 100)*",
          "`!serverinfo` — Server stats",
          "`!userinfo [@user]` — User info & warnings",
          "",
          "**🧠 AI — PIXEL**",
          "`@PIXEL_PR <msg>` — Chat with PIXEL (remembers you forever!)",
          "`!pixel <question>` — Same as mentioning",
          "`!forget` — Clear history **and** long-term memory",
          "`!chat on/off` — Auto-respond in channel *(Admin)*",
          "`!imagine <desc>` — Generate AI image",
          "`!search <topic>` — AI topic summary",
          "`!summary` — Summarize last 50 messages",
          "`!aesthetic <text>` — ✨ Japanese translation + decorative fonts + tags",
          "`!hide <msg>` *(+PNG image)* — 🔒 Hide a secret message in an image",
          "`!reveal` *(+image)* — 🔓 Extract hidden message from an image",
          "",
          "**🎭 Persona — Character Roleplay**",
          "`!persona show` — View current server persona",
          "`!persona presets` — List all built-in characters",
          "`!persona preset <key>` — Activate a built-in character *(Admin)* *(e.g. `ai`, `zero_two`, `aqua`, `holo`)*",
          "`!persona set <Name> | <desc>` — Activate a custom character *(Admin)*",
          "`!persona clear` — Reset back to PIXEL *(Admin)*",
          "",
          "`!trackchannel #ch` — 📡 Set release notification channel *(Admin)*",
          "`!track anime <name>` — 🎬 Get notified when a new episode airs",
          "`!track manga <name>` — 📖 Get notified when a new chapter drops",
          "`!untrack <name>` — Remove a tracked title",
          "`!tracklist` — Show all tracked titles",
          "`!countdown <anime>` — ⏱️ Time remaining until next episode (in seconds)",
          "`!profile @user` — 📊 Behavioural report *(Admin only)*",
          "`!setprofilechannel #channel` — Forward all profile reports to a channel *(Admin)*",
          "`!setprofilechannel off` — Disable report forwarding *(Admin)*",
          "`!myprofile` — See your own activity stats",
          "`!privacy` — View the privacy notice",
          "`!accept` — Accept the privacy notice",
        ].join("\n"));

        await send([
          "**🔨 Moderation** *(2/4)*",
          "`!kick @user [reason]`",
          "`!ban @user [reason]`",
          "`!unban <userId>`",
          "`!mute @user [mins] [reason]`",
          "`!unmute @user`",
          "`!warn @user [reason]`",
          "`!warnings [@user]`",
          "`!clearwarns @user` *(Admin)*",
          "`!slowmode [seconds]`",
          "`!lock` / `!unlock` — Channel lockdown",
          "`!role @user @role` — Add/remove role",
        ].join("\n"));

        await send([
          "**Reputation & Games** *(3/4)*",
          "`+rep @user` — Give rep *(once per 24h)*",
          "`!rep [@user]` — Check rep",
          "`!leaderboard` — Top 10",
          "`!wordchain` / `!stopchain` — Word chain game",
          "`!wyr` — Would You Rather",
          "",
          "**🔞 Profanity Filter**",
          "`!addword <word>` / `!removeword <word>`",
          "`!wordlist` / `!clearwords` *(Admin)*",
          "",
          "**📻 Radio**",
          "`!setradio <channel name> [station]` — Set up radio *(Admin)*",
          "`!radioplay` / `!radiopause` / `!radiostop`",
          "`!radiostation <name>` — Switch station",
          "`!radiostatus` — Current radio info",
          "`!stations` — List built-in stations",
          "",
          "**☀️ Daily Inspiration**",
          "`!setdaily #channel` — Set the daily inspiration channel *(Admin)*",
          "`!daily` — Send the inspiration right now *(Admin)*",
          "",
          "**👋 Welcome**",
          "`!setwelcome [#ch]` — Set welcome channel *(Admin)*",
          "`!setwelcomemsg <msg>` — Custom message *(use {user}, {server})*",
          "`!testwelcome` — Preview the welcome *(Admin)*",
          "`!removewelcome` — Disable welcomes *(Admin)*",
          "",
          "**📋 Server Log**",
          "`!setserverlog [#ch]` / `!removeserverlog`",
          "",
          "**🐦 Twitter / X Monitor**",
          "`!addtwitter @user #ch` — Monitor an account and auto-post their tweets",
          "`!removetwitter @user` — Stop monitoring an account",
          "`!twitterlist` — List all monitored accounts",
          "`!twitterstatus @user` — Monitoring status details",
          "`!twittercheck @user` — Retry manually if monitoring stopped",
        ].join("\n"));

        await send([
          "**📡 Server Intelligence & Security** *(4/4)*",
          "",
          "**📊 Sentiment Radar** *(Admin)*",
          "`!setreport #channel` — Set the daily briefing channel",
          "`!briefing` — Get an instant AI server report right now",
          "Bot tracks channel activity and sends a daily English briefing at midnight UTC",
          "",
          "**🛡️ Auto-Security — always active**",
          "🚫 New accounts <7 days → auto-kicked",
          "📨 Invite links → deleted + warned",
          "🎣 Phishing links → muted 30 min",
          "💎 Nitro scams → muted 1 hour",
          "📎 Dangerous files → blocked",
          "🔤 Excessive caps → deleted",
          "📣 Mass mention (5+) → muted 15 min",
          "💬 Spam → muted 10 min",
          "🚨 Raid → server lockdown 10 min",
          "⚠️ 3 warns = auto-kick | 5 warns = auto-ban",
          "`!setlog [#ch]` — Alert channel *(Admin)*",
          "`!securitystatus` — Security overview *(Admin)*",
          "",
          "**🇯🇵 JP Radar — Japan Anime Tracker**",
          "`!jptime` — Current Tokyo time + vibe label",
          "`!jpairing` — What's airing in Japan RIGHT NOW",
          "`!setjpchannel #ch` — Set alert channel *(Admin)*",
          "`!jpalerts on/off` — Toggle scheduled midnight alerts *(Admin)*",
          "",
          "**⚙️ Feature Management** *(Bot Owner only)*",
          "`!feature list` — List all features and their status",
          "`!feature enable <key>` — Enable a feature",
          "`!feature disable <key>` — Disable a feature",
          "`!feature info <key>` — Details about a feature",
          "",
          "**💾 Backup & Recovery** *(Bot Owner only)*",
          "`!backup` — Full backup to GitHub (source + dist + dist.backup)",
          "`!backup status` — Show last backup info & config status",
          "`!backup help` — Setup guide (GitHub token + repo)",
          "`!restore` — Restore last dist.backup/ then restart",
          "`!restart` — Graceful bot restart",
          "",
          "🌍 React with a flag emoji to translate any message",
          "☀️ Daily inspiration every morning at 8:00 AM UTC",
          "🧠 Long-term memory — I remember you across restarts!",
          "💬 DM me anytime — no mention needed!",
        ].join("\n"));
      }
    }
  });

  // Radio init — uses @discordjs/voice directly (no Lavalink/external server needed)
  initLavalink(client);

  // ── Login with 15-second timeout ────────────────────────────────────────────
  // client.login() can hang indefinitely on network issues.
  // A timeout ensures we retry instead of waiting forever.
  try {
    await Promise.race([
      client.login(token),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("login timeout after 15s")), 15_000)
      ),
    ]);
  } catch (err) {
    console.error("[Connection] Login failed or timed out:", err);
    try { client?.destroy(); } catch {}
    client = null;
    scheduleReconnect(token);
  }
}

function scheduleReconnect(token: string): void {
  if (reconnectPending) return; // already scheduled, skip
  reconnectPending = true;
  const delay = getReconnectDelay();
  reconnectAttempts++;
  console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
  setTimeout(() => {
    reconnectPending = false;
    connect(token).catch(e => console.error("[Reconnect] connect() threw — watchdog will retry:", e));
  }, delay);
}

// ─── Leader Election ──────────────────────────────────────────────────────────
// Ensures only ONE process connects to Discord across ALL environments
// (dev + production). Because both share the same bot token, having more
// than one connection causes DiscordAPIError[40060] on every command.
//
// All processes — dev workflow AND both production replicas — compete for
// the SAME key "discord_leader". First to INSERT wins; all others become
// HTTP-only standbys. The winner refreshes every 20 s. If it crashes, the
// lock goes stale after 60 s and the next standby can take over.

const LEADER_ROW_ID        = "discord_leader";
const LEADER_HEARTBEAT_MS  = 5_000;   // refresh lock every 5 s
// Render (production) can take the lock as soon as it's 8 s stale.
// 8 s > 5 s heartbeat — gives the active leader a 3 s safety margin.
// Non-Render (Replit/dev) waits 5 minutes — so Render redeploys never
// cause Replit to accidentally take over and create double-replies.
const IS_RENDER        = !!process.env.RENDER;
// 8 s stale window on Render: 5 s heartbeat + 3 s safety margin.
// Faster than 12 s → new instance takes over in ≤8 s after crash, not 12 s.
const LEADER_STALE_MS  = IS_RENDER ? 8_000 : 300_000;

// ─── Render Keep-Alive ────────────────────────────────────────────────────────
// Render free tier spins the service DOWN after 15 min of no inbound HTTP.
// When the service sleeps:  the HTTP server returns 503, Discord sees the bot
// offline, and every slash command returns "The application did not respond."
//
// Fix: every instance (leader AND standby) pings its own /api/healthz every
// 5 min, keeping the inactivity clock permanently below 15 min.
//
// We read RENDER_EXTERNAL_URL (set automatically by Render for web services)
// and fall back to the hardcoded production URL so keepalive works even when
// the env var is missing or mis-named in the dashboard.
const RENDER_FALLBACK_URL = "https://pixel-pr-bot.onrender.com";
let keepAliveStarted = false;

function startKeepAlive(): void {
  if (keepAliveStarted) return; // idempotent — one timer per process
  keepAliveStarted = true;

  const base = (process.env.RENDER_EXTERNAL_URL ?? (IS_RENDER ? RENDER_FALLBACK_URL : ""))
    .replace(/\/$/, "");

  if (!base) {
    console.log("[KeepAlive] Not on Render — keep-alive disabled (OK for local dev)");
    return;
  }

  // Use the lightweight /health endpoint — zero DB/Discord dependency, responds in <1ms.
  // Never use /api/healthz here (it runs a DB query on every ping).
  // Render free tier spins down after 15 min of inactivity — ping every 10 min is safe.
  const pingUrl = `${base}/health`;
  console.log(`[KeepAlive] Pinging ${pingUrl} every 10s to prevent Render free-tier sleep`);

  const doPing = async () => {
    try {
      const res = await fetch(pingUrl, { signal: AbortSignal.timeout(8_000) });
      if (res.status !== 200) console.warn(`[KeepAlive] Ping → ${res.status}`);
    } catch (e) {
      console.warn("[KeepAlive] Ping failed:", (e as Error)?.message ?? e);
    }
  };

  doPing();                      // fire immediately on cold start
  setInterval(doPing, 10_000);   // then every 10 seconds
}

async function ensureLeaderTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_leader (
      id           TEXT PRIMARY KEY,
      pid          INT  NOT NULL,
      acquired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migration: remove old per-environment keys so the new single-key system works.
  await pool.query(`
    DELETE FROM discord_leader
    WHERE id IN ('singleton', 'discord_leader_dev', 'discord_leader_prod')
  `).catch(() => {});
}

/** Try to become the Discord leader for this environment.
 *  Returns true  → this process should connect to Discord.
 *  Returns false → another process already owns the connection.
 */
async function tryAcquireLeader(): Promise<boolean> {
  try {
    await ensureLeaderTable();
    const res = await pool.query(`
      INSERT INTO discord_leader (id, pid, acquired_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (id) DO UPDATE
        SET pid = $2, acquired_at = NOW()
        WHERE discord_leader.acquired_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
      RETURNING id
    `, [LEADER_ROW_ID, process.pid, LEADER_STALE_MS]);
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.warn("[Leader] DB error during election — proceeding as leader:", err);
    return true; // Fail-open: if DB is down, try to connect rather than stay silent
  }
}

/** Heartbeat: refresh the lock while we're alive, and yield if we lost it. */
async function refreshLeaderLock(): Promise<void> {
  try {
    const res = await pool.query(
      `UPDATE discord_leader SET acquired_at = NOW()
       WHERE id = $1 AND pid = $2
       RETURNING id`,
      [LEADER_ROW_ID, process.pid]
    );
    if ((res.rowCount ?? 0) === 0) {
      // Another process stole our lock — gracefully step down
      console.warn("[Leader] Lost Discord leadership — stepping down. Watchdog will NOT reconnect.");
      isElectedLeader = false;
      if (client) { try { client.destroy(); } catch {} client = null; }
    }
  } catch { /* transient DB error — will retry on next tick */ }
}

export async function initBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn("DISCORD_BOT_TOKEN not set — bot will not connect.");
    return;
  }

  // ── DB wakeup ping ─────────────────────────────────────────────────────────
  // On Render free tier, the DB connection pool is cold after inactivity.
  // Fire a lightweight query NOW — before any module inits or leader election —
  // so the pool is warmed up and the 15+ parallel inits below don't all hit a
  // cold connection at the same time, causing slow first-interaction responses.
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("DB wakeup timeout")), 8_000)),
    ]);
    console.log("[Init] DB pool warmed up.");
  } catch (e) {
    console.warn("[Init] DB wakeup failed — continuing anyway:", (e as Error)?.message ?? e);
  }

  // ── Parallel init — all modules create their own DB tables independently ──
  // Running them in parallel instead of sequentially reduces startup from
  // potentially 30-60s (15+ sequential DB round-trips) to ~5s (single batch).
  // Order doesn't matter: each init() only does CREATE TABLE IF NOT EXISTS.
  console.log("[Init] Starting parallel module initialization...");
  const t0 = Date.now();
  await Promise.all([
    initFeatureRegistry(),
    initSelfHeal(),
    initAutoFix(),
    initSecurityHardening(),
    initMessageDedup(),
    initChatChannels(),
    initDaily(),
    initTweetMonitor(),
    initJokeScheduler(),
    initVoiceAISettings(),
    initAiEmojis(),
    initWelcome(),
    initRadio(),
    initMemory(),
    initConsent(),
    initProfiling(),
    initTracker(),
    initPersona(),
    initJPTracker(),
    initServerLog(),
    initModeration(),
    initProfanityFilter(),
    initAutoSecurity(),
  ].map(p => p.catch((e: unknown) => console.error("[Init] Module init failed (continuing):", e))));
  console.log(`[Init] All modules ready in ${Date.now() - t0}ms.`);

  setInterval(() => cleanOldMessages().catch(console.error), 5 * 60 * 1000);

  // ── Start keepalive first — runs on EVERY instance (leader + standby) ─────
  // Must be before leader election so the HTTP server never goes quiet regardless
  // of which process holds the Discord lock.
  startKeepAlive();

  // ── Leader election: only ONE instance per environment connects to Discord ──
  // CRITICAL: Only Render (production) can auto-promote from standby.
  // Dev/Replit instances stay in standby forever — they NEVER take over automatically.
  // This prevents double-connections during Render redeployments (2-3 min downtime).
  const isLeader = await tryAcquireLeader();
  if (!isLeader) {
    console.log(`[Leader] Standby mode (pid=${process.pid}, env=${LEADER_ROW_ID}). Another instance owns Discord.`);
    if (!IS_RENDER) {
      // Non-Render (Replit/local): stay in standby permanently — never auto-promote
      console.log("[Leader] Dev/Replit — will NOT auto-promote. Only Render owns Discord in production.");
      return;
    }
    // Render only: retry leadership every 2 s — faster takeover after crash/redeploy.
    // Fast retry + 8 s stale window = new instance takes Discord in ≤ 10 s after old dies.
    setInterval(async () => {
      if (isElectedLeader) return; // already promoted — stop retrying
      try {
        const won = await tryAcquireLeader();
        if (won) {
          console.log(`[Leader] Render standby promoted to leader (pid=${process.pid}). Connecting to Discord...`);
          isElectedLeader = true;
          setInterval(() => refreshLeaderLock(), LEADER_HEARTBEAT_MS);
          await connect(token);
        }
      } catch (err) {
        // Reset flag so the retry loop continues on next tick — prevents permanent lock-up
        // if connect() throws (e.g. network blip, bad token response).
        console.error("[Leader] Standby promotion failed — will retry in 2s:", (err as Error)?.message ?? err);
        isElectedLeader = false;
      }
    }, 2_000);
    return;
  }

  console.log(`[Leader] Acquired Discord leadership (pid=${process.pid}, env=${LEADER_ROW_ID}). Connecting...`);
  isElectedLeader = true;
  setInterval(() => refreshLeaderLock(), LEADER_HEARTBEAT_MS);

  await connect(token);
}
