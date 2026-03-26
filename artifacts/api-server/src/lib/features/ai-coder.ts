// ─── AI Coder Engine ──────────────────────────────────────────────────────────
// Allows the bot to build new features, improve existing code, and self-develop.
//
// Commands:
//   /build <description>        — build a new slash command from natural language
//   /improve <target> <desc>    — improve/refactor existing code
//
// Flow for /build:
//   1. User describes a new feature (Arabic or English)
//   2. Gemini generates a complete AIPlugin entry (TypeScript)
//   3. Entry is appended to ai-plugins.ts inside the array marker
//   4. TypeScript validated (--noEmit)
//   5. Dist rebuilt (node build.mjs)
//   6. Patch saved to DB for production sync
//   7. Process restarts → new command live in seconds
//
// Flow for /improve:
//   1. User names the target (file/feature) + describes the improvement
//   2. Gemini reads the target source and generates a surgical patch
//   3. Same validate → rebuild → sync pipeline

import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from "fs";
import { resolve }                                                             from "path";
import { execSync }                                                            from "child_process";
import { ai }                                                                  from "@workspace/integrations-gemini-ai";
import { pool }                                                                from "@workspace/db";
import { SlashCommandBuilder }                                                 from "discord.js";
import type { BehaviorType }                                                   from "./ai-behaviors.js";
import { hotRegisterCommands, hotRegisterGuildCommand, clearGuildPlugins }      from "../plugin-registrar.js";
import { scheduleRestart, restartCooldownSec }                                 from "./restart-manager.js";

// Path resolution that works in BOTH dev (src/lib/features/) and production (dist/)
// Dev:   import.meta.dirname = .../artifacts/api-server/src/lib/features  (5 levels up → workspace)
// Prod:  import.meta.dirname = .../artifacts/api-server/dist              (3 levels up → workspace)
const _d = import.meta.dirname;
const _inDist = _d.includes("/dist");
const WORKSPACE_ROOT  = _inDist ? resolve(_d, "../../..")  : resolve(_d, "../../../../..");
const API_SERVER_DIR  = _inDist ? resolve(_d, "..")        : resolve(_d, "../../..");
const AI_PLUGINS_PATH    = resolve(WORKSPACE_ROOT, "artifacts/api-server/src/lib/features/ai-plugins.ts");
const AI_BEHAVIORS_PATH  = resolve(WORKSPACE_ROOT, "artifacts/api-server/src/lib/features/ai-behaviors.ts");

// ─── DB init ───────────────────────────────────────────────────────────────────
export async function initAICoder(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_coder_builds (
      id           SERIAL PRIMARY KEY,
      command_name TEXT,
      description  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      ts_valid     BOOLEAN,
      build_ok     BOOLEAN,
      built_by     TEXT,
      error_msg    TEXT,
      built_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_coder_improvements (
      id           SERIAL PRIMARY KEY,
      target       TEXT NOT NULL,
      description  TEXT NOT NULL,
      patch_old    TEXT,
      patch_new    TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      ts_valid     BOOLEAN,
      build_ok     BOOLEAN,
      improved_by  TEXT,
      error_msg    TEXT,
      improved_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_coder_behaviors (
      id           SERIAL PRIMARY KEY,
      behavior_id  TEXT,
      behavior_name TEXT,
      behavior_type TEXT NOT NULL,
      description  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      built_by     TEXT,
      error_msg    TEXT,
      built_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_coder_retries (
      id           SERIAL PRIMARY KEY,
      description  TEXT NOT NULL,
      build_type   TEXT NOT NULL,
      error_msg    TEXT NOT NULL,
      requested_by TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("[AICoder] Initialized — /build and /improve ready");
}

// ─── Save a build retry token (used by /build failure "Apply Fix" button) ────
export async function saveBuildRetry(
  description: string,
  buildType:   string,
  errorMsg:    string,
  requestedBy: string,
): Promise<number | null> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO ai_coder_retries (description, build_type, error_msg, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [description.slice(0, 800), buildType, errorMsg.slice(0, 1000), requestedBy],
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    console.error("[AICoder] Failed to save retry token:", e);
    return null;
  }
}

// ─── Load a build retry token ─────────────────────────────────────────────────
export async function loadBuildRetry(
  retryId: number,
): Promise<{ description: string; buildType: string; errorMsg: string; requestedBy: string } | null> {
  try {
    const { rows } = await pool.query(
      `SELECT description, build_type, error_msg, requested_by FROM ai_coder_retries WHERE id = $1`,
      [retryId],
    );
    if (!rows[0]) return null;
    return {
      description:  rows[0].description,
      buildType:    rows[0].build_type,
      errorMsg:     rows[0].error_msg,
      requestedBy:  rows[0].requested_by,
    };
  } catch (e) {
    console.error("[AICoder] Failed to load retry token:", e);
    return null;
  }
}

// ─── Context for Gemini: what APIs are available inside a plugin handler ──────
const PLUGIN_CONTEXT = `
=== discord.js v14 API — AVAILABLE IN SCOPE (DO NOT import anything) ===
- SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, MessageFlags, PermissionFlagsBits  (discord.js)
- ChatInputCommandInteraction  (TypeScript type only)
- ai   → await ai.models.generateContent({ model:"gemini-2.5-flash", contents:[{role:"user",parts:[{text:"..."}]}] })
         result.text  ← correct way to read text; NEVER use result.response, result.candidates, etc.
- pool → const { rows } = await pool.query("SELECT $1", [value])
- fetchLatestTweets(username: string) → Promise<{ tweets: Tweet[]; source: string }>
         Fetches REAL tweets from X/Twitter via Nitter RSS — always use this for any Twitter feature.
         Tweet shape: { text: string; url: string; author: string; pubDate: string; imageUrl?: string }
- buildTweetEmbed(tweet, username) → EmbedBuilder   (polished Discord embed for one tweet)
- buildTweetButton(tweetUrl)       → ActionRowBuilder (blue "View on X" link button)

=== ⚠️ CRITICAL LIMITATIONS — READ BEFORE WRITING ANY HANDLER ===
❌ GEMINI HAS NO INTERNET ACCESS — it CANNOT find real-time data:
   ❌ Do NOT ask AI to "find tweets", "get news", "fetch prices", "search Reddit", etc.
   ❌ Do NOT use ai.models.generateContent() to retrieve live or factual internet data
   ❌ Do NOT use ai.models.generateContent() to look up anything that changes over time
   ✅ Use ai ONLY for: text generation, jokes, summaries, creative writing, analysis of provided text
   ✅ For Twitter data: ALWAYS use fetchLatestTweets(username) — it hits real Nitter RSS feeds
   ✅ For web search: explain to the user that the feature requires an external API key
❌ Do NOT call external APIs (Twitter API, OpenAI, weather, Reddit) without credentials in the description
   ✅ If an external API is needed and no key is provided, reply with an Ephemeral error explaining it

=== CORRECT ai.models USAGE ===
✅ const res = await ai.models.generateContent({ model:"gemini-2.5-flash", contents:[{role:"user",parts:[{text:"..."}]}] });
   const text = res.text ?? "";   // ← CORRECT — always use res.text
❌ res.response.candidates[0].content.parts[0].text  ← WRONG — will throw at runtime
❌ res.candidates?.[0]?.content?.parts?.[0]?.text    ← WRONG — this field does not exist

=== CORRECT PATTERNS (v14) ===
✅ interaction.reply({ content: "text", flags: MessageFlags.Ephemeral })
✅ await interaction.deferReply({ flags: MessageFlags.Ephemeral });
   await interaction.editReply({ content: "done" });
✅ interaction.options.getString("name")   // returns string | null
✅ interaction.options.getInteger("name")  // returns number | null
✅ interaction.options.getUser("name")     // returns User | null
✅ const embed = new EmbedBuilder().setTitle("...").setDescription("...").setColor(0x5865F2);
   await interaction.reply({ embeds: [embed] });

=== FORBIDDEN PATTERNS — these cause TypeScript errors ===
❌ { ephemeral: true }              → WRONG. Use { flags: MessageFlags.Ephemeral }
❌ interaction.editReply({ flags: MessageFlags.Ephemeral })  → editReply has NO flags option
❌ import { ... } from "..."        → DO NOT add any import statements
❌ interaction.reply().then()       → use await, not .then()
❌ message.reply(...)               → use interaction.reply(), not message
❌ client.on(...)                   → no client access inside handler
❌ channel.isTextBased()            → getChannel() returns a union; cast: (channel as any).isTextBased?.()
❌ channel.isVoiceBased()           → same issue; cast: (channel as any).isVoiceBased?.()
❌ channel.isThread()               → cast: (channel as any).isThread?.()
❌ channel.send(...)                → cast channel to TextChannel or use (channel as any).send(...)
`.trim();

// ─── Pre-sanitize Gemini handler code: fix known v13→v14 migration mistakes ────
// Gemini is trained on older discord.js examples and produces deprecated patterns.
// These deterministic fixes run BEFORE TypeScript validation so errors never reach tsc.
function sanitizeHandlerBody(code: string): string {
  let c = code
    // ❌ { ephemeral: true }  →  ✅ { flags: MessageFlags.Ephemeral }
    .replace(/,?\s*ephemeral\s*:\s*true/g, ", flags: MessageFlags.Ephemeral")
    // ❌ editReply({ flags:... }) — editReply has no flags option → strip it
    .replace(/(\.editReply\([^)]*),\s*flags\s*:\s*MessageFlags\.Ephemeral/g, "$1")
    // ❌ interaction.followUp({ ephemeral: true }) → flags
    .replace(/(\.followUp\([^)]*),\s*ephemeral\s*:\s*true/g, "$1, flags: MessageFlags.Ephemeral")
    // ❌ import { ... } from "..." → remove any stray imports
    .replace(/^import\s+.*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, "")
    // ❌ interaction.isCommand() — removed in v14
    .replace(/interaction\.isCommand\(\)/g, "interaction.isChatInputCommand()")
    // ❌ channel.isTextBased() — getChannel() returns a union type without this method
    //    Cast to (channel as any) to satisfy TypeScript while keeping runtime behavior
    .replace(/\b(\w+)\.isTextBased\(\)/g, "($1 as any).isTextBased?.()")
    .replace(/\b(\w+)\.isVoiceBased\(\)/g, "($1 as any).isVoiceBased?.()")
    .replace(/\b(\w+)\.isThread\(\)/g,     "($1 as any).isThread?.()")
    // ❌ channel.send(...) on unknown channel type — cast to any
    .replace(/\b(const\s+\w+\s*=\s*interaction\.options\.getChannel\([^)]+\))\s*;/g, "$1 as any;")
    .trim();

  // ❌ Gemini sometimes wraps handlerBody in the full async function signature — unwrap it.
  // Pattern: "async (interaction...) => {\n  body\n}" or "async (interaction...) => body"
  const arrowMatch = c.match(/^async\s*\(interaction[^)]*\)\s*(?::\s*Promise<void>)?\s*=>\s*\{([\s\S]*)\}$/);
  if (arrowMatch) { c = arrowMatch[1].trim(); }

  // ❌ Gemini sometimes wraps handlerBody in a plain { body } block — unwrap outer braces.
  // Only unwrap if the outer braces are balanced and the content is valid TS body.
  if (c.startsWith("{") && c.endsWith("}")) {
    const inner = c.slice(1, -1).trim();
    let depth = 0;
    let safe = true;
    for (const ch of inner) {
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth < 0) { safe = false; break; } }
    }
    if (safe && depth === 0) c = inner;
  }

  return c.trim();
}

// ─── Build a new feature from natural language description ─────────────────────
export interface BuildResult {
  success:     boolean;
  commandName: string;
  description: string;
  error?:      string;
  status:      "built" | "ts_fail" | "build_fail" | "gemini_fail" | "duplicate";
}

export async function buildFeature(description: string, requestedBy: string, previousError?: string, guildId?: string | null): Promise<BuildResult> {
  console.log(`[AICoder] Building feature: "${description.slice(0, 80)}..."`);

  // 1. Generate plugin code with Gemini
  const previousErrorSection = previousError
    ? `\n\n⚠️ PREVIOUS ATTEMPT FAILED — Learn from this error and fix it:\n\`\`\`\n${previousError.slice(0, 600)}\n\`\`\`\nDo NOT repeat the same mistake. Adjust your approach accordingly.\n`
    : "";

  const prompt = `You are an expert TypeScript Discord bot developer.

Build a new Discord slash command plugin based on this description:
"${description}"${previousErrorSection}

${PLUGIN_CONTEXT}

Output ONLY a raw JSON object (no markdown, no code block wrapper):
{
  "commandName": "lowercase-name-max-32-chars",
  "commandDescription": "Max 100 chars description shown in Discord",
  "options": [
    { "type": "string|integer|boolean|user|channel", "name": "optionname", "description": "...", "required": true }
  ],
  "handlerBody": "...TypeScript lines that go INSIDE the handler body — see rules below..."
}

CRITICAL RULES FOR handlerBody:
1. handlerBody contains ONLY the statements inside the function body — NO function signature, NO wrapping braces {}
2. ✅ CORRECT: "await interaction.deferReply({ flags: MessageFlags.Ephemeral });\nconst x = 1;\nawait interaction.editReply({ content: String(x) });"
3. ❌ WRONG: "async (interaction) => { ... }"   ← do NOT include function wrapper
4. ❌ WRONG: "{ await interaction.reply(...); }" ← do NOT wrap body in braces
5. commandName: lowercase, hyphens only, no spaces, max 32 chars
6. commandDescription: max 100 chars
7. Always wrap logic in try/catch and handle errors gracefully
8. For AI-powered features, use the ai client shown above
9. For data storage, use pool.query with parameterized queries ($1, $2, ...)
10. Always deferReply if the response might take >2 seconds
11. Make the feature useful and polished

ABSOLUTE SAFETY RULES (NEVER violate — core protection):
❌ NEVER call process.exit(), process.kill(), or anything that stops the process
❌ NEVER import or require any module (all dependencies are pre-injected in scope)
❌ NEVER read or write any file (no fs, no readFileSync, no writeFileSync)
❌ NEVER access core bot files (slash-commands, tweet-monitor, self-heal, ai-coder, etc.)
❌ NEVER use eval(), new Function(), or dynamic code execution
❌ NEVER start infinite loops or recursive calls without a clear exit condition
❌ NEVER delete or DROP any database table (only INSERT/SELECT/UPDATE your own rows)
✅ ALWAYS use try/catch so errors stay inside this plugin and never reach core features
✅ ALWAYS use parameterized SQL ($1, $2, ...) to prevent injection`;

  let geminiOutput: { commandName: string; commandDescription: string; options: any[]; handlerBody: string } | null = null;

  let buildLastError = "";
  for (const [attempt, temp] of [[1, 0.1], [2, 0.2]] as [number, number][]) {
    try {
      const res = await ai.models.generateContent({
        model:    "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config:   { maxOutputTokens: 8192, temperature: temp },
      });
      const rawText = res.text ?? "";
      if (!rawText.trim()) { buildLastError = "Empty response"; continue; }
      geminiOutput = JSON.parse(extractJSON(rawText));
      if (geminiOutput?.commandName && geminiOutput?.handlerBody) break;
      buildLastError = "Incomplete output (missing commandName or handlerBody)";
    } catch (e) {
      buildLastError = String(e).slice(0, 200);
      console.warn(`[AICoder] /build attempt ${attempt} failed: ${buildLastError}`);
    }
  }
  if (!geminiOutput?.commandName || !geminiOutput?.handlerBody) {
    await saveBuild(null, description, "gemini_fail", false, false, requestedBy, buildLastError);
    return { success: false, commandName: "", description, error: `AI generation failed: ${buildLastError.slice(0, 120)}`, status: "gemini_fail" };
  }

  const { commandName, commandDescription, options } = geminiOutput;
  // Pre-sanitize handlerBody: fix common v13→v14 migration mistakes Gemini makes
  const handlerBody = sanitizeHandlerBody(geminiOutput.handlerBody);

  // 2. Check for duplicate command name
  const existingPlugins = readFileSync(AI_PLUGINS_PATH, "utf-8");
  if (existingPlugins.includes(`name: "${commandName}"`)) {
    await saveBuild(commandName, description, "duplicate", null, null, requestedBy, `Command /${commandName} already exists`);
    return { success: false, commandName, description, error: `Command /${commandName} already exists`, status: "duplicate" };
  }

  // 3. Build the TypeScript plugin entry
  const optionsCode = (options ?? []).map((o: any) => {
    const typeMethod =
      o.type === "integer" ? "addIntegerOption" :
      o.type === "boolean" ? "addBooleanOption" :
      o.type === "user"    ? "addUserOption" :
      o.type === "channel" ? "addChannelOption" :
                             "addStringOption";
    return `.${typeMethod}(o => o.setName("${o.name}").setDescription("${o.description.slice(0, 100)}").setRequired(${!!o.required}))`;
  }).join("\n      ");

  const guildIdEntry = guildId ? `"${guildId}"` : "null";
  const pluginEntry = `
  {
    name: "${commandName}",
    guildId: ${guildIdEntry},
    definition: new SlashCommandBuilder()
      .setName("${commandName}")
      .setDescription("${commandDescription.slice(0, 100).replace(/"/g, '\\"')}")${optionsCode ? "\n      " + optionsCode : ""}
      .toJSON(),
    handler: async (interaction: ChatInputCommandInteraction): Promise<void> => {
      ${handlerBody.split("\n").join("\n      ")}
    },
  },`;

  // 3b. Runtime safety scan — reject code with dangerous patterns
  //     Protects core features from being affected by any AI-generated plugin.
  const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /process\.(exit|kill|abort)\s*\(/,         reason: "process termination call" },
    { pattern: /\brequire\s*\(/,                          reason: "dynamic require()" },
    { pattern: /\beval\s*\(/,                             reason: "eval()" },
    { pattern: /new\s+Function\s*\(/,                     reason: "new Function()" },
    { pattern: /\bfs\b.*\.(write|read|unlink|rm)\s*\(/,  reason: "file system write/read" },
    { pattern: /DROP\s+TABLE/i,                           reason: "DROP TABLE" },
    { pattern: /TRUNCATE\s+TABLE/i,                       reason: "TRUNCATE TABLE" },
  ];
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(handlerBody)) {
      const errMsg = `Safety check failed: plugin contains forbidden pattern (${reason}). Rejected to protect core features.`;
      console.error(`[AICoder] ⛔ ${errMsg}`);
      return { success: false, commandName, description, error: errMsg, status: "build_fail" };
    }
  }

  // 4. Insert into ai-plugins.ts before the array end marker
  const ARRAY_END_MARKER = "  // ── AI PLUGINS ARRAY END ─────────────────────────────────────────────────";
  if (!existingPlugins.includes(ARRAY_END_MARKER)) {
    return { success: false, commandName, description, error: "ai-plugins.ts marker not found", status: "build_fail" };
  }

  // 4a. Deduplicate — remove any existing plugin with the same name before inserting
  const PLUGIN_START_RE = new RegExp(
    `\\s*\\{\\s*\\n\\s*name:\\s*"${commandName}",[\\s\\S]*?\\},\\s*(?=\\n\\s*(?:\\{|// ── AI PLUGINS ARRAY END))`,
    "g"
  );
  const deduped = existingPlugins.replace(PLUGIN_START_RE, "");
  if (deduped !== existingPlugins) {
    console.warn(`[AICoder] Removed duplicate plugin definition for /${commandName} before inserting updated version.`);
  }
  const existingPluginsClean = deduped;

  const updatedPlugins = existingPluginsClean.replace(ARRAY_END_MARKER, `${pluginEntry}\n${ARRAY_END_MARKER}`);

  // Backup + write
  const backupPath = `${AI_PLUGINS_PATH}.backup`;
  copyFileSync(AI_PLUGINS_PATH, backupPath);
  writeFileSync(AI_PLUGINS_PATH, updatedPlugins, "utf-8");

  // 5. TypeScript validation — with AI self-healing retry
  let tsValid    = false;
  let finalBody  = handlerBody;
  let finalEntry = pluginEntry;

  for (let tsAttempt = 1; tsAttempt <= 3; tsAttempt++) {
    try {
      execSync("pnpm tsc --noEmit", { cwd: API_SERVER_DIR, stdio: "pipe" });
      tsValid = true;
      break; // TS passed ✅
    } catch (e: any) {
      const tsStderr = (e?.stdout?.toString() ?? "") + (e?.stderr?.toString() ?? "");
      // Filter to errors in ai-plugins.ts only
      const relevantErrors = tsStderr
        .split("\n")
        .filter((l: string) => l.includes("ai-plugins") || l.includes("error TS"))
        .slice(0, 20)
        .join("\n")
        .slice(0, 1200);

      console.warn(`[AICoder] TS attempt ${tsAttempt} failed:\n${relevantErrors}`);

      if (tsAttempt === 3) {
        // All attempts exhausted — rollback
        copyFileSync(backupPath, AI_PLUGINS_PATH);
        unlinkSync(backupPath);
        await saveBuild(commandName, description, "ts_fail", false, null, requestedBy, relevantErrors);
        const shortErr = relevantErrors.slice(0, 400) || "Unknown TypeScript error";
        return {
          success: false, commandName, description, status: "ts_fail",
          error: `TypeScript error (auto-fix failed after 3 attempts):\n\`\`\`\n${shortErr}\n\`\`\``,
        };
      }

      // Ask Gemini to fix the TS errors
      console.log(`[AICoder] Asking Gemini to fix TS errors (attempt ${tsAttempt})...`);
      try {
        const fixRes = await ai.models.generateContent({
          model: "gemini-2.5-pro",
          contents: [{
            role: "user",
            parts: [{
              text: `Fix this TypeScript error in a Discord bot plugin handler body.

CURRENT handlerBody (statements only — NO function wrapper, NO outer braces):
\`\`\`typescript
${finalBody}
\`\`\`

TYPESCRIPT ERRORS:
\`\`\`
${relevantErrors}
\`\`\`

${PLUGIN_CONTEXT}

IMPORTANT:
- The handler function signature is already provided: async (interaction: ChatInputCommandInteraction): Promise<void> => { YOUR_CODE_HERE }
- Output ONLY the statements that go INSIDE the function — do NOT add function signature, do NOT wrap in braces {}
- Do NOT use any imports — they are already available globally.
- Output only plain TypeScript, no JSON, no markdown fences.`,
            }],
          }],
          config: { maxOutputTokens: 4096, temperature: 0.05 },
        });

        let fixed = (fixRes.text ?? "").trim();
        // Strip markdown fences if Gemini added them
        fixed = fixed.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "").trim();
        if (!fixed) throw new Error("Empty fix response");

        // Apply same v13→v14 sanitization to the fixed code too
        finalBody  = sanitizeHandlerBody(fixed);
        finalEntry = `
  {
    name: "${commandName}",
    definition: new SlashCommandBuilder()
      .setName("${commandName}")
      .setDescription("${commandDescription.slice(0, 100).replace(/"/g, '\\"')}")${optionsCode ? "\n      " + optionsCode : ""}
      .toJSON(),
    handler: async (interaction: ChatInputCommandInteraction): Promise<void> => {
      ${finalBody.split("\n").join("\n      ")}
    },
  },`;

        // Rewrite the file with fixed code (start from original to avoid stacking bad versions)
        const rewritten = existingPlugins.replace(ARRAY_END_MARKER, `${finalEntry}\n${ARRAY_END_MARKER}`);
        writeFileSync(AI_PLUGINS_PATH, rewritten, "utf-8");
      } catch (fixErr) {
        console.warn(`[AICoder] Gemini fix attempt ${tsAttempt} failed: ${fixErr}`);
        // Restore previous version and try original again next iteration
        writeFileSync(AI_PLUGINS_PATH, updatedPlugins, "utf-8");
      }
    }
  }

  // 6. Rebuild dist
  let buildOk = false;
  try {
    execSync("node ./build.mjs", { cwd: API_SERVER_DIR, stdio: "pipe", timeout: 120_000 });
    buildOk = true;
  } catch (e: any) {
    const buildErr = (e?.stdout?.toString() ?? "").slice(0, 300);
    copyFileSync(backupPath, AI_PLUGINS_PATH);
    unlinkSync(backupPath);
    await saveBuild(commandName, description, "build_fail", true, false, requestedBy, buildErr);
    return { success: false, commandName, description, error: "Build failed — rolled back", status: "build_fail" };
  }

  unlinkSync(backupPath);

  // 7. Save to DB + save patch for production sync
  await saveBuild(commandName, description, "built", tsValid, buildOk, requestedBy, null);
  await savePluginPatchToAutoFix(commandName, existingPlugins, updatedPlugins);

  // 8. Hot-register the new command via REST immediately — no restart required.
  //    This ensures the command appears in Discord even if this instance is
  //    in standby mode (production bot holds leadership) after the build.
  try {
    let builder = new SlashCommandBuilder()
      .setName(commandName)
      .setDescription(commandDescription.slice(0, 100));
    if (optionsCode) {
      try {
        const applyOpts = new Function("builder", `return builder${optionsCode};`) as
          (b: SlashCommandBuilder) => SlashCommandBuilder;
        builder = applyOpts(builder);
      } catch { /* opts eval failed — register without options, restart will fix */ }
    }
    const def = builder.toJSON() as unknown as Record<string, unknown>;
    let registered: boolean;
    if (guildId) {
      // Guild-specific command — instant, visible only in that server
      registered = await hotRegisterGuildCommand(guildId, def);
    } else {
      // Global command — propagates to all servers
      registered = await hotRegisterCommands(def);
    }
    if (registered) {
      const scope = guildId ? `guild ${guildId}` : "all servers (global)";
      console.log(`[AICoder] ✅ /${commandName} hot-registered in Discord for ${scope}`);
    }
  } catch (regErr) {
    console.warn(`[AICoder] Hot-registration skipped (registrar not init):`, regErr);
  }

  const restarting = scheduleRestart(`/build:${commandName}`);
  if (!restarting) {
    const wait = restartCooldownSec();
    console.log(`[AICoder] ✅ Built /${commandName} — restart cooldown active (${wait}s). Changes staged.`);
  } else {
    console.log(`[AICoder] ✅ Built /${commandName} — restarting in 4s`);
  }

  return { success: true, commandName, description, status: "built" };
}

// ─── Behavior Context (for /build → behavior) ──────────────────────────────────
const BEHAVIOR_CONTEXT = `
=== discord.js v14 + TypeScript — AVAILABLE IN SCOPE (DO NOT import anything) ===
- client: Client                     → Discord.js Client instance (use to access guilds, channels, etc.)
- EmbedBuilder, MessageFlags, PermissionFlagsBits  (discord.js)
- ai   → await ai.models.generateContent({ model:"gemini-2.5-flash", contents:[{role:"user",parts:[{text:"..."}]}] })
- pool → const { rows } = await pool.query("SELECT $1", [value])

=== HANDLER SIGNATURES — use EXACTLY one of these (do NOT import types) ===

For type="event", event="guildMemberAdd":
  async (client, member) => { /* member.user.username, member.guild, etc. */ }

For type="event", event="messageDelete":
  async (client, message) => { /* message.content may be null for uncached */ }

For type="event", event="guildMemberRemove":
  async (client, member) => { /* member left the server */ }

For type="schedule":
  async (client) => {
    // Use client.guilds.cache to access guilds and channels
    // e.g.: const guild = client.guilds.cache.get("GUILD_ID");
  }

For type="autoresponder":
  async (client, message) => {
    // message.content, message.author, message.channel, message.guild available
    await message.reply("response");
  }

=== CORRECT v14 PATTERNS ===
✅ await message.reply({ content: "text" });
✅ await message.channel.send({ embeds: [embed] });
✅ const embed = new EmbedBuilder().setTitle("...").setDescription("...").setColor(0x5865F2);
✅ member.guild.name, member.user.username, member.user.id
✅ const channel = client.channels.cache.get("ID") as TextChannel;

=== FORBIDDEN ===
❌ import { ... } from "..."    → DO NOT add any import statements
❌ { ephemeral: true }          → use { flags: MessageFlags.Ephemeral }
❌ interaction.reply(...)       → no interaction object in behaviors; use message or member
`.trim();

// ─── Classify request: command vs behavior ─────────────────────────────────────
// Fast keyword-based classification; falls back to Gemini for ambiguous cases.
export async function classifyRequest(description: string): Promise<"command" | BehaviorType> {
  const lower = description.toLowerCase();

  // ── Schedule signals ──────────────────────────────────────────────────────
  const scheduleKw = [
    "كل يوم", "كل ساعة", "كل دقيقة", "كل أسبوع", "يومياً", "أسبوعياً",
    "every day", "every hour", "every minute", "every week", "daily", "hourly",
    "weekly", "at ", "الساعة", "مجدول", "منتظم", "schedule", "cron",
    "صباح كل", "مساء كل", "في تمام",
  ];
  if (scheduleKw.some(k => lower.includes(k))) return "schedule";

  // ── Event signals ─────────────────────────────────────────────────────────
  const eventKw = [
    "لما ينضم", "لما حدا ينضم", "عند انضمام", "لما عضو ينضم",
    "لما حدا يغادر", "لما عضو يغادر", "عند مغادرة",
    "لما حدا يتحذف", "لما رسالة تحذف", "لما رسالة تتعدل",
    "when.*join", "when.*leave", "when.*member", "when.*ban", "when.*kick",
    "when.*delete", "when.*edit", "on guild", "guildmember", "messagedelete",
    "عند حذف", "عند تعديل", "عند الحظر", "عند الطرد",
  ];
  if (eventKw.some(k => lower.match(new RegExp(k)))) return "event";

  // ── Autoresponder signals ──────────────────────────────────────────────────
  const autoKw = [
    "لما حدا يقول", "لما يقولون", "إذا حدا كتب", "لو حدا كتب",
    "when someone says", "when.*types", "when.*writes", "if message contains",
    "auto.*reply", "auto.*respond", "respond to", "reply.*when",
    "ترد على", "رد تلقائي", "عند الكتابة", "لما يكتب أحد",
    "إذا كتب", "لو كتب",
  ];
  if (autoKw.some(k => lower.match(new RegExp(k)))) return "autoresponder";

  // ── Explicit command signals ────────────────────────────────────────────────
  const cmdKw = [
    "أمر", "كوماند", "command", "slash", "/", "يأمر", "الأمر", "أمر يعمل",
    "بني أمر", "اصنع أمر", "create command", "build command", "new command",
  ];
  if (cmdKw.some(k => lower.includes(k))) return "command";

  // ── Gemini fallback for ambiguous descriptions ─────────────────────────────
  try {
    const res = await ai.models.generateContent({
      model:    "gemini-2.5-flash",
      contents: [{
        role: "user", parts: [{
          text: `Classify this Discord bot feature request into one of: command, event, schedule, autoresponder.

command       = a /slash command users invoke manually
event         = fires on a Discord.js event (join, leave, message delete, etc.)
schedule      = fires on a recurring time schedule (daily, hourly, every X minutes)
autoresponder = automatically replies when a message matches a pattern/keyword

Request: "${description}"

Reply with ONLY one word: command, event, schedule, or autoresponder`,
        }],
      }],
      config: { maxOutputTokens: 10, temperature: 0 },
    });
    const label = (res.text ?? "").trim().toLowerCase().split(/\s+/)[0];
    if (["command", "event", "schedule", "autoresponder"].includes(label)) {
      return label as "command" | BehaviorType;
    }
  } catch { /* ignore, default to command */ }

  return "command"; // safe default
}

// ─── Build a new behavior (event / schedule / autoresponder) ──────────────────
export interface BehaviorResult {
  success:     boolean;
  behaviorId:  string;
  name:        string;
  type:        BehaviorType;
  description: string;
  error?:      string;
  status:      "built" | "ts_fail" | "build_fail" | "gemini_fail" | "duplicate";
}

export async function buildBehavior(
  description: string,
  type: BehaviorType,
  requestedBy: string,
  previousError?: string,
): Promise<BehaviorResult> {
  console.log(`[AICoder] Building ${type} behavior: "${description.slice(0, 80)}..."`);

  // ── Behavior-type-specific guidance for Gemini ────────────────────────────
  const typeGuide: Record<BehaviorType, string> = {
    event: `You are building an EVENT BEHAVIOR.
Pick the best Discord.js event for this request. Common events:
- "guildMemberAdd"    → member joins
- "guildMemberRemove" → member leaves
- "messageDelete"     → message deleted
- "messageUpdate"     → message edited
- "guildBanAdd"       → member banned
- "guildBanRemove"    → member unbanned
- "voiceStateUpdate"  → voice channel changes
- "messageReactionAdd"→ reaction added

The handler receives (client, ...eventArgs) — see BEHAVIOR_CONTEXT for argument types per event.`,

    schedule: `You are building a SCHEDULE BEHAVIOR.
Choose an appropriate cron expression:
- "0 9 * * *"   → every day at 9am
- "0 * * * *"   → every hour
- "*/30 * * * *"→ every 30 minutes
- "0 9 * * 1"   → every Monday at 9am
- "0 9,21 * * *"→ twice a day (9am + 9pm)

The handler receives only (client). Use client.guilds.cache to access guilds/channels.`,

    autoresponder: `You are building an AUTORESPONDER BEHAVIOR.
Choose a useful regex pattern (as a string, will be compiled with new RegExp(pattern, flags)).
The handler receives (client, message). Use message.reply() to respond.
Keep responses relevant and not spammy — check message.author.bot to skip bots.`,
  };

  const previousErrorSection = previousError
    ? `\n\n⚠️ PREVIOUS ATTEMPT FAILED — Learn from this error and fix it:\n\`\`\`\n${previousError.slice(0, 600)}\n\`\`\`\nDo NOT repeat the same mistake. Adjust your approach accordingly.\n`
    : "";

  const prompt = `You are an expert TypeScript Discord bot developer.

Build a new Discord bot BEHAVIOR (not a slash command) based on this description:
"${description}"${previousErrorSection}

${typeGuide[type]}

${BEHAVIOR_CONTEXT}

Output ONLY a raw JSON object (no markdown, no code block wrapper):
{
  "id":          "lowercase-slug-max-32-chars",
  "name":        "Human Readable Name",
  "event":       "guildMemberAdd",     // ONLY for type="event" — use the exact discord.js event name
  "schedule":    "0 9 * * *",          // ONLY for type="schedule" — cron expression
  "pattern":     "صباح|good morning",  // ONLY for type="autoresponder" — regex string
  "flags":       "i",                  // ONLY for type="autoresponder" — regex flags (usually "i")
  "handlerBody": "...TypeScript lines inside the handler body (NO function wrapper, NO outer braces)..."
}

CRITICAL RULES:
1. handlerBody: ONLY the statements inside the function — no signature, no wrapping braces {}
2. The first parameter is always "client" — the Discord.js Client
3. Second parameter varies by type (member for guildMemberAdd, message for autoresponder/messageCreate, etc.)
4. id: lowercase, hyphens only, no spaces, max 32 chars
5. Always wrap logic in try/catch
6. Skip bot messages in autoresponders: if (message.author.bot) return;
7. Do NOT add imports — all dependencies are already in scope`;

  let geminiOut: {
    id: string; name: string;
    event?: string; schedule?: string; pattern?: string; flags?: string;
    handlerBody: string;
  } | null = null;

  let lastErr = "";
  for (const [attempt, temp] of [[1, 0.1], [2, 0.2]] as [number, number][]) {
    try {
      const res = await ai.models.generateContent({
        model:    "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config:   { maxOutputTokens: 8192, temperature: temp },
      });
      const rawText = res.text ?? "";
      if (!rawText.trim()) { lastErr = "Empty response"; continue; }
      geminiOut = JSON.parse(extractJSON(rawText));
      if (geminiOut?.id && geminiOut?.handlerBody) break;
      lastErr = "Incomplete output (missing id or handlerBody)";
    } catch (e) {
      lastErr = String(e).slice(0, 200);
      console.warn(`[AICoder] /build behavior attempt ${attempt} failed: ${lastErr}`);
    }
  }

  if (!geminiOut?.id || !geminiOut?.handlerBody) {
    await saveBehaviorBuild(null, description, type, "gemini_fail", requestedBy, lastErr);
    return { success: false, behaviorId: "", name: "", type, description, error: `AI generation failed: ${lastErr.slice(0, 120)}`, status: "gemini_fail" };
  }

  const { id, name, event: evName, schedule, pattern, flags } = geminiOut;
  const handlerBody = sanitizeHandlerBody(geminiOut.handlerBody);

  // Check for duplicate
  const existingBehaviors = readFileSync(AI_BEHAVIORS_PATH, "utf-8");
  if (existingBehaviors.includes(`id: "${id}"`)) {
    await saveBehaviorBuild(id, description, type, "duplicate", requestedBy, `Behavior "${id}" already exists`);
    return { success: false, behaviorId: id, name: name ?? id, type, description, error: `Behavior "${id}" already exists`, status: "duplicate" };
  }

  // ── Build the handler parameter list based on type ─────────────────────────
  const paramMap: Record<BehaviorType, string> = {
    event:         `client: import("discord.js").Client, ...args: any[]`,
    schedule:      `client: import("discord.js").Client`,
    autoresponder: `client: import("discord.js").Client, message: import("discord.js").Message`,
  };
  const handlerSig = paramMap[type];

  // ── Build optional fields ──────────────────────────────────────────────────
  const eventField    = type === "event"         ? `\n    event:    "${evName ?? "messageCreate"}",` : "";
  const scheduleField = type === "schedule"      ? `\n    schedule: "${schedule ?? "0 9 * * *"}",` : "";
  const patternField  = type === "autoresponder" ? `\n    pattern:  ${JSON.stringify(pattern ?? "")},` : "";
  const flagsField    = type === "autoresponder" && flags ? `\n    flags:    "${flags}",` : "";

  const behaviorEntry = `
  {
    id:          "${id}",
    name:        "${(name ?? id).replace(/"/g, '\\"')}",
    description: ${JSON.stringify(description)},
    type:        "${type}",${eventField}${scheduleField}${patternField}${flagsField}
    handler: async (${handlerSig}): Promise<void> => {
      ${handlerBody.split("\n").join("\n      ")}
    },
  },`;

  const ARRAY_END_MARKER = "  // ── AI BEHAVIORS ARRAY END ───────────────────────────────────────────────";
  if (!existingBehaviors.includes(ARRAY_END_MARKER)) {
    return { success: false, behaviorId: id, name: name ?? id, type, description, error: "ai-behaviors.ts marker not found", status: "build_fail" };
  }

  const updatedBehaviors = existingBehaviors.replace(ARRAY_END_MARKER, `${behaviorEntry}\n${ARRAY_END_MARKER}`);

  const backupPath = `${AI_BEHAVIORS_PATH}.backup`;
  copyFileSync(AI_BEHAVIORS_PATH, backupPath);
  writeFileSync(AI_BEHAVIORS_PATH, updatedBehaviors, "utf-8");

  // ── TypeScript validation with self-healing retry ──────────────────────────
  let tsValid   = false;
  let finalBody = handlerBody;
  let finalEntry = behaviorEntry;

  for (let tsAttempt = 1; tsAttempt <= 3; tsAttempt++) {
    try {
      execSync("pnpm tsc --noEmit", { cwd: API_SERVER_DIR, stdio: "pipe" });
      tsValid = true;
      break;
    } catch (e: any) {
      const tsStderr = (e?.stdout?.toString() ?? "") + (e?.stderr?.toString() ?? "");
      const relevantErrors = tsStderr
        .split("\n")
        .filter((l: string) => l.includes("ai-behaviors") || l.includes("error TS"))
        .slice(0, 20).join("\n").slice(0, 1200);

      console.warn(`[AICoder] Behavior TS attempt ${tsAttempt} failed:\n${relevantErrors}`);

      if (tsAttempt === 3) {
        copyFileSync(backupPath, AI_BEHAVIORS_PATH);
        unlinkSync(backupPath);
        await saveBehaviorBuild(id, description, type, "ts_fail", requestedBy, relevantErrors);
        return {
          success: false, behaviorId: id, name: name ?? id, type, description,
          status: "ts_fail", error: `TypeScript error (auto-fix failed after 3 attempts):\n\`\`\`\n${relevantErrors.slice(0, 400)}\n\`\`\``,
        };
      }

      // Ask Gemini to fix
      try {
        const fixRes = await ai.models.generateContent({
          model: "gemini-2.5-pro",
          contents: [{ role: "user", parts: [{ text: `Fix this TypeScript error in a Discord bot behavior handler body.

CURRENT handlerBody (statements only — NO function wrapper, NO outer braces):
\`\`\`typescript
${finalBody}
\`\`\`

TYPESCRIPT ERRORS:
\`\`\`
${relevantErrors}
\`\`\`

${BEHAVIOR_CONTEXT}

IMPORTANT:
- The handler signature is already provided — output ONLY the statements inside
- Do NOT add function signature, do NOT wrap in braces {}
- Do NOT use imports — output plain TypeScript only, no markdown fences.` }] }],
          config: { maxOutputTokens: 4096, temperature: 0.05 },
        });
        let fixed = (fixRes.text ?? "").trim().replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "").trim();
        if (!fixed) throw new Error("Empty fix");
        finalBody = sanitizeHandlerBody(fixed);
        finalEntry = `
  {
    id:          "${id}",
    name:        "${(name ?? id).replace(/"/g, '\\"')}",
    description: ${JSON.stringify(description)},
    type:        "${type}",${eventField}${scheduleField}${patternField}${flagsField}
    handler: async (${handlerSig}): Promise<void> => {
      ${finalBody.split("\n").join("\n      ")}
    },
  },`;
        const rewritten = existingBehaviors.replace(ARRAY_END_MARKER, `${finalEntry}\n${ARRAY_END_MARKER}`);
        writeFileSync(AI_BEHAVIORS_PATH, rewritten, "utf-8");
      } catch (fixErr) {
        console.warn(`[AICoder] Behavior fix attempt ${tsAttempt} failed: ${fixErr}`);
        writeFileSync(AI_BEHAVIORS_PATH, updatedBehaviors, "utf-8");
      }
    }
  }

  // ── Rebuild dist ──────────────────────────────────────────────────────────
  let buildOk = false;
  try {
    execSync("node ./build.mjs", { cwd: API_SERVER_DIR, stdio: "pipe", timeout: 120_000 });
    buildOk = true;
  } catch (e: any) {
    const buildErr = (e?.stdout?.toString() ?? "").slice(0, 300);
    copyFileSync(backupPath, AI_BEHAVIORS_PATH);
    unlinkSync(backupPath);
    await saveBehaviorBuild(id, description, type, "build_fail", requestedBy, buildErr);
    return { success: false, behaviorId: id, name: name ?? id, type, description, error: "Build failed — rolled back", status: "build_fail" };
  }

  unlinkSync(backupPath);
  await saveBehaviorBuild(id, description, type, "built", requestedBy, null);

  // Save patch for production sync
  await saveBehaviorPatchToAutoFix(id, existingBehaviors, updatedBehaviors);

  const restartingBeh = scheduleRestart(`/build-behavior:${id}`);
  if (!restartingBeh) {
    console.log(`[AICoder] ✅ Built behavior "${id}" — restart cooldown active. Changes staged.`);
  } else {
    console.log(`[AICoder] ✅ Built behavior "${id}" (${type}) — restarting in 4s`);
  }

  return { success: true, behaviorId: id, name: name ?? id, type, description, status: "built" };
}

// ─── Robust JSON extraction from Gemini response ──────────────────────────────
// Gemini sometimes wraps JSON in ```json, ```typescript, ```ts, or other blocks.
// This function strips all that and extracts the raw JSON object.
function extractJSON(raw: string): string {
  // Remove ALL markdown code fences regardless of language tag
  let cleaned = raw
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/\n?```$/gm, "")
    .trim();

  // Find the outermost { ... } to handle extra commentary before/after
  const first = cleaned.indexOf("{");
  const last  = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return cleaned.slice(first, last + 1);
  }
  return cleaned;
}

// ─── Smart source extraction ──────────────────────────────────────────────────
// For files ≤ 30,000 chars → send the whole file.
// For larger files (e.g. slash-commands.ts at 150k chars):
//   1. Try to extract the EXACT function/case block that matches keywords
//      using brace-counting (gives Gemini the precise code, not a random window)
//   2. Fallback: keyword-scored cluster window (dense keyword region + context)

function extractRelevantSource(source: string, description: string, maxChars = 30_000): string {
  const lines = source.split("\n");
  const total = lines.length;

  if (source.length <= maxChars) return source;

  const keywords = description
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s_-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3);

  if (keywords.length === 0) return source.slice(0, maxChars);

  // ── Strategy 1: Extract complete function/case block ────────────────────────
  const fnExtract = extractFunctionSection(lines, keywords, maxChars);
  if (fnExtract) return fnExtract;

  // ── Strategy 2: Keyword-density cluster window ──────────────────────────────
  // Find the 30-line cluster with the most keyword hits, then expand around it
  const CLUSTER_WIN = 30;
  const lineScores  = lines.map(l => {
    const lower = l.toLowerCase();
    return keywords.filter(k => lower.includes(k)).length;
  });

  let bestClusterStart = 0;
  let bestClusterScore = 0;
  for (let i = 0; i <= total - CLUSTER_WIN; i++) {
    const score = lineScores.slice(i, i + CLUSTER_WIN).reduce((a, b) => a + b, 0);
    if (score > bestClusterScore) { bestClusterScore = score; bestClusterStart = i; }
  }

  const avgCharsPerLine = Math.ceil(source.length / total);
  const windowLines     = Math.floor(maxChars / avgCharsPerLine);
  const start           = Math.max(0, bestClusterStart - 10);
  const end             = Math.min(total, start + windowLines);

  return [
    `// ⚡ Window: lines ${start + 1}–${end} of ${total} (best keyword cluster)`,
    `// Keywords searched: ${keywords.slice(0, 6).join(", ")}`,
    "",
    lines.slice(start, end).join("\n"),
  ].join("\n");
}

// ── Extracts a complete function/case/handler block matching keywords ──────────
// Uses brace-counting to capture the ENTIRE block (not just a fixed char window)
function extractFunctionSection(lines: string[], keywords: string[], maxChars: number): string | null {
  const FUNC_RE = /(?:(?:export\s+)?(?:async\s+)?function\s+\w+)|(?:(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\()|(?:case\s+['"`](\w+)['"`]\s*:)/;
  const lowerLines = lines.map(l => l.toLowerCase());

  let bestLine  = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!FUNC_RE.test(lines[i]!)) continue;
    // Score = keywords matched in this line + next 5 lines
    const ctx   = lowerLines.slice(i, Math.min(lines.length, i + 6)).join(" ");
    const score = keywords.filter(k => ctx.includes(k)).length;
    if (score > bestScore) { bestScore = score; bestLine = i; }
  }

  if (bestLine < 0 || bestScore === 0) return null;

  // Walk forward from bestLine, counting braces to find the end of the block
  let depth    = 0;
  let started  = false;
  let endLine  = bestLine;

  for (let i = bestLine; i < Math.min(lines.length, bestLine + 1200); i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; }
    }
    if (started && depth === 0) { endLine = i; break; }
  }

  if (!started || endLine <= bestLine) return null;

  const ctxStart  = Math.max(0, bestLine - 6);           // include preceding comments
  const extracted = lines.slice(ctxStart, endLine + 1).join("\n");

  if (extracted.length > maxChars) return null;           // block too big → use window

  return [
    `// ⚡ Function extract: lines ${ctxStart + 1}–${endLine + 1} of ${lines.length}`,
    `// Matched function near line ${bestLine + 1} | keywords: ${keywords.slice(0, 5).join(", ")}`,
    "",
    extracted,
  ].join("\n");
}

// ─── Improve existing code ─────────────────────────────────────────────────────
export const TARGET_FILE_MAP: Record<string, string> = {
  "slash-commands":  "artifacts/api-server/src/lib/features/slash-commands.ts",
  "daily":           "artifacts/api-server/src/lib/features/daily.ts",
  "welcome":         "artifacts/api-server/src/lib/features/welcome.ts",
  "auto-security":   "artifacts/api-server/src/lib/features/auto-security.ts",
  "server-log":      "artifacts/api-server/src/lib/features/server-log.ts",
  "moderation":      "artifacts/api-server/src/lib/features/moderation.ts",
  "reputation":      "artifacts/api-server/src/lib/features/reputation.ts",
  "profiling":       "artifacts/api-server/src/lib/features/profiling.ts",
  "tracker":         "artifacts/api-server/src/lib/features/tracker.ts",
  "jp-tracker":      "artifacts/api-server/src/lib/features/jp-tracker.ts",
  "memory":          "artifacts/api-server/src/lib/features/memory.ts",
  "events":          "artifacts/api-server/src/lib/features/events.ts",
  "radio":           "artifacts/api-server/src/lib/features/radio.ts",
  "tweet-monitor":   "artifacts/api-server/src/lib/features/tweet-monitor.ts",
  "youtube-monitor": "artifacts/api-server/src/lib/features/youtube-monitor.ts",
  "ai-plugins":      "artifacts/api-server/src/lib/features/ai-plugins.ts",
  "ai-behaviors":    "artifacts/api-server/src/lib/features/ai-behaviors.ts",
  "self-heal":       "artifacts/api-server/src/lib/features/self-heal.ts",
  "discord-bot":     "artifacts/api-server/src/lib/discord-bot.ts",
};

// ─── Fuzzy Patch Application ──────────────────────────────────────────────────
// Applies old→new patch using 4 progressive normalization levels so that minor
// whitespace/indent differences from Gemini don't cause failures.
interface FuzzyResult { patched: string; method: string }

function applyPatchFuzzy(source: string, oldCode: string, newCode: string): FuzzyResult | null {
  // Level 1 — exact match
  if (source.includes(oldCode)) {
    return { patched: source.replace(oldCode, newCode), method: "exact" };
  }

  // Level 2 — normalize CRLF + trailing spaces per line
  const normL2 = (s: string) => s.replace(/\r\n/g, "\n").split("\n").map(l => l.trimEnd()).join("\n");
  const srcL2 = normL2(source);
  const oldL2 = normL2(oldCode);
  if (srcL2.includes(oldL2)) {
    return { patched: srcL2.replace(oldL2, normL2(newCode)), method: "crlf+trailspace" };
  }

  // Level 3 — normalize ALL whitespace within each line (collapse multiple spaces/tabs)
  const normL3 = (s: string) => s.replace(/\r\n/g, "\n").split("\n").map(l => l.trim().replace(/\s+/g, " ")).join("\n");
  const srcL3 = normL3(source);
  const oldL3 = normL3(oldCode);
  if (srcL3.includes(oldL3)) {
    const srcLines  = source.split("\n");
    const oldL3Lines = oldL3.split("\n");
    const srcL3Lines = srcL3.split("\n");
    // Find where the normalized block starts in the source
    const startIdx = srcL3Lines.findIndex((_, i) =>
      srcL3Lines.slice(i, i + oldL3Lines.length).join("\n") === oldL3
    );
    if (startIdx !== -1) {
      const before = srcLines.slice(0, startIdx).join("\n");
      const after  = srcLines.slice(startIdx + oldL3Lines.length).join("\n");
      return {
        patched: [before, newCode, after].filter(s => s.length > 0).join("\n"),
        method: "whitespace-norm",
      };
    }
  }

  // Level 4 — sliding window line-similarity (≥85% of non-empty lines must match)
  const oldLines = oldCode.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (oldLines.length < 2) return null;

  const srcLines  = source.split("\n");
  let bestScore   = 0;
  let bestStart   = -1;

  for (let i = 0; i <= srcLines.length - oldLines.length; i++) {
    let matches = 0;
    for (let j = 0; j < oldLines.length; j++) {
      const a = (srcLines[i + j] ?? "").trim().replace(/\s+/g, " ");
      const b = oldLines[j]!.replace(/\s+/g, " ");
      if (a === b) matches++;
      else if (a.includes(b) || b.includes(a)) matches += 0.8;
    }
    const score = matches / oldLines.length;
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }

  if (bestScore >= 0.85 && bestStart >= 0) {
    const before = srcLines.slice(0, bestStart).join("\n");
    const after  = srcLines.slice(bestStart + oldLines.length).join("\n");
    return {
      patched: [before, newCode, after].filter(s => s.length > 0).join("\n"),
      method: `fuzzy-${Math.round(bestScore * 100)}%`,
    };
  }

  return null; // all 4 levels failed
}

export interface ImproveResult {
  success:     boolean;
  target:      string;
  description: string;
  patchDesc:   string;
  error?:      string;
}

export async function improveCode(target: string, description: string, requestedBy: string): Promise<ImproveResult> {
  // Handle plugin:name → map to ai-plugins.ts with plugin context injected
  let resolvedTarget = target.toLowerCase().trim();
  if (resolvedTarget.startsWith("plugin:")) {
    const pluginName = target.slice("plugin:".length);
    description = `[AUTO-HEAL for plugin /${pluginName}] ${description}\n\nCRITICAL: Only modify the handler body of the plugin named "${pluginName}". Do NOT touch other plugins. Use the correct API patterns from PLUGIN_CONTEXT.`;
    resolvedTarget = "ai-plugins";
  }

  const relPath = TARGET_FILE_MAP[resolvedTarget];
  if (!relPath) {
    return { success: false, target, description, patchDesc: "", error: `Unknown target: ${target}. Valid: ${Object.keys(TARGET_FILE_MAP).join(", ")}` };
  }

  const absPath = resolve(WORKSPACE_ROOT, relPath);
  if (!existsSync(absPath)) {
    return { success: false, target, description, patchDesc: "", error: `File not found: ${relPath}` };
  }

  const source  = readFileSync(absPath, "utf-8");
  const excerpt = extractRelevantSource(source, description, 30_000);

  const buildPrompt = (code: string) => {
    // Annotate source lines with numbers so Gemini can reference them
    const numbered = code.split("\n").map((l, i) => `${String(i + 1).padStart(4, " ")}│${l}`).join("\n");
    return `You are an expert TypeScript Discord bot developer. Improve existing code.

TARGET FILE: ${relPath}
IMPROVEMENT REQUESTED: "${description}"

SOURCE CODE (${source.split("\n").length} lines total):
\`\`\`
${numbered}
\`\`\`

Output ONLY a JSON object — start with { end with } — no other text, no markdown fences.

{
  "old_code": "PASTE THE EXACT LINES from above that you want to change (copy character-for-character, WITHOUT the line number prefix)",
  "new_code": "the improved replacement code",
  "description": "one sentence summary of the change"
}

CRITICAL:
- old_code must appear VERBATIM in the source (copy-paste from the code above, after the │ character)
- Include at least 3 consecutive lines for uniqueness
- new_code must be valid TypeScript
- If truly impossible as a single replacement: {"old_code":"","new_code":"","description":"Cannot patch: <reason>"}`;
  };

  let patch: { old_code: string; new_code: string; description: string } | null = null;
  let lastError = "";

  for (const [attempt, code] of [
    [1, excerpt] as [number, string],
    [2, extractRelevantSource(source, description, 15_000)] as [number, string],
  ]) {
    try {
      const res = await ai.models.generateContent({
        model:    "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: buildPrompt(code) }] }],
        config:   { maxOutputTokens: 8192, temperature: attempt === 1 ? 0.05 : 0.15 },
      });

      const rawText = res.text ?? "";
      if (!rawText.trim()) { lastError = "Empty response"; continue; }

      patch = JSON.parse(extractJSON(rawText));
      console.log(`[AICoder] /improve attempt ${attempt}: JSON parsed OK`);
      break;
    } catch (e) {
      lastError = String(e).slice(0, 300);
      console.warn(`[AICoder] /improve attempt ${attempt} failed: ${lastError}`);
    }
  }

  if (!patch) {
    await saveImprovement(target, description, null, null, "gemini_fail", null, null, requestedBy, lastError);
    return { success: false, target, description, patchDesc: "", error: `AI generation failed: ${lastError.slice(0, 120)}` };
  }

  if (!patch.old_code || !patch.new_code) {
    await saveImprovement(target, description, null, null, "no_patch", null, null, requestedBy, patch.description ?? "");
    return { success: false, target, description, patchDesc: patch.description ?? "", error: `Cannot auto-improve: ${patch.description}` };
  }

  // ── Fuzzy patch application ────────────────────────────────────────────────
  // Gemini sometimes has minor whitespace differences — try 4 normalization levels
  const fuzzyResult = applyPatchFuzzy(source, patch.old_code, patch.new_code);
  if (!fuzzyResult) {
    await saveImprovement(target, description, patch.old_code, patch.new_code, "not_found", null, null, requestedBy, "fuzzy match failed");
    return {
      success: false, target, description, patchDesc: patch.description,
      error:   `The AI generated a change but I couldn't locate the exact code block in **${target}**. ` +
               `Try describing the change more specifically — mention the function name and what exactly to modify inside it.`,
    };
  }

  console.log(`[AICoder] Patch located via ${fuzzyResult.method} matching`);

  // Backup + apply
  const backupPath = `${absPath}.improve.backup`;
  copyFileSync(absPath, backupPath);
  writeFileSync(absPath, fuzzyResult.patched, "utf-8");

  // TypeScript validation
  try {
    execSync("pnpm tsc --noEmit", { cwd: API_SERVER_DIR, stdio: "pipe" });
  } catch {
    copyFileSync(backupPath, absPath);
    unlinkSync(backupPath);
    await saveImprovement(target, description, patch.old_code, patch.new_code, "ts_fail", false, null, requestedBy, "TS failed");
    return { success: false, target, description, patchDesc: patch.description, error: "TypeScript validation failed — rolled back" };
  }

  // Rebuild
  try {
    execSync("node ./build.mjs", { cwd: API_SERVER_DIR, stdio: "pipe", timeout: 120_000 });
  } catch {
    copyFileSync(backupPath, absPath);
    unlinkSync(backupPath);
    await saveImprovement(target, description, patch.old_code, patch.new_code, "build_fail", true, false, requestedBy, "Build failed");
    return { success: false, target, description, patchDesc: patch.description, error: "Build failed — rolled back" };
  }

  unlinkSync(backupPath);
  await saveImprovement(target, description, patch.old_code, patch.new_code, "improved", true, true, requestedBy, null);

  // Save to auto-fix log for production sync
  await pool.query(
    `INSERT INTO auto_fix_log (error_key, source_file_rel, patch_old, patch_new, description, status, ts_valid, build_ok, synced)
     VALUES ($1,$2,$3,$4,$5,'applied',TRUE,TRUE,TRUE)`,
    [`improve:${target}`, relPath, patch.old_code.slice(0, 2000), patch.new_code.slice(0, 2000), patch.description],
  ).catch(console.error);

  const restartingImp = scheduleRestart(`/improve:${target}`);
  if (!restartingImp) {
    console.log(`[AICoder] ✅ Improved ${target} — restart cooldown active. Changes staged.`);
  } else {
    console.log(`[AICoder] ✅ Improved ${target} — restarting in 4s`);
  }

  return { success: true, target, description, patchDesc: patch.description };
}

// ─── List built plugins ────────────────────────────────────────────────────────
export async function getBuiltFeatures(limit = 10): Promise<{
  commandName: string; description: string; status: string; builtAt: Date; builtBy: string;
}[]> {
  const { rows } = await pool.query(
    `SELECT command_name, description, status, built_at, built_by FROM ai_coder_builds ORDER BY built_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(r => ({ commandName: r.command_name, description: r.description, status: r.status, builtAt: r.built_at, builtBy: r.built_by }));
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
async function saveBuild(
  commandName: string | null, description: string, status: string,
  tsValid: boolean | null, buildOk: boolean | null, builtBy: string, error: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_coder_builds (command_name, description, status, ts_valid, build_ok, built_by, error_msg)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [commandName, description, status, tsValid, buildOk, builtBy, error],
  ).catch(console.error);
}

async function saveImprovement(
  target: string, description: string, patchOld: string | null, patchNew: string | null,
  status: string, tsValid: boolean | null, buildOk: boolean | null, improvedBy: string, error: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_coder_improvements (target, description, patch_old, patch_new, status, ts_valid, build_ok, improved_by, error_msg)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [target, description, patchOld?.slice(0, 1000), patchNew?.slice(0, 1000), status, tsValid, buildOk, improvedBy, error],
  ).catch(console.error);
}

// Save behavior build result to DB
async function saveBehaviorBuild(
  behaviorId: string | null, description: string, type: BehaviorType,
  status: string, builtBy: string, error: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_coder_behaviors (behavior_id, behavior_name, behavior_type, description, status, built_by, error_msg)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [behaviorId, behaviorId, type, description, status, builtBy, error],
  ).catch(console.error);
}

// Save behavior build as a patch record so production syncs it
async function saveBehaviorPatchToAutoFix(behaviorId: string, oldSource: string, newSource: string): Promise<void> {
  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");
  const insertedLines: string[] = [];
  let j = 0;
  for (let i = 0; i < newLines.length; i++) {
    if (j < oldLines.length && newLines[i] === oldLines[j]) { j++; }
    else { insertedLines.push(newLines[i]); }
  }
  await pool.query(
    `INSERT INTO auto_fix_log (error_key, source_file_rel, patch_old, patch_new, description, status, ts_valid, build_ok, synced)
     VALUES ($1,$2,$3,$4,$5,'applied',TRUE,TRUE,TRUE)`,
    [
      `behavior:${behaviorId}`,
      "artifacts/api-server/src/lib/features/ai-behaviors.ts",
      "  // ── AI BEHAVIORS ARRAY END ───────────────────────────────────────────────",
      insertedLines.join("\n") + "\n  // ── AI BEHAVIORS ARRAY END ───────────────────────────────────────────────",
      `Added new behavior: ${behaviorId}`,
    ],
  ).catch(console.error);
}

// Save plugin build as a patch record so production syncs it
async function savePluginPatchToAutoFix(commandName: string, oldSource: string, newSource: string): Promise<void> {
  // Find the new code that was added (the diff)
  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");
  // Find the inserted lines
  const insertedLines: string[] = [];
  let j = 0;
  for (let i = 0; i < newLines.length; i++) {
    if (j < oldLines.length && newLines[i] === oldLines[j]) { j++; }
    else { insertedLines.push(newLines[i]); }
  }

  await pool.query(
    `INSERT INTO auto_fix_log (error_key, source_file_rel, patch_old, patch_new, description, status, ts_valid, build_ok, synced)
     VALUES ($1,$2,$3,$4,$5,'applied',TRUE,TRUE,TRUE)`,
    [
      `build:${commandName}`,
      "artifacts/api-server/src/lib/features/ai-plugins.ts",
      "  // ── AI PLUGINS ARRAY END ─────────────────────────────────────────────────",
      insertedLines.join("\n") + "\n  // ── AI PLUGINS ARRAY END ─────────────────────────────────────────────────",
      `Added new plugin: /${commandName}`,
    ],
  ).catch(console.error);
}

// ─── Reset Guild Plugins ──────────────────────────────────────────────────────
/**
 * Removes ALL AI-built plugins that belong to a specific guild:
 *   1. Strips their entries from ai-plugins.ts (persistent — survives restart)
 *   2. Splices them from the in-memory aiPluginCommands array (takes effect immediately)
 *   3. Calls clearGuildPlugins() to delete them from Discord instantly
 *
 * @returns Names of the plugins that were removed.
 */
export interface ResetGuildResult {
  removed:  string[];   // plugin names removed
  discord:  boolean;    // true if Discord commands were cleared successfully
}

export async function resetGuildPlugins(
  guildId:         string,
  aiPluginCommands: Array<{ name: string; guildId?: string | null }>,
): Promise<ResetGuildResult> {
  // ── 1. Identify plugins that belong to this guild ─────────────────────────
  const targets = aiPluginCommands.filter(p => p.guildId === guildId);
  if (targets.length === 0) {
    return { removed: [], discord: true };
  }
  const targetNames = new Set(targets.map(p => p.name));

  // ── 2. Remove their entries from ai-plugins.ts ────────────────────────────
  const ARRAY_START = "  // ── AI PLUGINS ARRAY START ────────────────────────────────────────────────";
  const ARRAY_END   = "  // ── AI PLUGINS ARRAY END ─────────────────────────────────────────────────";

  if (existsSync(AI_PLUGINS_PATH)) {
    const src    = readFileSync(AI_PLUGINS_PATH, "utf8");
    const sIdx   = src.indexOf(ARRAY_START);
    const eIdx   = src.indexOf(ARRAY_END);
    if (sIdx !== -1 && eIdx !== -1) {
      const before     = src.slice(0, sIdx + ARRAY_START.length);
      const arrayBody  = src.slice(sIdx + ARRAY_START.length, eIdx);
      const after      = src.slice(eIdx);

      // Parse each top-level {…}, block using brace-depth counting
      const blocks: Array<{ text: string; start: number; end: number }> = [];
      let i = 0;
      while (i < arrayBody.length) {
        const openIdx = arrayBody.indexOf("  {", i);
        if (openIdx === -1) break;
        let depth = 0;
        let j = openIdx;
        let inStr = false;
        let strCh = "";
        while (j < arrayBody.length) {
          const ch = arrayBody[j];
          if (inStr) {
            if (ch === "\\" ) { j++; }                     // skip escaped char
            else if (ch === strCh) { inStr = false; }
          } else {
            if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; }
            else if (ch === "{") { depth++; }
            else if (ch === "}") { depth--; if (depth === 0) { j++; break; } }
          }
          j++;
        }
        // Consume optional trailing comma
        if (j < arrayBody.length && arrayBody[j] === ",") j++;
        blocks.push({ text: arrayBody.slice(openIdx, j), start: openIdx, end: j });
        i = j;
      }

      // Keep blocks that do NOT belong to this guild
      const keptBody = blocks
        .filter(b => {
          // Quick check: does this block contain `guildId: "targetGuildId"`?
          const belongsToGuild = b.text.includes(`guildId: "${guildId}"`);
          return !belongsToGuild;
        })
        .map(b => b.text)
        .join("\n");

      const newSrc = before + "\n" + keptBody + (keptBody.trim() ? "\n" : "") + after;
      writeFileSync(AI_PLUGINS_PATH, newSrc, "utf8");
      console.log(`[AICoder] ✅ Removed ${targetNames.size} guild plugin(s) from ai-plugins.ts`);
    }
  }

  // ── 3. Splice from in-memory array (immediate effect, no restart needed) ──
  for (let i = aiPluginCommands.length - 1; i >= 0; i--) {
    if (aiPluginCommands[i].guildId === guildId) {
      aiPluginCommands.splice(i, 1);
    }
  }

  // ── 4. Delete from Discord ─────────────────────────────────────────────────
  const discord = await clearGuildPlugins(guildId, targetNames);

  return { removed: [...targetNames], discord };
}
