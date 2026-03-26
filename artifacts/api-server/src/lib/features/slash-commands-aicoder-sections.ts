import { improveCode } from "./ai-coder.js";

const PLUGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const PLUGIN_FAIL_THRESHOLD = 3;

const _pluginFailures  = new Map<string, number[]>();
const _pluginImproving = new Set<string>();

export async function trackPluginFailure(
  pluginName: string,
  err: unknown,
  adminChannelSender?: (msg: string) => Promise<void>,
): Promise<void> {
  const now   = Date.now();
  const times = (_pluginFailures.get(pluginName) ?? []).filter(t => now - t < PLUGIN_FAIL_WINDOW_MS);
  times.push(now);
  _pluginFailures.set(pluginName, times);

  if (times.length >= PLUGIN_FAIL_THRESHOLD && !_pluginImproving.has(pluginName)) {
    _pluginImproving.add(pluginName);
    _pluginFailures.delete(pluginName);

    const errMsg = String((err as any)?.message ?? err).slice(0, 400);
    console.warn(`[Slash] ⚡ Plugin /${pluginName} failed ${times.length}x in 10min — auto-improving...`);

    if (adminChannelSender) {
      await adminChannelSender(
        `⚡ **Plugin \`/${pluginName}\` failed ${times.length} times** in 10 minutes.\n` +
        `🔧 Auto-improve triggered — fixing now...\n\`\`\`${errMsg.slice(0, 300)}\`\`\``
      ).catch(() => {});
    }

    improveCode(
      `plugin:${pluginName}`,
      `The plugin is broken at runtime. Error: ${errMsg}. Fix the handler so it works correctly.`,
      "auto-heal",
    ).then(result => {
      _pluginImproving.delete(pluginName);
      if (result.success) {
        console.log(`[Slash] ✅ Auto-improved /${pluginName} successfully`);
        if (adminChannelSender) {
          adminChannelSender(`✅ **Plugin \`/${pluginName}\` auto-fixed** and reloaded.`).catch(() => {});
        }
      } else {
        console.warn(`[Slash] ❌ Auto-improve for /${pluginName} failed: ${result.error}`);
        _pluginImproving.delete(pluginName);
      }
    }).catch(e => {
      _pluginImproving.delete(pluginName);
      console.error(`[Slash] Auto-improve error for /${pluginName}:`, e);
    });
  }
}
