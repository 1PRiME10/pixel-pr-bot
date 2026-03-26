// ─── GitHub Backup System ──────────────────────────────────────────────────────
// Backs up the entire workspace (source code + dist/ + dist.backup/) to GitHub.
//
// Required secrets (set via Replit Secrets):
//   GITHUB_BACKUP_TOKEN  — GitHub Personal Access Token (repo scope)
//   GITHUB_BACKUP_REPO   — Target repo, format: "username/repo-name"
//
// Commands:
//   !backup          — push everything to GitHub
//   !backup status   — show last backup info
//   !backup help     — show setup instructions

import { exec }        from "child_process";
import { promisify }   from "util";
import { resolve }     from "path";
import { fileURLToPath } from "url";
import { dirname }     from "path";
import { existsSync }  from "fs";

const execAsync = promisify(exec);

// Paths — production (dist/index.mjs) vs development (src/lib/) safe
//
// Production:  __dir = …/artifacts/api-server/dist
//   API_DIR  = dist/..        → api-server/
//   WORKSPACE = dist/../../.. → workspace/       (git init runs here if needed)
//
// Development: __dir = …/artifacts/api-server/src/lib
//   API_DIR  = src/lib/../..         → api-server/
//   WORKSPACE = src/lib/../../../..  → workspace/  (Replit git repo is HERE)
const __dir     = dirname(fileURLToPath(import.meta.url));
const _inDist   = __dir.includes("/dist");
const API_DIR   = _inDist ? resolve(__dir, "..")       : resolve(__dir, "..", "..");
const WORKSPACE = _inDist ? resolve(__dir, "../../..") : resolve(__dir, "../../../..");

// In-memory last backup record
let lastBackup: { date: string; repo: string; sha?: string } | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function maskToken(url: string): string {
  return url.replace(/https:\/\/[^@]+@/, "https://***@");
}

async function git(cmd: string, cwd = WORKSPACE): Promise<string> {
  const { stdout, stderr } = await execAsync(`git ${cmd}`, { cwd, timeout: 60_000 });
  return (stdout + stderr).trim();
}

// ─── Main backup function ─────────────────────────────────────────────────────

export async function runBackup(
  reply: (msg: string) => Promise<any>,
  send:  (msg: string) => Promise<any>,
): Promise<void> {
  const token = process.env.GITHUB_BACKUP_TOKEN?.trim();
  const repo  = process.env.GITHUB_BACKUP_REPO?.trim();

  if (!token || !repo) {
    await reply(
      "❌ **الإعداد ناقص!**\n\n" +
      "أضف هذين الـ secrets في Replit:\n" +
      "• `GITHUB_BACKUP_TOKEN` — توكن GitHub (repo scope)\n" +
      "• `GITHUB_BACKUP_REPO` — اسم الـ repo مثل `1PRiME10/pixel-pr-backup`\n\n" +
      "اكتب `!backup help` لتعليمات التفصيلية."
    );
    return;
  }

  const remoteUrl = `https://${token}@github.com/${repo}.git`;
  const _now      = new Date();
  const _local    = new Date(_now.getTime() + 3 * 60 * 60 * 1000); // UTC+3
  const date      = _local.toISOString().slice(0, 19).replace("T", "  "); // "2026-03-25  08:22:31"
  const branch    = "main";

  await reply("📦 **بدأ الباك اب إلى GitHub...**\nقد يستغرق 30-60 ثانية.");

  try {
    // ── Step 0: Ensure we are inside a git repo (production VM may not have one) ─
    const isGitRepo = await git(`rev-parse --git-dir`, WORKSPACE)
      .then(() => true)
      .catch(() => false);
    if (!isGitRepo) {
      console.log("[Backup] No git repo found — initialising one...");
      await git(`init`, WORKSPACE);
    }

    // ── Step 1: git config ──────────────────────────────────────────────────
    await git(`config user.email "pixelpr-bot@backup.local"`, WORKSPACE);
    await git(`config user.name "PIXEL_PR Backup Bot"`, WORKSPACE);

    // ── Step 2: Force-add dist/ and dist.backup/ (normally in .gitignore) ──
    // These dirs may be empty or not present on fresh deploys — wrap in try-catch
    // so a missing/empty dir doesn't abort the entire backup.
    const distDir   = resolve(API_DIR, "dist");
    const backupDir = resolve(API_DIR, "dist.backup");

    await send("🔧 **[1/4]** جاري إضافة ملفات البناء...");

    if (existsSync(distDir)) {
      try { await git(`add -f artifacts/api-server/dist/`, WORKSPACE); }
      catch { /* dir may be empty or gitignored differently — git add . below will pick it up */ }
    }
    if (existsSync(backupDir)) {
      try { await git(`add -f artifacts/api-server/dist.backup/`, WORKSPACE); }
      catch { /* same — skip silently */ }
    }

    // ── Step 3: Stage all source files ────────────────────────────────────
    await send("📁 **[2/4]** جاري تجميع جميع الملفات...");
    await git(`add .`, WORKSPACE);

    // ── Step 4: Commit ─────────────────────────────────────────────────────
    await send("✍️ **[3/4]** جاري إنشاء commit...");
    let commitOut = "";
    try {
      commitOut = await git(
        `commit -m "backup: ${date} | PIXEL_PR full backup (source + dist)"`,
        WORKSPACE
      );
    } catch (e: any) {
      // If "nothing to commit" that's fine — still push
      if (!e.message?.includes("nothing to commit")) throw e;
      commitOut = "nothing to commit — pushing existing HEAD";
    }
    console.log(`[Backup] Commit: ${commitOut.slice(0, 120)}`);

    // ── Step 5: Set/update remote (token embedded in URL) ─────────────────
    try { await git(`remote remove _pixelbak`); } catch {}
    await git(`remote add _pixelbak ${remoteUrl}`);

    // ── Step 6: Push ───────────────────────────────────────────────────────
    await send(`🚀 **[4/4]** جاري الرفع إلى GitHub...`);
    await git(`push _pixelbak HEAD:${branch} --force`);

    // ── Step 7: Get current SHA ────────────────────────────────────────────
    let sha = "unknown";
    try { sha = (await git(`rev-parse --short HEAD`)).trim(); } catch {}

    lastBackup = { date, repo, sha };

    await send(
      `✅ **تمت النسخة الاحتياطية بنجاح!**\n\n` +
      `📎 **GitHub:** https://github.com/${repo}/tree/${branch}\n` +
      `🔑 **Commit:** \`${sha}\`\n` +
      `🕐 **التوقيت:** \`${date}\`\n\n` +
      `**ما تم رفعه:**\n` +
      `• 📜 كود المصدر الكامل (TypeScript)\n` +
      `• ⚙️ ملفات البناء (\`dist/\`)\n` +
      `• 💾 النسخة الاحتياطية للبناء (\`dist.backup/\`)\n` +
      `• 🗃️ إعدادات الـ database schema\n` +
      `• 🛡️ Watchdog + جميع الملفات الثانوية`
    );

  } catch (e: any) {
    const msg = e.message ?? String(e);
    console.error("[Backup] Error:", maskToken(msg));
    await send(
      `❌ **فشل الباك اب!**\n\`\`\`\n${maskToken(msg).slice(0, 500)}\n\`\`\``
    );
  } finally {
    // Always remove remote — don't leave token in git config
    try { await git(`remote remove _pixelbak`); } catch {}
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function getBackupStatus(): string {
  const token = process.env.GITHUB_BACKUP_TOKEN?.trim();
  const repo  = process.env.GITHUB_BACKUP_REPO?.trim();

  const configured = token && repo
    ? `✅ مُعدّ | Repo: \`${repo}\``
    : "❌ غير مُعدّ — GITHUB_BACKUP_TOKEN / GITHUB_BACKUP_REPO مفقودان";

  const last = lastBackup
    ? `✅ آخر باك اب: \`${lastBackup.date}\` | SHA: \`${lastBackup.sha ?? "?"}\``
    : "⏳ لم يتم باك اب بعد في هذه الجلسة";

  return (
    `📊 **GitHub Backup Status**\n\n` +
    `**الإعداد:** ${configured}\n` +
    `**آخر عملية:** ${last}\n\n` +
    `اكتب \`!backup\` للنسخ الاحتياطي الآن.`
  );
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export const BACKUP_HELP = `
🔧 **إعداد GitHub Backup — خطوة بخطوة**

**الخطوة 1: إنشاء Repo على GitHub**
اذهب إلى https://github.com/new
• اجعله **Private** (سري)
• لا تضيف README
• سمّه مثلاً: \`pixel-pr-backup\`

**الخطوة 2: إنشاء Personal Access Token**
اذهب إلى: https://github.com/settings/tokens/new
• **Note:** \`PIXEL_PR Backup\`
• **Expiration:** لا تاريخ انتهاء (No expiration)
• **Scopes:** ✅ \`repo\` (كل sub-checkboxes)
• اضغط Generate token ✅

**الخطوة 3: إضافة Secrets في Replit**
في Replit → Tools → Secrets:
• \`GITHUB_BACKUP_TOKEN\` = التوكن من الخطوة 2
• \`GITHUB_BACKUP_REPO\` = \`اسم_المستخدم/pixel-pr-backup\`

**الخطوة 4: تشغيل الباك اب**
\`\`\`
!backup
\`\`\`

**ملاحظات:**
• الباك اب يتضمن: source code + dist/ + dist.backup/ + DB schema
• يُوصى بالباك اب قبل أي تغييرات كبيرة
• التوكن لا يُحفظ في الـ repo (يُحذف فوراً بعد الرفع)
`.trim();
