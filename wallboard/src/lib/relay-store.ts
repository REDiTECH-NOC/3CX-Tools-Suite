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
    if (o.expiresAt < now) { _agentOverrides.splice(i, 1); continue; }
    const queue = payload.queues.find(q => q.number === o.queueNumber);
    if (queue) {
      const agent = queue.agents.find(a => a.ext === o.ext);
      if (agent && agent.loggedIn === o.loggedIn) {
        _agentOverrides.splice(i, 1);
      }
    }
  }
  // Prune membership overrides
  for (let i = _membershipOverrides.length - 1; i >= 0; i--) {
    const o = _membershipOverrides[i];
    if (o.expiresAt < now) { _membershipOverrides.splice(i, 1); continue; }
    const queue = payload.queues.find(q => q.number === o.queueNumber);
    if (queue) {
      const inList = queue.agents.some(a => a.ext === o.ext);
      if (inList === o.present) {
        // Relay confirmed the membership change
        _membershipOverrides.splice(i, 1);
      }
    }
  }
}

// ─── Membership overrides (add/remove agent from queue) ─────────────────

interface MembershipOverride {
  queueNumber: string;
  ext: string;
  present: boolean; // true = should appear in queue, false = should not
  expiresAt: number;
}

const _membershipOverrides: MembershipOverride[] = [];

/**
 * Optimistic override for agent membership (add/remove from queue).
 * The relay polls membership every 10s — this provides instant UI feedback.
 */
export function setMembershipOverride(queueNumber: string, ext: string, present: boolean): void {
  const idx = _membershipOverrides.findIndex(o => o.queueNumber === queueNumber && o.ext === ext);
  if (idx >= 0) _membershipOverrides.splice(idx, 1);
  _membershipOverrides.push({ queueNumber, ext, present, expiresAt: Date.now() + 20_000 });
}

/**
 * Get membership override for an agent, or undefined if none.
 */
export function getMembershipOverride(queueNumber: string, ext: string): boolean | undefined {
  const now = Date.now();
  for (let i = _membershipOverrides.length - 1; i >= 0; i--) {
    if (_membershipOverrides[i].expiresAt < now) _membershipOverrides.splice(i, 1);
  }
  const o = _membershipOverrides.find(o => o.queueNumber === queueNumber && o.ext === ext);
  return o?.present;
}

/**
 * Get all membership overrides that ADD agents to a specific queue.
 * Used by the poller to inject agents not yet in relay data.
 */
export function getAddedMembershipOverrides(queueNumber: string): { ext: string }[] {
  const now = Date.now();
  return _membershipOverrides.filter(o =>
    o.queueNumber === queueNumber && o.present && o.expiresAt > now
  ).map(o => ({ ext: o.ext }));
}
