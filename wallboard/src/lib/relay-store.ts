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
