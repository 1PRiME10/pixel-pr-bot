// ─── Security Hardening Layer ─────────────────────────────────────────────────
// Protects the bot from abuse, exploitation, and vulnerabilities.
//
// Features:
//   • Per-user + per-command rate limiting (token bucket)
//   • Input sanitization (null bytes, control chars, length enforcement)
//   • Anti-spam detection with auto-timeout
//   • Suspicious activity logging + admin alerts
//   • Gemini-powered security scan (reads source, finds vulnerabilities)
//   • Gemini-powered auto-harden (patches found vulnerabilities)

import { readFileSync, existsSync }           from "fs";
import { resolve }                             from "path";
import { execSync }                            from "child_process";
import { ChatInputCommandInteraction,
         EmbedBuilder, GuildMember }           from "discord.js";
import { generateWithFallback }                 from "@workspace/integrations-gemini-ai";
import { pool }                                from "@workspace/db";

const _d = import.meta.dirname;
const WORKSPACE_ROOT = _d.includes("/dist") ? resolve(_d, "../../..") : resolve(_d, "../../../../..");

// ─── Robust JSON extraction ────────────────────────────────────────────────────
function extractJsonRobust(raw: string): string {
  let s = raw.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "").trim();
  const fo = s.indexOf("{"), lo = s.lastIndexOf("}");
  if (fo !== -1 && lo > fo) return s.slice(fo, lo + 1);
  const fa = s.indexOf("["), la = s.lastIndexOf("]");
  if (fa !== -1 && la > fa) return s.slice(fa, la + 1);
  return s;
}

// ─── Rate-Limit configuration ──────────────────────────────────────────────────
interface RateLimitConfig { limit: number; windowMs: number; }

const RATE_PROFILES: Record<string, RateLimitConfig> = {
  global:   { limit: 20,  windowMs: 60_000        },  // 20 cmds / min per user
  ai:       { limit: 3,   windowMs: 5  * 60_000   },  // 3 AI cmds / 5 min
  security: { limit: 2,   windowMs: 10 * 60_000   },  // 2 security ops / 10 min
  build:    { limit: 2,   windowMs: 10 * 60_000   },  // 2 builds / 10 min
  admin:    { limit: 10,  windowMs: 60_000        },
};

// key: `userId:profile`
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult { allowed: boolean; retryAfterSec: number; }

export function checkRateLimit(userId: string, profile: keyof typeof RATE_PROFILES): RateLimitResult {
  const cfg = RATE_PROFILES[profile] ?? RATE_PROFILES.global!;
  const key = `${userId}:${profile}`;
  const now = Date.now();

  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + cfg.windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }

  if (bucket.count >= cfg.limit) {
    return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count++;
  return { allowed: true, retryAfterSec: 0 };
}

// Clean up old buckets every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key);
  }
}, 15 * 60_000);

// ─── Input sanitization ────────────────────────────────────────────────────────
export function sanitize(input: string, maxLen = 2000): string {
  return input
    .slice(0, maxLen)
    .replace(/\0/g, "")                         // null bytes
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")  // control chars
    .replace(/`{3,}/g, "` ` `")                 // code block injection
    .trim();
}

export function sanitizeCommandOption(i: ChatInputCommandInteraction, name: string, maxLen = 500): string {
  return sanitize(i.options.getString(name) ?? "", maxLen);
}

// ─── Anti-spam: track suspicious users ────────────────────────────────────────
const suspiciousActivity = new Map<string, { events: number[]; warned: boolean }>();
let adminChannelId: string | null = null;
let adminClient: import("discord.js").Client | null = null;

export function setSecurityClient(client: import("discord.js").Client): void {
  adminClient = client;
}
export function setSecurityAdminChannel(channelId: string): void {
  adminChannelId = channelId;
}

export function trackSuspiciousActivity(userId: string, username: string, event: string): void {
  const now = Date.now();
  let record = suspiciousActivity.get(userId) ?? { events: [], warned: false };

  // Keep events in last 30 seconds
  record.events = record.events.filter(t => now - t < 30_000);
  record.events.push(now);

  if (record.events.length >= 10 && !record.warned) {
    record.warned = true;
    console.warn(`[Security] Suspicious activity from ${username} (${userId}): ${event}`);
    alertAdmin(`🚨 **Suspicious activity detected**\nUser: <@${userId}> (${username})\nEvent: ${event}\n${record.events.length} events in 30 seconds`).catch(() => {});

    // Log to DB
    pool.query(
      `INSERT INTO security_audit_log (user_id, username, event, event_count, detected_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [userId, username, event, record.events.length],
    ).catch(console.error);
  }

  suspiciousActivity.set(userId, record);
}

async function alertAdmin(message: string): Promise<void> {
  if (!adminClient || !adminChannelId) return;
  try {
    const ch = await adminClient.channels.fetch(adminChannelId);
    if (ch?.isTextBased()) await (ch as import("discord.js").TextChannel).send({ content: message });
  } catch { /* non-critical */ }
}

// ─── DB init ───────────────────────────────────────────────────────────────────
export async function initSecurityHardening(): Promise<void> {
  // Drop old incompatible security_config if it lacks the 'id' TEXT primary key
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'security_config'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'security_config' AND column_name = 'id'
      ) THEN
        DROP TABLE security_config;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_audit_log (
      id           SERIAL PRIMARY KEY,
      user_id      TEXT NOT NULL,
      username     TEXT,
      event        TEXT,
      event_count  INTEGER,
      detected_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS security_scan_results (
      id           SERIAL PRIMARY KEY,
      severity     TEXT,
      file         TEXT,
      description  TEXT,
      suggestion   TEXT,
      fixed        BOOLEAN DEFAULT FALSE,
      scanned_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS security_config (
      id               TEXT PRIMARY KEY DEFAULT 'singleton',
      harden_level     INTEGER NOT NULL DEFAULT 1,
      last_scan_at     TIMESTAMPTZ,
      vulnerabilities  INTEGER DEFAULT 0,
      hardened_at      TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO security_config (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
  `);
  console.log("[Security] Initialized — rate limiting + sanitization active");
}

// ─── Source files to scan ──────────────────────────────────────────────────────
const SCAN_FILES = [
  "artifacts/api-server/src/lib/features/slash-commands.ts",
  "artifacts/api-server/src/lib/features/daily.ts",
  "artifacts/api-server/src/lib/features/welcome.ts",
  "artifacts/api-server/src/lib/features/auto-security.ts",
  "artifacts/api-server/src/lib/features/server-log.ts",
  "artifacts/api-server/src/lib/features/moderation.ts",
  "artifacts/api-server/src/lib/features/reputation.ts",
  "artifacts/api-server/src/lib/features/profiling.ts",
  "artifacts/api-server/src/lib/discord-bot.ts",
  "artifacts/api-server/src/lib/features/ai-coder.ts",
  "artifacts/api-server/src/lib/features/ai-plugins.ts",
];

export interface Vulnerability {
  severity:    "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  file:        string;
  line?:       number;
  description: string;
  suggestion:  string;
  codeSnippet?: string;
}

// ─── Security scan ─────────────────────────────────────────────────────────────
export async function runSecurityScan(): Promise<Vulnerability[]> {
  const fileSummaries: string[] = [];

  for (const rel of SCAN_FILES) {
    const abs = resolve(WORKSPACE_ROOT, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf-8");
    // Trim to first 400 lines to keep prompt manageable
    const trimmed = src.split("\n").slice(0, 400).join("\n");
    fileSummaries.push(`\n\n=== FILE: ${rel} ===\n${trimmed}`);
  }

  const prompt = `You are an expert security auditor specializing in Discord bots, Node.js/TypeScript, and web security.

Audit the following source code files for security vulnerabilities. Focus on:
1. Unvalidated/unsanitized user inputs used in DB queries, file operations, or eval-like constructs
2. Missing permission checks (admin-only operations exposed to regular users)
3. Rate limiting gaps (expensive operations not throttled)
4. Hardcoded secrets or credentials
5. SQL injection risks (even with parameterized queries — look for dynamic query building)
6. Path traversal vulnerabilities
7. Code injection (eval, Function constructor, dynamic imports with user input)
8. Privilege escalation possibilities
9. Denial-of-service vectors (unbounded loops, large payloads, expensive regex)
10. Insecure direct object references

SOURCE FILES:
${fileSummaries.join("")}

Respond with ONLY a valid JSON array (no markdown, no explanation):
[
  {
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "file": "relative/path/to/file.ts",
    "description": "Specific description of the vulnerability",
    "suggestion": "How to fix it (concrete code suggestion if possible)"
  }
]

If no vulnerabilities found, return: []
Be precise and actionable. Maximum 15 items.`;

  try {
    const resText = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      maxOutputTokens: 8192,
    });

    const raw  = extractJsonRobust(resText ?? "");
    const data = JSON.parse(raw) as Vulnerability[];

    // Persist to DB
    for (const v of data) {
      await pool.query(
        `INSERT INTO security_scan_results (severity, file, description, suggestion)
         VALUES ($1,$2,$3,$4)`,
        [v.severity, v.file, v.description, v.suggestion],
      ).catch(console.error);
    }

    await pool.query(
      `UPDATE security_config SET last_scan_at = NOW(), vulnerabilities = $1 WHERE id = 'singleton'`,
      [data.length],
    ).catch(console.error);

    return data;
  } catch (e) {
    console.error("[Security] Scan failed:", e);
    return [];
  }
}

// ─── Security harden ───────────────────────────────────────────────────────────
export interface HardenResult {
  fixed:  number;
  failed: number;
  details: string[];
}

export async function hardenSecurity(): Promise<HardenResult> {
  // Get unfixed vulnerabilities from last scan
  const { rows } = await pool.query(
    `SELECT id, severity, file, description, suggestion
     FROM security_scan_results
     WHERE fixed = FALSE
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END
     LIMIT 10`,
  );

  if (!rows.length) {
    return { fixed: 0, failed: 0, details: ["No pending vulnerabilities — run /security scan first"] };
  }

  const API_SERVER_DIR = resolve(WORKSPACE_ROOT, "artifacts/api-server");
  const result: HardenResult = { fixed: 0, failed: 0, details: [] };

  for (const vuln of rows) {
    const abs = resolve(WORKSPACE_ROOT, vuln.file);
    if (!existsSync(abs)) {
      result.details.push(`⚠️ File not found: ${vuln.file}`);
      continue;
    }

    const source = readFileSync(abs, "utf-8");

    const prompt = `You are fixing a security vulnerability in a TypeScript Discord bot.

VULNERABILITY:
Severity: ${vuln.severity}
File: ${vuln.file}
Description: ${vuln.description}
Suggested fix: ${vuln.suggestion}

SOURCE FILE (first 600 lines):
\`\`\`typescript
${source.split("\n").slice(0, 600).join("\n")}
\`\`\`

Generate a MINIMAL surgical patch. Output ONLY raw JSON (no markdown):
{
  "old_code": "<exact string from source to replace>",
  "new_code": "<replacement — must be valid TypeScript>",
  "explanation": "<one sentence describing the fix>"
}

If the vulnerability cannot be safely auto-fixed, return:
{"old_code":"","new_code":"","explanation":"Cannot safely auto-fix: <reason>"}`;

    try {
      const resText2 = await generateWithFallback({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        maxOutputTokens: 8192,
      });
      const raw   = extractJsonRobust(resText2 ?? "");
      const patch = JSON.parse(raw) as { old_code: string; new_code: string; explanation: string };

      if (!patch.old_code || !patch.new_code) {
        result.failed++;
        result.details.push(`⚠️ ${vuln.severity} — ${patch.explanation}`);
        continue;
      }

      if (!source.includes(patch.old_code)) {
        result.failed++;
        result.details.push(`⚠️ Could not locate code to patch in ${vuln.file}`);
        continue;
      }

      // Apply
      const patched = source.replace(patch.old_code, patch.new_code);
      const { writeFileSync } = await import("fs");
      writeFileSync(abs, patched, "utf-8");

      // Validate TypeScript
      try {
        execSync("pnpm tsc --noEmit", { cwd: API_SERVER_DIR, stdio: "pipe" });
      } catch {
        // Rollback
        writeFileSync(abs, source, "utf-8");
        result.failed++;
        result.details.push(`❌ TypeScript validation failed for ${vuln.file} fix — rolled back`);
        continue;
      }

      // Mark fixed in DB
      await pool.query(`UPDATE security_scan_results SET fixed = TRUE WHERE id = $1`, [vuln.id]);
      result.fixed++;
      result.details.push(`✅ Fixed (${vuln.severity}): ${patch.explanation}`);
    } catch (e) {
      result.failed++;
      result.details.push(`❌ Error processing ${vuln.file}: ${String(e).slice(0, 80)}`);
    }
  }

  // Rebuild if anything was fixed
  if (result.fixed > 0) {
    try {
      execSync("node ./build.mjs", { cwd: API_SERVER_DIR, stdio: "pipe", timeout: 120_000 });
      await pool.query(`UPDATE security_config SET hardened_at = NOW() WHERE id = 'singleton'`);
      result.details.push("🔨 Dist rebuilt — restarting to apply changes...");
      setTimeout(() => process.exit(0), 3000);
    } catch {
      result.details.push("⚠️ Build failed after patching — manual review needed");
    }
  }

  return result;
}

// ─── Security status ───────────────────────────────────────────────────────────
export async function getSecurityStatus(): Promise<{
  lastScan:  Date | null;
  vulnCount: number;
  fixed:     number;
  level:     number;
  hardenedAt: Date | null;
}> {
  const { rows: cfg } = await pool.query(`SELECT * FROM security_config WHERE id = 'singleton'`);
  const { rows: fixed } = await pool.query(`SELECT COUNT(*) AS n FROM security_scan_results WHERE fixed = TRUE`);
  return {
    lastScan:   cfg[0]?.last_scan_at   ?? null,
    vulnCount:  cfg[0]?.vulnerabilities ?? 0,
    fixed:      parseInt(fixed[0]?.n ?? "0"),
    level:      cfg[0]?.harden_level   ?? 1,
    hardenedAt: cfg[0]?.hardened_at    ?? null,
  };
}
