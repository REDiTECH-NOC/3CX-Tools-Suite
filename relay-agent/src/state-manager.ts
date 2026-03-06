/**
 * State Manager — tracks current queue state and detects changes.
 *
 * Merges data from:
 * 1. REST API (ActiveCalls) — polled every 750ms (fast loop)
 * 2. REST API (Users, Queues, QueueAgents) — polled every 10s/60s/3min (slow loop)
 * 3. Report API (queue stats) — polled every 30s
 * 4. WebSocket monitor (QueuesInfo) — event-driven agent login status
 *
 * Only emits when state actually changes (new calls, answered calls,
 * agent status changes). Full state reconciliation every 5s as safety net.
 */

import { EventEmitter } from 'events';

// ─── Types (mirrors RelayPushPayload on wallboard side) ────────────────

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

/** Report API stats collected locally by the relay agent. */
export interface RelayReportStats {
  queueNumber: string;
  callsCount: number;
  answeredCount: number;
  avgRingTime: string;   // ISO 8601 duration
  avgTalkTime: string;   // ISO 8601 duration
  ringTime: string;      // ISO 8601 total ring time
  talkTime: string;      // ISO 8601 total talk time
}

export interface RelayPushPayload {
  version: 1;
  ts: number;
  queues: RelayQueueData[];
  /** Report API stats collected locally (windowed + full-day). Absent if not yet fetched. */
  reportStats?: {
    windowedStats: RelayReportStats[];
    fullDayStats: RelayReportStats[];
    windowMinutes: number;
    pbxTimezone: string;
  };
}

// ─── Fingerprinting for change detection ─────────────────────────────────

function fingerprintQueue(q: RelayQueueData): string {
  const agentPart = q.agents
    .map(a => `${a.ext}:${a.loggedIn ? '1' : '0'}:${a.callState}`)
    .join(',');
  const callPart = q.queuedCalls
    .map(c => `${c.id}:${Math.round(c.waitSec)}`)
    .join(',');
  return `${q.callsWaiting}|${Math.round(q.longestWaitSec)}|${agentPart}|${callPart}`;
}

function fingerprintState(queues: RelayQueueData[]): string {
  return queues.map(q => `${q.number}=${fingerprintQueue(q)}`).join(';');
}

// ─── State Manager ───────────────────────────────────────────────────────

export class StateManager extends EventEmitter {
  private lastFingerprint = '';
  private lastFullSyncTime = 0;
  private lastPayload: RelayPushPayload | null = null;
  private _reportStats: RelayPushPayload['reportStats'] = undefined;

  /** Full reconciliation interval — push full state even if "unchanged" as safety net. */
  private readonly FULL_SYNC_INTERVAL_MS = 5_000;

  /** Update cached report stats (called from the slow report loop). */
  setReportStats(stats: RelayPushPayload['reportStats']): void {
    this._reportStats = stats;
  }

  /**
   * Update the state with new queue data.
   * Emits 'change' only if something actually changed,
   * or if enough time has passed for a full sync.
   */
  update(queues: RelayQueueData[]): void {
    const now = Date.now();
    const fp = fingerprintState(queues);
    const changed = fp !== this.lastFingerprint;
    const fullSyncDue = now - this.lastFullSyncTime >= this.FULL_SYNC_INTERVAL_MS;

    if (!changed && !fullSyncDue) return;

    this.lastFingerprint = fp;
    this.lastPayload = {
      version: 1,
      ts: now,
      queues,
      reportStats: this._reportStats,
    };

    if (changed) {
      this.emit('change', this.lastPayload);
    }

    if (fullSyncDue) {
      this.lastFullSyncTime = now;
      this.emit('sync', this.lastPayload);
    }
  }

  /** Get the latest payload (for initial sync on connect). */
  getLastPayload(): RelayPushPayload | null {
    return this.lastPayload;
  }
}
