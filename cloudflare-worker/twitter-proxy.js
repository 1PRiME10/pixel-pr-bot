// ─────────────────────────────────────────────────────────────────────────────
// PIXEL_PR — Twitter Proxy  (Cloudflare Worker)
// ─────────────────────────────────────────────────────────────────────────────
// SETUP:
//   1. Go to https://workers.cloudflare.com  → create free account
//   2. Create a new Worker → paste this entire file
//   3. Settings → Variables → add: PROXY_SECRET = any_random_secret
//   4. Deploy → copy the Worker URL  (e.g. https://xyz.your-name.workers.dev)
//   5. On Render add two env vars:
//        TWITTER_PROXY_URL    = https://xyz.your-name.workers.dev
//        TWITTER_PROXY_SECRET = same_random_secret
// ─────────────────────────────────────────────────────────────────────────────

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const USER_QID   = "oUZZZ8Oddwxs8Cd3iW3UEA";
// UserTweets QIDs — chronological Posts tab only.
// ⚠️  DO NOT add profileBestHighlights QIDs here — they return popular/old tweets, not newest.
const TWEET_QIDS = [
  "V1ze5q3ijDS1VeLwLY0m7g", // UserTweets (Posts tab) — confirmed 2026-03-26
  "XicnWRbyQ3WgVlwd5MedHA", // UserTweets fallback #1
  "H8OjuYEErBMQam1dmf9-iA", // UserTweets fallback #2
];

// Guest token cache — persists within the same CF isolate (avoids duplicate API calls)
let _cachedGuestToken = null;
let _guestTokenAt = 0;

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

async function getGuestToken() {
  const now = Date.now();
  // Reuse cached token for up to 90 minutes (tokens are valid ~3 hours)
  if (_cachedGuestToken && now - _guestTokenAt < 90 * 60_000) return _cachedGuestToken;
  const resp = await fetch("https://api.twitter.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}` },
  });
  if (!resp.ok) throw new Error(`Guest token HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.guest_token) throw new Error("guest_token missing from response");
  _cachedGuestToken = data.guest_token;
  _guestTokenAt = now;
  return _cachedGuestToken;
}

async function resolveUserId(username, guestToken) {
  const vars = encodeURIComponent(
    JSON.stringify({ screen_name: username, withSafetyModeUserFields: true })
  );
  // Try twitter.com/i/api path first — works from Cloudflare IPs where api.twitter.com returns 400
  const urls = [
    `https://twitter.com/i/api/graphql/${USER_QID}/UserByScreenName?variables=${vars}`,
    `https://api.twitter.com/graphql/${USER_QID}/UserByScreenName?variables=${vars}&features=%7B%22hidden_profile_likes_enabled%22%3Atrue%7D`,
  ];
  let lastErr = "";
  for (const url of urls) {
    const resp = await fetch(url, { headers: twitterHeaders(guestToken) });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      lastErr = `HTTP ${resp.status}: ${body.slice(0, 80)}`;
      continue;
    }
    const data = await resp.json();
    const userId = data?.data?.user?.result?.rest_id;
    if (userId) return userId;
    lastErr = "rest_id missing in response";
  }
  throw new Error(`UserByScreenName failed — ${lastErr}`);
}

function extractTweets(data, username) {
  // Twitter uses either timeline_v2 (Posts tab) or timeline (profileBestHighlights) depending on the QID
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
    const media =
      legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
    const imageUrl = media[0]?.media_url_https;

    const text = (legacy.full_text)
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
  // Sort newest-first by ID (Twitter may return mixed order with some QIDs)
  tweets.sort((a, b) => {
    if (!/^\d+$/.test(a.id) || !/^\d+$/.test(b.id)) return 0;
    return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
  });
  return tweets;
}

// ── Syndication fallback — uses Twitter's public embed endpoint ──────────────
// Works for most public accounts; Cloudflare IPs are rarely rate-limited here.
async function fetchViaSyndication(username, sinceId) {
  const resp = await fetch(
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(username)}?count=20&lang=en&dnt=1`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://publish.twitter.com/",
      },
    }
  );
  if (!resp.ok) return null; // 429 or other error — just skip

  const html = await resp.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  let nextData;
  try { nextData = JSON.parse(match[1]); } catch { return null; }

  const entries =
    nextData?.props?.pageProps?.timeline?.entries ??
    nextData?.props?.pageProps?.timeline?.timeline?.entries ??
    [];
  if (!entries.length) return null;

  const tweets = [];
  for (const entry of entries) {
    const raw = entry?.tweet ?? entry?.content?.tweet ?? entry;
    if (!raw?.id_str || !raw?.full_text) continue;

    const text = (raw.full_text)
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    const imageUrl =
      raw.entities?.media?.[0]?.media_url_https ??
      raw.extended_entities?.media?.[0]?.media_url_https;

    tweets.push({
      id:      raw.id_str,
      text,
      author:  raw.user?.name ?? username,
      url:     `https://x.com/${username}/status/${raw.id_str}`,
      pubDate: raw.created_at ?? "",
      imageUrl,
    });
  }

  // Sort newest-first
  tweets.sort((a, b) => {
    if (!/^\d+$/.test(a.id) || !/^\d+$/.test(b.id)) return 0;
    return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
  });

  // Filter by sinceId if provided
  if (sinceId && /^\d+$/.test(sinceId)) {
    return tweets.filter(t => /^\d+$/.test(t.id) && BigInt(t.id) > BigInt(sinceId));
  }
  return tweets;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    // ── Auth ───────────────────────────────────────────────────────────────
    const secret = env.PROXY_SECRET;
    if (!secret) return json({ error: "PROXY_SECRET env var not set" }, 503);

    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return json({ error: "Unauthorized" }, 401);

    // ── Params ─────────────────────────────────────────────────────────────
    const url      = new URL(request.url);
    const username = url.searchParams.get("username")?.trim();
    const sinceId  = url.searchParams.get("since_id")?.trim();
    if (!username) return json({ error: "Missing ?username= param" }, 400);

    // ── Fetch tweets ───────────────────────────────────────────────────────
    try {
      // ── Strategy ──────────────────────────────────────────────────────────
      // When since_id is provided (regular polling — looking for NEW tweets):
      //   1. Try Syndication first  → most reliable for "latest" tweets
      //   2. If Syndication empty   → try GraphQL UserTweets (chronological QIDs only)
      //
      // When no since_id (first-time setup — just grab most recent tweet):
      //   1. Try GraphQL first      → richer data, no API-key needed
      //   2. If GraphQL empty       → try Syndication

      // Resolve userId for GraphQL path (Syndication uses username only)
      const guestToken = await getGuestToken();
      const userId = url.searchParams.get("user_id")?.trim() || await resolveUserId(username, guestToken);

      // ── Helper: fetch via GraphQL UserTweets ─────────────────────────────
      async function fetchGraphQL(filterSinceId) {
        const tweetVars = encodeURIComponent(JSON.stringify({
          userId,
          count: 20,
          includePromotedContent: false,
          withVoice: true,
          withV2Timeline: true,
        }));

        const qidErrors = [];
        for (const qid of TWEET_QIDS) {
          const tweetUrl =
            `https://twitter.com/i/api/graphql/${qid}/UserTweets` +
            `?variables=${tweetVars}&features=${encodeURIComponent(TWEET_FEATURES)}`;
          const tweetResp = await fetch(tweetUrl, { headers: twitterHeaders(guestToken) });
          if (!tweetResp.ok) {
            const body = await tweetResp.text().catch(() => "");
            qidErrors.push(`${qid}: HTTP ${tweetResp.status} — ${body.slice(0, 80)}`);
            continue;
          }
          const data = await tweetResp.json();
          const tweets = extractTweets(data, username);
          if (tweets.length === 0) { qidErrors.push(`${qid}: 0 tweets`); continue; }

          // Filter by sinceId if requested
          const filtered = (filterSinceId && /^\d+$/.test(filterSinceId))
            ? tweets.filter(t => /^\d+$/.test(t.id) && BigInt(t.id) > BigInt(filterSinceId))
            : tweets;

          return { tweets: filtered, qid };
        }
        // All QIDs failed
        throw new Error(`GraphQL all QIDs failed: ${qidErrors.join(" | ")}`);
      }

      // ── Main fetch strategy ───────────────────────────────────────────────
      let resultTweets = [];
      let resultSource = "cf-worker:graphql";
      let usedQid = null;

      if (sinceId && /^\d+$/.test(sinceId)) {
        // POLLING mode: skip Syndication here — the caller (Render) already tried it and got 0.
        // Hitting the same CDN URL again returns the same stale cache → wasted round-trip.
        // Go straight to GraphQL which is the only real-time source.
        try {
          const gql = await fetchGraphQL(sinceId);
          resultTweets = gql.tweets;
          usedQid = gql.qid;
          resultSource = "cf-worker:graphql";
          // GraphQL returned 0 with sinceId → verify with a fresh (no sinceId) call
          // to detect stale-cache misses where GraphQL thinks there's nothing new.
          if (resultTweets.length === 0) {
            try {
              const fresh = await fetchGraphQL(null);
              if (fresh.tweets.length > 0) {
                const newest = fresh.tweets[0]; // already sorted newest-first
                if (newest && /^\d+$/.test(newest.id) && BigInt(newest.id) > BigInt(sinceId)) {
                  // There IS a newer tweet — recover all missed ones
                  resultTweets = fresh.tweets.filter(t => /^\d+$/.test(t.id) && BigInt(t.id) > BigInt(sinceId));
                  resultSource = "cf-worker:graphql-recovery";
                }
              }
            } catch (_e) { /* recovery failed — return empty */ }
          }
        } catch (_e) {
          // GraphQL failed — last resort: try Syndication (may still have the tweet if CDN updated)
          const syndicationTweets = await fetchViaSyndication(username, sinceId).catch(() => null);
          if (syndicationTweets && syndicationTweets.length > 0) {
            resultTweets = syndicationTweets;
            resultSource = "cf-worker:syndication-fallback";
          }
        }
      } else {
        // INITIAL mode: try GraphQL first (no sinceId — we want any recent tweet to seed the monitor)
        try {
          const gql = await fetchGraphQL(null);
          resultTweets = gql.tweets;
          usedQid = gql.qid;
          resultSource = "cf-worker:graphql";
        } catch (_e) {
          // GraphQL failed → fallback to Syndication
          const syndicationTweets = await fetchViaSyndication(username, null).catch(() => null);
          if (syndicationTweets && syndicationTweets.length > 0) {
            resultTweets = syndicationTweets;
            resultSource = "cf-worker:syndication";
          }
        }
      }

      return json({ tweets: resultTweets, source: resultSource, userId, qid: usedQid });
    } catch (err) {
      return json({ error: err.message ?? String(err) }, 502);
    }
  },
};
