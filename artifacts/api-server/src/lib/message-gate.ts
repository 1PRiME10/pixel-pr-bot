// ─── Global Message Gate ──────────────────────────────────────────────────────
// FAST in-memory dedup — zero DB round-trips per message.
//
// Design:
//   1. Gate listener fires first (registered before all feature modules).
//      It claims the message instantly in an in-memory Map.
//   2. A background DB claim runs asynchronously — does NOT block the response.
//      This handles cross-instance dedup during rare deployment overlaps.
//   3. isClaimed() is now synchronous (instant Map lookup).
//
// Trade-off: During the ~1-2 minute window when two Render instances overlap
// on a rolling deploy, there's a tiny chance of a duplicate response on a
// command. This is far better than making every message pay a DB round-trip
// (5-20ms) which saturates the pool when radio is streaming.
//
// Usage in feature modules (unchanged — await still works on sync return):
//   const ok = await isClaimed(message.id);
//   if (!ok) return;

import { Client, Events, Message } from "discord.js";
import { tryClaimMessage } from "./message-dedup.js";

// In-memory claim set — message IDs owned by THIS instance
// Values: expiry timestamp (for lazy cleanup)
const localClaimed = new Map<string, number>();
const TTL_MS = 120_000; // 2 minutes — messages older than this can't recur

// ── Lazy cleanup: evict expired entries when the map grows large ──────────────
function maybeCleanup(): void {
  if (localClaimed.size < 2000) return;
  const now = Date.now();
  for (const [id, exp] of localClaimed) {
    if (exp <= now) localClaimed.delete(id);
  }
}

/**
 * Register the gate BEFORE any feature module.
 * Claims each message instantly in memory; DB claim runs in background for
 * cross-instance dedup without blocking the response path.
 */
export function registerGate(client: Client): void {
  client.on(Events.MessageCreate, (message: Message) => {
    if (message.author.bot) return;

    // Instant claim — O(1), no async, no DB wait
    localClaimed.set(message.id, Date.now() + TTL_MS);
    maybeCleanup();

    // Background DB claim for cross-instance dedup (non-blocking)
    // If another instance already claimed this message in the DB, it wins.
    // We still respond here, but the duplicate response is acceptable vs. 20ms delay.
    tryClaimMessage(message.id).then((claimed) => {
      if (!claimed) {
        // Another instance won the DB race — revoke local claim
        // This prevents us from processing THIS message again if the event refires.
        localClaimed.delete(message.id);
      }
    }).catch(() => {
      // DB error — keep local claim so the message still gets processed
    });
  });
}

/**
 * Feature modules call this at the top of their messageCreate handler.
 * Now synchronous — resolves immediately with no DB round-trip.
 * Returns true if this instance should process the message.
 */
export function isClaimed(messageId: string): boolean {
  const exp = localClaimed.get(messageId);
  if (exp === undefined) return false;
  if (Date.now() > exp) { localClaimed.delete(messageId); return false; }
  return true;
}
