/**
 * Queue Monitor — detects when calls are waiting in monitored queues
 * and triggers paging. Uses a simple queue-level timer:
 *
 *   Queue goes 0→1+ calls:  start timer
 *   Timer hits threshold:   PAGE (first)
 *   Repeat interval:        PAGE again (while calls > 0)
 *   Queue goes back to 0:   stop timer, reset
 *
 * Does NOT track individual calls or their wait times.
 */

import { EventEmitter } from 'events';
import { ThreecxClient, ThreecxActiveCall } from './threecx-client';
import {
  getMonitoredQueues,
  getSetting,
  MonitoredQueue,
  WavFile,
  getDb,
} from './db';
import { isRelayFresh, getRelayData, onRelayPush, offRelayPush, type RelayPushPayload } from './relay-receiver';

export interface PageEvent {
  queueNumber: string;
  queueName: string;
  callsWaiting: number;
  longestWaitSeconds: number; // seconds since queue went from 0→1+
  wavFile: WavFile | null;
  pagingExtension: string;
  playCount: number;
}

/** Per-queue state: tracks when calls first appeared and when we last paged. */
interface QueueState {
  callsWaitingSince: number; // Date.now() when queue went from 0→1+
  lastPagedAt: number;       // Date.now() of last page emission (0 = never paged)
  callsWaiting: number;      // current count
}

export class QueueMonitor extends EventEmitter {
  private client: ThreecxClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queueState = new Map<string, QueueState>();
  private running = false;
  private pollCount = 0;
  private _lastRelayMode = false;
  private _relayHandler: ((payload: RelayPushPayload) => void) | null = null;
  private _relayPollInProgress = false;

  constructor(client: ThreecxClient) {
    super();
    this.client = client;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = parseInt(getSetting('poll_interval_ms') || '5000', 10);
    console.log(`[QueueMonitor] Starting — poll every ${intervalMs}ms`);

    // Subscribe to relay pushes for real-time evaluation
    this._relayHandler = () => {
      if (!this.running || this._relayPollInProgress) return;
      const relayEnabled = getSetting('relay_enabled') === 'true';
      if (!relayEnabled || !isRelayFresh()) return;
      this._relayPollInProgress = true;
      this.poll()
        .catch((err) => console.error('[QueueMonitor] Relay-triggered poll error:', err))
        .finally(() => { this._relayPollInProgress = false; });
    };
    onRelayPush(this._relayHandler);

    // Run immediately, then on interval (fallback for polling mode)
    this.poll().catch((err) =>
      console.error('[QueueMonitor] Initial poll error:', err),
    );
    this.timer = setInterval(() => {
      this.poll().catch((err) =>
        console.error('[QueueMonitor] Poll error:', err),
      );
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._relayHandler) {
      offRelayPush(this._relayHandler);
      this._relayHandler = null;
    }
    this.queueState.clear();
    console.log('[QueueMonitor] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Get current status of monitored queues for the UI. */
  getStatus(): {
    queues: { queueNumber: string; callsWaiting: number; waitingSince: number }[];
  } {
    const now = Date.now();
    const queues = Array.from(this.queueState.entries()).map(([queueNumber, state]) => ({
      queueNumber,
      callsWaiting: state.callsWaiting,
      waitingSince: Math.round((now - state.callsWaitingSince) / 1000),
    }));
    return { queues };
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    this.pollCount++;

    const monitoredQueues = getMonitoredQueues().filter((q) => q.enabled && q.paging_extension);
    if (monitoredQueues.length === 0) {
      if (this.pollCount % 12 === 1) {
        console.log('[QueueMonitor] No enabled queues with paging extension configured — skipping');
      }
      return;
    }

    const queueMap = new Map<string, MonitoredQueue>();
    for (const q of monitoredQueues) {
      queueMap.set(q.queue_number, q);
    }

    // ── Relay mode check: use relay data if available and fresh ──
    const relayEnabled = getSetting('relay_enabled') === 'true';
    const relayFresh = relayEnabled && isRelayFresh();

    if (relayFresh !== this._lastRelayMode) {
      this._lastRelayMode = relayFresh;
      console.log(
        relayFresh
          ? '[QueueMonitor] Switched to RELAY mode — using relay agent data'
          : '[QueueMonitor] Fell back to POLLING mode',
      );
    }

    const now = Date.now();
    // queueNumber → calls waiting count
    const callCounts = new Map<string, number>();

    if (relayFresh) {
      // ── Relay mode: get call counts from relay payload ──
      const relayData = getRelayData();
      if (relayData) {
        for (const rq of relayData.queues) {
          if (!queueMap.has(rq.number)) continue;
          callCounts.set(rq.number, rq.callsWaiting);
        }

        if (this.pollCount % 12 === 1) {
          const totalWaiting = Array.from(callCounts.values()).reduce((s, c) => s + c, 0);
          console.log(
            `[QueueMonitor] Relay poll #${this.pollCount} — ${relayData.queues.length} queues, ${totalWaiting} total waiting`,
          );
        }
      }
    } else {
      // ── Polling mode: count calls per queue from PBX API ──
      let activeCalls: ThreecxActiveCall[];
      try {
        activeCalls = await this.client.getActiveCalls();
      } catch (err) {
        console.error('[QueueMonitor] Failed to fetch active calls:', err);
        return;
      }

      if (this.pollCount % 12 === 1) {
        console.log(
          `[QueueMonitor] Poll #${this.pollCount} — ${activeCalls.length} active call(s), ` +
          `monitoring queues: [${Array.from(queueMap.keys()).join(', ')}]`,
        );
      }

      for (const call of activeCalls) {
        const queueNumber = this.findQueueForCall(call, queueMap);
        if (!queueNumber) continue;
        if (this.isCallConnected(call, queueMap)) continue;
        callCounts.set(queueNumber, (callCounts.get(queueNumber) || 0) + 1);
      }
    }

    // ── Evaluate each monitored queue ──
    for (const [queueNumber, queue] of queueMap) {
      const callsWaiting = callCounts.get(queueNumber) || 0;
      const state = this.queueState.get(queueNumber);

      if (callsWaiting === 0) {
        // Queue is empty — reset state
        if (state) {
          console.log(
            `[QueueMonitor] Queue ${queue.queue_name} (${queueNumber}): back to 0 — timer reset`,
          );
          this.queueState.delete(queueNumber);
        }
        continue;
      }

      // Calls are waiting
      if (!state) {
        // Queue just went from 0→1+ — start timer
        console.log(
          `[QueueMonitor] Queue ${queue.queue_name} (${queueNumber}): ${callsWaiting} waiting — timer started`,
        );
        this.queueState.set(queueNumber, {
          callsWaitingSince: now,
          lastPagedAt: 0,
          callsWaiting,
        });
        continue; // Don't page yet — timer just started
      }

      // Update current count
      state.callsWaiting = callsWaiting;

      const waitingSec = (now - state.callsWaitingSince) / 1000;

      // Check if we've waited long enough for initial page
      if (waitingSec < queue.threshold_seconds) {
        continue; // Not time yet
      }

      // Threshold met — check if we should page
      if (state.lastPagedAt === 0) {
        // First page
        this.triggerPage(queue, callsWaiting, waitingSec, state, now, 'FIRST');
        continue;
      }

      // Check repeat interval
      const repeatInterval = queue.repeat_interval_seconds || 0;
      if (repeatInterval <= 0) continue; // No repeat configured

      const secsSinceLastPage = (now - state.lastPagedAt) / 1000;
      if (secsSinceLastPage >= repeatInterval) {
        this.triggerPage(queue, callsWaiting, waitingSec, state, now, 'REPEAT');
      }
    }
  }

  private triggerPage(
    queue: MonitoredQueue,
    callsWaiting: number,
    waitingSec: number,
    state: QueueState,
    now: number,
    type: 'FIRST' | 'REPEAT',
  ): void {
    const wavFile = queue.wav_file_id ? this.getWavFile(queue.wav_file_id) : null;

    const event: PageEvent = {
      queueNumber: queue.queue_number,
      queueName: queue.queue_name,
      callsWaiting,
      longestWaitSeconds: Math.round(waitingSec),
      wavFile,
      pagingExtension: queue.paging_extension!,
      playCount: queue.play_count || 1,
    };

    console.log(
      `[QueueMonitor] >>> PAGE — queue ${queue.queue_name} (${queue.queue_number}), ` +
      `${callsWaiting} calls waiting, timer at ${Math.round(waitingSec)}s — ${type} page`,
    );

    state.lastPagedAt = now;
    this.emit('page', event);
  }

  /**
   * Check if a call is waiting in one of the monitored queues.
   * Returns the queue number if found, null otherwise.
   */
  private findQueueForCall(
    call: ThreecxActiveCall,
    queueMap: Map<string, MonitoredQueue>,
  ): string | null {
    if (queueMap.has(call.Callee)) return call.Callee;

    for (const queueNumber of queueMap.keys()) {
      if (call.Callee?.startsWith(queueNumber + ' ')) return queueNumber;
    }

    if (call.Segments) {
      for (const seg of call.Segments) {
        if (seg.DialedDn && queueMap.has(seg.DialedDn)) return seg.DialedDn;
        if (seg.CalleeNumber && queueMap.has(seg.CalleeNumber)) return seg.CalleeNumber;
        if (seg.Dn && queueMap.has(seg.Dn)) return seg.Dn;
      }
    }

    return null;
  }

  /**
   * Check if a call has been answered/connected to an agent.
   * "Talking" to a queue number means hold music — NOT answered.
   */
  private isCallConnected(call: ThreecxActiveCall, queueMap: Map<string, MonitoredQueue>): boolean {
    const status = call.Status?.toLowerCase() || '';

    if (status === 'talking' || status === 'connected') {
      const calleeExt = call.Callee?.split(' ')[0] ?? '';
      if (queueMap.has(calleeExt)) return false;
      if (queueMap.has(call.Callee)) return false;
      return true;
    }

    if (call.Segments) {
      for (const seg of call.Segments) {
        const segStatus = seg.Status?.toLowerCase() || '';
        if (segStatus === 'talking' || segStatus === 'connected') return true;
      }
    }

    return false;
  }

  /** Get WAV file info from DB. */
  private getWavFile(id: number): WavFile | null {
    try {
      return getDb()
        .prepare('SELECT * FROM wav_files WHERE id = ?')
        .get(id) as WavFile | null;
    } catch {
      return null;
    }
  }
}
