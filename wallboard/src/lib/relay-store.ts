import { EventEmitter } from 'events';
import type { RelayPushPayload } from '@/types/relay';

/**
 * In-memory store for relay agent state.
 *
 * Two modes of operation:
 * 1. WebSocket (preferred): relay-ws-server calls setRelayConnected/setRelayDisconnected
 *    and setRelayData on each message. Connection state is authoritative.
 * 2. HTTP fallback: /api/relay/push calls setRelayData. Freshness is time-based.
 *
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
let _wsConnected = false; // true when relay agent has an active WebSocket

const STALE_MS = 15_000; // fallback: 15s without data = offline (HTTP mode only)

// ─── Connection lifecycle (called by relay-ws-server) ────────────────────

/** Mark relay agent as connected via WebSocket. */
export function setRelayConnected(ip: string): void {
  _wsConnected = true;
  _relayIp = ip;
}

/** Mark relay agent as disconnected. Clears connection flag but keeps last data. */
export function setRelayDisconnected(): void {
  _wsConnected = false;
}

// ─── Data updates (called by WS server or HTTP endpoint) ─────────────────

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
 * - WebSocket mode: returns true if WS is connected (instant disconnect detection).
 * - HTTP fallback: returns true if last push was within maxAgeMs.
 */
export function isRelayFresh(maxAgeMs: number = STALE_MS): boolean {
  // WebSocket connection is authoritative
  if (_wsConnected) return true;
  // HTTP fallback: time-based freshness
  if (!_data || _receivedAt === 0) return false;
  return Date.now() - _receivedAt < maxAgeMs;
}

/** Is the relay connected via WebSocket? */
export function isRelayWsConnected(): boolean {
  return _wsConnected;
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
