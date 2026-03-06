/**
 * Relay Receiver — accepts push data from the 3CX Relay Agent.
 *
 * Stores the latest relay payload in memory. The QueueMonitor
 * checks this data before falling back to its own PBX polling.
 */

import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { getSetting, setSetting } from './db';

// ─── Event emitter for real-time relay push notifications ────
const _emitter = new EventEmitter();
_emitter.setMaxListeners(20);

/** Subscribe to relay data pushes. Fires immediately when new data arrives. */
export function onRelayPush(callback: (payload: RelayPushPayload) => void): void {
  _emitter.on('push', callback);
}

/** Unsubscribe from relay data pushes. */
export function offRelayPush(callback: (payload: RelayPushPayload) => void): void {
  _emitter.off('push', callback);
}

// ─── Types (matches relay-agent payload) ─────────────────────

export interface RelayReportStats {
  queueNumber: string;
  callsCount: number;
  answeredCount: number;
  avgRingTime: string;   // ISO 8601 duration e.g. "PT30.7S"
  avgTalkTime: string;   // ISO 8601 duration
  ringTime: string;      // ISO 8601 total ring time
  talkTime: string;      // ISO 8601 total talk time
}

export interface RelayPushPayload {
  version: 1;
  ts: number;
  queues: RelayQueueData[];
  /** Report API stats collected locally by the relay agent. Absent if not yet fetched. */
  reportStats?: {
    windowedStats: RelayReportStats[];
    fullDayStats: RelayReportStats[];
    windowMinutes: number;
    pbxTimezone: string;
  };
}

export interface RelayQueueData {
  id: number;
  number: string;
  name: string;
  callsWaiting: number;
  longestWaitSec: number;
  agents: RelayAgentData[];
  queuedCalls: RelayQueuedCall[];
}

export interface RelayAgentData {
  ext: string;
  name: string;
  loggedIn: boolean;
  callState: 'available' | 'talking' | 'ringing' | 'offline';
  profileName: string;
  isRegistered: boolean;
}

export interface RelayQueuedCall {
  id: number;
  caller: string;
  callerName: string;
  waitSec: number;
  startedAt: string;
}

// ─── In-memory store ─────────────────────────────────────────

let _data: RelayPushPayload | null = null;
let _receivedAt = 0;
let _relayIp: string | null = null;

/** Max age in ms before relay data is considered stale (default 15s). */
const DEFAULT_STALE_MS = 15_000;

export function setRelayData(payload: RelayPushPayload, ip?: string): void {
  _data = payload;
  _receivedAt = Date.now();
  _relayIp = ip ?? null;
  _emitter.emit('push', payload);
}

export function getRelayData(): RelayPushPayload | null {
  return _data;
}

export function isRelayFresh(maxAgeMs: number = DEFAULT_STALE_MS): boolean {
  if (!_data || _receivedAt === 0) return false;
  return Date.now() - _receivedAt < maxAgeMs;
}

export function getRelayAge(): number {
  if (_receivedAt === 0) return Infinity;
  return Date.now() - _receivedAt;
}

export function getRelayStatus(): {
  enabled: boolean;
  hasFreshData: boolean;
  lastReceivedAt: number;
  ageMs: number;
  ip: string | null;
} {
  const enabled = getSetting('relay_enabled') === 'true';
  return {
    enabled,
    hasFreshData: isRelayFresh(),
    lastReceivedAt: _receivedAt,
    ageMs: getRelayAge(),
    ip: _relayIp,
  };
}

/**
 * Validate an incoming relay API key against the stored hash.
 * Returns true if the key is valid.
 */
export function validateRelayKey(apiKey: string): boolean {
  const storedHash = getSetting('relay_api_key_hash');
  if (!storedHash) return false;

  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  return keyHash === storedHash;
}

/**
 * Store a new relay API key hash.
 */
export function setRelayKeyHash(plainKey: string): void {
  const hash = createHash('sha256').update(plainKey).digest('hex');
  setSetting('relay_api_key_hash', hash);
}
