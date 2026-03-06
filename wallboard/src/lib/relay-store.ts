import { EventEmitter } from 'events';
import type { RelayPushPayload } from '@/types/relay';

/**
 * In-memory store for relay agent state.
 *
 * The relay agent pushes data via HTTP POST to /api/relay/push.
 * Freshness is time-based — if no push received within STALE_MS, relay is offline.
 * The poller subscribes to the 'data' event to react immediately to relay pushes.
 */

// ─── Event emitter for real-time notifications ───────────────────────────

const _emitter = new EventEmitter();
_emitter.setMaxListeners(50);

/** Subscribe to relay data updates. Callback fires immediately when new data arrives. */
export function onRelayData(callback: (payload: RelayPushPayload) => void): void {
  _emitter.on('data', callback);
}

/** Unsubscribe from relay data updates. */
export function offRelayData(callback: (payload: RelayPushPayload) => void): void {
  _emitter.off('data', callback);
}

// ─── State ───────────────────────────────────────────────────────────────

let _data: RelayPushPayload | null = null;
let _receivedAt = 0;
let _relayIp: string | null = null;

const STALE_MS = 15_000; // 15s without data = offline

// ─── Data updates (called by HTTP push endpoint) ─────────────────────────

/** Store a new relay push payload and notify subscribers. */
export function setRelayData(payload: RelayPushPayload, ip?: string): void {
  _data = payload;
  _receivedAt = Date.now();
  if (ip) _relayIp = ip;
  // Clear overrides only when relay data confirms the change
  pruneConfirmedOverrides(payload);
  _emitter.emit('data', payload);
}

// ─── Queries (used by poller, admin router, etc.) ────────────────────────

/** Get the latest relay push payload (or null if none received). */
export function getRelayData(): RelayPushPayload | null {
  return _data;
}

/**
 * Check if relay data is available and current.
 * Returns true if last push was within maxAgeMs.
 */
export function isRelayFresh(maxAgeMs: number = STALE_MS): boolean {
  if (!_data || _receivedAt === 0) return false;
  return Date.now() - _receivedAt < maxAgeMs;
}

/** Get age of relay data in milliseconds. */
export function getRelayAge(): number {
  if (_receivedAt === 0) return Infinity;
  return Date.now() - _receivedAt;
}

/** Get the IP of the relay agent. */
export function getRelayIp(): string | null {
  return _relayIp;
}

/** Get the timestamp when relay data was last received. */
export function getRelayReceivedAt(): number {
  return _receivedAt;
}

// ─── Optimistic overrides (for immediate UI updates after actions) ─────

interface AgentOverride {
  queueNumber: string;
  ext: string;
  loggedIn: boolean;
  expiresAt: number;
}

const _agentOverrides: AgentOverride[] = [];

/**
 * Apply an optimistic override to an agent's login status.
 * The next relay push or 10s timeout clears it automatically.
 */
export function setAgentOverride(queueNumber: string, ext: string, loggedIn: boolean): void {
  // Remove any existing override for the same agent+queue
  const idx = _agentOverrides.findIndex(o => o.queueNumber === queueNumber && o.ext === ext);
  if (idx >= 0) _agentOverrides.splice(idx, 1);
  _agentOverrides.push({ queueNumber, ext, loggedIn, expiresAt: Date.now() + 20_000 });
}

/**
 * Get optimistic login override for an agent, or undefined if none.
 * Automatically prunes expired overrides.
 */
export function getAgentOverride(queueNumber: string, ext: string): boolean | undefined {
  const now = Date.now();
  // Prune expired
  for (let i = _agentOverrides.length - 1; i >= 0; i--) {
    if (_agentOverrides[i].expiresAt < now) _agentOverrides.splice(i, 1);
  }
  const o = _agentOverrides.find(o => o.queueNumber === queueNumber && o.ext === ext);
  return o?.loggedIn;
}

/** Clear all overrides. */
export function clearAgentOverrides(): void {
  _agentOverrides.length = 0;
}

/**
 * Remove overrides that the relay data has confirmed (agent status matches override).
 * Keeps overrides alive until the relay actually reflects the change.
 */
function pruneConfirmedOverrides(payload: RelayPushPayload): void {
  const now = Date.now();
  for (let i = _agentOverrides.length - 1; i >= 0; i--) {
    const o = _agentOverrides[i];
    // Expired — remove regardless
    if (o.expiresAt < now) { _agentOverrides.splice(i, 1); continue; }
    // Check if relay data now matches the override
    const queue = payload.queues.find(q => q.number === o.queueNumber);
    if (queue) {
      const agent = queue.agents.find(a => a.ext === o.ext);
      if (agent && agent.loggedIn === o.loggedIn) {
        // Relay confirmed the change — override no longer needed
        _agentOverrides.splice(i, 1);
      }
    }
  }
}
