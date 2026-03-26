import { isClaimed } from "../message-gate.js";
import {
  Client,
  Events,
  Message,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  Colors,
} from "discord.js";
import { pool } from "@workspace/db";

const PREFIX = "!";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes (GraphQL guest API has no strict rate limit)

// After this many consecutive failures → slow-retry (once every 6 hours)
const FAILURE_THRESHOLD = 5;
// After this many → give up and mark permanently unreachable
const DEAD_THRESHOLD = 30;
// Slow retry backoff after FAILURE_THRESHOLD failures
const SLOW_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours (was 1 hour)

// ─── Twitter API v2 ───────────────────────────────────────────────────────────
const TWITTER_API_BASE = "https://api.twitter.com/2";
const getBearerToken = () => process.env.TWITTER_BEARER_TOKEN ?? "";

// In-memory user ID cache (avoids repeated API lookups across polls)
const userIdCache = new Map<string, string>();

async function resolveTwitterUserId(username: string): Promise<string> {
  if (userIdCache.has(username)) return userIdCache.get(username)!;

  // Check DB cache (survives restarts)
  const dbRes = await pool.query(
    `SELECT twitter_user_id FROM tweet_monitors WHERE twitter_user = $1 AND twitter_user_id IS NOT NULL LIMIT 1`,
    [username],
  );
  if (dbRes.rows[0]?.twitter_user_id) {
    const cached = dbRes.rows[0].twitter_user_id as string;
    userIdCache.set(username, cached);
    return cached;
  }

  // Fetch from Twitter API
  const resp = await fetch(`${TWITTER_API_BASE}/users/by/username/${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${getBearerToken()}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 429) throw new Error("Twitter API rate limited (user lookup)");
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Twitter API user lookup ${resp.status}: ${body}`);
  }

  const data = await resp.json() as { data?: { id: string; name: string } };
  const userId = data?.data?.id;
  if (!userId) throw new Error(`Twitter user @${username} not found`);

  userIdCache.set(username, userId);
  // Persist to DB for future restarts
  await pool.query(
    `UPDATE tweet_monitors SET twitter_user_id = $1 WHERE twitter_user = $2`,
    [userId, username],
  ).catch(() => {});

  return userId;
}

// ─── Twitter GraphQL guest API ───────────────────────────────────────────────
// This is the same bearer token embedded in Twitter's web app (public, no auth required).
// It enables reading public timeline data without any paid API plan.
const TWITTER_WEB_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// Known working query IDs — Twitter's web app uses these internally.
// Try in order; if a query ID returns 403/404 Twitter has rotated it.
const USER_BY_SCREEN_NAME_QID = "oUZZZ8Oddwxs8Cd3iW3UEA"; // confirmed 2026-03-26
const USER_TWEETS_QIDS = [
  "V1ze5q3ijDS1VeLwLY0m7g", // confirmed 2026-03-26
  "XicnWRbyQ3WgVlwd5MedHA", // fallback #1
  "H8OjuYEErBMQam1dmf9-iA", // fallback #2
];

// In-memory user-ID cache for GraphQL lookups (user IDs never change)
const graphqlUserIdCache = new Map<string, string>();

function twitterWebHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TWITTER_WEB_BEARER}`,
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
}

async function resolveUserIdViaGraphQL(username: string): Promise<string> {
  const key = username.toLowerCase();
  if (graphqlUserIdCache.has(key)) return graphqlUserIdCache.get(key)!;

  // Check DB cache (survives restarts)
  const dbRes = await pool.query(
    `SELECT twitter_user_id FROM tweet_monitors WHERE twitter_user = $1 AND twitter_user_id IS NOT NULL LIMIT 1`,
    [username],
  ).catch(() => null);
  if (dbRes?.rows[0]?.twitter_user_id) {
    const id = dbRes.rows[0].twitter_user_id as string;
    graphqlUserIdCache.set(key, id);
    return id;
  }

  const vars = encodeURIComponent(JSON.stringify({ screen_name: username, withSafetyModeUserFields: true }));
  const url = `https://api.twitter.com/graphql/${USER_BY_SCREEN_NAME_QID}/UserByScreenName?variables=${vars}&features=%7B%22hidden_profile_likes_enabled%22%3Atrue%7D`;
  const resp = await fetch(url, { headers: twitterWebHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`UserByScreenName HTTP ${resp.status}`);
  const data = await resp.json() as { data?: { user?: { result?: { rest_id?: string } } } };
  const userId = data?.data?.user?.result?.rest_id;
  if (!userId) throw new Error(`Could not resolve user ID for @${username} via GraphQL`);

  graphqlUserIdCache.set(key, userId);
  // Persist to DB so the next restart doesn't need another lookup
  await pool.query(
    `UPDATE tweet_monitors SET twitter_user_id = $1 WHERE twitter_user = $2`,
    [userId, username],
  ).catch(() => {});
  return userId;
}

// Feature flags required by Twitter's GraphQL UserTweets endpoint
const GRAPHQL_TWEET_FEATURES = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

function extractTweetsFromGraphQLResponse(data: any, username: string): Tweet[] {
  const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions;
  if (!Array.isArray(instructions)) return [];

  // The entries live either in a TimelineAddEntries instruction or directly as `entries`
  const addEntries = instructions.find(
    (i: any) => i.type === "TimelineAddEntries" || Array.isArray(i.entries),
  );
  const entries: any[] = addEntries?.entries ?? [];

  const tweets: Tweet[] = [];
  for (const entry of entries) {
    if (!entry.entryId?.startsWith("tweet-")) continue;

    const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
    // Handle tombstones / withheld tweets
    const legacy = tweetResult?.legacy ?? tweetResult?.tweet?.legacy;
    if (!legacy?.id_str || !legacy?.full_text) continue;

    const authorLegacy = tweetResult?.core?.user_results?.result?.legacy ?? {};
    const authorName = (authorLegacy?.name as string | undefined) ?? username;

    // Extract first image from extended_entities (preferred) or entities
    const media: any[] = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
    const imageUrl = (media[0]?.media_url_https as string | undefined);

    const rawText = (legacy.full_text as string)
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    tweets.push({
      id: legacy.id_str as string,
      text: rawText,
      author: authorName,
      url: `https://x.com/${username}/status/${legacy.id_str}`,
      pubDate: (legacy.created_at as string) ?? "",
      imageUrl,
    });
  }
  return tweets;
}

async function fetchViaTwitterGraphQL(
  username: string,
  sinceId?: string | null,
): Promise<{ tweets: Tweet[]; source: string }> {
  const userId = await resolveUserIdViaGraphQL(username);

  const tweetVars = {
    userId,
    count: 20,
    includePromotedContent: false,
    withVoice: true,
    withV2Timeline: true,
  };

  const errors: string[] = [];
  for (const queryId of USER_TWEETS_QIDS) {
    const url = `https://api.twitter.com/graphql/${queryId}/UserTweets?variables=${encodeURIComponent(JSON.stringify(tweetVars))}&features=${encodeURIComponent(JSON.stringify(GRAPHQL_TWEET_FEATURES))}`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers: twitterWebHeaders(), signal: AbortSignal.timeout(12_000) });
    } catch (e: any) {
      errors.push(`${queryId}: ${e.message}`);
      continue;
    }
    if (!resp.ok) { errors.push(`${queryId}: HTTP ${resp.status}`); continue; }

    const data = await resp.json();
    const tweets = extractTweetsFromGraphQLResponse(data, username);

    // Filter to only tweets newer than sinceId (same client-side approach as Nitter)
    const filtered = sinceId && isNumericId(sinceId)
      ? tweets.filter(t => isNumericId(t.id) && BigInt(t.id) > BigInt(sinceId))
      : tweets;

    console.log(`[TweetMonitor] @${username} ✓ GraphQL (${queryId}) — ${tweets.length} total, ${filtered.length} new`);
    return { tweets: filtered, source: `twitter-graphql:${queryId}` };
  }

  throw new Error(`Twitter GraphQL all query IDs failed for @${username}: ${errors.join(" | ")}`);
}

// ─── DB init ─────────────────────────────────────────────────────────────────
export async function initTweetMonitor(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweet_monitors (
      id             SERIAL PRIMARY KEY,
      guild_id       TEXT NOT NULL,
      channel_id     TEXT NOT NULL,
      twitter_user   TEXT NOT NULL,
      last_tweet_id  TEXT,
      fail_count     INTEGER NOT NULL DEFAULT 0,
      last_fail_at   TIMESTAMPTZ,
      unreachable    BOOLEAN NOT NULL DEFAULT FALSE,
      twitter_user_id TEXT,
      UNIQUE(guild_id, twitter_user)
    )
  `);
  // Migrate: add columns if upgrading from older schema
  await pool.query(`ALTER TABLE tweet_monitors ADD COLUMN IF NOT EXISTS fail_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE tweet_monitors ADD COLUMN IF NOT EXISTS last_fail_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE tweet_monitors ADD COLUMN IF NOT EXISTS unreachable BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE tweet_monitors ADD COLUMN IF NOT EXISTS twitter_user_id TEXT`).catch(() => {});

  // On startup: reset ALL non-permanently-unreachable accounts so they get
  // a fresh attempt on the first poll cycle after restart.
  // Accounts that hit DEAD_THRESHOLD (30 failures) are left marked unreachable.
  const resetResult = await pool.query(
    `UPDATE tweet_monitors
     SET fail_count = 0, last_fail_at = NULL
     WHERE unreachable = FALSE
       AND fail_count > 0`
  ).catch(() => null);
  if (resetResult && resetResult.rowCount && resetResult.rowCount > 0) {
    console.log(`[TweetMonitor] ♻️ Reset fail_count for ${resetResult.rowCount} account(s) — will retry on next poll cycle`);
  }
}

// ─── Tweet fetching — Twitter API v2 + Nitter RSS fallback ───────────────────
interface Tweet {
  id: string;
  text: string;
  author: string;
  url: string;
  pubDate: string;
  imageUrl?: string;
}

function isNumericId(id: string): boolean {
  return /^\d+$/.test(id);
}

// Nitter / Nitter-compatible public instances.
// Last verified: 2026-03-26 (from cloud IP — all confirmed broken or whitelisted).
// NOTE: The primary free path is now Twitter's GraphQL guest API (fetchViaTwitterGraphQL).
// Nitter RSS is kept as a last-resort fallback ONLY.
//
// Status as of 2026-03-26:
//   rss.xcancel.com / xcancel.com  → NOW REQUIRES WHITELIST (email rss@xcancel.com)
//   nitter.tiekoetter.com          → Cloudflare (blocks cloud IPs)
//   nitter.adminforge.de           → Cloudflare (blocks cloud IPs)
//   nitter.privacyredirect.com     → Bot detection challenge page
//   nitter.bird.froth.zone         → Permanently shut down (410)
//   nitter.1d4.us                  → DNS failure
const NITTER_INSTANCES = [
  "rss.xcancel.com",                // 🔒 whitelist required (kept in case bot IP gets whitelisted)
  "xcancel.com",                    // 🔒 same — redirects to rss.xcancel.com
  "nitter.tiekoetter.com",          // 🤖 Cloudflare (may work from non-cloud IPs)
  "nitter.adminforge.de",           // 🤖 Cloudflare
  "nitter.weiler.rocks",            // ⚠️ speculative
  "nitter.cz",                      // ⚠️ speculative
];

// RSSHub instances — NOTE: as of 2026-03-26 all public RSSHub instances have
// dropped Twitter/X support (rsshub.app redirects to google.com/404).
// List kept empty to avoid wasting time on dead sources.
// If a working self-hosted RSSHub instance becomes available, add it here.
const RSSHUB_INSTANCES: string[] = [];

// ── RSS parser — works for both Nitter and RSSHub output formats ──────────────
function parseRssXml(xml: string, username: string): Tweet[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  const tweets: Tweet[] = [];

  for (const item of items) {
    // Extract status URL and tweet ID
    const linkMatch = item.match(/<link>(?:<!\[CDATA\[)?(https?:\/\/[^<]+?\/status\/(\d+)[^<]*)(?:\]\]>)?<\/link>/);
    if (!linkMatch) continue;
    const tweetId  = linkMatch[2]!;
    const tweetUrl = `https://x.com/${username}/status/${tweetId}`;

    // Extract text from <title> — Nitter/RSSHub format: "@user: tweet text"
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    let text = titleMatch ? titleMatch[1]!.trim() : "";
    // Strip "@user: " prefix and HTML entities
    text = text
      .replace(/^R to @[^:]+:\s*/, "RT: ")   // normalize retweets
      .replace(/^@[^:]+:\s*/, "")             // strip "@user: " prefix
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

    // Author
    const authorMatch = item.match(/<dc:creator>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:creator>/);
    const author = authorMatch ? authorMatch[1]!.trim() : username;

    // Date
    const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const pubDate   = dateMatch ? dateMatch[1]!.trim() : "";

    // Image (enclosure or media:content)
    const imgMatch = item.match(/url="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp)[^"]*)"/i);
    const imageUrl = imgMatch?.[1];

    if (text && tweetId) {
      tweets.push({ id: tweetId, text, author, url: tweetUrl, pubDate, imageUrl });
    }
  }
  return tweets;
}

// ── Try a single RSS source (Nitter or RSSHub) ───────────────────────────────
async function trySingleRssSource(
  type: "nitter" | "rsshub",
  host: string,
  username: string,
): Promise<{ tweets: Tweet[]; source: string }> {
  const url = type === "nitter"
    ? `https://${host}/${encodeURIComponent(username)}/rss`
    : `https://${host}/twitter/user/${encodeURIComponent(username)}`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PIXEL_PR_Bot/2.0; +https://discord.com)" },
    signal:  AbortSignal.timeout(6_000),   // 6 s per source (was 10 s)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  if (!xml.includes("<rss") && !xml.includes("<feed") && !xml.includes("<channel"))
    throw new Error("not RSS");
  const tweets = parseRssXml(xml, username);
  return { tweets, source: `${type}:${host}` };
}

// ── Fetch via free RSS — parallel batches of 3, Nitter first then RSSHub ──────
// Tries up to 3 sources at once. First success wins. Never waits more than ~12 s.
async function fetchViaRss(username: string): Promise<{ tweets: Tweet[]; source: string }> {
  const allSources: Array<{ type: "nitter" | "rsshub"; host: string }> = [
    ...NITTER_INSTANCES.map(h => ({ type: "nitter" as const, host: h })),
    ...RSSHUB_INSTANCES.map(h => ({ type: "rsshub" as const, host: h })),
  ];

  const errors: string[] = [];

  // Try in parallel batches of 3 — first batch covers the most-reliable instances
  for (let i = 0; i < allSources.length; i += 3) {
    const batch = allSources.slice(i, i + 3);
    const result = await Promise.any(
      batch.map(({ type, host }) =>
        trySingleRssSource(type, host, username).then(r => {
          console.log(`[TweetMonitor] @${username} ✓ via ${r.source} — ${r.tweets.length} tweet(s)`);
          return r;
        }).catch(e => { errors.push(`${host}: ${e.message}`); return Promise.reject(e); })
      )
    ).catch(() => null);

    if (result) return result;
  }

  throw new Error(`All RSS sources failed for @${username}. Errors: ${errors.slice(0, 3).join(" | ")}`);
}

// ── Fetch via Twitter API v2 (requires Basic/Pro plan for reading others' tweets) ──
async function fetchViaTwitterApiV2(
  username: string,
  sinceId?: string | null,
): Promise<{ tweets: Tweet[]; source: string }> {
  const token = getBearerToken();
  if (!token) throw new Error("TWITTER_BEARER_TOKEN not set");

  const userId = await resolveTwitterUserId(username);

  const params: Record<string, string> = {
    max_results:    "10",
    "tweet.fields": "id,text,created_at,attachments",
    expansions:     "attachments.media_keys,author_id",
    "media.fields": "url,preview_image_url,type",
    "user.fields":  "name",
    exclude:        "retweets,replies",
  };
  if (sinceId && isNumericId(sinceId)) params.since_id = sinceId;

  const url = `${TWITTER_API_BASE}/users/${userId}/tweets?${new URLSearchParams(params)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal:  AbortSignal.timeout(12_000),
  });

  const remaining = resp.headers.get("x-rate-limit-remaining");
  const reset     = resp.headers.get("x-rate-limit-reset");
  if (remaining !== null) {
    const resetTime = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : "?";
    console.log(`[TweetMonitor] @${username} Twitter v2 rate limit: ${remaining} remaining, resets: ${resetTime}`);
  }

  if (resp.status === 402 || resp.status === 403) {
    // Plan insufficient — propagate with a clear code so caller can fall back
    throw Object.assign(new Error(`Twitter API v2 plan insufficient (${resp.status})`), { code: "PLAN_REQUIRED" });
  }
  if (resp.status === 429) {
    const resetTime = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : "soon";
    throw new Error(`Twitter API rate limited — resets at ${resetTime}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Twitter API v2 ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    data?: Array<{ id: string; text: string; created_at?: string; attachments?: { media_keys?: string[] } }>;
    includes?: {
      media?: Array<{ media_key: string; url?: string; preview_image_url?: string }>;
      users?: Array<{ name: string }>;
    };
  };

  if (!data.data?.length) return { tweets: [], source: "twitter-api-v2" };

  const mediaMap = new Map<string, string>();
  for (const m of (data.includes?.media ?? [])) {
    const mUrl = m.url ?? m.preview_image_url;
    if (m.media_key && mUrl) mediaMap.set(m.media_key, mUrl);
  }

  const authorName = data.includes?.users?.[0]?.name ?? username;
  const tweets: Tweet[] = data.data.map(t => {
    const mediaKey = t.attachments?.media_keys?.[0];
    return {
      id: t.id, text: t.text, author: authorName,
      url: `https://x.com/${username}/status/${t.id}`,
      pubDate: t.created_at ?? "",
      imageUrl: mediaKey ? mediaMap.get(mediaKey) : undefined,
    };
  });
  return { tweets, source: "twitter-api-v2" };
}

// ── Public entry — priority: Twitter API v2 → GraphQL guest → Nitter RSS ─────
export async function fetchLatestTweets(
  username: string,
  sinceId?: string | null,
): Promise<{ tweets: Tweet[]; source: string }> {
  // 1. Twitter API v2 (requires paid bearer token — most reliable if available)
  const token = getBearerToken();
  if (token) {
    try {
      return await fetchViaTwitterApiV2(username, sinceId);
    } catch (err: any) {
      console.warn(`[TweetMonitor] @${username} — Twitter API v2 failed (${err.message}), falling back to GraphQL guest API`);
    }
  }

  // 2. Twitter GraphQL guest API (free, no key needed — uses same bearer as twitter.com web app)
  //    NOTE: rss.xcancel.com now requires whitelisting, so GraphQL is our primary free path.
  try {
    return await fetchViaTwitterGraphQL(username, sinceId);
  } catch (err: any) {
    console.warn(`[TweetMonitor] @${username} — Twitter GraphQL failed (${err.message}), falling back to Nitter RSS`);
  }

  // 3. Nitter/RSSHub RSS (last resort — most public instances are dead/blocked as of 2026-03)
  const { tweets, source } = await fetchViaRss(username);
  if (sinceId && isNumericId(sinceId)) {
    const filtered = tweets.filter(t => isNumericId(t.id) && BigInt(t.id) > BigInt(sinceId));
    return { tweets: filtered, source };
  }
  return { tweets, source };
}

// Backward-compat wrapper
async function fetchTweets(username: string): Promise<Tweet[]> {
  const { tweets } = await fetchLatestTweets(username);
  return tweets;
}

// ─── Build Discord embed ──────────────────────────────────────────────────────
export function buildTweetEmbed(tweet: Tweet, username: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setAuthor({
      name: `${tweet.author} (@${username})`,
      iconURL: `https://unavatar.io/twitter/${username}`,
      url: `https://x.com/${username}`,
    })
    .setDescription(tweet.text.length > 4096 ? tweet.text.slice(0, 4093) + "..." : tweet.text)
    .setURL(tweet.url)
    .setFooter({ text: "X (Twitter)" })
    .setTimestamp(tweet.pubDate ? new Date(tweet.pubDate) : new Date());

  if (tweet.imageUrl) embed.setImage(tweet.imageUrl);
  return embed;
}

export function buildTweetButton(tweetUrl: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("View on X")
      .setStyle(ButtonStyle.Link)
      .setURL(tweetUrl)
      .setEmoji("🐦")
  );
}

// ─── Poll one username for one guild ─────────────────────────────────────────
async function pollAccount(
  client: Client,
  guildId: string,
  channelId: string,
  username: string,
  lastId: string | null,
  failCount: number,
  lastFailAt: Date | null,
  unreachable: boolean
): Promise<{ newId: string | null; failCount: number; unreachable: boolean }> {

  // Skip unreachable accounts entirely
  if (unreachable) return { newId: lastId, failCount, unreachable: true };

  // Slow-retry: if failing consistently, check only once every SLOW_RETRY_INTERVAL_MS (6 h)
  if (failCount >= FAILURE_THRESHOLD && lastFailAt) {
    const msSinceFail = Date.now() - lastFailAt.getTime();
    if (msSinceFail < SLOW_RETRY_INTERVAL_MS) {
      return { newId: lastId, failCount, unreachable: false }; // skip this cycle
    }
  }

  let tweets: Tweet[];
  let source = "unknown";
  try {
    const result = await fetchLatestTweets(username, lastId);
    tweets = result.tweets;
    source = result.source;
    console.log(`[TweetMonitor] @${username} ✓ via ${source} (${tweets.length} new tweet(s))`);
  } catch (err: any) {
    const errMsg = String(err?.message ?? err).slice(0, 300);
    const newFailCount = failCount + 1;
    const nowUnreachable = newFailCount >= DEAD_THRESHOLD;

    // Always log the actual error so it's visible in logs
    console.error(`[TweetMonitor] @${username} poll failed (attempt ${newFailCount}): ${errMsg}`);

    await pool.query(
      `UPDATE tweet_monitors SET fail_count = $1, last_fail_at = NOW(), unreachable = $2
       WHERE guild_id = $3 AND twitter_user = $4`,
      [newFailCount, nowUnreachable, guildId, username]
    );

    if (newFailCount === FAILURE_THRESHOLD) {
      console.warn(`[TweetMonitor] @${username} — switching to hourly retry after ${newFailCount} failures`);
    }

    if (nowUnreachable) {
      console.warn(`[TweetMonitor] @${username} marked unreachable after ${newFailCount} failures`);
      // Notify the monitor channel — fetch from API if not in cache (post-restart safe)
      const channel = (
        client.channels.cache.get(channelId) ??
        await client.channels.fetch(channelId).catch(() => null)
      ) as TextChannel | null;
      if (channel) {
        await channel.send(
          `⚠️ **Twitter/X Monitor**: Could not reach **@${username}** after ${newFailCount} attempts.\n` +
          `This account may be **private**, **suspended**, or the RSS feed is permanently blocked.\n` +
          `Use \`!removetwitter @${username}\` to stop monitoring it, or \`!twittercheck @${username}\` to retry manually.`
        ).catch(() => {});
      }
    }

    return { newId: lastId, failCount: newFailCount, unreachable: nowUnreachable };
  }

  // Success — reset fail count
  if (failCount > 0) {
    await pool.query(
      `UPDATE tweet_monitors SET fail_count = 0, last_fail_at = NULL, unreachable = FALSE
       WHERE guild_id = $1 AND twitter_user = $2`,
      [guildId, username]
    );
  }

  if (!tweets.length) return { newId: lastId, failCount: 0, unreachable: false };

  // Safety cap: never post tweets older than 48 hours (prevents RSS flood of old posts)
  const MAX_TWEET_AGE_MS = 48 * 60 * 60 * 1000;
  const MAX_TWEETS_PER_POLL = 5; // safety cap — never spam more than 5 per cycle

  const recentTweets = tweets.filter(t => {
    if (!t.pubDate) return true; // no date info → include (let it through)
    const age = Date.now() - new Date(t.pubDate).getTime();
    return age < MAX_TWEET_AGE_MS;
  });

  // If all fetched tweets are older than 48h, it means the saved lastId is stale.
  // Update lastId to the newest tweet we saw (to skip the backlog) but post nothing.
  if (recentTweets.length === 0 && tweets.length > 0) {
    const newestStale = tweets.reduce((a, b) =>
      isNumericId(a.id) && isNumericId(b.id) && BigInt(a.id) > BigInt(b.id) ? a : b
    );
    const savedId = isNumericId(newestStale.id) ? newestStale.id : lastId;
    console.log(`[TweetMonitor] @${username} — all ${tweets.length} fetched tweets are >48h old, skipping backlog, advancing lastId`);
    return { newId: savedId, failCount: 0, unreachable: false };
  }

  // Twitter API v2 with since_id already returns only new tweets.
  // Reverse so oldest posts first (API returns newest first), then cap.
  const newTweets = lastId
    ? [...recentTweets].reverse().slice(0, MAX_TWEETS_PER_POLL)
    : [recentTweets[0]].filter(Boolean); // first run: seed lastId without posting old tweets

  if (!newTweets.length) return { newId: lastId, failCount: 0, unreachable: false };

  const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return { newId: lastId, failCount: 0, unreachable: false };

  for (const tweet of newTweets) {
    try {
      await channel.send({
        embeds: [buildTweetEmbed(tweet, username)],
        components: [buildTweetButton(tweet.url)],
      });
    } catch { /* channel deleted or no perms */ }
  }

  const latestSentId = newTweets[newTweets.length - 1].id;
  // Only persist numeric IDs — non-numeric IDs (malformed URLs) would break future BigInt comparisons
  const savedId = isNumericId(latestSentId) ? latestSentId : lastId;
  return { newId: savedId, failCount: 0, unreachable: false };
}

// ─── Polling loop ─────────────────────────────────────────────────────────────
let pollRunning = false; // prevent concurrent poll cycles within the same process

async function runPollCycle(client: Client): Promise<void> {
  // Guard: skip if already polling (prevents timeout + interval overlap)
  if (pollRunning) {
    console.log("[TweetMonitor] Poll cycle already running — skipping this tick");
    return;
  }
  pollRunning = true;

  // Acquire a dedicated connection for the advisory lock.
  // pg_advisory_lock is session-scoped — lock + unlock MUST use the same connection.
  const lockClient = await pool.connect();
  let gotLock = false;
  try {
    const lockRes = await lockClient.query(`SELECT pg_try_advisory_lock(987654321) AS locked`);
    gotLock = lockRes.rows[0]?.locked === true;
  } catch (err) {
    console.error("[TweetMonitor] Could not acquire advisory lock:", err);
    lockClient.release();
    pollRunning = false;
    return;
  }

  if (!gotLock) {
    console.log("[TweetMonitor] Another instance is polling — skipping this tick");
    lockClient.release();
    pollRunning = false;
    return;
  }

  try {
    let rows: {
      guild_id: string;
      channel_id: string;
      twitter_user: string;
      last_tweet_id: string | null;
      fail_count: number;
      last_fail_at: Date | null;
      unreachable: boolean;
    }[] = [];

    try {
      const res = await pool.query(
        `SELECT guild_id, channel_id, twitter_user, last_tweet_id, fail_count, last_fail_at, unreachable
         FROM tweet_monitors`
      );
      rows = res.rows;
    } catch (err) {
      console.error("[TweetMonitor] DB error:", err);
      return;
    }

    for (const row of rows) {
      try {
        const result = await pollAccount(
          client,
          row.guild_id,
          row.channel_id,
          row.twitter_user,
          row.last_tweet_id,
          row.fail_count ?? 0,
          row.last_fail_at,
          row.unreachable ?? false,
        );
        if (result.newId && result.newId !== row.last_tweet_id) {
          await pool.query(
            `UPDATE tweet_monitors SET last_tweet_id = $1 WHERE guild_id = $2 AND twitter_user = $3`,
            [result.newId, row.guild_id, row.twitter_user],
          );
        }
      } catch (rowErr) {
        console.error(`[TweetMonitor] Error polling @${row.twitter_user}:`, rowErr);
      }
    }
  } finally {
    // Unlock on the SAME connection that acquired the lock, then release it back to the pool
    await lockClient.query(`SELECT pg_advisory_unlock(987654321)`).catch(() => {});
    lockClient.release();
    pollRunning = false;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
function isAdmin(message: Message): boolean {
  return !!(message.member?.permissions.has(PermissionFlagsBits.Administrator));
}

export function cleanUsername(raw: string): string {
  return raw.replace(/^@/, "").trim().toLowerCase();
}

export async function addTwitterAccount(
  guildId: string, channelId: string, username: string,
): Promise<{ verified: boolean }> {
  let latestId: string | null = null;
  let verified = false;
  try {
    const tweets = await fetchTweets(username);
    if (tweets.length) { latestId = isNumericId(tweets[0].id) ? tweets[0].id : null; verified = true; }
  } catch {}
  await pool.query(
    `INSERT INTO tweet_monitors (guild_id, channel_id, twitter_user, last_tweet_id, fail_count, unreachable)
     VALUES ($1, $2, $3, $4, 0, FALSE)
     ON CONFLICT (guild_id, twitter_user)
     DO UPDATE SET channel_id = EXCLUDED.channel_id, last_tweet_id = EXCLUDED.last_tweet_id,
                   fail_count = 0, last_fail_at = NULL, unreachable = FALSE`,
    [guildId, channelId, username, latestId],
  );
  return { verified };
}

export async function removeTwitterAccount(guildId: string, username: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM tweet_monitors WHERE guild_id = $1 AND twitter_user = $2 RETURNING id`,
    [guildId, username],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listTwitterAccounts(
  guildId: string,
): Promise<Array<{ username: string; channelId: string; unreachable: boolean; failCount: number }>> {
  const { rows } = await pool.query(
    `SELECT twitter_user, channel_id, unreachable, fail_count FROM tweet_monitors WHERE guild_id = $1 ORDER BY twitter_user`,
    [guildId],
  );
  return rows.map(r => ({
    username:    r.twitter_user,
    channelId:   r.channel_id,
    unreachable: r.unreachable,
    failCount:   r.fail_count ?? 0,
  }));
}

export { FAILURE_THRESHOLD };

async function handleAddTwitter(message: Message, args: string[]): Promise<void> {
  if (!isAdmin(message)) {
    await message.reply("❌ Only admins can use this command.");
    return;
  }
  const username = cleanUsername(args[0] ?? "");
  const channelMention = args[1];
  const channelId = channelMention?.replace(/[<#>]/g, "");

  if (!username || !channelId) {
    await message.reply("**Usage:** `!addtwitter @username #channel`\nExample: `!addtwitter elonmusk #twitter-feed`");
    return;
  }

  const channel = message.guild!.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) {
    await message.reply("❌ Channel not found. Please mention a valid text channel.");
    return;
  }

  const msg = await message.reply(`⏳ Adding **@${username}** to the watch list...`);
  let latestId: string | null = null;
  let verified = false;

  try {
    const tweets = await fetchTweets(username);
    if (tweets.length) {
      // Only save numeric IDs — non-numeric would trigger a false "new tweet" on first poll
      latestId = isNumericId(tweets[0].id) ? tweets[0].id : null;
      verified = true;
    }
  } catch {
    // RSS sources unavailable — still save, polling will retry
  }

  await pool.query(
    `INSERT INTO tweet_monitors (guild_id, channel_id, twitter_user, last_tweet_id, fail_count, unreachable)
     VALUES ($1, $2, $3, $4, 0, FALSE)
     ON CONFLICT (guild_id, twitter_user)
     DO UPDATE SET channel_id = EXCLUDED.channel_id, last_tweet_id = EXCLUDED.last_tweet_id,
                   fail_count = 0, last_fail_at = NULL, unreachable = FALSE`,
    [message.guild!.id, channelId, username, latestId]
  );

  if (verified) {
    await msg.edit(
      `✅ Now monitoring **@${username}** — new tweets will be sent to ${channel}.\n📡 Checking every ${POLL_INTERVAL_MS / 60000} minutes (via Nitter RSS / Twitter API).`
    );
  } else {
    await msg.edit(
      `⚠️ Added **@${username}** to the watch list, but couldn't verify the account right now (Twitter & all RSS mirrors unavailable).\n` +
      `Will keep retrying. If the account is **private or suspended**, use \`!removetwitter @${username}\`.`
    );
  }
}

async function handleRemoveTwitter(message: Message, args: string[]): Promise<void> {
  if (!isAdmin(message)) {
    await message.reply("❌ Only admins can use this command.");
    return;
  }
  const username = cleanUsername(args[0] ?? "");
  if (!username) {
    await message.reply("**Usage:** `!removetwitter @username`");
    return;
  }

  const res = await pool.query(
    `DELETE FROM tweet_monitors WHERE guild_id = $1 AND twitter_user = $2 RETURNING id`,
    [message.guild!.id, username]
  );

  if (res.rowCount && res.rowCount > 0) {
    await message.reply(`✅ Stopped monitoring **@${username}**.`);
  } else {
    await message.reply(`❌ **@${username}** wasn't being monitored.`);
  }
}

async function handleTwitterList(message: Message): Promise<void> {
  if (!isAdmin(message)) {
    await message.reply("❌ Only admins can use this command.");
    return;
  }

  const res = await pool.query(
    `SELECT twitter_user, channel_id, fail_count, unreachable FROM tweet_monitors WHERE guild_id = $1 ORDER BY twitter_user`,
    [message.guild!.id]
  );

  if (!res.rows.length) {
    await message.reply("📭 No Twitter/X accounts are being monitored.\nUse `!addtwitter @username #channel` to add one.");
    return;
  }

  const lines = res.rows.map((r: any) => {
    let status = "✅";
    if (r.unreachable) status = "🔴 unreachable";
    else if (r.fail_count >= FAILURE_THRESHOLD) status = `⚠️ failing (${r.fail_count} errors, hourly retry)`;
    return `${status} **@${r.twitter_user}** → <#${r.channel_id}>`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🐦 Monitored X / Twitter Accounts")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "✅ active • ⚠️ failing (hourly retry) • 🔴 unreachable (use !removetwitter)" });

  await message.reply({ embeds: [embed] });
}

async function handleTwitterCheck(message: Message, args: string[]): Promise<void> {
  if (!isAdmin(message)) {
    await message.reply("❌ Only admins can use this command.");
    return;
  }
  const username = cleanUsername(args[0] ?? "");
  if (!username) {
    await message.reply("**Usage:** `!twittercheck @username`");
    return;
  }

  const msg = await message.reply(`🔄 Retrying **@${username}**...`);
  try {
    const { tweets, source } = await fetchLatestTweets(username);
    // Reset failure state
    await pool.query(
      `UPDATE tweet_monitors SET fail_count = 0, last_fail_at = NULL, unreachable = FALSE
       WHERE guild_id = $1 AND twitter_user = $2`,
      [message.guild!.id, username]
    );
    await msg.edit(
      `✅ **@${username}** is reachable! Found ${tweets.length} recent tweet(s) via \`${source}\`.\n` +
      `📡 Monitoring resumed.`
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown error";
    await msg.edit(
      `❌ **@${username}** is still unreachable (Twitter API + all RSS mirrors failed).\n` +
      `Error: \`${reason}\`\n` +
      `The account may be **private**, **suspended**, or blocked by all sources.`
    );
  }
}

async function handleTwitterStatus(message: Message, args: string[]): Promise<void> {
  if (!isAdmin(message)) {
    await message.reply("❌ Only admins can use this command.");
    return;
  }
  const username = cleanUsername(args[0] ?? "");
  if (!username) {
    await message.reply("**Usage:** `!twitterstatus @username`");
    return;
  }

  const res = await pool.query(
    `SELECT twitter_user, channel_id, last_tweet_id, fail_count, last_fail_at, unreachable
     FROM tweet_monitors WHERE guild_id = $1 AND twitter_user = $2`,
    [message.guild!.id, username]
  );
  if (!res.rows.length) {
    await message.reply(`❌ **@${username}** is not in the watch list. Use \`!addtwitter @${username} #channel\` to add it.`);
    return;
  }

  const row = res.rows[0] as any;
  const msg = await message.reply(`🔍 Testing feed for **@${username}**...`);

  let apiTestResult = "";
  let tweetCount = 0;
  try {
    const result = await fetchLatestTweets(username);
    tweetCount = result.tweets.length;
    apiTestResult = `✅ Reachable via \`${result.source}\` — ${tweetCount} recent tweet(s) found`;
  } catch (err) {
    apiTestResult = `❌ All sources failed: ${err instanceof Error ? err.message : "Unknown error"}`;
  }

  const statusLine = row.unreachable
    ? "🔴 **UNREACHABLE** — polling is paused"
    : row.fail_count >= FAILURE_THRESHOLD
    ? `⚠️ **Failing** — ${row.fail_count} errors, hourly retry mode`
    : "✅ **Active**";

  const embed = new EmbedBuilder()
    .setColor(row.unreachable ? Colors.Red : row.fail_count >= FAILURE_THRESHOLD ? Colors.Yellow : Colors.Green)
    .setTitle(`🐦 Status: @${username}`)
    .addFields(
      { name: "Monitoring Status", value: statusLine, inline: false },
      { name: "Alert Channel",     value: `<#${row.channel_id}>`, inline: true },
      { name: "Fail Count",        value: `${row.fail_count}/${DEAD_THRESHOLD}`, inline: true },
      { name: "Last Fail",         value: row.last_fail_at ? `<t:${Math.floor(new Date(row.last_fail_at).getTime()/1000)}:R>` : "Never", inline: true },
      { name: "Last Known Tweet",  value: row.last_tweet_id ? `[View](https://x.com/${username}/status/${row.last_tweet_id})` : "None saved", inline: true },
      { name: "Feed Test (Twitter API → Nitter RSS)", value: apiTestResult, inline: false },
    )
    .setFooter({ text: row.unreachable ? "Use !twittercheck @username to force a retry" : `Checks every ${POLL_INTERVAL_MS / 60000} minutes` });

  await msg.edit({ content: "", embeds: [embed] });
}

// ─── Register ────────────────────────────────────────────────────────────────
export function registerTweetMonitor(client: Client): void {
  setInterval(() => runPollCycle(client), POLL_INTERVAL_MS);
  setTimeout(() => runPollCycle(client), 30_000);

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    if (!message.content.startsWith(PREFIX)) return;

    const [rawCmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase();

    if (cmd === "addtwitter")     await handleAddTwitter(message, args);
    if (cmd === "removetwitter")  await handleRemoveTwitter(message, args);
    if (cmd === "twitterlist")    await handleTwitterList(message);
    if (cmd === "twittercheck")   await handleTwitterCheck(message, args);
    if (cmd === "twitterstatus")  await handleTwitterStatus(message, args);
  });
}
