import { EventEmitter } from 'events';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { ThreecxClient } from '@/lib/threecx-client';
import { pruneOldSnapshots } from '@/lib/snapshot-pruning';
import { ThreecxQueueMonitor } from '@/lib/threecx-queue-monitor';
import { isRelayFresh, getRelayData, getRelayAge, onRelayData, offRelayData } from '@/lib/relay-store';
import type { RelayPushPayload } from '@/types/relay';
import type {
  ThreecxQueue,
  ThreecxActiveCall,
  ThreecxUser,
  ThreecxQueueAgent,
  ThreecxQueueManager,
  ThreecxQueueDetailedStats,
} from '@/types/threecx';
import type {
  WallboardState,
  QueueWallboardData,
  QueueAgentStatus,
  WallboardTotals,
} from '@/types/wallboard';

// ─── Constants ──────────────────────────────────────────────────────────────

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const GRACE_PERIOD_MS = 60 * 1000; // 60 seconds before stopping after last client disconnects
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_AVG_WAIT_WINDOW_MIN = 60;
const REPORT_API_INTERVAL_MS = 30_000; // Query Report API every 30s for authoritative stats
const MANAGER_FETCH_INTERVAL_MS = 60_000; // Fetch queue managers every 60s (rarely change)

/**
 * Get midnight (start of "today") in the PBX's local timezone as a UTC Date.
 * E.g., for America/Chicago at 7:10 PM CST on March 5:
 *   local date = "2026-03-05"
 *   noon UTC on March 5 = 6:00 AM CST → offset = 6 - 12 = -6
 *   midnight CST = 06:00 UTC → Date.UTC(2026, 2, 5, 6, 0, 0)
 */
function getMidnightInTimezone(tz: string, now: Date): Date {
  // Get today's date string in the PBX timezone
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // "YYYY-MM-DD"
  const [y, m, d] = dateStr.split('-').map(Number);

  // Use noon UTC to safely determine the offset (avoids DST edge cases at midnight)
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const localNoon = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(noonUtc);
  const localHour = parseInt(localNoon, 10);
  const offsetHours = localHour - 12; // negative = west of UTC

  // Midnight local = UTC midnight minus the offset
  return new Date(Date.UTC(y, m - 1, d, -offsetHours, 0, 0));
}

/** Parse ISO 8601 duration (e.g. "PT8M42S", "PT30.7S", "PT1M") to seconds. */
function parseIsoDuration(iso: string): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) +
         (parseInt(m[2] || '0', 10) * 60) +
         (parseFloat(m[3] || '0'));
}

// ─── Broadcast Hub ──────────────────────────────────────────────────────────

/**
 * Type-safe event emitter for wallboard state broadcasts.
 */
class WallboardBroadcastHub {
  private emitter = new EventEmitter();
  private clientCount = 0;

  constructor() {
    // Allow many SSE listeners without memory leak warnings
    this.emitter.setMaxListeners(500);
  }

  addClient(callback: (state: WallboardState) => void): void {
    this.emitter.on('wallboard', callback);
    this.clientCount++;
  }

  removeClient(callback: (state: WallboardState) => void): void {
    this.emitter.off('wallboard', callback);
    this.clientCount = Math.max(0, this.clientCount - 1);
  }

  emit(state: WallboardState): void {
    this.emitter.emit('wallboard', state);
  }

  getClientCount(): number {
    return this.clientCount;
  }
}

// ─── Visible Queue Info ─────────────────────────────────────────────────────

interface VisibleQueue {
  dbId: string;
  queueId: number;
  queueNumber: string;
  queueName: string;
  sortOrder: number;
}

// ─── ThreecxPoller ──────────────────────────────────────────────────────────

class ThreecxPoller {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private currentIntervalMs = DEFAULT_POLL_INTERVAL_MS; // track current interval to detect changes
  private graceTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false; // guards against overlapping polls
  private lastPruneTime = 0;
  private currentState: WallboardState | null = null;
  private client: ThreecxClient | null = null;
  private managerClient: ThreecxClient | null = null; // separate client for $expand=Managers (XAPI caches per-connection)
  private lastConfigHash = ''; // detect config changes
  private _lastReportWarnTime = 0; // throttle report warning logs
  private _lastManagerHash = ''; // only log managers when they change
  private queueMonitor: ThreecxQueueMonitor | null = null;
  private monitorConfigHash = '';
  private _lastReconcileTime = 0; // throttle WS↔DB reconciliation
  private _lastReportApiTime = 0; // throttle Report API queries
  private _lastManagerFetchTime = 0; // throttle manager queries (rarely change)
  private _cachedManagersByQueue = new Map<number, ThreecxQueueManager[]>(); // cached manager data
  private _reportApiStats = new Map<string, ThreecxQueueDetailedStats>(); // queueNumber → windowed report data
  private _fullDayReportApiStats = new Map<string, ThreecxQueueDetailedStats>(); // queueNumber → full-day report data
  private _todayMaxWait = new Map<string, number>(); // queueNumber → running max wait seen today
  private _todayMaxWaitDate = ''; // YYYY-MM-DD — resets at midnight
  private _reportFieldsLogged = false; // log Report API field structure once
  private _waitObservations = new Map<string, Array<{ ts: number; wait: number }>>(); // windowed peak tracking
  private _previousQueuedCalls = new Map<string, Map<number, { startStr: string; lastSeenServerMs: number }>>(); // call departure tracking
  private _lastRelayMode = false; // track mode transitions for logging
  private _relayDataHandler: (() => void) | null = null; // bound handler for relay EventEmitter
  private _relayPollDebounce: ReturnType<typeof setTimeout> | null = null;

  readonly hub = new WallboardBroadcastHub();

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Start the polling engine. Called when the first SSE client connects.
   * Safe to call multiple times -- idempotent.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Cancel any pending grace-period shutdown
    if (this.graceTimeoutHandle) {
      clearTimeout(this.graceTimeoutHandle);
      this.graceTimeoutHandle = null;
    }

    console.log('[ThreecxPoller] Starting polling engine');

    // Subscribe to relay data events — trigger immediate poll when relay pushes new data
    if (!this._relayDataHandler) {
      this._relayDataHandler = () => {
        // Debounce: relay may push rapidly; coalesce into one poll within 50ms
        if (this._relayPollDebounce) return;
        this._relayPollDebounce = setTimeout(() => {
          this._relayPollDebounce = null;
          if (this.running && !this.polling) {
            void this.poll();
          }
        }, 50);
      };
      onRelayData(this._relayDataHandler);
    }

    // Fire the first poll immediately, then schedule recurring
    void this.poll();
    this.scheduleInterval(DEFAULT_POLL_INTERVAL_MS);
  }

  /**
   * Stop the polling engine (after grace period). Called when last SSE client disconnects.
   */
  stopGraceful(): void {
    if (!this.running) return;

    // If there are still clients, don't stop
    if (this.hub.getClientCount() > 0) return;

    // Already waiting for grace period
    if (this.graceTimeoutHandle) return;

    console.log(`[ThreecxPoller] No clients remaining, starting ${GRACE_PERIOD_MS / 1000}s grace period`);

    this.graceTimeoutHandle = setTimeout(() => {
      this.graceTimeoutHandle = null;
      // Double-check no clients reconnected during grace period
      if (this.hub.getClientCount() === 0) {
        this.stop();
      }
    }, GRACE_PERIOD_MS);
  }

  /**
   * Immediately stop polling. Internal use.
   */
  private stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    // Unsubscribe from relay data events
    if (this._relayDataHandler) {
      offRelayData(this._relayDataHandler);
      this._relayDataHandler = null;
    }
    if (this._relayPollDebounce) {
      clearTimeout(this._relayPollDebounce);
      this._relayPollDebounce = null;
    }

    if (this.queueMonitor) {
      this.queueMonitor.stop();
    }

    console.log('[ThreecxPoller] Polling engine stopped');
  }

  /** Get the queue monitor instance (for use by queue-actions router). */
  getQueueMonitor(): ThreecxQueueMonitor | null {
    return this.queueMonitor;
  }

  /**
   * Get the last computed wallboard state for immediate delivery to new SSE clients.
   */
  getCurrentState(): WallboardState | null {
    return this.currentState;
  }

  /**
   * Whether the poller is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Trigger an immediate poll cycle (e.g. after a queue sign in/out action).
   * Also forces the queue monitor to reconnect for fresh per-queue data.
   * Skips poll if already in progress.
   */
  forcePoll(): void {
    if (!this.running) return;
    // Force a full monitor reconnect for fresh per-queue status
    if (this.queueMonitor) {
      this.queueMonitor.forceReconnect();
    }
    // Delay to let the monitor fully reconnect (REST login + session + WS + data)
    setTimeout(() => {
      if (!this.polling) {
        void this.poll();
      }
    }, 4000);
  }

  // ─── Interval Management ────────────────────────────────────────

  private scheduleInterval(ms: number): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
    this.intervalHandle = setInterval(() => {
      if (!this.polling) {
        void this.poll();
      }
    }, ms);
  }

  // ─── Poll Cycle ─────────────────────────────────────────────────

  /**
   * Execute a single poll cycle:
   *  1. Load config
   *  2. Fetch all data from 3CX
   *  3. Compute WallboardState
   *  4. Store snapshots
   *  5. Broadcast to SSE clients
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const pollStart = Date.now();

    try {
      // ── 1. Load SystemConfig ──────────────────────────────────
      const config = await prisma.systemConfig.findUnique({
        where: { id: 'singleton' },
      });

      if (!config || !config.setupComplete) {
        // No config yet, emit a connecting state and wait
        this.emitState({
          lastUpdated: new Date().toISOString(),
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          connectionStatus: 'connecting',
          dataMode: 'polling',
          queues: [],
          totals: emptyTotals(),
          avgWaitWindowMinutes: DEFAULT_AVG_WAIT_WINDOW_MIN,
        });
        return;
      }

      // Adjust interval if config changed
      if (config.pollIntervalMs !== this.currentIntervalMs && this.intervalHandle) {
        console.log(`[ThreecxPoller] Poll interval changed: ${this.currentIntervalMs}ms → ${config.pollIntervalMs}ms`);
        this.currentIntervalMs = config.pollIntervalMs;
        this.scheduleInterval(config.pollIntervalMs);
      }

      // ── 2. Create/Reuse ThreecxClient + QueueMonitor ────────────
      const configHash = `${config.pbxUrl}:${config.extensionNumber}:${config.encryptedPassword}`;
      if (!this.client || configHash !== this.lastConfigHash) {
        const password = decrypt(config.encryptedPassword);
        this.client = new ThreecxClient(config.pbxUrl, config.extensionNumber, password);
        this.managerClient = null; // force recreation with new credentials
        this._lastManagerFetchTime = 0; // force immediate manager fetch
        this.lastConfigHash = configHash;

        // Start (or restart) the queue monitor with new credentials
        if (this.queueMonitor) {
          this.queueMonitor.stop();
        }
        this.queueMonitor = new ThreecxQueueMonitor(config.pbxUrl, config.extensionNumber, password);
        this.monitorConfigHash = configHash;
        void this.queueMonitor.start();
      } else if (!this.queueMonitor || this.monitorConfigHash !== configHash) {
        // Monitor not started yet or config changed
        if (this.queueMonitor) {
          this.queueMonitor.stop();
        }
        const password = decrypt(config.encryptedPassword);
        this.queueMonitor = new ThreecxQueueMonitor(config.pbxUrl, config.extensionNumber, password);
        this.monitorConfigHash = configHash;
        void this.queueMonitor.start();
      }

      // ── 3. Load visible queues from DB ─────────────────────────
      const wallboardQueues = await prisma.wallboardQueue.findMany({
        where: { visible: true },
        orderBy: { sortOrder: 'asc' },
      });

      if (wallboardQueues.length === 0) {
        this.emitState({
          lastUpdated: new Date().toISOString(),
          pollIntervalMs: config.pollIntervalMs,
          connectionStatus: 'connected',
          dataMode: 'polling',
          queues: [],
          totals: emptyTotals(),
          avgWaitWindowMinutes: config.avgWaitWindowMinutes ?? DEFAULT_AVG_WAIT_WINDOW_MIN,
        });
        return;
      }

      const visibleQueues: VisibleQueue[] = wallboardQueues.map((q) => ({
        dbId: q.id,
        queueId: q.queueId,
        queueNumber: q.queueNumber,
        queueName: q.queueName,
        sortOrder: q.sortOrder,
      }));

      const visibleQueueIds = new Set(visibleQueues.map((q) => q.queueId));

      // ── 3b. Check for relay agent data ────────────────────────
      // If the relay agent is pushing fresh data, use it instead of polling
      // the PBX REST API directly. Still run Report API for day totals.
      const relayActive = isRelayFresh();
      const relayPayload = relayActive ? getRelayData() : null;

      if (relayActive && !this._lastRelayMode) {
        console.log(`[ThreecxPoller] Switched to RELAY mode (age=${Math.round(getRelayAge())}ms)`);
        this._lastRelayMode = true;
        // Stop our own QueueMonitor — the relay agent has its own local monitor.
        // Running both causes session conflicts on the shared PBX extension.
        if (this.queueMonitor) {
          console.log('[ThreecxPoller] Stopping local QueueMonitor (relay provides agent data)');
          this.queueMonitor.stop();
        }
      } else if (!relayActive && this._lastRelayMode) {
        console.log(`[ThreecxPoller] Relay stale (age=${Math.round(getRelayAge())}ms), falling back to POLLING mode`);
        this._lastRelayMode = false;
        // Restart our own QueueMonitor since relay is gone
        if (this.queueMonitor) {
          console.log('[ThreecxPoller] Restarting local QueueMonitor (relay disconnected)');
          void this.queueMonitor.start();
        }
      }

      // ── RELAY MODE: Use relay agent data instead of REST polling ──
      if (relayActive && relayPayload) {
        const now = new Date();
        const avgWaitWindowMinutes = config.avgWaitWindowMinutes ?? DEFAULT_AVG_WAIT_WINDOW_MIN;
        const pbxTz = (config as Record<string, unknown>).pbxTimezone as string ?? 'America/Chicago';

        // Midnight reset (same as polling mode)
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: pbxTz });
        if (this._todayMaxWaitDate !== todayStr) {
          this._todayMaxWait.clear();
          this._waitObservations.clear();
          this._todayMaxWaitDate = todayStr;
        }

        // Report API stats — prefer relay-provided stats (local collection),
        // fall back to remote Report API only if relay doesn't include them.
        if (relayPayload.reportStats) {
          // Use relay-collected report stats (no remote call needed)
          this._reportApiStats.clear();
          for (const rs of relayPayload.reportStats.windowedStats) {
            this._reportApiStats.set(rs.queueNumber, {
              QueueDnNumber: rs.queueNumber, QueueDn: rs.queueNumber,
              CallsCount: rs.callsCount, AnsweredCount: rs.answeredCount,
              RingTime: rs.ringTime, AvgRingTime: rs.avgRingTime,
              TalkTime: rs.talkTime, AvgTalkTime: rs.avgTalkTime, CallbacksCount: 0,
            });
          }
          this._fullDayReportApiStats.clear();
          for (const rs of relayPayload.reportStats.fullDayStats) {
            this._fullDayReportApiStats.set(rs.queueNumber, {
              QueueDnNumber: rs.queueNumber, QueueDn: rs.queueNumber,
              CallsCount: rs.callsCount, AnsweredCount: rs.answeredCount,
              RingTime: rs.ringTime, AvgRingTime: rs.avgRingTime,
              TalkTime: rs.talkTime, AvgTalkTime: rs.avgTalkTime, CallbacksCount: 0,
            });
          }

          // Persist daily summaries from relay-provided full-day stats
          if (now.getTime() - this._lastReportApiTime > REPORT_API_INTERVAL_MS) {
            this._lastReportApiTime = now.getTime();
            try {
              const todayDateStr = now.toLocaleDateString('en-CA', { timeZone: pbxTz });
              const [tdY, tdM, tdD] = todayDateStr.split('-').map(Number);
              const todayDate = new Date(Date.UTC(tdY, tdM - 1, tdD));
              for (const rs of relayPayload.reportStats.fullDayStats) {
                const vq = visibleQueues.find((q) => q.queueNumber === rs.queueNumber);
                if (!vq) continue;
                const answered = rs.answeredCount ?? 0;
                const abandoned = Math.max(0, (rs.callsCount ?? 0) - answered);
                const avgWaitSec = Math.round(parseIsoDuration(rs.avgRingTime) * 100) / 100;
                const avgTalkSec = Math.round(parseIsoDuration(rs.avgTalkTime) * 100) / 100;
                const runningMax = this._todayMaxWait.get(rs.queueNumber) ?? 0;
                const existing = await prisma.queueDailySummary.findUnique({
                  where: { queueId_date: { queueId: vq.queueId, date: todayDate } },
                  select: { maxWaitSec: true },
                });
                const bestMax = Math.max(runningMax, existing?.maxWaitSec ?? 0);
                if (bestMax > runningMax) this._todayMaxWait.set(rs.queueNumber, bestMax);
                await prisma.queueDailySummary.upsert({
                  where: { queueId_date: { queueId: vq.queueId, date: todayDate } },
                  update: { totalAnswered: answered, totalAbandoned: abandoned, totalOffered: rs.callsCount ?? 0, avgWaitSec, avgTalkSec, maxWaitSec: bestMax },
                  create: { queueId: vq.queueId, date: todayDate, totalAnswered: answered, totalAbandoned: abandoned, totalOffered: rs.callsCount ?? 0, avgWaitSec, avgTalkSec, maxWaitSec: bestMax },
                });
              }
            } catch (err) {
              if (!this._lastReportWarnTime || Date.now() - this._lastReportWarnTime > 60_000) {
                console.warn('[ThreecxPoller] Report stats persistence failed (non-fatal):', err instanceof Error ? err.message : String(err));
                this._lastReportWarnTime = Date.now();
              }
            }
          }
        } else if (this.client && now.getTime() - this._lastReportApiTime > REPORT_API_INTERVAL_MS) {
          // Fallback: relay doesn't provide report stats — query remotely
          this._lastReportApiTime = now.getTime();
          try {
            const dayStart = getMidnightInTimezone(pbxTz, now);
            const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
            const windowStart = new Date(now.getTime() - avgWaitWindowMinutes * 60 * 1000);

            const [windowedStats, fullDayStats] = await Promise.all([
              this.client.getQueueDetailedStats(windowStart.toISOString(), now.toISOString()),
              this.client.getQueueDetailedStats(dayStart.toISOString(), dayEnd.toISOString()),
            ]);

            this._reportApiStats.clear();
            for (const rs of windowedStats) this._reportApiStats.set(rs.QueueDnNumber, rs);
            this._fullDayReportApiStats.clear();
            for (const rs of fullDayStats) this._fullDayReportApiStats.set(rs.QueueDnNumber, rs);

            const todayDateStr = now.toLocaleDateString('en-CA', { timeZone: pbxTz });
            const [tdY, tdM, tdD] = todayDateStr.split('-').map(Number);
            const todayDate = new Date(Date.UTC(tdY, tdM - 1, tdD));
            for (const rs of fullDayStats) {
              const vq = visibleQueues.find((q) => q.queueNumber === rs.QueueDnNumber);
              if (!vq) continue;
              const answered = rs.AnsweredCount ?? 0;
              const abandoned = Math.max(0, (rs.CallsCount ?? 0) - answered);
              const avgWaitSec = Math.round(parseIsoDuration(rs.AvgRingTime) * 100) / 100;
              const avgTalkSec = Math.round(parseIsoDuration(rs.AvgTalkTime) * 100) / 100;
              const runningMax = this._todayMaxWait.get(rs.QueueDnNumber) ?? 0;
              const existing = await prisma.queueDailySummary.findUnique({
                where: { queueId_date: { queueId: vq.queueId, date: todayDate } },
                select: { maxWaitSec: true },
              });
              const bestMax = Math.max(runningMax, existing?.maxWaitSec ?? 0);
              if (bestMax > runningMax) this._todayMaxWait.set(rs.QueueDnNumber, bestMax);
              await prisma.queueDailySummary.upsert({
                where: { queueId_date: { queueId: vq.queueId, date: todayDate } },
                update: { totalAnswered: answered, totalAbandoned: abandoned, totalOffered: rs.CallsCount ?? 0, avgWaitSec, avgTalkSec, maxWaitSec: bestMax },
                create: { queueId: vq.queueId, date: todayDate, totalAnswered: answered, totalAbandoned: abandoned, totalOffered: rs.CallsCount ?? 0, avgWaitSec, avgTalkSec, maxWaitSec: bestMax },
              });
            }
          } catch (err) {
            if (!this._lastReportWarnTime || Date.now() - this._lastReportWarnTime > 60_000) {
              console.warn('[ThreecxPoller] Report API in relay mode failed (non-fatal):', err instanceof Error ? err.message : String(err));
              this._lastReportWarnTime = Date.now();
            }
          }
        }

        // Manager data — still fetch in relay mode (relay doesn't track managers)
        const needManagerFetchRelay = now.getTime() - this._lastManagerFetchTime > MANAGER_FETCH_INTERVAL_MS;
        if (needManagerFetchRelay && this.client) {
          this._lastManagerFetchTime = now.getTime();
          try {
            const password = decrypt(config.encryptedPassword);
            this.managerClient = new ThreecxClient(config.pbxUrl, config.extensionNumber, password);
            const managerResults = await Promise.all(
              visibleQueues.map((q) => this.managerClient!.getQueueWithManagers(q.queueId)),
            );
            this._cachedManagersByQueue.clear();
            for (let i = 0; i < visibleQueues.length; i++) {
              const expanded = managerResults[i] as { Managers?: ThreecxQueueManager[] };
              const managers = expanded?.Managers ?? [];
              this._cachedManagersByQueue.set(visibleQueues[i].queueId, managers);
            }
          } catch (err) {
            console.warn('[ThreecxPoller] Manager fetch in relay mode failed (non-fatal):', err instanceof Error ? err.message : String(err));
          }
        }

        // Build queue data from relay payload
        const relayQueueMap = new Map(relayPayload.queues.map((rq) => [rq.number, rq]));

        const queueDataList: QueueWallboardData[] = visibleQueues.map((vq) => {
          const rq = relayQueueMap.get(vq.queueNumber);
          const reportStats = this._reportApiStats.get(vq.queueNumber);
          const fullDayStats = this._fullDayReportApiStats.get(vq.queueNumber);

          if (!rq) {
            // Queue not in relay data — return empty
            return {
              queueId: vq.queueId, queueNumber: vq.queueNumber, queueName: vq.queueName,
              callsWaiting: 0, longestWaitSec: 0, agentsLoggedIn: 0, agentsTotal: 0,
              agentsTalking: 0, agentsAvailable: 0, callsAnswered: 0, callsAbandoned: 0,
              avgWaitSec: 0, totalAvgWaitSec: 0, abandonRate: 0, agents: [], managerExtensions: [],
            };
          }

          // Use relay's real-time data for live metrics
          const callsWaiting = rq.callsWaiting;
          const longestWaitSec = rq.longestWaitSec;

          // Update departure tracking with relay's more precise call data
          const prevCalls = this._previousQueuedCalls.get(vq.queueNumber) ?? new Map();
          const currentCallIds = new Set(rq.queuedCalls.map((c) => c.id));
          const nowMs = now.getTime();

          prevCalls.forEach((info, callId) => {
            if (!currentCallIds.has(callId)) {
              const startMs = new Date(info.startStr).getTime();
              if (!isNaN(startMs) && startMs > 0) {
                const estimatedEndMs = (info.lastSeenServerMs + nowMs) / 2;
                const waitSec = Math.max(0, Math.round((estimatedEndMs - startMs) / 1000));
                if (waitSec > 0) {
                  const prev = this._todayMaxWait.get(vq.queueNumber) ?? 0;
                  if (waitSec > prev) this._todayMaxWait.set(vq.queueNumber, waitSec);
                  const obs = this._waitObservations.get(vq.queueNumber) ?? [];
                  obs.push({ ts: nowMs, wait: waitSec });
                  this._waitObservations.set(vq.queueNumber, obs);
                }
              }
            }
          });

          // Update call tracking from relay's queued calls
          const newPrevCalls = new Map<number, { startStr: string; lastSeenServerMs: number }>();
          for (const call of rq.queuedCalls) {
            const existing = prevCalls.get(call.id);
            newPrevCalls.set(call.id, {
              startStr: existing?.startStr ?? call.startedAt,
              lastSeenServerMs: nowMs,
            });
          }
          this._previousQueuedCalls.set(vq.queueNumber, newPrevCalls);

          // Update running max from relay's current wait
          if (longestWaitSec > 0) {
            const prev = this._todayMaxWait.get(vq.queueNumber) ?? 0;
            if (longestWaitSec > prev) this._todayMaxWait.set(vq.queueNumber, longestWaitSec);
          }

          // Prune + record windowed observations
          const obs = this._waitObservations.get(vq.queueNumber) ?? [];
          if (longestWaitSec > 0) obs.push({ ts: nowMs, wait: longestWaitSec });
          const windowMs = avgWaitWindowMinutes * 60 * 1000;
          this._waitObservations.set(vq.queueNumber, obs.filter((o) => o.ts >= nowMs - windowMs));

          // Report API for day totals (relay doesn't provide these)
          const callsAnswered = fullDayStats?.AnsweredCount ?? 0;
          const callsAbandoned = fullDayStats
            ? Math.max(0, (fullDayStats.CallsCount ?? 0) - (fullDayStats.AnsweredCount ?? 0))
            : 0;
          const totalDenominator = callsAnswered + callsAbandoned;
          const abandonRate = totalDenominator > 0
            ? Math.round((callsAbandoned / totalDenominator) * 10000) / 100
            : 0;
          const avgWaitSec = reportStats != null
            ? Math.round(parseIsoDuration(reportStats.AvgRingTime))
            : 0;
          const totalAvgWaitSec = fullDayStats != null
            ? Math.round(parseIsoDuration(fullDayStats.AvgRingTime))
            : 0;

          // Agent statuses from relay (enrich with cached manager data)
          const cachedManagers = this._cachedManagersByQueue.get(vq.queueId) ?? [];
          const managerExtSet = new Set(cachedManagers.map((m) => m.Number));
          const agentStatuses: QueueAgentStatus[] = rq.agents.map((ra) => ({
            extensionNumber: ra.ext,
            displayName: ra.name,
            queueStatus: ra.loggedIn ? 'LoggedIn' as const : 'LoggedOut' as const,
            callState: ra.callState,
            profileName: ra.profileName,
            isRegistered: ra.isRegistered,
            isManager: managerExtSet.has(ra.ext),
          }));

          const agentsLoggedIn = rq.agents.filter((a) => a.loggedIn).length;
          const agentsTalking = rq.agents.filter((a) => a.callState === 'talking').length;

          return {
            queueId: vq.queueId,
            queueNumber: vq.queueNumber,
            queueName: rq.name || vq.queueName,
            callsWaiting,
            longestWaitSec,
            agentsLoggedIn,
            agentsTotal: rq.agents.length,
            agentsTalking,
            agentsAvailable: Math.max(0, agentsLoggedIn - agentsTalking),
            callsAnswered,
            callsAbandoned,
            avgWaitSec,
            totalAvgWaitSec,
            abandonRate,
            agents: agentStatuses,
            managerExtensions: this._cachedManagersByQueue.get(vq.queueId)?.map((m) => m.Number) ?? [],
          };
        });

        // Compute totals (same logic as polling mode)
        const totals = computeTotals(queueDataList);
        let longestWaitWindow = 0;
        let longestWaitToday = 0;
        let windowAvgSum = 0, windowCount = 0, todayAvgSum = 0, todayCount = 0;
        for (const q of queueDataList) {
          const obs = this._waitObservations.get(q.queueNumber) ?? [];
          const windowPeak = obs.reduce((max, o) => Math.max(max, o.wait), 0);
          longestWaitWindow = Math.max(longestWaitWindow, windowPeak);
          const queueMax = this._todayMaxWait.get(q.queueNumber) ?? 0;
          longestWaitToday = Math.max(longestWaitToday, queueMax);
          if (q.avgWaitSec > 0) { windowAvgSum += q.avgWaitSec; windowCount++; }
          if (q.totalAvgWaitSec > 0) { todayAvgSum += q.totalAvgWaitSec; todayCount++; }
        }
        totals.longestWaitWindow = longestWaitWindow;
        totals.longestWaitToday = longestWaitToday;
        totals.avgWaitWindow = windowCount > 0 ? Math.round(windowAvgSum / windowCount) : 0;
        totals.avgWaitToday = todayCount > 0 ? Math.round(todayAvgSum / todayCount) : 0;

        const pollMs = Date.now() - pollStart;
        console.log(`[ThreecxPoller] RELAY Totals: LW-win=${longestWaitWindow}s LW-today=${longestWaitToday}s avgW-today=${totals.avgWaitToday}s avgW-window=${totals.avgWaitWindow}s (${pollMs}ms, relay age=${Math.round(getRelayAge())}ms)`);

        // Store snapshots
        await prisma.queueSnapshot.createMany({
          data: queueDataList.map((q) => ({
            queueId: q.queueId, callsWaiting: q.callsWaiting, callsAnswered: q.callsAnswered,
            callsAbandoned: q.callsAbandoned, agentsLoggedIn: q.agentsLoggedIn,
            agentsTalking: q.agentsTalking, agentsAvailable: q.agentsAvailable,
            longestWaitSec: q.longestWaitSec, avgWaitSec: q.avgWaitSec, abandonRate: q.abandonRate,
          })),
        });

        // Emit state in relay mode
        this.emitState({
          lastUpdated: now.toISOString(),
          pollIntervalMs: config.pollIntervalMs,
          connectionStatus: 'connected',
          dataMode: 'realtime',
          queues: queueDataList,
          totals,
          avgWaitWindowMinutes,
        });

        // Periodic pruning
        if (Date.now() - this.lastPruneTime > PRUNE_INTERVAL_MS) {
          this.lastPruneTime = Date.now();
          pruneOldSnapshots().catch((err) => console.error('[ThreecxPoller] Pruning failed:', err));
        }

        return; // Skip polling mode entirely
      }

      // ── POLLING MODE: Fetch data from 3CX REST API ──────────────
      // ── 4. Fetch data from 3CX in parallel ────────────────────
      const now = new Date();

      // Fetch core data (queues, calls, users, agents) in parallel.
      // Managers are fetched on a slower cadence (every 60s) via a separate client
      // because the 3CX XAPI caches $expand data per-connection.
      const password = decrypt(config.encryptedPassword);
      if (!this.managerClient) {
        this.managerClient = new ThreecxClient(config.pbxUrl, config.extensionNumber, password);
      }

      const [
        allQueues,
        activeCalls,
        users,
        ...agentResults
      ] = await Promise.all([
        this.client.getQueues(),
        this.client.getActiveCalls(),
        this.client.getUsers(),
        // Agent lists change frequently (login/logout) — fetch every cycle
        ...visibleQueues.map((q) => this.client!.getQueueAgents(q.queueId)),
      ]);

      // Log ALL active calls so we can see what's happening with each one
      if (activeCalls.length > 0) {
        console.log(`[ThreecxPoller] ActiveCalls: ${activeCalls.length} calls:`);
        for (const c of activeCalls) {
          const segInfo = c.Segments?.map((seg) =>
            `[${seg.CallerNumber ?? '?'}→${seg.CalleeNumber ?? '?'} dn=${seg.Dn ?? '?'} dialed=${seg.DialedDn ?? '?'} ${seg.Status ?? '?'}]`
          ).join(' ') ?? 'no-segs';
          console.log(`  #${c.Id}: ${c.Caller} → ${c.Callee} [${c.Status}] est=${c.EstablishedAt ?? 'null'} ${segInfo}`);
        }
      }

      // Unpack agent results
      const agentsByQueue = new Map<number, ThreecxQueueAgent[]>();
      for (let i = 0; i < visibleQueues.length; i++) {
        agentsByQueue.set(visibleQueues[i].queueId, agentResults[i] as ThreecxQueueAgent[]);
      }

      // Manager data — throttled to every 60s (rarely changes, uses separate auth session)
      const managersByQueue = new Map<number, ThreecxQueueManager[]>();
      const needManagerFetch = now.getTime() - this._lastManagerFetchTime > MANAGER_FETCH_INTERVAL_MS;
      if (needManagerFetch) {
        this._lastManagerFetchTime = now.getTime();
        // Recreate manager client periodically to bust XAPI connection-level caching
        this.managerClient = new ThreecxClient(config.pbxUrl, config.extensionNumber, password);
        const managerResults = await Promise.all(
          visibleQueues.map((q) => this.managerClient!.getQueueWithManagers(q.queueId)),
        );
        this._cachedManagersByQueue.clear();
        for (let i = 0; i < visibleQueues.length; i++) {
          const expanded = managerResults[i] as { Managers?: ThreecxQueueManager[] };
          const managers = expanded?.Managers ?? [];
          this._cachedManagersByQueue.set(visibleQueues[i].queueId, managers);
          managersByQueue.set(visibleQueues[i].queueId, managers);
        }
      } else {
        // Use cached manager data
        for (const q of visibleQueues) {
          managersByQueue.set(q.queueId, this._cachedManagersByQueue.get(q.queueId) ?? []);
        }
      }

      // Log manager data only when it changes (avoid spam every 10s)
      const managerHash = visibleQueues.map(q => {
        const m = managersByQueue.get(q.queueId) ?? [];
        return `${q.queueNumber}:${m.map(mg => mg.Number).sort().join(',')}`;
      }).join('|');
      if (managerHash !== this._lastManagerHash) {
        this._lastManagerHash = managerHash;
        for (const q of visibleQueues) {
          const m = managersByQueue.get(q.queueId) ?? [];
          console.log(`[ThreecxPoller] Queue ${q.queueNumber} (id=${q.queueId}) managers: ${m.map(mg => mg.Number).join(', ') || '(none)'}`);
        }
      }

      // Build lookup maps
      const userMap = new Map<string, ThreecxUser>();
      for (const u of users) {
        userMap.set(u.Number, u);
      }

      const queueMap = new Map<number, ThreecxQueue>();
      for (const q of allQueues) {
        queueMap.set(q.Id, q);
      }


      // ── 5. Compute WallboardState ─────────────────────────────
      const avgWaitWindowMinutes = config.avgWaitWindowMinutes ?? DEFAULT_AVG_WAIT_WINDOW_MIN;

      // One-time: discover available Report API endpoints on this PBX
      // Metadata discovery removed — endpoints are known. Available reports:
      // ReportDetailedQueueStatistics, ReportQueuePerformanceTotals,
      // ReportQueuePerformanceOverview, ReportAbandonedQueueCalls, etc.

      // ── 5a. Midnight reset for running max wait ──
      // Must run BEFORE Report API block, because the Report API syncs _todayMaxWait
      // from DB (GREATEST pattern). If we clear after that sync, the value is lost.
      {
        const pbxTz = (config as Record<string, unknown>).pbxTimezone as string ?? 'America/Chicago';
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: pbxTz });
        if (this._todayMaxWaitDate !== todayStr) {
          this._todayMaxWait.clear();
          this._waitObservations.clear();
          this._todayMaxWaitDate = todayStr;
        }
      }

      // ── 5b. Query 3CX Report API for stats (every 30s) ──
      // Two queries:
      //   1. WINDOWED query (last N minutes) → feeds wallboard avgWaitSec column
      //   2. FULL-DAY query → persists to QueueDailySummary for historical reporting
      // Uses PBX timezone for "today" boundaries (container runs UTC, PBX is local time).
      if (this.client && now.getTime() - this._lastReportApiTime > REPORT_API_INTERVAL_MS) {
        this._lastReportApiTime = now.getTime();
        try {
          const pbxTz = (config as Record<string, unknown>).pbxTimezone as string ?? 'America/Chicago';
          const dayStart = getMidnightInTimezone(pbxTz, now);
          const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
          const windowStart = new Date(now.getTime() - avgWaitWindowMinutes * 60 * 1000);

          // Log timezone-corrected boundaries (first time only)
          if (this._lastReportApiTime === now.getTime()) {
            console.log(`[ThreecxPoller] Report API day boundaries: ${dayStart.toISOString()} → ${dayEnd.toISOString()} (tz=${pbxTz})`);
          }

          // Parallel: windowed query for wallboard + full-day query for DB persistence
          const [windowedStats, fullDayStats] = await Promise.all([
            this.client.getQueueDetailedStats(windowStart.toISOString(), now.toISOString()),
            this.client.getQueueDetailedStats(dayStart.toISOString(), dayEnd.toISOString()),
          ]);

          // Windowed stats → _reportApiStats (used for wallboard avgWaitSec column)
          this._reportApiStats.clear();
          for (const rs of windowedStats) {
            this._reportApiStats.set(rs.QueueDnNumber, rs);
          }

          // Full-day stats → _fullDayReportApiStats (used for "today" totals + 24h avg column)
          this._fullDayReportApiStats.clear();
          for (const rs of fullDayStats) {
            this._fullDayReportApiStats.set(rs.QueueDnNumber, rs);
          }

          // Full-day stats → QueueDailySummary persistence (use PBX timezone for date)
          const todayDateStr = now.toLocaleDateString('en-CA', { timeZone: pbxTz }); // "YYYY-MM-DD"
          const [tdY, tdM, tdD] = todayDateStr.split('-').map(Number);
          const todayDate = new Date(Date.UTC(tdY, tdM - 1, tdD)); // midnight UTC representation of PBX date
          for (const rs of fullDayStats) {
            const vq = visibleQueues.find((q) => q.queueNumber === rs.QueueDnNumber);
            if (!vq) continue;
            const answered = rs.AnsweredCount ?? 0;
            const abandoned = Math.max(0, (rs.CallsCount ?? 0) - answered);
            const avgWaitSec = Math.round(parseIsoDuration(rs.AvgRingTime) * 100) / 100;
            const avgTalkSec = Math.round(parseIsoDuration(rs.AvgTalkTime) * 100) / 100;
            const totalRingSec = Math.round(parseIsoDuration(rs.RingTime));

            // maxWaitSec: NEVER overwrite DB with a lower value.
            // On container restart, _todayMaxWait is empty (0). Read DB first
            // and use Math.max to preserve the historical max from before restart.
            const runningMax = this._todayMaxWait.get(rs.QueueDnNumber) ?? 0;
            const existing = await prisma.queueDailySummary.findUnique({
              where: { queueId_date: { queueId: vq.queueId, date: todayDate } },
              select: { maxWaitSec: true },
            });
            const bestMax = Math.max(runningMax, existing?.maxWaitSec ?? 0);

            // Sync in-memory running max with DB (seeds _todayMaxWait on first poll after restart)
            if (bestMax > runningMax) {
              this._todayMaxWait.set(rs.QueueDnNumber, bestMax);
            }

            await prisma.queueDailySummary.upsert({
              where: { queueId_date: { queueId: vq.queueId, date: todayDate } },
              update: {
                totalAnswered: answered,
                totalAbandoned: abandoned,
                totalOffered: rs.CallsCount ?? 0,
                avgWaitSec,
                avgTalkSec,
                maxWaitSec: bestMax,
              },
              create: {
                queueId: vq.queueId,
                date: todayDate,
                totalAnswered: answered,
                totalAbandoned: abandoned,
                totalOffered: rs.CallsCount ?? 0,
                avgWaitSec,
                avgTalkSec,
                maxWaitSec: bestMax,
              },
            });
          }
          if (windowedStats.length > 0) {
            const winLabel = avgWaitWindowMinutes >= 60
              ? `${avgWaitWindowMinutes / 60}h`
              : `${avgWaitWindowMinutes}m`;
            console.log(`[ThreecxPoller] Report API (${winLabel} window): ${windowedStats.map((r) =>
              `Q${r.QueueDnNumber}(A=${r.AnsweredCount} Ab=${Math.max(0, (r.CallsCount ?? 0) - (r.AnsweredCount ?? 0))} AvgW=${parseIsoDuration(r.AvgRingTime).toFixed(0)}s)`
            ).join(', ')}`);
          }
          if (fullDayStats.length > 0) {
            console.log(`[ThreecxPoller] Report API (full day): ${fullDayStats.map((r) =>
              `Q${r.QueueDnNumber}(A=${r.AnsweredCount} Ab=${Math.max(0, (r.CallsCount ?? 0) - (r.AnsweredCount ?? 0))} AvgW=${parseIsoDuration(r.AvgRingTime).toFixed(0)}s AvgRingTime="${r.AvgRingTime}")`
            ).join(', ')}`);
            // Log ALL fields once to check for hidden max wait field
            if (!this._reportFieldsLogged) {
              console.log(`[ThreecxPoller] Report API full response fields: ${JSON.stringify(fullDayStats[0])}`);
              this._reportFieldsLogged = true;
            }
          }
        } catch (reportApiErr) {
          // Non-fatal — fall back to WS stats
          if (!this._lastReportWarnTime || Date.now() - this._lastReportWarnTime > 60_000) {
            console.warn('[ThreecxPoller] Report API query failed (non-fatal):', reportApiErr instanceof Error ? reportApiErr.message : String(reportApiErr));
            this._lastReportWarnTime = Date.now();
          }
        }
      }

      // Drain WS call events (so the buffer doesn't grow unbounded) but don't use for totals
      this.queueMonitor?.getAndClearCallEvents();

      // Extract 3CX server time once (avoids clock skew between container and PBX)
      const serverNowMs = (() => {
        for (const c of activeCalls) {
          const sn = (c as unknown as Record<string, unknown>)?.ServerNow as string;
          if (sn) { const ms = new Date(sn).getTime(); if (!isNaN(ms)) return ms; }
        }
        return Date.now();
      })();

      // Build queue wallboard data
      const queueDataList: QueueWallboardData[] = visibleQueues.map((vq) => {
        let agents = agentsByQueue.get(vq.queueId) ?? [];
        const managers = managersByQueue.get(vq.queueId) ?? [];

        // WebSocket monitor is the authoritative source for which agents are in
        // each queue. The REST API (getQueueAgents) can return stale/cached data
        // for minutes after changes. When the monitor has data, use its agent list.
        // WebSocket monitor is the authoritative source for which agents are in
        // each queue — BUT only when it has actual agent data. Empty lists from
        // the monitor may mean "data not available" (auth session contested), not
        // "genuinely 0 agents". In that case, fall back to REST API.
        if (this.queueMonitor?.hasData()) {
          const monitorAgentNumbers = this.queueMonitor.getQueueAgentNumbers(vq.queueNumber);
          if (monitorAgentNumbers && monitorAgentNumbers.length > 0) {
            const monitorSet = new Set(monitorAgentNumbers);
            // Filter REST agents to only those the monitor confirms are in the queue
            const confirmedAgents = agents.filter((a) => monitorSet.has(a.Number));
            // Add any agents the monitor shows but REST didn't return (stale removal)
            for (const extNum of monitorAgentNumbers) {
              if (!confirmedAgents.some((a) => a.Number === extNum)) {
                confirmedAgents.push({ Number: extNum });
              }
            }
            agents = confirmedAgents;
          }
        }
        const queueDef = queueMap.get(vq.queueId);

        // Manager extension set for quick lookup
        const managerExtensions = new Set(managers.map((m) => m.Number));


        // Agents logged in — WebSocket monitor is the ONLY reliable per-queue source.
        // XAPI User.QueueStatus is GLOBAL (logged into ANY queue = "LoggedIn" everywhere) so
        // it must NOT be used when the monitor has data, even if stale.
        const loggedInAgents = agents.filter((a) => {
          if (this.queueMonitor?.hasData()) {
            const monitorStatus =
              this.queueMonitor.isAgentLoggedInByNumber(vq.queueNumber, a.Number) ??
              this.queueMonitor.isAgentLoggedIn(vq.queueId, a.Number);
            if (monitorStatus !== undefined) return monitorStatus;
          }
          // Last resort: XAPI global status (only when monitor has never connected)
          const user = userMap.get(a.Number);
          return user?.QueueStatus === 'LoggedIn';
        });
        const loggedInExtensions = new Set(loggedInAgents.map((a) => a.Number));

        // Active calls cross-reference: find calls involving this queue's agents
        // ActiveCalls Caller/Callee format: "1002 tools, admin" or "10000 skyetel (+15153182968)"
        // Extract the extension number (first token before space) for matching.
        const extractExt = (field: string) => field.split(' ')[0];
        const talkingExtensions = new Set<string>();
        const ringingExtensions = new Set<string>();

        for (const call of activeCalls) {
          const callerExt = extractExt(call.Caller);
          const calleeExt = extractExt(call.Callee);
          const callerInQueue = loggedInExtensions.has(callerExt);
          const calleeInQueue = loggedInExtensions.has(calleeExt);

          if (callerInQueue || calleeInQueue) {
            const status = call.Status?.toLowerCase() ?? '';
            const ext = callerInQueue ? callerExt : calleeExt;

            if (status.includes('talking') || status.includes('connected')) {
              talkingExtensions.add(ext);
            } else if (status.includes('ringing') || status.includes('dialing')) {
              ringingExtensions.add(ext);
            }
          }

          // Also check segments for more detailed call state
          if (call.Segments) {
            for (const seg of call.Segments) {
              const segCaller = extractExt(seg.CallerNumber ?? seg.Dn ?? '');
              const segCallee = extractExt(seg.CalleeNumber ?? seg.DialedDn ?? '');
              const segStatus = (seg.Status ?? '').toLowerCase();

              if (loggedInExtensions.has(segCaller) || loggedInExtensions.has(segCallee)) {
                const ext = loggedInExtensions.has(segCaller) ? segCaller : segCallee;
                if (segStatus.includes('talking') || segStatus.includes('connected')) {
                  talkingExtensions.add(ext);
                } else if (segStatus.includes('ringing') || segStatus.includes('dialing')) {
                  ringingExtensions.add(ext);
                }
              }
            }
          }
        }

        // ── Calls waiting detection ──
        // Three methods (checked in order), using top-level status to filter:
        //   1. Callee directly references queue number
        //   2. Any segment field (CalleeNumber, DialedDn, Dn) references queue number
        //      (fixes RingAll bug where CalleeNumber = agent ext but DialedDn = queue)
        //   3. Call "Routing" to a queue agent with no segments available
        const queueNumber = vq.queueNumber;
        const allAgentExts = new Set(agents.map((a) => a.Number));
        const calleeContainsQueue = (field: string) =>
          field === queueNumber || extractExt(field) === queueNumber ||
          field.includes(` ${queueNumber}`) || field.endsWith(queueNumber);

        const queuedCalls = activeCalls.filter((call) => {
          const topStatus = (call.Status ?? '').toLowerCase();
          const isTalkingOrConnected = topStatus.includes('talking') || topStatus.includes('connected');

          // "Talking" to the QUEUE itself = caller is hearing hold music / ringing agents.
          // 3CX marks the first-in-line caller as "Talking" even though no agent answered.
          // Only skip "Talking" calls whose Callee is an agent extension (actually answered).
          if (isTalkingOrConnected && calleeContainsQueue(call.Callee)) {
            return true; // "Talking" to queue = still waiting
          }
          if (isTalkingOrConnected) return false; // Actually answered by agent

          // Method 1: Top-level Callee references queue directly
          if (calleeContainsQueue(call.Callee)) return true;

          // Method 2: Check ALL segment fields individually for queue number.
          // With RingAll, CalleeNumber = agent ext, but DialedDn/Dn = queue number.
          // Also check CallerNumber — when queue routes to an agent, the queue
          // extension may appear as the segment caller.
          if (call.Segments) {
            const hasQueueRef = call.Segments.some((seg) =>
              [seg.CallerNumber, seg.CalleeNumber, seg.DialedDn, seg.Dn]
                .some((f) => f != null && calleeContainsQueue(f))
            );
            if (hasQueueRef) return true;
          }

          // Method 3: Call "Routing" to a queue agent (no segments).
          // Queue-routed calls typically show "Routing"; direct calls show "Ringing".
          if ((!call.Segments || call.Segments.length === 0) && topStatus.includes('routing')) {
            const calleeExt = extractExt(call.Callee);
            if (allAgentExts.has(calleeExt)) return true;
          }

          return false;
        });

        // WebSocket provides real-time callsWaiting (s4 + s5 = waiting + ringing).
        const wsCallStats = this.queueMonitor?.getCallStats(vq.queueNumber);
        // Use the MAX of WS and ActiveCalls counts — WS can briefly under-report
        // during state transitions (e.g., drops to 0 when a second call enters queue).
        const callsWaiting = Math.max(wsCallStats?.callsWaiting ?? 0, queuedCalls.length);

        // Detailed debug logging for queue call detection
        const nonTalkingCalls = activeCalls.filter((c) => {
          const s = (c.Status ?? '').toLowerCase();
          return !s.includes('talking') && !s.includes('connected');
        });
        if (nonTalkingCalls.length > 0 || (wsCallStats?.callsWaiting ?? 0) > 0) {
          console.log(`[ThreecxPoller] Q${queueNumber} callsWaiting: WS=${wsCallStats?.callsWaiting ?? 0} ActiveCalls=${queuedCalls.length} → ${callsWaiting} (${nonTalkingCalls.length} non-talking total)`);
          for (const qc of queuedCalls) {
            const segInfo = qc.Segments?.map((seg) =>
              `[${seg.CallerNumber ?? '?'}→${seg.CalleeNumber ?? '?'} dn=${seg.Dn ?? '?'} dialed=${seg.DialedDn ?? '?'} ${seg.Status ?? '?'}]`
            ).join(' ') ?? 'no-segs';
            console.log(`  ✓ Matched #${qc.Id}: ${qc.Caller} → ${qc.Callee} [${qc.Status}] ${segInfo}`);
          }
          // Always log unmatched non-talking calls so we can see what was missed
          const unmatchedNonTalking = nonTalkingCalls.filter(
            (c) => !queuedCalls.some((qc) => qc.Id === c.Id)
          );
          for (const c of unmatchedNonTalking) {
            const segInfo = c.Segments?.map((seg) =>
              `[${seg.CallerNumber ?? '?'}→${seg.CalleeNumber ?? '?'} dn=${seg.Dn ?? '?'} dialed=${seg.DialedDn ?? '?'} ${seg.Status ?? '?'}]`
            ).join(' ') ?? 'no-segs';
            console.log(`  ✗ Missed  #${c.Id}: ${c.Caller} → ${c.Callee} [${c.Status}] ${segInfo}`);
          }
        }

        const agentsLoggedIn = loggedInAgents.length;
        const agentsTalking = talkingExtensions.size;
        const agentsAvailable = Math.max(0, agentsLoggedIn - agentsTalking);

        // Day-total metrics: Report API is primary (timezone-corrected, accurate counts).
        // WS stats are corrupted by auto-pager session conflict on ext 1000.
        // WS only used as fallback before first Report API fetch completes.
        const reportStats = this._reportApiStats.get(vq.queueNumber); // windowed
        const fullDayStats = this._fullDayReportApiStats.get(vq.queueNumber); // full day
        const callsAnswered = fullDayStats?.AnsweredCount ?? wsCallStats?.callsAnswered ?? 0;
        const callsAbandoned = fullDayStats
          ? Math.max(0, (fullDayStats.CallsCount ?? 0) - (fullDayStats.AnsweredCount ?? 0))
          : wsCallStats?.callsAbandoned ?? 0;
        const totalDenominator = callsAnswered + callsAbandoned;
        const abandonRate = totalDenominator > 0
          ? Math.round((callsAbandoned / totalDenominator) * 10000) / 100
          : 0;

        // ── Wait time metrics ──
        // longestWaitSec = REAL-TIME current longest wait computed from ActiveCalls.
        // Uses pre-extracted serverNowMs (avoids clock skew with container).
        // WS s13 is NOT used — it's session-scoped cumulative and unreliable.
        let longestWaitSec = 0;
        for (const call of queuedCalls) {
          const startStr = call.EstablishedAt || call.LastChangeStatus;
          if (startStr) {
            const startMs = new Date(startStr).getTime();
            if (!isNaN(startMs) && startMs > 0 && startMs < serverNowMs) {
              const waitSec = Math.max(0, Math.floor((serverNowMs - startMs) / 1000));
              longestWaitSec = Math.max(longestWaitSec, waitSec);
            }
          }
        }

        // ── Call departure tracking ──
        // Polling every 10s means a call waiting 11s might only show 2s at the
        // sample point. By tracking calls across polls, we capture the ACTUAL
        // total wait when a call leaves the queue (answered or abandoned).
        const prevCalls = this._previousQueuedCalls.get(queueNumber) ?? new Map();
        const currentCallIds = new Set(queuedCalls.map((c) => c.Id));

        prevCalls.forEach((info, callId) => {
          if (!currentCallIds.has(callId)) {
            // Call departed between last poll and now
            const startMs = new Date(info.startStr).getTime();
            if (!isNaN(startMs) && startMs > 0) {
              // Midpoint between last-seen and now = best estimate of when call ended
              const estimatedEndMs = (info.lastSeenServerMs + serverNowMs) / 2;
              const waitSec = Math.max(0, Math.round((estimatedEndMs - startMs) / 1000));
              if (waitSec > 0) {
                // Update today running max
                const prev = this._todayMaxWait.get(queueNumber) ?? 0;
                if (waitSec > prev) {
                  this._todayMaxWait.set(queueNumber, waitSec);
                }
                // Record windowed observation
                const obs = this._waitObservations.get(queueNumber) ?? [];
                obs.push({ ts: now.getTime(), wait: waitSec });
                this._waitObservations.set(queueNumber, obs);

                console.log(`[ThreecxPoller] Q${queueNumber} call #${callId} departed: ~${waitSec}s wait`);
              }
            }
          }
        });

        // Update call tracking for next poll
        const newPrevCalls = new Map<number, { startStr: string; lastSeenServerMs: number }>();
        for (const call of queuedCalls) {
          const startStr = call.EstablishedAt || call.LastChangeStatus || '';
          const existing = prevCalls.get(call.Id);
          newPrevCalls.set(call.Id, {
            startStr: existing?.startStr ?? startStr, // preserve original start time
            lastSeenServerMs: serverNowMs,
          });
        }
        this._previousQueuedCalls.set(queueNumber, newPrevCalls);

        // Also update running max from currently active calls (live display)
        if (longestWaitSec > 0) {
          const prev = this._todayMaxWait.get(queueNumber) ?? 0;
          if (longestWaitSec > prev) {
            this._todayMaxWait.set(queueNumber, longestWaitSec);
          }
        }

        // Prune old windowed observations
        {
          const obs = this._waitObservations.get(queueNumber) ?? [];
          if (longestWaitSec > 0) {
            obs.push({ ts: now.getTime(), wait: longestWaitSec });
          }
          const windowMs = avgWaitWindowMinutes * 60 * 1000;
          const cutoff = now.getTime() - windowMs;
          const pruned = obs.filter((o) => o.ts >= cutoff);
          this._waitObservations.set(queueNumber, pruned);
        }

        // avgWaitSec = WINDOWED average wait time (configurable: 1h, 3h, etc.)
        // Uses the windowed Report API query matching the admin-configured window.
        const avgWaitSec = reportStats != null
          ? Math.round(parseIsoDuration(reportStats.AvgRingTime))
          : wsCallStats?.avgWaitSec ?? 0;

        // totalAvgWaitSec = FULL-DAY (24h) average wait time from Report API.
        // Do NOT fall back to WS s12 — corrupted by auto-pager session conflict.
        const totalAvgWaitSec = fullDayStats != null
          ? Math.round(parseIsoDuration(fullDayStats.AvgRingTime))
          : 0;

        // Build agent status array
        const agentStatuses: QueueAgentStatus[] = agents.map((agent) => {
          const user = userMap.get(agent.Number);
          const displayName = user
            ? `${user.FirstName} ${user.LastName}`.trim() || agent.Number
            : agent.Number;

          // Monitor is the only reliable per-queue source; XAPI QueueStatus is global
          let isLoggedIn = user?.QueueStatus === 'LoggedIn';
          if (this.queueMonitor?.hasData()) {
            const monitorStatus =
              this.queueMonitor.isAgentLoggedInByNumber(vq.queueNumber, agent.Number) ??
              this.queueMonitor.isAgentLoggedIn(vq.queueId, agent.Number);
            if (monitorStatus !== undefined) isLoggedIn = monitorStatus;
          }
          let callState: QueueAgentStatus['callState'] = 'offline';

          if (isLoggedIn) {
            if (talkingExtensions.has(agent.Number)) {
              callState = 'talking';
            } else if (ringingExtensions.has(agent.Number)) {
              callState = 'ringing';
            } else {
              callState = 'available';
            }
          }

          return {
            extensionNumber: agent.Number,
            displayName,
            queueStatus: isLoggedIn ? 'LoggedIn' : 'LoggedOut',
            callState,
            profileName: user?.CurrentProfileName ?? 'Unknown',
            isRegistered: user?.IsRegistered ?? false,
            isManager: managerExtensions.has(agent.Number),
          };
        });

        return {
          queueId: vq.queueId,
          queueNumber: vq.queueNumber,
          queueName: queueDef?.Name ?? vq.queueName,
          callsWaiting,
          longestWaitSec,
          agentsLoggedIn,
          agentsTotal: agents.length,
          agentsTalking,
          agentsAvailable,
          callsAnswered,
          callsAbandoned,
          avgWaitSec,
          totalAvgWaitSec,
          abandonRate,
          agents: agentStatuses,
          managerExtensions: Array.from(managerExtensions),
        };
      });

      // ── 6. Compute totals ──────────────────────────────────────
      const totals = computeTotals(queueDataList);

      // ── 6b. Wait time totals from per-queue data ──
      // Window metrics use avgWaitSec (windowed Report API).
      // Today metrics use totalAvgWaitSec (full-day Report API).
      // longestWaitToday = running max from our own ActiveCalls measurements (not WS s13).
      {
        let longestWaitWindow = 0;
        let longestWaitToday = 0;
        let windowAvgSum = 0;
        let windowCount = 0;
        let todayAvgSum = 0;
        let todayCount = 0;
        for (const q of queueDataList) {
          // Windowed peak: highest observed wait within the configured window
          const obs = this._waitObservations.get(q.queueNumber) ?? [];
          const windowPeak = obs.reduce((max, o) => Math.max(max, o.wait), 0);
          longestWaitWindow = Math.max(longestWaitWindow, windowPeak);
          // Running max from our own real-time measurements (resets at midnight)
          const queueMax = this._todayMaxWait.get(q.queueNumber) ?? 0;
          longestWaitToday = Math.max(longestWaitToday, queueMax);
          if (q.avgWaitSec > 0) {
            windowAvgSum += q.avgWaitSec;
            windowCount++;
          }
          if (q.totalAvgWaitSec > 0) {
            todayAvgSum += q.totalAvgWaitSec;
            todayCount++;
          }
        }
        totals.longestWaitWindow = longestWaitWindow;
        totals.longestWaitToday = longestWaitToday;
        totals.avgWaitWindow = windowCount > 0 ? Math.round(windowAvgSum / windowCount) : 0;
        totals.avgWaitToday = todayCount > 0 ? Math.round(todayAvgSum / todayCount) : 0;

        const pollMs = Date.now() - pollStart;
        console.log(`[ThreecxPoller] Totals: LW-win=${longestWaitWindow}s LW-today=${longestWaitToday}s avgW-today=${totals.avgWaitToday}s avgW-window=${totals.avgWaitWindow}s (${pollMs}ms)`);
      }

      // ── 7. Store QueueSnapshots ────────────────────────────────
      await prisma.queueSnapshot.createMany({
        data: queueDataList.map((q) => ({
          queueId: q.queueId,
          callsWaiting: q.callsWaiting,
          callsAnswered: q.callsAnswered,
          callsAbandoned: q.callsAbandoned,
          agentsLoggedIn: q.agentsLoggedIn,
          agentsTalking: q.agentsTalking,
          agentsAvailable: q.agentsAvailable,
          longestWaitSec: q.longestWaitSec,
          avgWaitSec: q.avgWaitSec,
          abandonRate: q.abandonRate,
        })),
      });

      // ── 8. Emit state ──────────────────────────────────────────
      const state: WallboardState = {
        lastUpdated: now.toISOString(),
        pollIntervalMs: config.pollIntervalMs,
        connectionStatus: 'connected',
        dataMode: 'polling',
        queues: queueDataList,
        totals,
        avgWaitWindowMinutes,
      };

      this.emitState(state);

      // ── 9. Periodic pruning ────────────────────────────────────
      if (Date.now() - this.lastPruneTime > PRUNE_INTERVAL_MS) {
        this.lastPruneTime = Date.now();
        // Fire and forget -- don't block the poll cycle
        pruneOldSnapshots()
          .then((count) => {
            if (count > 0) {
              console.log(`[ThreecxPoller] Pruned ${count} old snapshots`);
            }
          })
          .catch((err) => {
            console.error('[ThreecxPoller] Snapshot pruning failed:', err);
          });
      }
    } catch (err) {
      console.error('[ThreecxPoller] Poll cycle failed:', err);

      // Emit error state so clients know something is wrong
      const errorState: WallboardState = {
        lastUpdated: new Date().toISOString(),
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        connectionStatus: 'error',
        dataMode: 'polling',
        queues: this.currentState?.queues ?? [],
        totals: this.currentState?.totals ?? emptyTotals(),
        avgWaitWindowMinutes: this.currentState?.avgWaitWindowMinutes ?? DEFAULT_AVG_WAIT_WINDOW_MIN,
      };

      this.emitState(errorState);
    } finally {
      this.polling = false;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private emitState(state: WallboardState): void {
    this.currentState = state;
    this.hub.emit(state);
  }

}

// ─── Utility Functions ──────────────────────────────────────────────────────

function emptyTotals(): WallboardTotals {
  return {
    totalCallsWaiting: 0,
    totalAgentsAvailable: 0,
    totalAgentsTalking: 0,
    totalAgentsLoggedIn: 0,
    totalAnsweredToday: 0,
    totalAbandonedToday: 0,
    overallAbandonRate: 0,
    longestWaitWindow: 0,
    longestWaitToday: 0,
    avgWaitWindow: 0,
    avgWaitToday: 0,
  };
}

function computeTotals(queues: QueueWallboardData[]): WallboardTotals {
  if (queues.length === 0) return emptyTotals();

  const totalCallsWaiting = queues.reduce((sum, q) => sum + q.callsWaiting, 0);
  const totalAgentsAvailable = queues.reduce((sum, q) => sum + q.agentsAvailable, 0);
  const totalAgentsTalking = queues.reduce((sum, q) => sum + q.agentsTalking, 0);
  const totalAgentsLoggedIn = queues.reduce((sum, q) => sum + q.agentsLoggedIn, 0);
  const totalAnsweredToday = queues.reduce((sum, q) => sum + q.callsAnswered, 0);
  const totalAbandonedToday = queues.reduce((sum, q) => sum + q.callsAbandoned, 0);
  const denominator = totalAnsweredToday + totalAbandonedToday;
  const overallAbandonRate = denominator > 0
    ? Math.round((totalAbandonedToday / denominator) * 10000) / 100
    : 0;

  return {
    totalCallsWaiting,
    totalAgentsAvailable,
    totalAgentsTalking,
    totalAgentsLoggedIn,
    totalAnsweredToday,
    totalAbandonedToday,
    overallAbandonRate,
    // Wait time metrics populated from QueuePerformanceOverview Report API
    longestWaitWindow: 0,
    longestWaitToday: 0,
    avgWaitWindow: 0,
    avgWaitToday: 0,
  };
}

// ─── Singleton Export ───────────────────────────────────────────────────────

/**
 * Singleton poller instance. Shared across all SSE connections.
 * In development with hot module reload, we store on globalThis to prevent
 * multiple instances.
 */
const globalForPoller = globalThis as unknown as {
  __threecxPoller: ThreecxPoller | undefined;
};

export const poller: ThreecxPoller =
  globalForPoller.__threecxPoller ?? new ThreecxPoller();

if (process.env.NODE_ENV !== 'production') {
  globalForPoller.__threecxPoller = poller;
}
