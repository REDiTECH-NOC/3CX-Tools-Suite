"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateManager = void 0;
const events_1 = require("events");
// ─── Fingerprinting for change detection ─────────────────────────────────
function fingerprintQueue(q) {
    const agentPart = q.agents
        .map(a => `${a.ext}:${a.loggedIn ? '1' : '0'}:${a.callState}`)
        .join(',');
    const callPart = q.queuedCalls
        .map(c => `${c.id}:${Math.round(c.waitSec)}`)
        .join(',');
    return `${q.callsWaiting}|${Math.round(q.longestWaitSec)}|${agentPart}|${callPart}`;
}
function fingerprintState(queues) {
    return queues.map(q => `${q.number}=${fingerprintQueue(q)}`).join(';');
}
// ─── State Manager ───────────────────────────────────────────────────────
class StateManager extends events_1.EventEmitter {
    lastFingerprint = '';
    lastFullSyncTime = 0;
    lastPayload = null;
    _reportStats = undefined;
    /** Full reconciliation interval — push full state even if "unchanged" as safety net. */
    FULL_SYNC_INTERVAL_MS = 5_000;
    /** Update cached report stats (called from the slow report loop). */
    setReportStats(stats) {
        this._reportStats = stats;
    }
    /**
     * Update the state with new queue data.
     * Emits 'change' only if something actually changed,
     * or if enough time has passed for a full sync.
     */
    update(queues) {
        const now = Date.now();
        const fp = fingerprintState(queues);
        const changed = fp !== this.lastFingerprint;
        const fullSyncDue = now - this.lastFullSyncTime >= this.FULL_SYNC_INTERVAL_MS;
        if (!changed && !fullSyncDue)
            return;
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
    getLastPayload() {
        return this.lastPayload;
    }
}
exports.StateManager = StateManager;
