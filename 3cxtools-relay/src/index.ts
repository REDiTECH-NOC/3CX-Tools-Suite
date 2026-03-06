#!/usr/bin/env node
/**
 * 3CXTools-Relay — Entry Point (HTTP Push Architecture)
 *
 * Split polling architecture:
 *   FAST (750ms): ActiveCalls only — detects call state changes instantly
 *   SLOW (10s):   Users — profile/registration changes
 *   SLOW (60s):   Queue definitions — names, numbers (almost never change)
 *   SLOW (3min):  Queue agent membership — which agents belong to which queue
 *   SLOW (30s):   Report API — day totals (answered, abandoned, avg wait)
 *
 * Agent login/logout: Event-driven via PBX MyPhone WebSocket (no polling).
 * Change detection: Fingerprinting — only pushes when state actually differs.
 * Transport: HTTP POST to wallboard + optional HTTP POST to auto-pager.
 */

import { loadConfig } from './config';
import { Collector } from './collector';
import type { ActiveCall, PbxQueue, PbxUser, QueueAgent, QueueDetailedStats } from './collector';
import { QueueMonitor } from './monitor';
import { StateManager } from './state-manager';
import type { RelayQueueData, RelayAgentData, RelayQueuedCall, RelayPushPayload, RelayReportStats } from './state-manager';
import { Pusher } from './pusher';

// ─── Config ───────────────────────────────────────────────────

const SLOW_USERS_INTERVAL_MS = 10_000;      // User profiles/registration
const SLOW_QUEUES_INTERVAL_MS = 60_000;      // Queue definitions
const SLOW_AGENTS_INTERVAL_MS = 10_000;      // Queue agent membership (10s — must detect adds/removes quickly)
const REPORT_API_INTERVAL_MS = 15_000;       // Report API stats (15s for faster answered/abandoned updates)
const PBX_TIMEZONE = 'America/Chicago';      // TODO: make configurable or detect from PBX

// ─── Main ─────────────────────────────────────────────────────

const config = loadConfig();
const collector = new Collector(config.pbxUrl, config.pbxExtension, config.pbxPassword);
const monitor = new QueueMonitor(config.pbxUrl, config.pbxExtension, config.pbxPassword);
const stateManager = new StateManager();

// HTTP Pushers — wallboard is required, auto-pager is optional
const wallboardPusher = new Pusher(config.wallboardUrl, config.apiKey);

const autoPagerPusher = config.autoPagerUrl && config.autoPagerApiKey
  ? new Pusher(config.autoPagerUrl, config.autoPagerApiKey)
  : null;

let running = true;
let fastTimer: ReturnType<typeof setTimeout> | null = null;
let _fastPollCount = 0;
let _pushCount = 0;

// ─── Cached slow data ────────────────────────────────────────

let cachedQueues: PbxQueue[] = [];
let cachedUsers: PbxUser[] = [];
let cachedUserMap = new Map<string, PbxUser>();
const queueAgentCache = new Map<number, string[]>(); // queueId → ext numbers

let lastUsersFetch = 0;
let lastQueuesFetch = 0;
let lastAgentsFetch = 0;
let lastReportFetch = 0;

// ─── Wire up event-driven pushes ──────────────────────────────

stateManager.on('change', (payload: RelayPushPayload) => {
  // Push to wallboard via HTTP
  if (!wallboardPusher.isAuthFailed()) {
    wallboardPusher.push(payload).then(r => { if (r.success) _pushCount++; }).catch(() => {});
  }

  // Push to auto-pager via HTTP
  if (autoPagerPusher && !autoPagerPusher.isAuthFailed()) {
    autoPagerPusher.push(payload).catch(() => {});
  }

  if (config.logLevel === 'debug') {
    const totalWaiting = payload.queues.reduce((s, q) => s + q.callsWaiting, 0);
    console.log(`[Relay] CHANGE: ${payload.queues.length}q, ${totalWaiting} waiting`);
  }
});

stateManager.on('sync', (payload: RelayPushPayload) => {
  if (!wallboardPusher.isAuthFailed()) {
    wallboardPusher.push(payload).then(r => { if (r.success) _pushCount++; }).catch(() => {});
  }

  if (autoPagerPusher && !autoPagerPusher.isAuthFailed()) {
    autoPagerPusher.push(payload).catch(() => {});
  }
});

// ─── Slow data refresh ───────────────────────────────────────

async function refreshSlowData(): Promise<void> {
  const now = Date.now();

  // Users — every 10s (profile changes, registration status)
  if (now - lastUsersFetch >= SLOW_USERS_INTERVAL_MS) {
    try {
      cachedUsers = await collector.getUsers();
      cachedUserMap = new Map(cachedUsers.map(u => [u.Number, u]));
      lastUsersFetch = now;
    } catch (err) {
      console.error('[Relay] Users refresh failed:', err instanceof Error ? err.message : err);
    }
  }

  // Queue definitions — every 60s (names, numbers — almost never change)
  if (now - lastQueuesFetch >= SLOW_QUEUES_INTERVAL_MS) {
    try {
      cachedQueues = await collector.getQueues();
      lastQueuesFetch = now;
    } catch (err) {
      console.error('[Relay] Queues refresh failed:', err instanceof Error ? err.message : err);
    }
  }

  // Queue agent membership — every 3min (which agents belong to which queue)
  if (now - lastAgentsFetch >= SLOW_AGENTS_INTERVAL_MS) {
    try {
      const results = await Promise.all(
        cachedQueues.map(q => collector.getQueueAgents(q.Id).then(agents => ({ id: q.Id, agents })))
      );
      for (const { id, agents } of results) {
        queueAgentCache.set(id, agents.map(a => a.Number));
      }
      lastAgentsFetch = now;
    } catch (err) {
      console.error('[Relay] Agent membership refresh failed:', err instanceof Error ? err.message : err);
    }
  }

  // Report API — every 30s (day totals: answered, abandoned, avg wait)
  if (now - lastReportFetch >= REPORT_API_INTERVAL_MS) {
    try {
      const nowDate = new Date();
      const dayStart = getMidnightInTimezone(PBX_TIMEZONE, nowDate);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const windowMinutes = 60; // 1hr window, same as wallboard default
      const windowStart = new Date(now - windowMinutes * 60 * 1000);

      const [windowedRaw, fullDayRaw] = await Promise.all([
        collector.getQueueDetailedStats(windowStart.toISOString(), nowDate.toISOString()),
        collector.getQueueDetailedStats(dayStart.toISOString(), dayEnd.toISOString()),
      ]);

      const toRelay = (s: QueueDetailedStats): RelayReportStats => ({
        queueNumber: s.QueueDnNumber,
        callsCount: s.CallsCount,
        answeredCount: s.AnsweredCount,
        avgRingTime: s.AvgRingTime,
        avgTalkTime: s.AvgTalkTime,
        ringTime: s.RingTime,
        talkTime: s.TalkTime,
      });

      stateManager.setReportStats({
        windowedStats: windowedRaw.map(toRelay),
        fullDayStats: fullDayRaw.map(toRelay),
        windowMinutes,
        pbxTimezone: PBX_TIMEZONE,
      });

      lastReportFetch = now;

      if (config.logLevel === 'debug') {
        console.log(`[Relay] Report API: ${fullDayRaw.length} queues, window=${windowMinutes}min`);
      }
    } catch (err) {
      console.error('[Relay] Report API failed:', err instanceof Error ? err.message : err);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function getMidnightInTimezone(tz: string, now: Date): Date {
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  const [y, m, d] = dateStr.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const localNoon = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  }).format(noonUtc);
  const localHour = parseInt(localNoon, 10);
  const offsetHours = localHour - 12;
  return new Date(Date.UTC(y, m - 1, d, -offsetHours, 0, 0));
}

/**
 * Extract extension number from formatted 3CX fields.
 * "1002 tools, admin" → "1002", "8003 - Queue 1" → "8003"
 */
function extractExt(field: string): string {
  return field.split(' ')[0];
}

/**
 * Fuzzy match: does this field reference the given queue number?
 * Handles exact match, extracted extension, space-separated, and suffix patterns.
 */
function calleeContainsQueue(field: string, queueNumber: string): boolean {
  if (!field) return false;
  return field === queueNumber
    || extractExt(field) === queueNumber
    || field.includes(` ${queueNumber}`)
    || field.endsWith(queueNumber);
}

function deriveCallState(
  ext: string,
  activeCalls: ActiveCall[],
  user: PbxUser | undefined,
  allQueueNumbers: Set<string>
): 'available' | 'talking' | 'ringing' | 'offline' {
  if (!user?.IsRegistered) return 'offline';

  for (const call of activeCalls) {
    const callerExt = extractExt(call.Caller || '');
    const calleeExt = extractExt(call.Callee || '');

    if (callerExt === ext || calleeExt === ext) {
      const status = (call.Status || '').toLowerCase();

      // "Talking" to a queue number means the caller is hearing hold music,
      // not that an agent is talking. Don't count as 'talking' for the agent.
      if (calleeExt === ext && allQueueNumbers.has(callerExt)) continue;
      if (callerExt === ext && allQueueNumbers.has(calleeExt)) continue;

      if (status.includes('talking') || status.includes('connected')) return 'talking';
      if (status.includes('ringing') || status.includes('routing')) return 'ringing';
    }

    if (call.Segments) {
      for (const seg of call.Segments) {
        const segFields = [seg.Dn, seg.DialedDn, seg.CallerNumber, seg.CalleeNumber];
        const matchesExt = segFields.some(f => f != null && extractExt(f) === ext);
        if (matchesExt) {
          const segStatus = (seg.Status || '').toLowerCase();
          if (segStatus.includes('talking') || segStatus.includes('connected')) return 'talking';
          if (segStatus.includes('ringing') || segStatus.includes('routing')) return 'ringing';
        }
      }
    }
  }

  return 'available';
}

/**
 * Detect calls waiting in a queue from ActiveCalls.
 * Ported from wallboard's proven 3-method detection logic.
 *
 * Method 1: "Talking"/"Connected" to queue itself = still waiting (hold music)
 * Method 2: Callee or segment fields reference queue (routing/ringing/transferring)
 * Method 3: "Routing" to a known queue agent with no segments = early ring phase
 */
function computeQueuedCalls(
  queueNumber: string,
  activeCalls: ActiveCall[],
  serverNow: Date,
  allAgentExts: Set<string>
): { queuedCalls: RelayQueuedCall[]; callsWaiting: number; longestWaitSec: number } {
  const queuedCalls: RelayQueuedCall[] = [];
  let longestWaitSec = 0;

  const matchesQueue = (field: string | undefined): boolean =>
    field != null && calleeContainsQueue(field, queueNumber);

  for (const call of activeCalls) {
    const topStatus = (call.Status || '').toLowerCase();
    const isTalkingOrConnected = topStatus.includes('talking') || topStatus.includes('connected');

    let isQueued = false;

    // Method 1: "Talking"/"Connected" to the queue itself = still waiting (hold music)
    if (isTalkingOrConnected && matchesQueue(call.Callee)) {
      isQueued = true;
    }
    // If talking/connected but NOT to queue → agent answered → skip
    else if (isTalkingOrConnected) {
      isQueued = false;
    }
    // Method 2a: Callee directly references queue (routing/ringing/transferring)
    else if (matchesQueue(call.Callee)) {
      isQueued = true;
    }
    // Method 2b: Any segment field references queue
    else if (call.Segments) {
      const hasQueueRef = call.Segments.some(seg =>
        [seg.CallerNumber, seg.CalleeNumber, seg.DialedDn, seg.Dn]
          .some(f => matchesQueue(f))
      );
      if (hasQueueRef) isQueued = true;
    }

    // Method 3: "Routing" to a known queue agent with no segments = early ring phase
    if (!isQueued && (!call.Segments || call.Segments.length === 0) && topStatus.includes('routing')) {
      const calleeExt = extractExt(call.Callee || '');
      if (allAgentExts.has(calleeExt)) isQueued = true;
    }

    if (!isQueued) continue;

    let waitSec = 0;
    const changeTime = call.LastChangeStatus || call.EstablishedAt;
    if (changeTime) {
      const callTime = new Date(changeTime);
      waitSec = Math.max(0, Math.floor((serverNow.getTime() - callTime.getTime()) / 1000));
    }

    longestWaitSec = Math.max(longestWaitSec, waitSec);

    queuedCalls.push({
      id: call.Id,
      caller: call.Caller || '',
      callerName: '',
      waitSec,
      startedAt: changeTime || new Date().toISOString(),
    });
  }

  return { queuedCalls, callsWaiting: queuedCalls.length, longestWaitSec };
}

// ─── Fast Poll Loop (750ms — ActiveCalls only) ───────────────

async function fastPoll(): Promise<void> {
  if (!running) return;

  try {
    // Check if slow data needs refreshing (runs inline, skips if not due)
    await refreshSlowData();

    // FAST: Only fetch active calls every cycle
    const activeCalls = await collector.getActiveCalls();

    // Debug logging for active calls (only in debug mode)
    if (config.logLevel === 'debug' && activeCalls.length > 0) {
      for (const call of activeCalls) {
        console.log(`[DEBUG] ActiveCall id=${call.Id} caller=${call.Caller} callee=${call.Callee} status=${call.Status} segments=${call.Segments?.length ?? 0}`);
      }
    }

    const serverNow = activeCalls.length > 0 && activeCalls[0].ServerNow
      ? new Date(activeCalls[0].ServerNow)
      : new Date();

    // Build per-queue data using cached slow data + fresh active calls
    const relayQueues: RelayQueueData[] = [];

    // Precompute queue number set (for deriveCallState to ignore queue-waiting calls)
    const allQueueNumbers = new Set(cachedQueues.map(q => q.Number));

    // Precompute all agent extensions across all queues (for Method 3 detection)
    const allAgentExts = new Set<string>();
    for (const exts of queueAgentCache.values()) {
      for (const ext of exts) allAgentExts.add(ext);
    }

    for (const queue of cachedQueues) {
      const agentExts = queueAgentCache.get(queue.Id) ?? [];

      const agents: RelayAgentData[] = [];
      for (const ext of agentExts) {
        const user = cachedUserMap.get(ext);
        const callState = deriveCallState(ext, activeCalls, user, allQueueNumbers);
        const wsLoggedIn = monitor.isAgentLoggedIn(queue.Number, ext);
        // WebSocket monitor is authoritative for per-queue login status.
        // Fallback to REST API QueueStatus (global — logged into ANY queue = "LoggedIn").
        // Not perfect for per-queue, but much better than defaulting to true.
        const loggedIn = wsLoggedIn ?? (user?.QueueStatus === 'LoggedIn');

        agents.push({
          ext,
          name: user ? `${user.FirstName} ${user.LastName}`.trim() : ext,
          loggedIn,
          callState,
          profileName: user?.CurrentProfileName ?? 'Unknown',
          isRegistered: user?.IsRegistered ?? false,
        });
      }

      const { queuedCalls, callsWaiting, longestWaitSec } = computeQueuedCalls(
        queue.Number, activeCalls, serverNow, allAgentExts
      );

      relayQueues.push({
        id: queue.Id,
        number: queue.Number,
        name: queue.Name,
        callsWaiting,
        longestWaitSec,
        agents,
        queuedCalls,
      });
    }

    // Feed into StateManager — it will emit 'change' or 'sync' as needed
    stateManager.update(relayQueues);
    _fastPollCount++;

  } catch (err) {
    console.error('[Relay] Poll error:', err instanceof Error ? err.message : err);
  }

  // Schedule next fast poll
  if (running) {
    fastTimer = setTimeout(fastPoll, config.pollIntervalMs);
  }
}

// ─── Status logging ───────────────────────────────────────────

function logStatus(): void {
  if (!running) return;
  const wb = wallboardPusher.isAuthFailed() ? 'auth-failed' : 'active';
  const mon = monitor.hasData() ? 'active' : 'waiting';
  const ap = autoPagerPusher ? (autoPagerPusher.isAuthFailed() ? 'auth-failed' : 'active') : 'n/a';
  const qCount = cachedQueues.length;
  const aCount = Array.from(queueAgentCache.values()).reduce((s, a) => s + a.length, 0);
  console.log(`[Relay] wallboard=${wb} mon=${mon} polls=${_fastPollCount} pushes=${_pushCount} queues=${qCount} agents=${aCount} autopager=${ap}`);
  _fastPollCount = 0;
  _pushCount = 0;
}

// ─── Start ────────────────────────────────────────────────────

async function start(): Promise<void> {
  console.log('=== 3CXTools-Relay ===');
  console.log(`PBX: ${config.pbxUrl}`);
  console.log(`Wallboard: ${config.wallboardUrl}/api/relay/push`);
  if (config.autoPagerUrl) console.log(`Auto-Pager: ${config.autoPagerUrl}/api/relay/push`);
  console.log(`Fast poll: ${config.pollIntervalMs}ms | Users: ${SLOW_USERS_INTERVAL_MS / 1000}s | Queues: ${SLOW_QUEUES_INTERVAL_MS / 1000}s | Agents: ${SLOW_AGENTS_INTERVAL_MS / 1000}s | Report: ${REPORT_API_INTERVAL_MS / 1000}s`);
  console.log(`Log level: ${config.logLevel}`);
  console.log();

  // Test PBX authentication
  try {
    console.log('[Relay] Authenticating with PBX...');
    await collector.authenticate();
    console.log('[Relay] PBX authentication successful');
  } catch (err) {
    console.error('[Relay] PBX authentication failed:', err instanceof Error ? err.message : err);
    console.error('[Relay] Check pbxUrl, pbxExtension, and pbxPassword');
    process.exit(1);
  }

  // Pre-fetch all slow data before starting the fast loop
  console.log('[Relay] Loading initial data...');
  try {
    const [queues, users] = await Promise.all([
      collector.getQueues(),
      collector.getUsers(),
    ]);
    cachedQueues = queues;
    cachedUsers = users;
    cachedUserMap = new Map(users.map(u => [u.Number, u]));
    lastQueuesFetch = Date.now();
    lastUsersFetch = Date.now();

    console.log(`[Relay] Found ${queues.length} queues, ${users.length} users`);

    // Fetch agent memberships for all queues
    const agentResults = await Promise.all(
      queues.map(q => collector.getQueueAgents(q.Id).then(agents => ({ id: q.Id, agents })))
    );
    for (const { id, agents } of agentResults) {
      queueAgentCache.set(id, agents.map(a => a.Number));
    }
    lastAgentsFetch = Date.now();

    const totalAgents = agentResults.reduce((s, r) => s + r.agents.length, 0);
    console.log(`[Relay] Loaded agent memberships: ${totalAgents} total across ${queues.length} queues`);
  } catch (err) {
    console.error('[Relay] Initial data load failed:', err instanceof Error ? err.message : err);
    console.error('[Relay] Will retry on first poll cycle');
  }

  // Start PBX WebSocket queue monitor for event-driven agent login/logout
  console.log('[Relay] Starting PBX queue monitor...');
  monitor.start().catch(err => {
    console.error('[Relay] Monitor start error:', err instanceof Error ? err.message : err);
  });

  // Wait briefly for monitor to connect before first poll
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Start fast poll loop
  console.log(`[Relay] Starting fast poll loop (${config.pollIntervalMs}ms)`);
  fastPoll();

  // Periodic status log every 30s
  const statusInterval = setInterval(logStatus, 30_000);

  // Clean up on shutdown
  const origShutdown = shutdown;
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.on('SIGTERM', () => { clearInterval(statusInterval); origShutdown(); });
  process.on('SIGINT', () => { clearInterval(statusInterval); origShutdown(); });
}

function shutdown(): void {
  console.log('\n[Relay] Shutting down...');
  running = false;
  if (fastTimer) {
    clearTimeout(fastTimer);
    fastTimer = null;
  }
  monitor.stop();
  console.log('[Relay] Stopped');
  process.exit(0);
}

// Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start
start().catch(err => {
  console.error('[Relay] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
