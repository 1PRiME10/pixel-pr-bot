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
const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes — faster catch after CDN cache updates

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
  "V1ze5q3ijDS1VeLwLY0m7g", // UserTweets (Posts tab)  — confirmed 2026-03-26
  "FOlovQsiHGDls3c0Q_HaSQ", // UserTweets (profileBestHighlights) — confirmed 2026-03-27
  "XicnWRbyQ3WgVlwd5MedHA", // fallback #1
  "H8OjuYEErBMQam1dmf9-iA", // fallback #2
];

// In-memory user-ID cache for GraphQL lookups (user IDs never change)
const graphqlUserIdCache = new Map<string, string>();

/** Seed an already-known Twitter user_id into cache + DB — call from twitterpoll or admin commands */
export async function cacheTwitterUserId(username: string, userId: string): Promise<void> {
  graphqlUserIdCache.set(username.toLowerCase(), userId);
  await pool.query(
    `UPDATE tweet_monitors SET twitter_user_id = $1 WHERE twitter_user = $2`,
    [userId, username],
  ).catch(() => {});
}

// ─── Guest token — required by Twitter GraphQL from cloud IPs ─────────────────
// Without x-guest-token the GraphQL endpoints return 403 from non-browser IPs.
// Guest tokens are valid ~3 hours; we refresh them every 90 minutes proactively.
let cachedGuestToken: string | null = null;
let guestTokenFetchedAt = 0;

async function refreshGuestToken(): Promise<string> {
  const resp = await fetch("https://api.twitter.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { Authorization: `Bearer ${TWITTER_WEB_BEARER}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Guest token HTTP ${resp.status}`);
  const data = await resp.json() as { guest_token?: string };
  if (!data.guest_token) throw new Error("No guest_token in response");
  console.log("[TweetMonitor] 🔑 Guest token refreshed");
  return data.guest_token;
}

async function getGuestToken(): Promise<string> {
  const now = Date.now();
  if (cachedGuestToken && now - guestTokenFetchedAt < 90 * 60_000) return cachedGuestToken;
  cachedGuestToken = await refreshGuestToken();
  guestTokenFetchedAt = now;
  return cachedGuestToken;
}

async function twitterWebHeaders(): Promise<Record<string, string>> {
  const guestToken = await getGuestToken();
  return {
    Authorization: `Bearer ${TWITTER_WEB_BEARER}`,
    "x-guest-token": guestToken,
    "x-csrf-token": "0",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "x-twitter-auth-type": "OAuth2Client",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://twitter.com/",
    "Origin": "https://twitter.com",
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
  const resp = await fetch(url, { headers: await twitterWebHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) cachedGuestToken = null; // force refresh
    const body = await resp.text().catch(() => "");
    throw new Error(`UserByScreenName HTTP ${resp.status}: ${body.slice(0, 150)}`);
  }
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
  // Twitter uses either timeline_v2 (Posts tab) or timeline (profileBestHighlights) depending on the QID
  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.data?.user?.result?.timeline?.timeline?.instructions;
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
      resp = await fetch(url, { headers: await twitterWebHeaders(), signal: AbortSignal.timeout(12_000) });
    } catch (e: any) {
      errors.push(`${queryId}: ${e.message}`);
      continue;
    }
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) cachedGuestToken = null;
      const body = await resp.text().catch(() => "");
      errors.push(`${queryId}: HTTP ${resp.status} — ${body.slice(0, 120)}`);
      continue;
    }

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
  await pool.query(`ALTER TABLE tweet_monitors ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});

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
          // Treat 0 tweets as failure (e.g. xcancel whitelist page, empty channel)
          if (!r.tweets.length) {
            errors.push(`${host}: returned 0 tweets (whitelist/empty)`);
            return Promise.reject(new Error("0 tweets"));
          }
          console.log(`[TweetMonitor] @${username} ✓ via ${r.source} — ${r.tweets.length} tweet(s)`);
          return r;
        }).catch(e => { errors.push(`${host}: ${e.message}`); return Promise.reject(e); })
      )
    ).catch(() => null);

    if (result) return result;
  }

  throw new Error(`All RSS sources failed for @${username}. Errors: ${errors.slice(0, 3).join(" | ")}`);
}

// ─── Proxy fetch — routes through Replit (its IPs are NOT blocked by Twitter) ─
// Set TWITTER_PROXY_URL=https://<replit-domain>/proxy/twitter on Render.
// Set TWITTER_PROXY_SECRET=<secret> on BOTH Render and the Replit deployment.
async function fetchViaProxy(
  username: string,
  sinceId?: string | null,
): Promise<{ tweets: Tweet[]; source: string }> {
  const proxyUrl = process.env.TWITTER_PROXY_URL;
  const secret   = process.env.TWITTER_PROXY_SECRET;
  if (!proxyUrl || !secret) throw new Error("TWITTER_PROXY_URL or TWITTER_PROXY_SECRET not set");

  const url = new URL(proxyUrl);
  url.searchParams.set("username", username);
  if (sinceId) url.searchParams.set("since_id", sinceId);

  // Pass cached user_id so the Worker can skip UserByScreenName (which gets 400 from Cloudflare IPs)
  const cachedId = graphqlUserIdCache.get(username.toLowerCase());
  if (cachedId) {
    url.searchParams.set("user_id", cachedId);
  } else {
    const dbRes = await pool.query(
      `SELECT twitter_user_id FROM tweet_monitors WHERE twitter_user = $1 AND twitter_user_id IS NOT NULL LIMIT 1`,
      [username],
    ).catch(() => null);
    if (dbRes?.rows[0]?.twitter_user_id) {
      url.searchParams.set("user_id", dbRes.rows[0].twitter_user_id as string);
    }
  }

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${secret}`,
      "User-Agent":  "PIXEL_PR_Bot/2.0 (Render->CF proxy)",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Proxy HTTP ${resp.status}: ${body.slice(0, 150)}`);
  }

  const data = await resp.json() as { tweets?: Tweet[]; source?: string; error?: string; userId?: string };
  if (data.error) throw new Error(`Proxy returned error: ${data.error}`);
  if (!Array.isArray(data.tweets)) throw new Error("Proxy: unexpected response format");

  // Cache the userId returned by the Worker so future calls skip UserByScreenName entirely
  if (data.userId) {
    graphqlUserIdCache.set(username.toLowerCase(), data.userId);
    pool.query(
      `UPDATE tweet_monitors SET twitter_user_id = $1 WHERE twitter_user = $2 AND twitter_user_id IS NULL`,
      [data.userId, username],
    ).catch(() => {});
  }

  console.log(`[TweetMonitor] @${username} ✓ via proxy (${data.source}) — ${data.tweets.length} tweet(s)`);
  return { tweets: data.tweets, source: `proxy:${data.source ?? "?"}` };
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

// ─── Twitter Syndication API ─────────────────────────────────────────────────
// This is Twitter's official embedded-timeline API used by platform.twitter.com.
// It serves any public IP (including Render cloud IPs) because websites embed it
// server-side. No auth required.
// URL: https://syndication.twitter.com/srv/timeline-profile/screen-name/{user}
// Response: HTML page with <script id="__NEXT_DATA__"> containing JSON tweet data.
async function fetchViaSyndication(
  username: string,
  sinceId?: string | null,
): Promise<{ tweets: Tweet[]; source: string }> {
  const url =
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(username)}` +
    `?count=20&lang=en&dnt=1`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://publish.twitter.com/",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Syndication HTTP ${resp.status}: ${body.slice(0, 150)}`);
  }

  const html = await resp.text();

  // Extract __NEXT_DATA__ JSON blob embedded in the page
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Syndication: __NEXT_DATA__ not found in response");

  let nextData: any;
  try { nextData = JSON.parse(match[1]!); } catch { throw new Error("Syndication: __NEXT_DATA__ JSON parse error"); }

  // Timeline entries live at props.pageProps.timeline.entries
  const entries: any[] =
    nextData?.props?.pageProps?.timeline?.entries ??
    nextData?.props?.pageProps?.timeline?.timeline?.entries ??
    [];

  if (!entries.length) throw new Error("Syndication: no entries in timeline");

  const tweets: Tweet[] = [];
  for (const entry of entries) {
    const raw = entry?.tweet ?? entry?.content?.tweet ?? entry;
    if (!raw?.id_str || !raw?.full_text) continue;

    const text = (raw.full_text as string)
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    const author = (raw.user?.name as string | undefined) ?? username;
    const imageUrl: string | undefined = raw.entities?.media?.[0]?.media_url_https
      ?? raw.extended_entities?.media?.[0]?.media_url_https;

    tweets.push({
      id:        raw.id_str as string,
      text,
      author,
      url:       `https://x.com/${username}/status/${raw.id_str}`,
      pubDate:   raw.created_at ?? "",
      imageUrl,
    });
  }

  if (!tweets.length) throw new Error("Syndication: parsed 0 tweets from timeline");

  const filtered =
    sinceId && isNumericId(sinceId)
      ? tweets.filter(t => isNumericId(t.id) && BigInt(t.id) > BigInt(sinceId))
      : tweets;

  console.log(`[TweetMonitor] @${username} ✓ via syndication — ${filtered.length}/${tweets.length} tweet(s)`);
  return { tweets: filtered, source: "twitter:syndication" };
}

// ── Public entry — Syndication first (stable, works from Render) → Proxy → GraphQL → RSS ──
//
// Priority order — permanent design:
//
//  1. Syndication  — twitter.com embedded timeline endpoint. Works from cloud/Render IPs.
//                    Always returns the chronological 20 latest tweets. No API key, no QID rotation.
//                    This is the most stable source and must remain the first attempt.
//
//  2. Proxy        — Cloudflare Worker (GraphQL guest API). Useful for small/private accounts
//                    not covered by Syndication, and as a second opinion.
//
//  3. Twitter v2   — Paid bearer token. Only available if TWITTER_BEARER_TOKEN is set.
//
//  4. GraphQL      — Direct guest API. Blocked from Render IPs but kept as fallback.
//
//  5. RSS          — Nitter/RSSHub. Last resort, most instances dead as of 2026.
//
// WHY Syndication first?
//   GraphQL QIDs rotate every few weeks (Twitter changes their web app). When a QID breaks,
//   the proxy falls back to "profileBestHighlights" which returns popular OLD tweets, not newest.
//   Syndication is served by a stable CDN endpoint that does NOT use rotating QIDs.
//   Moving it to position #1 makes the bot permanently immune to QID changes.
export async function fetchLatestTweets(
  username: string,
  sinceId?: string | null,
): Promise<{ tweets: Tweet[]; source: string }> {

  // ── 1. Syndication (stable, always chronological, works from Render IPs) ───
  //
  // NOTE: Syndication can serve stale/pinned timelines for some accounts — it may
  // return tweets that are months or years old even when the account has posted today.
  // So we ONLY trust Syndication when it returns new tweets (filtered.length > 0).
  // When it returns 0 new, we ALWAYS fall through to Proxy for verification.
  // This prevents missed tweets caused by stale Syndication caches.
  let syndicationEmpty = false;
  try {
    const result = await fetchViaSyndication(username, sinceId);
    if (result.tweets.length > 0) return result; // ← new tweets found, done
    // 0 new tweets from Syndication — could be stale cache, fall through to Proxy
    syndicationEmpty = true;
    console.warn(`[TweetMonitor] @${username} — Syndication returned 0 new tweets, verifying with proxy`);
  } catch (err: any) {
    console.warn(`[TweetMonitor] @${username} — Syndication failed (${err.message}), trying proxy`);
  }

  // ── 2. Proxy — Cloudflare Worker (GraphQL guest API via CF IPs) ─────────────
  if (process.env.TWITTER_PROXY_URL) {
    try {
      const proxyResult = await fetchViaProxy(username, sinceId);
      if (proxyResult.tweets.length > 0) return proxyResult;

      // Both Syndication and Proxy returned 0 — but Syndication may be serving a
      // stale cache. Do a quick "fresh check" without sinceId to get the absolute
      // latest tweet, then compare its ID to what we have stored.
      // If the latest tweet is newer than sinceId, Syndication lied → recover the tweet.
      if (sinceId != null && isNumericId(sinceId) && syndicationEmpty) {
        try {
          const freshCheck = await fetchViaProxy(username, null);
          if (freshCheck.tweets.length > 0) {
            // Sort newest-first to reliably get the latest tweet
            const sorted = [...freshCheck.tweets].sort((a, b) => {
              if (!isNumericId(a.id) || !isNumericId(b.id)) return 0;
              return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
            });
            const latestId = sorted[0]?.id;
            if (latestId && isNumericId(latestId) && BigInt(latestId) > BigInt(sinceId)) {
              // Stale-cache miss confirmed — there IS a newer tweet we almost skipped
              console.warn(
                `[TweetMonitor] @${username} — stale-cache miss: latest=${latestId}, tracked=${sinceId}. Recovering missed tweet(s).`
              );
              const missed = sorted.filter(t => isNumericId(t.id) && BigInt(t.id) > BigInt(sinceId));
              return { tweets: missed, source: `${freshCheck.source}:stale-fix` };
            }
          }
        } catch {
          // Fresh check failed — fall through to GraphQL methods
        }
        return proxyResult; // Confirmed: genuinely no new tweets
      }

      console.warn(`[TweetMonitor] @${username} — Proxy returned 0 tweets, trying direct GraphQL`);
    } catch (err: any) {
      console.warn(`[TweetMonitor] @${username} — Proxy failed (${err.message}), trying direct GraphQL`);
    }
  }

  // ── 3. Twitter API v2 (requires paid bearer token) ──────────────────────────
  const token = getBearerToken();
  if (token) {
    try {
      return await fetchViaTwitterApiV2(username, sinceId);
    } catch (err: any) {
      console.warn(`[TweetMonitor] @${username} — Twitter API v2 failed (${err.message}), trying GraphQL guest`);
    }
  }

  // ── 4. Twitter GraphQL guest API (blocked from Render IPs — last direct attempt) ──
  try {
    return await fetchViaTwitterGraphQL(username, sinceId);
  } catch (err: any) {
    console.warn(`[TweetMonitor] @${username} — Twitter GraphQL failed (${err.message}), trying Nitter RSS`);
  }

  // ── 5. Nitter/RSSHub RSS (last resort) ──────────────────────────────────────
  const { tweets, source } = await fetchViaRss(username);
  if (sinceId && isNumericId(sinceId)) {
    return { tweets: tweets.filter(t => isNumericId(t.id) && BigInt(t.id) > BigInt(sinceId)), source };
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
  unreachable: boolean,
  cachedFetch?: { tweets: Tweet[]; source: string } | Error,
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
    if (cachedFetch) {
      // Use pre-fetched result — cache was fetched with the minimum sinceId across guilds,
      // so we must filter down to THIS guild's lastId before posting.
      if (cachedFetch instanceof Error) throw cachedFetch;
      const raw = cachedFetch.tweets;
      tweets = (lastId && isNumericId(lastId))
        ? raw.filter(t => isNumericId(t.id) && BigInt(t.id) > BigInt(lastId))
        : raw;
      source = cachedFetch.source;
    } else {
      const result = await fetchLatestTweets(username, lastId);
      tweets = result.tweets;
      source = result.source;
    }
    console.log(`[TweetMonitor] @${username} ✓ via ${source} (${tweets.length} tweet(s) fetched)`);
  } catch (err: any) {
    const errMsg = String(err?.message ?? err).slice(0, 300);
    const newFailCount = failCount + 1;
    const nowUnreachable = newFailCount >= DEAD_THRESHOLD;

    // Always log the actual error so it's visible in logs
    console.error(`[TweetMonitor] @${username} poll failed (attempt ${newFailCount}): ${errMsg}`);

    await pool.query(
      `UPDATE tweet_monitors SET fail_count = $1, last_fail_at = NOW(), unreachable = $2, last_error = $5
       WHERE guild_id = $3 AND twitter_user = $4`,
      [newFailCount, nowUnreachable, guildId, username, errMsg]
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

  // Sort tweets newest-first by ID (API may return mixed order, especially with highlights QID)
  tweets.sort((a, b) => {
    if (!isNumericId(a.id) || !isNumericId(b.id)) return 0;
    return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
  });

  // ── First run (no lastId): seed the tracker with the newest tweet ID without posting.
  // This prevents blasting old tweets into Discord when a new account is added.
  if (!lastId) {
    const seed = tweets[0];
    const seedId = seed && isNumericId(seed.id) ? seed.id : null;
    return { newId: seedId, failCount: 0, unreachable: false };
  }

  // ── Subsequent runs: age-filter + cap to avoid flooding ──────────────────────
  // Only send tweets published in the last 48 hours.
  // Tweets without a pubDate are skipped (cannot verify age — conservative).
  const MAX_TWEET_AGE_MS    = 48 * 60 * 60 * 1000; // 48 h
  const MAX_TWEETS_PER_POLL = 3;                    // cap per poll cycle

  const freshTweets = tweets.filter(t => {
    if (!t.pubDate) return false;
    const age = Date.now() - new Date(t.pubDate).getTime();
    return !isNaN(age) && age < MAX_TWEET_AGE_MS;
  });

  if (!freshTweets.length) {
    // All tweets are stale — advance lastId to the newest to avoid re-checking next cycle.
    const newestId = tweets[0] && isNumericId(tweets[0].id) ? tweets[0].id : lastId;
    return { newId: newestId, failCount: 0, unreachable: false };
  }

  // Reverse to post oldest-first, cap to MAX_TWEETS_PER_POLL
  const newTweets = [...freshTweets].reverse().slice(0, MAX_TWEETS_PER_POLL);

  // Fetch channel from Discord API if not in cache (common after restarts — cache is empty).
  // Silently dropping tweets when the channel isn't cached was the root cause of missed posts.
  const channel = (
    client.channels.cache.get(channelId) ??
    await client.channels.fetch(channelId).catch(() => null)
  ) as TextChannel | null;
  if (!channel) {
    console.warn(`[TweetMonitor] @${username} — channel ${channelId} not found (deleted?), skipping`);
    return { newId: lastId, failCount: 0, unreachable: false };
  }

  // Track the last tweet that was SUCCESSFULLY sent — so a failed send is retried next poll
  // rather than being silently skipped forever.
  let lastSuccessfullySentId: string | null = null;

  for (let ti = 0; ti < newTweets.length; ti++) {
    const tweet = newTweets[ti];
    try {
      await channel.send({
        embeds: [buildTweetEmbed(tweet, username)],
        components: [buildTweetButton(tweet.url)],
      });
      lastSuccessfullySentId = tweet.id;
    } catch (e: any) {
      console.warn(`[TweetMonitor] @${username} — failed to send tweet ${tweet.id}: ${e?.message ?? e}`);
    }
    // 1.5 s stagger between tweets — reduces event-loop pressure during burst sends
    if (ti < newTweets.length - 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 1_500));
    }
  }

  // Only advance last_tweet_id to the last tweet that actually reached Discord.
  // If ALL sends failed, keep lastId so every tweet is retried next cycle.
  const sentId = lastSuccessfullySentId ?? null;
  const savedId = sentId && isNumericId(sentId) ? sentId : lastId;
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

    // ── Phase 1: fetch each unique username ONCE with 2 s stagger ──────────────
    // Avoids N×guilds HTTP requests when the same account is monitored in multiple servers.
    const uniqueUsernames = [
      ...new Set(
        rows
          .filter(r => !r.unreachable)
          .filter(r => !(
            r.fail_count >= FAILURE_THRESHOLD &&
            r.last_fail_at &&
            Date.now() - r.last_fail_at.getTime() < SLOW_RETRY_INTERVAL_MS
          ))
          .map(r => r.twitter_user),
      ),
    ];

    // Compute the minimum (oldest) sinceId per username across all guilds.
    // Fetching with the oldest sinceId captures new tweets for every guild;
    // each guild then re-filters to its own lastId inside pollAccount.
    const minSinceId = new Map<string, string | null>();
    for (const row of rows.filter(r => uniqueUsernames.includes(r.twitter_user))) {
      const u  = row.twitter_user;
      const id = row.last_tweet_id;
      if (!minSinceId.has(u)) {
        minSinceId.set(u, id);
      } else {
        const cur = minSinceId.get(u)!;
        if (cur === null || id === null) {
          minSinceId.set(u, null);                                            // any null → fetch all
        } else if (isNumericId(cur) && isNumericId(id) && BigInt(id) < BigInt(cur)) {
          minSinceId.set(u, id);                                              // keep the older one
        }
      }
    }

    const fetchCache = new Map<string, { tweets: Tweet[]; source: string } | Error>();
    for (let i = 0; i < uniqueUsernames.length; i++) {
      const u = uniqueUsernames[i];
      try {
        fetchCache.set(u, await fetchLatestTweets(u, minSinceId.get(u) ?? null));
      } catch (err: any) {
        fetchCache.set(u, err instanceof Error ? err : new Error(String(err)));
      }
      if (i < uniqueUsernames.length - 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 2_000)); // 2 s stagger
      }
    }

    // ── Phase 2: distribute cached results to every (guild, username) row ──────
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
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
          fetchCache.get(row.twitter_user), // undefined for unreachable/slow-retry rows
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
      // 1.5 s between accounts to avoid burst Discord sends during peak cycles
      if (ri < rows.length - 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 1_500));
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
): Promise<Array<{ username: string; channelId: string; unreachable: boolean; failCount: number; lastTweetId: string | null; lastError: string | null }>> {
  const { rows } = await pool.query(
    `SELECT twitter_user, channel_id, unreachable, fail_count, last_tweet_id, last_error FROM tweet_monitors WHERE guild_id = $1 ORDER BY twitter_user`,
    [guildId],
  );
  return rows.map(r => ({
    username:    r.twitter_user,
    channelId:   r.channel_id,
    unreachable: r.unreachable,
    failCount:   r.fail_count ?? 0,
    lastTweetId: r.last_tweet_id ?? null,
    lastError:   r.last_error ?? null,
  }));
}

export async function resetAllTwitterAccounts(guildId: string): Promise<number> {
  const res = await pool.query(
    `UPDATE tweet_monitors
     SET fail_count = 0, last_fail_at = NULL, unreachable = FALSE, last_error = NULL
     WHERE guild_id = $1 AND fail_count > 0`,
    [guildId],
  );
  return res.rowCount ?? 0;
}

/**
 * Advance every account's last_tweet_id to its ACTUAL current latest tweet,
 * without posting anything to Discord. Call this after fixing the proxy so that
 * old stale IDs don't cause a flood of historical tweets on the next poll.
 */
export async function advanceAllTwitterAccounts(
  guildId: string,
): Promise<{ updated: string[]; skipped: string[]; failed: string[] }> {
  const rows = await pool.query(
    `SELECT twitter_user, twitter_user_id FROM tweet_monitors WHERE guild_id = $1 AND unreachable = FALSE`,
    [guildId],
  ).then(r => r.rows as { twitter_user: string; twitter_user_id: string | null }[]);

  const updated: string[] = [];
  const skipped: string[] = [];
  const failed:  string[] = [];

  for (const row of rows) {
    const username = row.twitter_user;
    try {
      // Fetch latest tweets WITHOUT sinceId — get whatever is newest right now
      const { tweets } = await fetchViaProxy(username, null);

      // Also try the full fetch chain as fallback
      let candidates = tweets;
      if (!candidates.length) {
        try {
          const chain = await fetchTweets(username);
          candidates = chain;
        } catch { /* ignore */ }
      }

      // Only keep numeric IDs (Twitter snowflakes)
      const validTweets = candidates.filter(t => /^\d+$/.test(t.id));
      if (!validTweets.length) { skipped.push(username); continue; }

      // Pick the highest (newest) ID
      const newestId = validTweets.reduce((best, t) =>
        BigInt(t.id) > BigInt(best.id) ? t : best,
      ).id;

      await pool.query(
        `UPDATE tweet_monitors
         SET last_tweet_id = $1,
             fail_count    = 0,
             last_fail_at  = NULL,
             unreachable   = FALSE,
             last_error    = NULL
         WHERE guild_id = $2 AND twitter_user = $3`,
        [newestId, guildId, username],
      );
      updated.push(username);
    } catch (err: any) {
      console.error(`[TweetMonitor] advanceAll: failed for @${username}:`, err?.message ?? err);
      failed.push(username);
    }
  }

  return { updated, skipped, failed };
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
    let errNote = "";
    if (r.unreachable) {
      status = "🔴";
      if (r.last_error) errNote = `\n  └ \`${String(r.last_error).slice(0, 120)}\``;
    } else if (r.fail_count >= FAILURE_THRESHOLD) {
      status = "⚠️";
      if (r.last_error) errNote = `\n  └ \`${String(r.last_error).slice(0, 120)}\``;
    }
    return `${status} **@${r.twitter_user}** → <#${r.channel_id}>${errNote}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("🐦 Monitored X / Twitter Accounts")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "✅ active • ⚠️ failing → use /twitterreset to retry now • 🔴 unreachable" });

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

async function handleTwitterReset(message: Message): Promise<void> {
  if (!isAdmin(message)) {
    await message.reply("❌ Only admins can use this command.");
    return;
  }
  const count = await resetAllTwitterAccounts(message.guild!.id);
  if (count === 0) {
    await message.reply("✅ All accounts are already healthy — no reset needed.");
  } else {
    await message.reply(`♻️ Reset **${count}** account(s) — they will retry on the next poll cycle (within 5 minutes).`);
  }
}

// ─── Register ────────────────────────────────────────────────────────────────
// Stored ref so we can clear the old interval on reconnect — prevents N intervals
// each holding a stale client reference after repeated reconnects.
let _tweetPollIntervalRef: ReturnType<typeof setInterval> | null = null;

// ─── Auto-reset failing accounts every 10 minutes ────────────────────────────
// After FAILURE_THRESHOLD consecutive failures the bot switches to slow-retry
// (6 h). The auto-reset clears that state so the normal 5-min cycle resumes
// automatically — no manual /twitterreset needed.
async function autoResetFailingAccounts(): Promise<void> {
  try {
    const { rowCount } = await pool.query(`
      UPDATE tweet_monitors
         SET fail_count = 0, last_fail_at = NULL
       WHERE unreachable = FALSE
         AND fail_count  >= $1
    `, [FAILURE_THRESHOLD]);
    if (rowCount && rowCount > 0) {
      console.log(`[TweetMonitor] ♻️ Auto-reset ${rowCount} failing account(s) — will retry on next poll`);
    }
  } catch (e: any) {
    console.warn("[TweetMonitor] Auto-reset error:", e?.message ?? e);
  }
}

export function registerTweetMonitor(client: Client): void {
  // Clear interval from previous connect() call (interval leak fix)
  if (_tweetPollIntervalRef) {
    clearInterval(_tweetPollIntervalRef);
    _tweetPollIntervalRef = null;
  }

  _tweetPollIntervalRef = setInterval(
    () => runPollCycle(client).catch(e => console.error("[TweetMonitor] Poll cycle crashed:", e)),
    POLL_INTERVAL_MS,
  );

  // Auto-reset failing accounts every 10 minutes (clears slow-retry state)
  setInterval(() => autoResetFailingAccounts(), 10 * 60 * 1000);

  // First poll 30 s after startup (gives Discord connection time to stabilise)
  setTimeout(
    () => runPollCycle(client).catch(e => console.error("[TweetMonitor] Initial poll crashed:", e)),
    30_000,
  );

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    try {
    if (!(await isClaimed(message.id))) return;
    if (!message.content.startsWith(PREFIX)) return;

    const [rawCmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase();

    if (cmd === "addtwitter")     await handleAddTwitter(message, args);
    if (cmd === "removetwitter")  await handleRemoveTwitter(message, args);
    if (cmd === "twitterlist")    await handleTwitterList(message);
    if (cmd === "twittercheck")   await handleTwitterCheck(message, args);
    if (cmd === "twitterstatus")  await handleTwitterStatus(message, args);
    if (cmd === "twitterreset")   await handleTwitterReset(message);
    } catch (err) {
      console.error("[Tweet-Monitor] Command handler error:", err);
      await message.reply("❌ Something went wrong. Please try again.").catch(() => {});
    }
  });
}
