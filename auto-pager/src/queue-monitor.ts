/**
 * Queue Monitor — polls 3CX ActiveCalls and detects queue conditions
 * that warrant paging. Evaluates per-queue thresholds (max wait time,
 * min calls waiting) and repeats pages at a configurable frequency
 * until the queue drops below the calls threshold.
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
import { isRelayFresh, getRelayData, type RelayQueueData } from './relay-receiver';

export interface PageEvent {
  queueNumber: string;
  queueName: string;
  callsWaiting: number;
  longestWaitSeconds: number;
  wavFile: WavFile | null;
  pagingExtension: string;
  playCount: number;
}

interface TrackedCall {
  callId: number;
  queueNumber: string;
  callerNumber: string;
  firstSeen: number; // Date.now()
}

/** Per-queue paging state — tracks when we last paged (in memory, not just DB). */
interface QueuePagingState {
  lastPagedAt: number; // Date.now() of last page emission
}

export class QueueMonitor extends EventEmitter {
  private client: ThreecxClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trackedCalls = new Map<number, TrackedCall>();
  private queuePagingState = new Map<string, QueuePagingState>();
  private running = false;
  private pollCount = 0;
  private _lastRelayMode = false;

  constructor(client: ThreecxClient) {
    super();
    this.client = client;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = parseInt(getSetting('poll_interval_ms') || '5000', 10);
    console.log(`[QueueMonitor] Starting — poll every ${intervalMs}ms`);

    // Run immediately, then on interval
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
    this.trackedCalls.clear();
    this.queuePagingState.clear();
    console.log('[QueueMonitor] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Get current status of tracked calls waiting in queues. */
  getStatus(): {
    trackedCalls: { callId: number; queueNumber: string; callerNumber: string; waitSeconds: number }[];
  } {
    const now = Date.now();
    const calls = Array.from(this.trackedCalls.values()).map((tc) => ({
      callId: tc.callId,
      queueNumber: tc.queueNumber,
      callerNumber: tc.callerNumber,
      waitSeconds: Math.round((now - tc.firstSeen) / 1000),
    }));
    return { trackedCalls: calls };
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
    const queueStats = new Map<string, { waitingCount: number; longestWaitSec: number }>();

    if (relayFresh) {
      // ── Relay mode: build stats from relay payload ──
      const relayData = getRelayData();
      if (relayData) {
        for (const rq of relayData.queues) {
          if (!queueMap.has(rq.number)) continue;
          queueStats.set(rq.number, {
            waitingCount: rq.callsWaiting,
            longestWaitSec: rq.longestWaitSec,
          });

          // Update tracked calls from relay's queued calls (for getStatus())
          for (const rc of rq.queuedCalls) {
            if (!this.trackedCalls.has(rc.id)) {
              this.trackedCalls.set(rc.id, {
                callId: rc.id,
                queueNumber: rq.number,
                callerNumber: rc.caller,
                firstSeen: now - (rc.waitSec * 1000),
              });
            }
          }
          // Remove tracked calls that are no longer in relay data for this queue
          const relayCallIds = new Set(rq.queuedCalls.map(c => c.id));
          for (const [callId, tc] of this.trackedCalls) {
            if (tc.queueNumber === rq.number && !relayCallIds.has(callId)) {
              this.trackedCalls.delete(callId);
            }
          }
        }

        if (this.pollCount % 12 === 1) {
          const totalWaiting = Array.from(queueStats.values()).reduce((s, q) => s + q.waitingCount, 0);
          console.log(
            `[QueueMonitor] Relay poll #${this.pollCount} — ${relayData.queues.length} queues, ${totalWaiting} total waiting`,
          );
        }
      }
    } else {
      // ── Polling mode: fetch from PBX API ──
      let activeCalls: ThreecxActiveCall[];
      try {
        activeCalls = await this.client.getActiveCalls();
      } catch (err) {
        console.error('[QueueMonitor] Failed to fetch active calls:', err);
        return;
      }

      // Debug: log every 12th poll (~60s) or whenever there are active calls
      const shouldLog = activeCalls.length > 0 || this.pollCount % 12 === 1;
      if (shouldLog) {
        console.log(
          `[QueueMonitor] Poll #${this.pollCount} — ${activeCalls.length} active call(s), ` +
          `monitoring queues: [${Array.from(queueMap.keys()).join(', ')}]`,
        );
      }

      // Debug: dump active calls
      if (activeCalls.length > 0) {
        if (this.pollCount <= 3 || this.pollCount % 60 === 1) {
          console.log(`[QueueMonitor] RAW ActiveCall[0]: ${JSON.stringify(activeCalls[0], null, 2)}`);
        }
        for (const call of activeCalls) {
          const segInfo = call.Segments
            ? call.Segments.map((s) =>
              `{Dn:${s.Dn},DialedDn:${s.DialedDn},CalleeNum:${s.CalleeNumber},Status:${s.Status}}`
            ).join(', ')
            : 'none';
          console.log(
            `[QueueMonitor]   Call #${call.Id}: Caller=${call.Caller}, Callee=${call.Callee}, ` +
            `Status=${call.Status}, Segments=[${segInfo}]`,
          );
        }
      }

      const seenCallIds = new Set<number>();

      for (const call of activeCalls) {
        const queueNumber = this.findQueueForCall(call, queueMap);
        if (!queueNumber) continue;

        // Skip connected calls — only count those still waiting
        if (this.isCallConnected(call)) continue;

        seenCallIds.add(call.Id);

        // Track when we first saw this call
        let tracked = this.trackedCalls.get(call.Id);
        if (!tracked) {
          tracked = {
            callId: call.Id,
            queueNumber,
            callerNumber: call.Caller,
            firstSeen: now,
          };
          this.trackedCalls.set(call.Id, tracked);
        }

        const waitSec = (now - tracked.firstSeen) / 1000;

        // Accumulate per-queue stats
        const stats = queueStats.get(queueNumber) || { waitingCount: 0, longestWaitSec: 0 };
        stats.waitingCount++;
        stats.longestWaitSec = Math.max(stats.longestWaitSec, waitSec);
        queueStats.set(queueNumber, stats);
      }

      // Clean up calls that are no longer active
      for (const [callId] of this.trackedCalls) {
        if (!seenCallIds.has(callId)) {
          this.trackedCalls.delete(callId);
        }
      }
    }

    // ── Evaluate each monitored queue for paging ──
    for (const [queueNumber, queue] of queueMap) {
      const stats = queueStats.get(queueNumber);
      const waitingCount = stats?.waitingCount || 0;
      const longestWaitSec = stats?.longestWaitSec || 0;
      const minCalls = queue.min_calls || 1;

      // Log queue state when there are calls
      if (waitingCount > 0) {
        console.log(
          `[QueueMonitor] Queue ${queue.queue_name} (${queueNumber}): ` +
          `${waitingCount} waiting, longest ${Math.round(longestWaitSec)}s — ` +
          `thresholds: ${queue.threshold_seconds}s wait, ${minCalls} calls`,
        );
      }

      // Check if both conditions are met
      const waitMet = longestWaitSec >= queue.threshold_seconds;
      const callsMet = waitingCount >= minCalls;

      if (!waitMet || !callsMet) {
        // If queue drops below min_calls threshold, clear its paging state
        // so the next breach starts fresh
        if (!callsMet && this.queuePagingState.has(queueNumber)) {
          console.log(
            `[QueueMonitor] Queue ${queueNumber} dropped below min calls (${waitingCount}/${minCalls}) — resetting page state`,
          );
          this.queuePagingState.delete(queueNumber);
        }
        continue;
      }

      // Both conditions met — check if we should page (first time or repeat interval)
      const pagingState = this.queuePagingState.get(queueNumber);
      const repeatInterval = queue.repeat_interval_seconds || 0;

      if (pagingState) {
        // Already paged before — check repeat interval
        if (repeatInterval <= 0) {
          // No repeat — already paged once, skip
          continue;
        }
        const secsSinceLastPage = (now - pagingState.lastPagedAt) / 1000;
        if (secsSinceLastPage < repeatInterval) {
          // Not time to repeat yet
          continue;
        }
        console.log(
          `[QueueMonitor] Queue ${queueNumber} — repeat interval reached (${Math.round(secsSinceLastPage)}s >= ${repeatInterval}s)`,
        );
      }

      // ── Trigger page ──
      const wavFile = queue.wav_file_id ? this.getWavFile(queue.wav_file_id) : null;

      const event: PageEvent = {
        queueNumber: queue.queue_number,
        queueName: queue.queue_name,
        callsWaiting: waitingCount,
        longestWaitSeconds: Math.round(longestWaitSec),
        wavFile,
        pagingExtension: queue.paging_extension!,
        playCount: queue.play_count || 1,
      };

      console.log(
        `[QueueMonitor] >>> PAGE — queue ${queue.queue_name} (${queueNumber}), ` +
        `${waitingCount} calls waiting, longest ${Math.round(longestWaitSec)}s — ` +
        `${pagingState ? 'REPEAT' : 'FIRST'} page`,
      );

      // Update in-memory paging state
      this.queuePagingState.set(queueNumber, { lastPagedAt: now });

      this.emit('page', event);
    }
  }

  /**
   * Check if a call is waiting in one of the monitored queues.
   * Returns the queue number if found, null otherwise.
   */
  private findQueueForCall(
    call: ThreecxActiveCall,
    queueMap: Map<string, MonitoredQueue>,
  ): string | null {
    // Check if the Callee matches a queue number directly
    if (queueMap.has(call.Callee)) return call.Callee;

    // 3CX returns Callee as "8003 Queue 1" — check if it starts with a queue number
    for (const queueNumber of queueMap.keys()) {
      if (call.Callee?.startsWith(queueNumber + ' ')) return queueNumber;
    }

    // Check segments for queue numbers
    if (call.Segments) {
      for (const seg of call.Segments) {
        if (seg.DialedDn && queueMap.has(seg.DialedDn)) return seg.DialedDn;
        if (seg.CalleeNumber && queueMap.has(seg.CalleeNumber)) return seg.CalleeNumber;
        if (seg.Dn && queueMap.has(seg.Dn)) return seg.Dn;
      }
    }

    return null;
  }

  /** Check if a call has been answered/connected to an agent. */
  private isCallConnected(call: ThreecxActiveCall): boolean {
    // Do NOT use EstablishedAt — 3CX sets it when the call enters the queue,
    // not when an agent answers. Use Status instead.
    const status = call.Status?.toLowerCase() || '';

    // "Talking" or "Connected" means an agent has answered
    if (status === 'talking' || status === 'connected') return true;

    // "Rerouting", "Ringing", "Dialing", "Queued" = still waiting
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
