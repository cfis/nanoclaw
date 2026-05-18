/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

// turn_send_invoked: did send_message / send_file fire this turn? Used by
// poll-loop to suppress the SDK's closing-text result that would otherwise
// be delivered as a duplicate of what the tool already sent.
//
// MUST be in SQLite. The nanoclaw MCP server (which owns send_message and
// send_file) runs in a separate process from the poll-loop: index.ts spawns
// it via `bun run mcp-tools/index.ts` and connects over stdio. SQLite is
// the only IPC channel between the two processes. A module-level variable
// here is invisible across the process boundary — set in the MCP server
// process, the poll-loop reads false, and the suppression is dead code.
//
// SIGKILL-mid-turn (where the row would otherwise stick at '1' into the
// next container's first turn) is handled by clearing the flag at the top
// of runPollLoop() alongside clearStaleProcessingAcks — see poll-loop.ts.
const TURN_SEND_INVOKED_KEY = 'turn_send_invoked';

export function setTurnSendInvoked(): void {
  setValue(TURN_SEND_INVOKED_KEY, '1');
}
export function getTurnSendInvoked(): boolean {
  return getValue(TURN_SEND_INVOKED_KEY) === '1';
}
export function clearTurnSendInvoked(): void {
  deleteValue(TURN_SEND_INVOKED_KEY);
}
