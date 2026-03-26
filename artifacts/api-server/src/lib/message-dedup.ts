import { pool } from "@workspace/db";

export async function initMessageDedup(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id   TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interaction_claims (
      interaction_id TEXT PRIMARY KEY,
      claimed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ─── Internal: atomic INSERT with optional timeout ─────────────────────────────
async function atomicClaim(
  table: string,
  idCol: string,
  id: string,
  timeoutMs?: number,
): Promise<boolean> {
  const doInsert = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await pool.query(
          `INSERT INTO ${table} (${idCol}) VALUES ($1)
           ON CONFLICT DO NOTHING
           RETURNING ${idCol}`,
          [id],
        );
        return (res.rowCount ?? 0) > 0;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 50 * (attempt + 1) * (attempt + 1)));
        }
      }
    }
    // All DB attempts failed — fail OPEN so we don't silently drop the interaction.
    // A potential duplicate response is far better than Discord's "did not respond" error.
    return true;
  };

  if (!timeoutMs) return doInsert();

  // Race the DB claim against a strict deadline.
  // If DB is slow, fail OPEN (let this instance handle it) to avoid Discord's
  // 3-second interaction timeout.  The worst-case is two instances briefly
  // handle the same interaction; that is far better than a 10062 silent fail.
  const timeoutPromise = new Promise<boolean>(resolve =>
    setTimeout(() => resolve(true), timeoutMs),
  );
  return Promise.race([doInsert(), timeoutPromise]);
}

/**
 * Atomically claim a message ID.
 * Returns true  → this instance owns the message, proceed.
 * Returns false → another instance already claimed it OR DB unavailable → skip.
 */
export async function tryClaimMessage(messageId: string): Promise<boolean> {
  return atomicClaim("processed_messages", "message_id", messageId);
}

/**
 * Atomically claim a slash command interaction ID.
 *
 * Hard deadline: 1 500 ms.  If the DB hasn't replied by then we fail OPEN
 * so that deferReply() still lands within Discord's 3-second window.
 *
 * Returns true  → this instance should handle the interaction (also returned
 *                 on any DB error — fail OPEN beats "did not respond").
 * Returns false → another instance already claimed it → drop silently.
 */
export async function tryClaimInteraction(interactionId: string): Promise<boolean> {
  return atomicClaim("interaction_claims", "interaction_id", interactionId, 800);
}

/**
 * Atomically claim a guild event (GuildMemberAdd, test welcome, etc.) by key.
 */
export async function tryClaimGuildEvent(eventKey: string): Promise<boolean> {
  return atomicClaim("interaction_claims", "interaction_id", eventKey);
}

export async function cleanOldMessages(): Promise<void> {
  await pool.query(
    `DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '10 minutes'`,
  );
  await pool.query(
    `DELETE FROM interaction_claims WHERE claimed_at < NOW() - INTERVAL '5 minutes'`,
  );
}
