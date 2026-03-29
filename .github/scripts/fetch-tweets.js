// ─────────────────────────────────────────────────────────────────────────────
// PIXEL_PR — Twitter Cache Fetcher (GitHub Actions)
// Runs every 5 min from GitHub's (Azure) IPs — not blocked by Twitter.
// Saves tweets to twitter-cache/{username}.json for the bot to read.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require("fs");
const path = require("path");

const CACHE_DIR   = path.join(process.cwd(), "twitter-cache");
const STATE_FILE  = path.join(CACHE_DIR, ".state.json");
const ACCOUNTS_FILE = path.join(CACHE_DIR, "accounts.json");

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const USER_QID = "oUZZZ8Oddwxs8Cd3iW3UEA";
const TWEET_QIDS = [
  "V1ze5q3ijDS1VeLwLY0m7g",
  "XicnWRbyQ3WgVlwd5MedHA",
  "H8OjuYEErBMQam1dmf9-iA",
];

const TWEET_FEATURES = JSON.stringify({
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
});

// ── Persist guest token and userId cache across Action runs (via git) ─────────
let state = { guestToken: null, guestTokenAt: 0, userIds: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Twitter headers ───────────────────────────────────────────────────────────
function twitterHeaders(guestToken) {
  return {
    Authorization: `Bearer ${BEARER}`,
    "x-guest-token": guestToken,
    "x-csrf-token": "0",
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Client",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://twitter.com/",
    Origin: "https://twitter.com",
  };
}

// ── Guest token — cached 90 min across runs ───────────────────────────────────
async function getGuestToken() {
  const now = Date.now();
  if (state.guestToken && now - state.guestTokenAt < 90 * 60_000) {
    return state.guestToken;
  }
  console.log("  [token] Fetching fresh guest token...");
  const resp = await fetch("https://api.twitter.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}` },
  });
  if (!resp.ok) throw new Error(`Guest token HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.guest_token) throw new Error("guest_token missing");
  state.guestToken = data.guest_token;
  state.guestTokenAt = now;
  saveState();
  console.log("  [token] Got fresh guest token.");
  return state.guestToken;
}

// ── Resolve userId — cached in .state.json across runs ───────────────────────
async function resolveUserId(username, guestToken) {
  const key = username.toLowerCase();
  if (state.userIds && state.userIds[key]) return state.userIds[key];

  const vars = encodeURIComponent(
    JSON.stringify({ screen_name: username, withSafetyModeUserFields: true })
  );
  const urls = [
    `https://twitter.com/i/api/graphql/${USER_QID}/UserByScreenName?variables=${vars}`,
    `https://api.twitter.com/graphql/${USER_QID}/UserByScreenName?variables=${vars}&features=%7B%22hidden_profile_likes_enabled%22%3Atrue%7D`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: twitterHeaders(guestToken), signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const userId = data?.data?.user?.result?.rest_id;
      if (userId) {
        if (!state.userIds) state.userIds = {};
        state.userIds[key] = userId;
        saveState();
        return userId;
      }
    } catch {}
  }
  throw new Error(`Could not resolve userId for @${username}`);
}

// ── Extract tweets from GraphQL response ──────────────────────────────────────
function extractTweets(data, username) {
  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.data?.user?.result?.timeline?.timeline?.instructions ??
    [];
  const addEntries = instructions.find(
    (i) => i.type === "TimelineAddEntries" || Array.isArray(i.entries)
  );
  const entries = addEntries?.entries ?? [];
  const tweets = [];

  for (const entry of entries) {
    if (!entry.entryId?.startsWith("tweet-")) continue;
    const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
    const legacy = tweetResult?.legacy ?? tweetResult?.tweet?.legacy;
    if (!legacy?.id_str || !legacy?.full_text) continue;

    const authorLegacy = tweetResult?.core?.user_results?.result?.legacy ?? {};
    const media = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
    const imageUrl = media[0]?.media_url_https;

    const text = legacy.full_text
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    tweets.push({
      id:      legacy.id_str,
      text,
      author:  authorLegacy?.name ?? username,
      url:     `https://x.com/${username}/status/${legacy.id_str}`,
      pubDate: legacy.created_at ?? "",
      imageUrl,
    });
  }

  tweets.sort((a, b) => {
    if (!/^\d+$/.test(a.id) || !/^\d+$/.test(b.id)) return 0;
    return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
  });
  return tweets;
}

// ── Fetch via Twitter GraphQL ─────────────────────────────────────────────────
async function fetchViaGraphQL(username, guestToken) {
  const userId = await resolveUserId(username, guestToken);
  const vars = encodeURIComponent(JSON.stringify({
    userId,
    count: 20,
    includePromotedContent: false,
    withVoice: true,
    withV2Timeline: true,
  }));

  const errors = [];
  for (const qid of TWEET_QIDS) {
    try {
      const url =
        `https://twitter.com/i/api/graphql/${qid}/UserTweets` +
        `?variables=${vars}&features=${encodeURIComponent(TWEET_FEATURES)}`;
      const resp = await fetch(url, {
        headers: twitterHeaders(guestToken),
        signal: AbortSignal.timeout(12_000),
      });
      if (!resp.ok) {
        errors.push(`${qid}: HTTP ${resp.status}`);
        if (resp.status === 401 || resp.status === 403) {
          state.guestToken = null; // force refresh next run
          saveState();
        }
        continue;
      }
      const data = await resp.json();
      const tweets = extractTweets(data, username);
      if (!tweets.length) { errors.push(`${qid}: 0 tweets`); continue; }
      return { tweets, source: `github-action:graphql:${qid}` };
    } catch (e) {
      errors.push(`${qid}: ${e.message}`);
    }
  }
  throw new Error(`GraphQL all QIDs failed: ${errors.join(" | ")}`);
}

// ── Fetch via Twitter Syndication (fallback) ──────────────────────────────────
async function fetchViaSyndication(username) {
  const resp = await fetch(
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(username)}?count=20&lang=en&dnt=1`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://publish.twitter.com/",
      },
      signal: AbortSignal.timeout(12_000),
    }
  );
  if (!resp.ok) throw new Error(`Syndication HTTP ${resp.status}`);

  const html = await resp.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Syndication: __NEXT_DATA__ not found");

  const nextData = JSON.parse(match[1]);
  const entries =
    nextData?.props?.pageProps?.timeline?.entries ??
    nextData?.props?.pageProps?.timeline?.timeline?.entries ??
    [];
  if (!entries.length) throw new Error("Syndication: no entries");

  const tweets = [];
  for (const entry of entries) {
    const raw = entry?.tweet ?? entry?.content?.tweet ?? entry;
    if (!raw?.id_str || !raw?.full_text) continue;

    const text = raw.full_text
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    tweets.push({
      id:      raw.id_str,
      text,
      author:  raw.user?.name ?? username,
      url:     `https://x.com/${username}/status/${raw.id_str}`,
      pubDate: raw.created_at ?? "",
      imageUrl: raw.extended_entities?.media?.[0]?.media_url_https ?? raw.entities?.media?.[0]?.media_url_https,
    });
  }

  tweets.sort((a, b) => {
    if (!/^\d+$/.test(a.id) || !/^\d+$/.test(b.id)) return 0;
    return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
  });

  if (!tweets.length) throw new Error("Syndication: 0 tweets parsed");
  return { tweets, source: "github-action:syndication" };
}

// ── Fetch one account ─────────────────────────────────────────────────────────
async function fetchAccount(username, guestToken) {
  // Try GraphQL first (most reliable from GitHub IPs)
  try {
    const result = await fetchViaGraphQL(username, guestToken);
    console.log(`  ✓ @${username} — GraphQL (${result.tweets.length} tweets)`);
    return result;
  } catch (e) {
    console.warn(`  ⚠ @${username} — GraphQL failed: ${e.message}`);
  }

  // Fallback: Syndication
  try {
    const result = await fetchViaSyndication(username);
    console.log(`  ✓ @${username} — Syndication fallback (${result.tweets.length} tweets)`);
    return result;
  } catch (e) {
    console.warn(`  ✗ @${username} — Syndication also failed: ${e.message}`);
    throw e;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[PIXEL_PR Twitter Cache] Starting fetch — ${new Date().toISOString()}`);

  // Read account list
  let accounts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    accounts = raw.accounts ?? [];
  } catch (e) {
    console.error("Failed to read accounts.json:", e.message);
    process.exit(1);
  }

  if (!accounts.length) {
    console.log("No accounts to fetch.");
    return;
  }

  console.log(`Fetching ${accounts.length} accounts: ${accounts.join(", ")}`);

  // Get guest token (shared across all accounts this run)
  let guestToken;
  try {
    guestToken = await getGuestToken();
  } catch (e) {
    console.error("FATAL: Could not get guest token:", e.message);
    process.exit(1);
  }

  // Fetch accounts — sequential to avoid rate limits
  let success = 0;
  let failed = 0;
  const fetchedAt = new Date().toISOString();

  for (const username of accounts) {
    const outFile = path.join(CACHE_DIR, `${username.toLowerCase()}.json`);

    try {
      const { tweets, source } = await fetchAccount(username, guestToken);

      const payload = { username, fetchedAt, source, tweets };
      fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
      success++;
    } catch (e) {
      console.error(`  ✗ @${username} — SKIPPED: ${e.message}`);

      // Preserve existing cache if available, just update fetchedAt to show we tried
      try {
        const existing = JSON.parse(fs.readFileSync(outFile, "utf8"));
        existing.lastAttempt = fetchedAt;
        existing.lastError = e.message;
        fs.writeFileSync(outFile, JSON.stringify(existing, null, 2));
      } catch {}
      failed++;
    }

    // Small delay between accounts to avoid burst rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone: ${success} succeeded, ${failed} failed.`);
}

main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
