// ─── RSS News Monitor ─────────────────────────────────────────────────────────
// Polls official Arabic / International / Japanese news RSS feeds every 5 min
// and posts breaking news to per-category Discord channels.
// No API key required — uses public RSS feeds directly from official sources.

import {
  Client,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
} from "discord.js";
import Parser from "rss-parser";
import { pool } from "@workspace/db";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_KEY         = 998877665;       // unique advisory lock key
const MAX_SEEN_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Official RSS Sources ─────────────────────────────────────────────────────
export interface NewsSource {
  id:       string;
  name:     string;
  flag:     string;
  lang:     "ar" | "en" | "ja";
  rssUrl:   string;
  color:    number;
}

export const NEWS_SOURCES: NewsSource[] = [
  // ── Arabic ─────────────────────────────────────────────────────────────────
  {
    id:     "aljazeera-ar",
    name:   "الجزيرة",
    flag:   "🇶🇦",
    lang:   "ar",
    rssUrl: "https://www.aljazeera.net/xml/rss/all.xml",
    color:  0x8B0000,
  },
  {
    id:     "bbc-arabic",
    name:   "BBC عربي",
    flag:   "🇬🇧",
    lang:   "ar",
    rssUrl: "https://feeds.bbci.co.uk/arabic/rss.xml",
    color:  0xBB1919,
  },
  {
    id:     "skynews-arabia",
    name:   "سكاي نيوز عربية",
    flag:   "🌍",
    lang:   "ar",
    rssUrl: "https://www.skynewsarabia.com/rss.xml",
    color:  0x005EB8,
  },
  {
    id:     "rt-arabic",
    name:   "RT عربي",
    flag:   "🌐",
    lang:   "ar",
    rssUrl: "https://arabic.rt.com/rss/",
    color:  0x0070CC,
  },
  // ── International (English) ────────────────────────────────────────────────
  {
    id:     "reuters",
    name:   "Reuters",
    flag:   "🌍",
    lang:   "en",
    rssUrl: "https://feeds.reuters.com/reuters/worldNews",
    color:  0xFF6600,
  },
  {
    id:     "bbc-world",
    name:   "BBC World",
    flag:   "🇬🇧",
    lang:   "en",
    rssUrl: "https://feeds.bbci.co.uk/news/world/rss.xml",
    color:  0xBB1919,
  },
  {
    id:     "apnews",
    name:   "AP News",
    flag:   "🌍",
    lang:   "en",
    rssUrl: "https://feeds.apnews.com/rss/apf-topnews",
    color:  0xFF0000,
  },
  // ── Japanese ──────────────────────────────────────────────────────────────
  {
    id:     "nhk-world",
    name:   "NHK World",
    flag:   "🇯🇵",
    lang:   "ja",
    rssUrl: "https://www3.nhk.or.jp/rss/news/cat0.xml",
    color:  0x005BAC,
  },
  {
    id:     "japan-times",
    name:   "The Japan Times",
    flag:   "🇯🇵",
    lang:   "ja",
    rssUrl: "https://www.japantimes.co.jp/feed/",
    color:  0xCC0000,
  },
];

// ─── RSS Parser ───────────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 10_000,
  headers: {
    "User-Agent":      "Mozilla/5.0 (compatible; PixelBot-News/1.0)",
    "Accept":          "application/rss+xml, application/xml, text/xml, */*",
    "Accept-Language": "ar,en,ja;q=0.9",
  },
});

// ─── DB setup ─────────────────────────────────────────────────────────────────
export async function initNewsMonitor(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_feed_config (
      id            SERIAL PRIMARY KEY,
      guild_id      TEXT NOT NULL UNIQUE,
      channel_id    TEXT NOT NULL DEFAULT '',
      channel_id_ar TEXT,
      channel_id_en TEXT,
      channel_id_ja TEXT,
      enabled       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migrate: add per-lang columns if they don't exist yet
  await pool.query(`ALTER TABLE news_feed_config ADD COLUMN IF NOT EXISTS channel_id_ar TEXT`);
  await pool.query(`ALTER TABLE news_feed_config ADD COLUMN IF NOT EXISTS channel_id_en TEXT`);
  await pool.query(`ALTER TABLE news_feed_config ADD COLUMN IF NOT EXISTS channel_id_ja TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_articles_seen (
      id         SERIAL PRIMARY KEY,
      article_id TEXT NOT NULL UNIQUE,
      source_id  TEXT NOT NULL,
      seen_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    DELETE FROM news_articles_seen
    WHERE seen_at < NOW() - INTERVAL '7 days'
  `);
}

// ─── Set / clear guild config ─────────────────────────────────────────────────
export interface NewsChannels {
  ar?: string | null;
  en?: string | null;
  ja?: string | null;
}

export async function setNewsChannel(guildId: string, channels: NewsChannels): Promise<void> {
  // Ensure row exists
  await pool.query(`
    INSERT INTO news_feed_config (guild_id, channel_id, enabled)
    VALUES ($1, '', TRUE)
    ON CONFLICT (guild_id) DO UPDATE SET enabled = TRUE
  `, [guildId]);

  // Update only the provided channels
  if (channels.ar !== undefined) {
    await pool.query(
      `UPDATE news_feed_config SET channel_id_ar = $1 WHERE guild_id = $2`,
      [channels.ar, guildId]
    );
  }
  if (channels.en !== undefined) {
    await pool.query(
      `UPDATE news_feed_config SET channel_id_en = $1 WHERE guild_id = $2`,
      [channels.en, guildId]
    );
  }
  if (channels.ja !== undefined) {
    await pool.query(
      `UPDATE news_feed_config SET channel_id_ja = $1 WHERE guild_id = $2`,
      [channels.ja, guildId]
    );
  }
}

export type NewsChannelKey = "ar" | "en" | "ja";

export async function removeNewsChannel(guildId: string, key: NewsChannelKey): Promise<boolean> {
  const col = key === "ar" ? "channel_id_ar" : key === "en" ? "channel_id_en" : "channel_id_ja";
  const { rowCount } = await pool.query(
    `UPDATE news_feed_config SET ${col} = NULL WHERE guild_id = $1`,
    [guildId]
  );
  return (rowCount ?? 0) > 0;
}

export async function stopNewsAlerts(guildId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE news_feed_config SET enabled = FALSE WHERE guild_id = $1`,
    [guildId]
  );
  return (rowCount ?? 0) > 0;
}

export interface NewsConfig {
  channelIdAr: string | null;
  channelIdEn: string | null;
  channelIdJa: string | null;
  enabled:     boolean;
}

export async function getNewsConfig(guildId: string): Promise<NewsConfig | null> {
  const { rows } = await pool.query(
    `SELECT channel_id_ar, channel_id_en, channel_id_ja, enabled
     FROM news_feed_config WHERE guild_id = $1`,
    [guildId]
  );
  if (!rows[0]) return null;
  return {
    channelIdAr: rows[0].channel_id_ar ?? null,
    channelIdEn: rows[0].channel_id_en ?? null,
    channelIdJa: rows[0].channel_id_ja ?? null,
    enabled:     rows[0].enabled,
  };
}

// ─── Fetch one source ─────────────────────────────────────────────────────────
interface NewsItem {
  id:          string;
  title:       string;
  link:        string;
  summary:     string;
  pubDate:     Date | null;
  source:      NewsSource;
}

async function fetchSourceNews(source: NewsSource): Promise<NewsItem[]> {
  try {
    const feed = await rssParser.parseURL(source.rssUrl);
    const items: NewsItem[] = [];

    for (const item of feed.items.slice(0, 10)) {
      const link  = item.link ?? item.guid ?? "";
      const title = item.title?.trim() ?? "";
      if (!title || !link) continue;

      const id = `${source.id}::${item.guid ?? link}`;
      const summary = (item.contentSnippet ?? item.content ?? item.summary ?? "")
        .replace(/<[^>]+>/g, "")
        .trim()
        .slice(0, 200);

      let pubDate: Date | null = null;
      if (item.pubDate) {
        const d = new Date(item.pubDate);
        if (!isNaN(d.getTime())) pubDate = d;
      }

      items.push({ id, title, link, summary, pubDate, source });
    }

    return items;
  } catch (err: any) {
    console.warn(`[NewsMonitor] ${source.name} RSS failed: ${err.message}`);
    return [];
  }
}

// ─── Filter out already-seen articles ─────────────────────────────────────────
async function filterUnseen(items: NewsItem[]): Promise<NewsItem[]> {
  if (!items.length) return [];

  const ids = items.map(i => i.id);
  const { rows } = await pool.query(
    `SELECT article_id FROM news_articles_seen WHERE article_id = ANY($1::text[])`,
    [ids]
  );
  const seenSet = new Set(rows.map((r: any) => r.article_id));
  return items.filter(i => !seenSet.has(i.id));
}

async function markAsSeen(items: NewsItem[]): Promise<void> {
  if (!items.length) return;
  for (const item of items) {
    await pool.query(
      `INSERT INTO news_articles_seen (article_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [item.id, item.source.id]
    );
  }
}

// ─── Build embed for one article ─────────────────────────────────────────────
function buildEmbed(item: NewsItem): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const src = item.source;
  const langLabel = src.lang === "ar" ? "🗞️ Breaking News — Arabic" :
                    src.lang === "ja" ? "🗞️ Breaking News — Japan" :
                    "🗞️ Breaking News — International";

  const embed = new EmbedBuilder()
    .setColor(src.color)
    .setAuthor({ name: `${src.flag} ${src.name}` })
    .setTitle(item.title.slice(0, 256))
    .setURL(item.link)
    .setFooter({ text: langLabel });

  if (item.summary) embed.setDescription(item.summary);
  if (item.pubDate) embed.setTimestamp(item.pubDate);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Read More")
      .setStyle(ButtonStyle.Link)
      .setURL(item.link)
      .setEmoji("🔗")
  );

  return { embed, row };
}

// ─── Post new articles — route each article to its language channel ───────────
async function postNewsToGuilds(client: Client, newItems: NewsItem[]): Promise<void> {
  if (!newItems.length) return;

  const { rows: configs } = await pool.query(
    `SELECT guild_id, channel_id_ar, channel_id_en, channel_id_ja
     FROM news_feed_config WHERE enabled = TRUE`
  );
  if (!configs.length) return;

  for (const cfg of configs) {
    // Build a map: channelId → items to post there
    const channelMap = new Map<string, NewsItem[]>();

    for (const item of newItems) {
      const channelId =
        item.source.lang === "ar" ? cfg.channel_id_ar :
        item.source.lang === "en" ? cfg.channel_id_en :
        item.source.lang === "ja" ? cfg.channel_id_ja : null;

      if (!channelId) continue; // No channel configured for this language

      if (!channelMap.has(channelId)) channelMap.set(channelId, []);
      channelMap.get(channelId)!.push(item);
    }

    for (const [channelId, items] of channelMap.entries()) {
      try {
        const channel = await client.channels.fetch(channelId).catch(() => null) as TextChannel | null;
        if (!channel?.isTextBased()) continue;

        for (const item of items) {
          try {
            const { embed, row } = buildEmbed(item);
            await channel.send({ embeds: [embed], components: [row] });
            await new Promise(r => setTimeout(r, 800));
          } catch (err: any) {
            console.warn(`[NewsMonitor] Failed to post article "${item.title.slice(0,40)}": ${err.message}`);
          }
        }
      } catch (err: any) {
        console.warn(`[NewsMonitor] Failed to fetch channel ${channelId}: ${err.message}`);
      }
    }
  }
}

// ─── Main poll cycle ──────────────────────────────────────────────────────────
async function runNewsPollCycle(client: Client): Promise<void> {
  const { rows: lockRows } = await pool.query(
    `SELECT pg_try_advisory_lock($1) AS acquired`, [LOCK_KEY]
  );
  if (!lockRows[0]?.acquired) return;

  try {
    const { rows: configs } = await pool.query(
      `SELECT 1 FROM news_feed_config WHERE enabled = TRUE
       AND (channel_id_ar IS NOT NULL OR channel_id_en IS NOT NULL OR channel_id_ja IS NOT NULL)
       LIMIT 1`
    );
    if (!configs.length) return;

    const allResults = await Promise.allSettled(
      NEWS_SOURCES.map(src => fetchSourceNews(src))
    );

    const allItems: NewsItem[] = [];
    for (const result of allResults) {
      if (result.status === "fulfilled") allItems.push(...result.value);
    }

    if (!allItems.length) return;

    const newItems = await filterUnseen(allItems);
    if (!newItems.length) {
      console.log(`[NewsMonitor] Poll complete — 0 new articles`);
      return;
    }

    await markAsSeen(newItems);

    newItems.sort((a, b) => {
      const ta = a.pubDate?.getTime() ?? 0;
      const tb = b.pubDate?.getTime() ?? 0;
      return ta - tb;
    });

    console.log(`[NewsMonitor] Poll complete — ${newItems.length} new article(s) to post`);
    await postNewsToGuilds(client, newItems);

  } finally {
    await pool.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
  }
}

// ─── Register & start ─────────────────────────────────────────────────────────
export function registerNewsMonitor(client: Client): void {
  initNewsMonitor()
    .then(async () => {
      console.log("[NewsMonitor] Initialized — starting poll loop (every 5 min)");

      setTimeout(() => {
        runNewsPollCycle(client).catch(e =>
          console.error("[NewsMonitor] Initial poll error:", e)
        );
      }, 30_000);

      setInterval(() => {
        runNewsPollCycle(client).catch(e =>
          console.error("[NewsMonitor] Poll cycle error:", e)
        );
      }, POLL_INTERVAL_MS);
    })
    .catch(e => console.error("[NewsMonitor] Init failed:", e));
}
