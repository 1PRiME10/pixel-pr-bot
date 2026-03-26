// ─── Plugin Hot-Registrar ─────────────────────────────────────────────────────
// Allows any instance (dev, prod, standby) to immediately push updated slash
// command definitions to Discord via REST — no gateway / leadership required.
//
// Initialised by slash-commands.ts on ClientReady.
// Called by ai-coder.ts after a successful /build or /improve run.
//
// Global commands  → Routes.applicationCommands       (all servers, up to 1h propagation)
// Guild commands   → Routes.applicationGuildCommands  (one server, instant)

import { REST, Routes } from "discord.js";

type Def = Record<string, unknown>;

let _token    = "";
let _clientId = "";
let _static:  Def[] = [];   // static command definitions (83 built-in commands)
let _plugins: Def[] = [];   // current AI-plugin definitions (in-memory snapshot)

/**
 * Called once by slash-commands.ts after the bot is ready.
 * Stores credentials + current command defs so any code path can re-register.
 */
export function initRegistrar(
  token:     string,
  clientId:  string,
  staticDefs: Def[],
  pluginDefs: Def[],
): void {
  _token    = token;
  _clientId = clientId;
  _static   = staticDefs;
  _plugins  = pluginDefs;
}

/** Returns the names of all currently registered commands (static + plugins). */
export function getRegisteredCommandNames(): string[] {
  return [..._static, ..._plugins]
    .map((d) => (d as any).name as string)
    .filter(Boolean);
}

/**
 * Immediately registers a GUILD-SPECIFIC command for one server.
 * Instant (no propagation delay). Does NOT touch global command list.
 *
 * @param guildId  Discord guild snowflake to register the command for.
 * @param def      Slash command JSON definition.
 * @returns true on success, false on failure.
 */
export async function hotRegisterGuildCommand(guildId: string, def: Def): Promise<boolean> {
  if (!_token || !_clientId) {
    console.warn("[Registrar] Not initialised — skipping guild hot-registration.");
    return false;
  }
  try {
    const rest = new REST({ version: "10" }).setToken(_token);
    // Fetch current guild commands, replace/add ours, then bulk PUT back
    const existing = await rest.get(
      Routes.applicationGuildCommands(_clientId, guildId)
    ) as Def[];
    const updated = [...existing.filter(c => c.name !== def.name), def];
    await rest.put(Routes.applicationGuildCommands(_clientId, guildId), { body: updated });
    console.log(`[Registrar] ✅ Hot-registered /${def.name} as guild command (guild: ${guildId})`);
    return true;
  } catch (err: any) {
    console.error("[Registrar] Guild hot-registration failed:", err?.message ?? err);
    return false;
  }
}

/**
 * Wipes ALL AI-built plugin commands from a specific guild via Discord REST.
 * Call after removing plugin entries from ai-plugins.ts so Discord reflects the change.
 *
 * @param guildId         Guild to clear plugin commands for.
 * @param pluginNames     Set of plugin names to remove (all others are preserved).
 * @returns true on success, false on failure.
 */
export async function clearGuildPlugins(guildId: string, pluginNames: Set<string>): Promise<boolean> {
  if (!_token || !_clientId) {
    console.warn("[Registrar] Not initialised — skipping guild plugin clear.");
    return false;
  }
  try {
    const rest = new REST({ version: "10" }).setToken(_token);
    const existing = await rest.get(
      Routes.applicationGuildCommands(_clientId, guildId)
    ) as Def[];
    // Keep any commands NOT in the plugin set (i.e. manually registered guild commands)
    const kept = existing.filter(c => !pluginNames.has(c.name as string));
    await rest.put(Routes.applicationGuildCommands(_clientId, guildId), { body: kept });
    console.log(`[Registrar] ✅ Cleared ${pluginNames.size} plugin command(s) from guild ${guildId}`);
    return true;
  } catch (err: any) {
    console.error("[Registrar] clearGuildPlugins failed:", err?.message ?? err);
    return false;
  }
}

/**
 * Immediately registers all global commands + an optional new definition via REST.
 * Safe to call from any instance regardless of Discord gateway leadership.
 *
 * @param extraDef  Optional new plugin definition to include.
 * @returns true on success, false on failure.
 */
export async function hotRegisterCommands(extraDef?: Def): Promise<boolean> {
  if (!_token || !_clientId) {
    console.warn("[Registrar] Not initialised — skipping hot-registration.");
    return false;
  }
  try {
    const all = [..._static, ..._plugins, ...(extraDef ? [extraDef] : [])];

    // Deduplicate by name (last writer wins — keeps the newest version)
    const seen = new Set<string>();
    const deduped: Def[] = [];
    for (const d of all.slice().reverse()) {
      const name = d.name as string;
      if (!seen.has(name)) { seen.add(name); deduped.unshift(d); }
    }

    const rest = new REST({ version: "10" }).setToken(_token);
    await rest.put(Routes.applicationCommands(_clientId), { body: deduped });
    console.log(`[Registrar] ✅ Hot-registered ${deduped.length} commands (${deduped.length - _static.length} AI-built)`);

    // Update in-memory snapshot so future calls include this plugin
    if (extraDef) {
      const name = extraDef.name as string;
      _plugins = _plugins.filter(p => p.name !== name);
      _plugins.push(extraDef);
    }
    return true;
  } catch (err: any) {
    console.error("[Registrar] Hot-registration failed:", err?.message ?? err);
    return false;
  }
}
