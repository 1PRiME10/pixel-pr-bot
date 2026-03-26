// ─── Restart Manager ──────────────────────────────────────────────────────────
// Prevents crash loops by enforcing a minimum gap between process restarts.
// Auto-fix NEVER restarts — only manual /build and /improve can.

const COOLDOWN_MS = 3 * 60_000; // 3 minutes between restarts
let lastRestartAt  = 0;
let pendingRestart = false;

/**
 * Request a process restart after code changes.
 * If a restart happened within the cooldown window, the request is skipped
 * and a descriptive message is returned instead.
 *
 * @param source - Who/what triggered the restart (for logging)
 * @param delayMs - Grace period before calling process.exit (default 4s)
 * @returns true if restart was scheduled, false if cooldown is active
 */
export function scheduleRestart(source: string, delayMs = 4000): boolean {
  const now  = Date.now();
  const diff = now - lastRestartAt;

  if (pendingRestart) {
    console.log(`[Restart] ${source}: restart already pending — skipping`);
    return false;
  }

  if (diff < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - diff) / 1000);
    console.log(`[Restart] ${source}: cooldown active (${waitSec}s remaining) — skipping restart. Changes staged for next cycle.`);
    return false;
  }

  lastRestartAt  = now;
  pendingRestart = true;
  console.log(`[Restart] ${source}: scheduling restart in ${delayMs / 1000}s`);
  setTimeout(() => {
    console.log(`[Restart] ${source}: restarting now`);
    process.exit(0);
  }, delayMs);
  return true;
}

/**
 * Check if a restart can be scheduled right now.
 */
export function canRestart(): boolean {
  if (pendingRestart) return false;
  return Date.now() - lastRestartAt >= COOLDOWN_MS;
}

/**
 * How many seconds until the next restart is allowed (0 if ready).
 */
export function restartCooldownSec(): number {
  const remaining = COOLDOWN_MS - (Date.now() - lastRestartAt);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
