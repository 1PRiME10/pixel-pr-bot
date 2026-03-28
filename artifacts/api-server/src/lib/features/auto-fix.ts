// ─── Auto-Fix Engine (v2 — cross-process patch sync) ─────────────────────────
// Uses Gemini AI to surgically patch TypeScript source when a recurring error
// is detected, then syncs the patch to ALL running instances via PostgreSQL.
//
// Full autonomous flow (no human intervention):
//   Dev bot:
//     Error occurs 3× in 10 min → Gemini reads source → generates patch →
//     TypeScript validation → backup → apply → rebuild dist → save to DB →
//     restart self
//
//   Production bot (on startup + every 30 min):
//     Reads new patches from DB → applies each one → rebuilds dist → restarts
//
// Both processes share the SAME PostgreSQL DB and the SAME file paths
// (/home/runner/workspace/...) so patches are fully portable.

import { execSync }                                          from "child_process";
import { readFileSync, writeFileSync, existsSync,
         copyFileSync, unlinkSync, cpSync, mkdirSync }       from "fs";
import { resolve }                                           from "path";
import { generateWithFallback }                               from "@workspace/integrations-gemini-ai";
import { pool }                                              from "@workspace/db";
import { scheduleRestart }                                  from "./restart-manager.js";

// ─── Paths (dev + production safe) ────────────────────────────────────────────
// Dev:  import.meta.dirname = .../src/lib/features  → 5 up = workspace
// Prod: import.meta.dirname = .../dist             → 3 up = workspace
const _d = import.meta.dirname;
const _inDist = _d.includes("/dist");
const WORKSPACE_ROOT = _inDist ? resolve(_d, "../../..") : resolve(_d, "../../../../..");
const API_SERVER_DIR = _inDist ? resolve(_d, "..")       : resolve(_d, "../../..");

// ─── Source file map: error context → relative path from WORKSPACE_ROOT ───────
const CONTEXT_TO_FILE: Record<string, string> = {
  "slash":              "artifacts/api-server/src/lib/features/slash-commands.ts",
  "sendPixelReply":     "artifacts/api-server/src/lib/discord-bot.ts",
  "daily":              "artifacts/api-server/src/lib/features/daily.ts",
  "welcome":            "artifacts/api-server/src/lib/features/welcome.ts",
  "auto-security":      "artifacts/api-server/src/lib/features/auto-security.ts",
  "server-log":         "artifacts/api-server/src/lib/features/server-log.ts",
  "tweet-monitor":      "artifacts/api-server/src/lib/features/tweet-monitor.ts",
  "youtube-monitor":    "artifacts/api-server/src/lib/features/youtube-monitor.ts",
  "tracker":            "artifacts/api-server/src/lib/features/tracker.ts",
  "jp-tracker":         "artifacts/api-server/src/lib/features/jp-tracker.ts",
  "profiling":          "artifacts/api-server/src/lib/features/profiling.ts",
  "memory":             "artifacts/api-server/src/lib/features/memory.ts",
  "events":             "artifacts/api-server/src/lib/features/events.ts",
  "radio":              "artifacts/api-server/src/lib/features/radio.ts",
  "moderation":         "artifacts/api-server/src/lib/features/moderation.ts",
  "self-heal":          "artifacts/api-server/src/lib/features/self-heal.ts",
  "auto-fix":           "artifacts/api-server/src/lib/features/auto-fix.ts",
  "unhandledRejection": "artifacts/api-server/src/lib/discord-bot.ts",
  "uncaughtException":  "artifacts/api-server/src/lib/discord-bot.ts",
};

// ─── State ────────────────────────────────────────────────────────────────────
export let autoFixEnabled = false;
let syncIntervalId: ReturnType<typeof setInterval> | null = null;

// ─── DB Init ──────────────────────────────────────────────────────────────────
export async function initAutoFix(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_fix_log (
      id              SERIAL PRIMARY KEY,
      error_key       TEXT NOT NULL,
      source_file_rel TEXT,          -- path relative to WORKSPACE_ROOT
      patch_old       TEXT,          -- exact string that was replaced
      patch_new       TEXT,          -- replacement string
      description     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      ts_valid        BOOLEAN,
      build_ok        BOOLEAN,
      synced          BOOLEAN DEFAULT FALSE,   -- TRUE = patch is ready for other instances
      applied_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS auto_fix_config (
      id                    TEXT PRIMARY KEY DEFAULT 'singleton',
      enabled               BOOLEAN NOT NULL DEFAULT FALSE,
      last_synced_patch_id  INTEGER NOT NULL DEFAULT 0,
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO auto_fix_config (id, enabled)
    VALUES ('singleton', FALSE)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Migration: add new columns if they don't exist yet
  await pool.query(`
    ALTER TABLE auto_fix_config
      ADD COLUMN IF NOT EXISTS last_synced_patch_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE auto_fix_log
      ADD COLUMN IF NOT EXISTS source_file_rel TEXT,
      ADD COLUMN IF NOT EXISTS synced           BOOLEAN DEFAULT FALSE;
  `);

  const { rows } = await pool.query(
    `SELECT enabled FROM auto_fix_config WHERE id = 'singleton'`,
  );
  autoFixEnabled = rows[0]?.enabled ?? false;

  // Apply any patches that were generated by OTHER instances (e.g., dev → production)
  await syncPatchesFromDB("startup");

  // Periodic sync every 30 minutes so production stays up to date
  if (!syncIntervalId) {
    syncIntervalId = setInterval(() => {
      syncPatchesFromDB("periodic").catch(console.error);
    }, 30 * 60 * 1000);
  }

  console.log(`[AutoFix] Initialized — auto-fix ${autoFixEnabled ? "ENABLED" : "disabled"}`);
}

// ─── Toggle auto-fix ──────────────────────────────────────────────────────────
export async function setAutoFixEnabled(on: boolean): Promise<void> {
  await pool.query(
    `UPDATE auto_fix_config SET enabled = $1, updated_at = NOW() WHERE id = 'singleton'`,
    [on],
  );
  autoFixEnabled = on;
}

// ─── Patch sync: apply patches generated by OTHER instances ──────────────────
// Reads patches from DB that have `synced = TRUE` and `id > last_synced_patch_id`.
// Applies each one to the local TS source, rebuilds dist, and restarts.
async function syncPatchesFromDB(trigger: string): Promise<void> {
  try {
    const { rows: cfg } = await pool.query(
      `SELECT last_synced_patch_id FROM auto_fix_config WHERE id = 'singleton'`,
    );
    const lastId: number = cfg[0]?.last_synced_patch_id ?? 0;

    const { rows: patches } = await pool.query(
      `SELECT id, source_file_rel, patch_old, patch_new, description
       FROM auto_fix_log
       WHERE synced = TRUE
         AND status = 'applied'
         AND id > $1
       ORDER BY id ASC`,
      [lastId],
    );

    if (!patches.length) return;

    console.log(`[AutoFix] [${trigger}] Found ${patches.length} new patch(es) to sync — applying...`);
    let applied = 0;

    for (const p of patches) {
      if (!p.source_file_rel || !p.patch_old || !p.patch_new) continue;

      const absPath = resolve(WORKSPACE_ROOT, p.source_file_rel);
      if (!existsSync(absPath)) {
        console.warn(`[AutoFix] Sync: source file not found: ${absPath}`);
        continue;
      }

      const source = readFileSync(absPath, "utf-8");
      if (!source.includes(p.patch_old)) {
        console.warn(`[AutoFix] Sync: old_code not found in ${absPath} — may already be patched`);
        // Still advance the pointer so we don't keep trying
        await pool.query(
          `UPDATE auto_fix_config SET last_synced_patch_id = $1 WHERE id = 'singleton'`,
          [p.id],
        );
        continue;
      }

      const patched = source.replace(p.patch_old, p.patch_new);
      writeFileSync(absPath, patched, "utf-8");
      console.log(`[AutoFix] Sync: applied patch #${p.id}: ${p.description}`);
      applied++;

      await pool.query(
        `UPDATE auto_fix_config SET last_synced_patch_id = $1 WHERE id = 'singleton'`,
        [p.id],
      );
    }

    if (applied > 0) {
      console.log(`[AutoFix] Sync: ${applied} patch(es) applied — rebuilding dist...`);
      const buildOk = rebuildDist();
      if (buildOk) {
        console.log("[AutoFix] Sync: rebuild successful — scheduling restart...");
        scheduleRestart("auto-fix-sync", 2000);
      } else {
        console.error("[AutoFix] Sync: rebuild FAILED after sync — manual intervention needed");
      }
    }
  } catch (e) {
    console.error("[AutoFix] syncPatchesFromDB error:", e);
  }
}

// ─── Error occurrence counter ─────────────────────────────────────────────────
const errorCounts  = new Map<string, { count: number; first: number }>();
const fixCooldowns = new Map<string, number>();
const TRIGGER_COUNT  = 3;
const TRIGGER_WINDOW = 10 * 60 * 1000; // 10 minutes
const COOLDOWN_MS    = 30 * 60 * 1000; // 30 min cooldown after a fix attempt

export function shouldAttemptFix(errorKey: string): boolean {
  if (!autoFixEnabled) return false;

  const lastFix = fixCooldowns.get(errorKey);
  if (lastFix && Date.now() - lastFix < COOLDOWN_MS) return false;

  const entry = errorCounts.get(errorKey);
  if (!entry) {
    errorCounts.set(errorKey, { count: 1, first: Date.now() });
    return false;
  }

  if (Date.now() - entry.first > TRIGGER_WINDOW) {
    errorCounts.set(errorKey, { count: 1, first: Date.now() });
    return false;
  }

  entry.count++;
  if (entry.count >= TRIGGER_COUNT) {
    errorCounts.delete(errorKey);
    fixCooldowns.set(errorKey, Date.now());
    return true;
  }
  return false;
}

// ─── Resolve source file path from error context ──────────────────────────────
function resolveSourceFile(context: string): { abs: string; rel: string } | null {
  for (const [key, rel] of Object.entries(CONTEXT_TO_FILE)) {
    if (context.startsWith(key) || context.includes(key)) {
      return { abs: resolve(WORKSPACE_ROOT, rel), rel };
    }
  }
  return null;
}

// ─── Extract relevant source lines around the error ───────────────────────────
function extractContext(source: string, errorMsg: string, maxLines = 120): string {
  const lines    = source.split("\n");
  if (lines.length <= maxLines) return source;

  const msgWords = errorMsg.replace(/[^a-zA-Z0-9_]/g, " ").split(/\s+/).filter(w => w.length > 4);
  let bestLine = 0, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = msgWords.filter(w => lines[i].includes(w)).length;
    if (score > bestScore) { bestScore = score; bestLine = i; }
  }

  const start  = Math.max(0, bestLine - Math.floor(maxLines / 2));
  const end    = Math.min(lines.length, start + maxLines);
  const prefix = start > 0 ? `// ... (lines 1–${start} omitted)\n` : "";
  const suffix = end < lines.length ? `\n// ... (lines ${end + 1}–${lines.length} omitted)` : "";
  return prefix + lines.slice(start, end).join("\n") + suffix;
}

// ─── Robust JSON extraction (handles all Gemini markdown fence variants) ────────
function extractJsonRobust(raw: string): string {
  let s = raw.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "").trim();
  const first = s.indexOf("{"); const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  const fa = s.indexOf("["); const la = s.lastIndexOf("]");
  if (fa !== -1 && la > fa) return s.slice(fa, la + 1);
  return s;
}

// ─── Gemini: generate surgical patch ─────────────────────────────────────────
interface Patch { old_code: string; new_code: string; description: string; }

async function generatePatch(err: any, context: string, absPath: string, source: string): Promise<Patch | null> {
  const errorMsg   = String(err?.message ?? err).slice(0, 400);
  const stackTrace = (err?.stack ?? "").slice(0, 600);
  const relevant   = extractContext(source, errorMsg);

  const prompt = `You are an expert TypeScript Discord bot developer and automated bug fixer.

A runtime error keeps occurring in this Discord bot code. Your ONLY job is to produce a MINIMAL, SURGICAL fix.

ERROR MESSAGE: ${errorMsg}
ERROR CODE: ${err?.code ?? "N/A"}
CONTEXT: ${context}
STACK TRACE:
${stackTrace}

SOURCE FILE: ${absPath}
RELEVANT SOURCE CODE:
\`\`\`typescript
${relevant}
\`\`\`

Respond with ONLY a raw JSON object (no markdown, no code block, no explanation outside JSON):
{
  "old_code": "<exact string from the source to replace — must be a UNIQUE substring>",
  "new_code": "<replacement string — must be valid TypeScript>",
  "description": "<one sentence: what the bug was and how you fixed it>"
}

STRICT RULES:
1. old_code must be an EXACT copy of text from the source shown above
2. old_code must be unique within the file — include surrounding code if needed
3. new_code must compile as TypeScript with no type errors
4. Fix must be MINIMAL — do not touch unrelated code
5. Common fixes: add null/undefined checks, wrap in try/catch, fix async patterns, handle edge cases
6. If you cannot find a safe fix, return: {"old_code":"","new_code":"","description":"No safe fix identified"}`;

  try {
    const responseText = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      maxOutputTokens: 8192,
    });

    const raw  = extractJsonRobust(responseText ?? "");
    const json = JSON.parse(raw) as Patch;
    if (!json.old_code || !json.new_code) {
      console.log("[AutoFix] Gemini: no safe fix identified:", json.description);
      return null;
    }
    return json;
  } catch (e) {
    console.error("[AutoFix] Gemini patch generation failed:", e);
    return null;
  }
}

// ─── TypeScript validation ────────────────────────────────────────────────────
function validateTypeScript(): boolean {
  try {
    execSync("pnpm tsc --noEmit", { cwd: API_SERVER_DIR, stdio: "pipe" });
    return true;
  } catch { return false; }
}

// ─── Rebuild dist (with automatic dist.backup/ snapshot) ─────────────────────
// Before every build we snapshot the CURRENT dist/ to dist.backup/.
// This means dist.backup/ always contains the last known-working build.
// The `start` npm script falls back to dist.backup/ if dist/index.mjs crashes
// at startup — so even a bad auto-fix can never permanently brick the bot.
function rebuildDist(): boolean {
  try {
    // Snapshot current dist/ → dist.backup/ (overwrite with the last good build)
    const distDir   = resolve(API_SERVER_DIR, "dist");
    const backupDir = resolve(API_SERVER_DIR, "dist.backup");
    if (existsSync(distDir)) {
      mkdirSync(backupDir, { recursive: true });
      cpSync(distDir, backupDir, { recursive: true, force: true });
      console.log("[AutoFix] 📦 dist.backup/ updated (snapshot of current build)");
    }
    execSync("node ./build.mjs", { cwd: API_SERVER_DIR, stdio: "pipe", timeout: 120_000 });
    return true;
  } catch { return false; }
}

// ─── Apply patch to file ──────────────────────────────────────────────────────
function applyPatch(absPath: string, patch: Patch): boolean {
  const source = readFileSync(absPath, "utf-8");
  if (!source.includes(patch.old_code)) {
    console.error("[AutoFix] old_code not found in source — patch aborted");
    return false;
  }
  writeFileSync(absPath, source.replace(patch.old_code, patch.new_code), "utf-8");
  return true;
}

// ─── Save patch to DB (for other instances to sync) ──────────────────────────
async function saveToDB(
  errorKey:    string,
  rel:         string | null,
  patch:       Patch | null,
  status:      string,
  tsValid:     boolean | null,
  buildOk:     boolean | null,
  synced:      boolean,
): Promise<number | null> {
  const { rows } = await pool.query(
    `INSERT INTO auto_fix_log
       (error_key, source_file_rel, patch_old, patch_new, description, status, ts_valid, build_ok, synced)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      errorKey,
      rel,
      patch?.old_code?.slice(0, 2000) ?? null,
      patch?.new_code?.slice(0, 2000) ?? null,
      patch?.description ?? null,
      status,
      tsValid,
      buildOk,
      synced,
    ],
  ).catch(e => { console.error("[AutoFix] DB save failed:", e); return { rows: [] }; });
  return rows[0]?.id ?? null;
}

// ─── Main: attempt auto-fix ───────────────────────────────────────────────────
export interface AutoFixResult {
  applied:     boolean;
  description: string;
  status:      "applied" | "failed_ts" | "failed_build" | "failed_patch" | "no_fix" | "no_file" | "rollback";
}

export async function attemptAutoFix(
  err:      any,
  context:  string,
  errorKey: string,
): Promise<AutoFixResult> {
  console.log(`[AutoFix] Attempting fix for: ${errorKey}`);

  // 1. Identify source file
  const filePaths = resolveSourceFile(context);
  if (!filePaths || !existsSync(filePaths.abs)) {
    await saveToDB(errorKey, filePaths?.rel ?? null, null, "no_file", null, null, false);
    return { applied: false, description: "Could not identify the source file", status: "no_file" };
  }

  const { abs: absPath, rel } = filePaths;
  const source = readFileSync(absPath, "utf-8");

  // 2. Generate patch
  const patch = await generatePatch(err, context, absPath, source);
  if (!patch) {
    await saveToDB(errorKey, rel, null, "no_fix", null, null, false);
    return { applied: false, description: "Gemini could not determine a safe fix", status: "no_fix" };
  }

  // 3. Backup
  const backupPath = `${absPath}.autofix.backup`;
  copyFileSync(absPath, backupPath);

  // 4. Apply patch
  if (!applyPatch(absPath, patch)) {
    unlinkSync(backupPath);
    await saveToDB(errorKey, rel, patch, "failed_patch", null, null, false);
    return { applied: false, description: "old_code string not found in source file", status: "failed_patch" };
  }

  // 5. TypeScript validation
  if (!validateTypeScript()) {
    copyFileSync(backupPath, absPath); // rollback
    unlinkSync(backupPath);
    await saveToDB(errorKey, rel, patch, "failed_ts", false, null, false);
    return { applied: false, description: `TypeScript validation failed — rolled back. Attempted: "${patch.description}"`, status: "failed_ts" };
  }

  // 6. Rebuild
  if (!rebuildDist()) {
    copyFileSync(backupPath, absPath); // rollback
    rebuildDist();                     // rebuild with original
    unlinkSync(backupPath);
    await saveToDB(errorKey, rel, patch, "failed_build", true, false, false);
    return { applied: false, description: `Build failed after patch — rolled back. Attempted: "${patch.description}"`, status: "failed_build" };
  }

  // 7. Success — save to DB with synced=TRUE so other instances pick it up
  unlinkSync(backupPath);
  await saveToDB(errorKey, rel, patch, "applied", true, true, true);

  // 8. Schedule restart
  console.log(`[AutoFix] ✅ Fix applied: ${patch.description}`);
  const restarted = scheduleRestart("auto-fix");
  if (!restarted) {
    console.log("[AutoFix] Restart cooldown active — fix staged, will apply on next restart.");
  } else {
    console.log("[AutoFix] Restarting in 4s to apply fix...");
  }

  return { applied: true, description: patch.description, status: "applied" };
}

// ─── Resolve a short filename or partial path to a workspace-relative path ────
// Handles inputs like: "slash-commands.ts", "features/slash-commands.ts",
// or the full "artifacts/api-server/src/lib/features/slash-commands.ts"
function resolveTargetPath(nameOrRel: string): { rel: string; abs: string } | null {
  // 1. Try path as given (user typed full relative path)
  const direct = resolve(WORKSPACE_ROOT, nameOrRel);
  if (existsSync(direct)) return { rel: nameOrRel, abs: direct };

  // 2. Search the CONTEXT_TO_FILE map for a matching basename
  const basename = nameOrRel.split("/").pop() ?? nameOrRel;
  for (const fullRel of Object.values(CONTEXT_TO_FILE)) {
    if (fullRel.endsWith(`/${basename}`) || fullRel === basename) {
      const abs = resolve(WORKSPACE_ROOT, fullRel);
      if (existsSync(abs)) return { rel: fullRel, abs };
    }
  }

  // 3. Brute-force scan known source dirs for the basename
  const searchDirs = [
    "artifacts/api-server/src/lib/features",
    "artifacts/api-server/src/lib",
    "artifacts/api-server/src",
  ];
  for (const dir of searchDirs) {
    const candidate = resolve(WORKSPACE_ROOT, dir, basename);
    if (existsSync(candidate)) return { rel: `${dir}/${basename}`, abs: candidate };
  }

  return null;
}

// ─── Manual Fix: triggered by "Apply Fix" button + modal in Discord ──────────
// Takes a target file (relative to workspace root) and a human/AI suggestion,
// asks Gemini to produce a MINIMAL surgical patch, then applies it exactly
// like the automatic path: TS validate → rebuild → restart.
export async function applyManualFix(
  targetFileRel: string,
  suggestion:    string,
  errorContext:  string = "manual",
): Promise<AutoFixResult> {
  // On Render, source .ts files are not deployed — only the compiled dist/ exists.
  // Code fixes must be made in the development environment (Replit) and deployed.
  if (process.env.RENDER) {
    return {
      applied:     false,
      description: "Code fixes are not available on the deployment server.\n" +
                   "Source files only exist in the development environment.\n" +
                   "Make this change in Replit and deploy manually from the Render dashboard.",
      status:      "no_file",
    };
  }

  const resolved = resolveTargetPath(targetFileRel);
  if (!resolved) {
    return { applied: false, description: `File not found: ${targetFileRel}`, status: "no_file" };
  }
  const { rel: resolvedRel, abs: absPath } = resolved;

  const source = readFileSync(absPath, "utf-8");

  // Ask Gemini to turn the suggestion into a concrete patch
  const prompt = `You are an expert TypeScript Discord bot developer.

A bot admin has provided a fix suggestion for a known bug. Your job is to produce a MINIMAL, SURGICAL code patch.

TARGET FILE: ${resolvedRel}
FIX SUGGESTION FROM ADMIN:
${suggestion.slice(0, 2000)}

CURRENT SOURCE CODE (excerpt for context):
\`\`\`typescript
${source.slice(0, 6000)}
\`\`\`

Respond with ONLY a raw JSON object (no markdown, no explanation outside JSON):
{
  "old_code": "<exact string from the source to replace — must be unique>",
  "new_code": "<replacement string — must be valid TypeScript>",
  "description": "<one sentence: what was changed and why>"
}

STRICT RULES:
1. old_code must be EXACT text from the source shown above
2. old_code must uniquely identify the location
3. new_code must be valid TypeScript
4. Fix must be MINIMAL — do not change unrelated lines
5. If no safe minimal patch is possible, return: {"old_code":"","new_code":"","description":"No safe patch identified"}`;

  let patch: Patch | null = null;
  try {
    const raw  = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      maxOutputTokens: 8192,
    });
    const json = JSON.parse(extractJsonRobust(raw ?? "")) as Patch;
    if (!json.old_code || !json.new_code) {
      return { applied: false, description: "AI could not produce a safe patch", status: "no_fix" };
    }
    patch = json;
  } catch (e) {
    console.error("[AutoFix] applyManualFix: Gemini error:", e);
    return { applied: false, description: "Gemini failed to generate patch", status: "no_fix" };
  }

  // Backup → Apply → Validate → Build
  const backupPath = `${absPath}.manual.backup`;
  copyFileSync(absPath, backupPath);

  if (!applyPatch(absPath, patch)) {
    unlinkSync(backupPath);
    return { applied: false, description: "old_code string not found in source", status: "failed_patch" };
  }

  if (!validateTypeScript()) {
    copyFileSync(backupPath, absPath);
    unlinkSync(backupPath);
    return {
      applied: false,
      description: `TypeScript validation failed — rolled back. Attempted: "${patch.description}"`,
      status: "failed_ts",
    };
  }

  if (!rebuildDist()) {
    copyFileSync(backupPath, absPath);
    rebuildDist();
    unlinkSync(backupPath);
    return {
      applied: false,
      description: `Build failed after patch — rolled back. Attempted: "${patch.description}"`,
      status: "failed_build",
    };
  }

  unlinkSync(backupPath);
  await saveToDB(`manual:${errorContext}`, resolvedRel, patch, "applied", true, true, true);

  console.log(`[AutoFix] ✅ Manual fix applied: ${patch.description}`);
  scheduleRestart("manual-fix");

  return { applied: true, description: patch.description, status: "applied" };
}

// ─── Fix history (for /autofix status) ───────────────────────────────────────
export async function getFixHistory(limit = 5): Promise<{
  id:          number;
  errorKey:    string;
  description: string;
  status:      string;
  tsValid:     boolean | null;
  buildOk:     boolean | null;
  synced:      boolean;
  appliedAt:   Date;
}[]> {
  const { rows } = await pool.query(
    `SELECT id, error_key, description, status, ts_valid, build_ok, synced, applied_at
     FROM auto_fix_log ORDER BY applied_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(r => ({
    id:          r.id,
    errorKey:    r.error_key,
    description: r.description ?? "",
    status:      r.status,
    tsValid:     r.ts_valid,
    buildOk:     r.build_ok,
    synced:      r.synced,
    appliedAt:   r.applied_at,
  }));
}
