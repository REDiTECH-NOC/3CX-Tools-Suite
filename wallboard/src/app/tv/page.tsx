'use client';

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWallboardSSE } from '@/hooks/use-wallboard-sse';
import { useThresholdColor, getThresholdClass } from '@/hooks/use-threshold-color';
import { useClock } from '@/hooks/use-clock';
import { trpc } from '@/lib/trpc';
import type {
  WallboardColumn,
  QueueWallboardData,
  ColumnDefinition,
  ThresholdLevel,
} from '@/types/wallboard';
import { COLUMN_DEFINITIONS } from '@/types/wallboard';
import {
  Phone,
  Users,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  TrendingDown,
  Maximize,
  Wifi,
  WifiOff,
  Activity,
  Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Default visible columns for TV mode.
 */
const TV_VISIBLE_COLUMNS: WallboardColumn[] = COLUMN_DEFINITIONS
  .filter((col) => col.defaultVisible)
  .map((col) => col.key);

/**
 * Auto-scroll configuration.
 */
const SCROLL_PAUSE_MS = 4000; // Pause at top/bottom
const SCROLL_STEP_PX = 2; // Pixels per frame
const SCROLL_INTERVAL_MS = 30; // Interval between scroll frames

/**
 * Format seconds into "M:SS" display string.
 */
function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatPercent(value: number): string {
  if (value === 0) return '0.0%';
  return `${value.toFixed(1)}%`;
}

function getColumnValue(
  queue: QueueWallboardData,
  key: WallboardColumn,
): number | string {
  switch (key) {
    case 'queueName':
      return queue.queueName;
    case 'currentWait':
      return queue.longestWaitSec;
    case 'avgWait':
      return queue.avgWaitSec;
    case 'totalAvgWait':
      return queue.totalAvgWaitSec;
    case 'agentsAvailable':
      return queue.agentsAvailable;
    case 'agentsTalking':
      return queue.agentsTalking;
    case 'agentsLoggedIn':
      return queue.agentsLoggedIn;
    case 'callsQueued':
      return queue.callsWaiting;
    case 'callsAnswered':
      return queue.callsAnswered;
    case 'callsAbandoned':
      return queue.callsAbandoned;
    case 'abandonRate':
      return queue.abandonRate;
    default:
      return 0;
  }
}

function formatValue(
  value: number | string,
  format: ColumnDefinition['format'],
): string {
  if (typeof value === 'string') return value;
  switch (format) {
    case 'time':
      return formatTime(value);
    case 'percent':
      return formatPercent(value);
    case 'number':
      return String(value);
    case 'text':
      return String(value);
    default:
      return String(value);
  }
}

// ---- Stat Card for TV Summary ----

function getStatBorderColor(level?: ThresholdLevel): string {
  switch (level) {
    case 'red':
      return 'border-red-500/50';
    case 'yellow':
      return 'border-amber-500/50';
    case 'green':
      return 'border-emerald-500/40';
    default:
      return 'border-border/50';
  }
}

function getStatBgColor(level?: ThresholdLevel): string {
  switch (level) {
    case 'red':
      return 'bg-red-500/10';
    case 'yellow':
      return 'bg-amber-500/10';
    case 'green':
      return 'bg-emerald-500/5';
    default:
      return 'bg-card/50';
  }
}

function getStatValueColor(level?: ThresholdLevel): string {
  switch (level) {
    case 'red':
      return 'text-red-600 dark:text-red-400';
    case 'yellow':
      return 'text-amber-600 dark:text-amber-400';
    case 'green':
      return 'text-emerald-600 dark:text-emerald-400';
    default:
      return 'text-foreground';
  }
}

function TVStatCard({
  icon,
  label,
  value,
  thresholdLevel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  thresholdLevel?: ThresholdLevel;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-xl border-2 px-6 py-4 transition-colors',
        getStatBorderColor(thresholdLevel),
        getStatBgColor(thresholdLevel),
      )}
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted/50">
        {icon}
      </div>
      <div className="flex flex-col">
        <span className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'text-3xl font-bold tabular-nums leading-tight',
            getStatValueColor(thresholdLevel),
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

// ---- Main TV Page ----

/**
 * TV/Kiosk mode wallboard page.
 *
 * Designed for large displays:
 * - Fullscreen with no navigation chrome
 * - Enlarged fonts and spacing
 * - Auto-scrolling queue grid when content exceeds viewport
 * - Wake Lock API to prevent screen sleep
 * - Escape key exits to /wallboard
 * - Fullscreen button in top-left corner
 */
export default function TVPage() {
  const router = useRouter();
  const clock = useClock();

  // ---- SSE data feed ----
  const { data, isConnected, lastUpdate, dataMode } = useWallboardSSE();

  // ---- Thresholds ----
  const thresholdsQuery = trpc.wallboard.getThresholds.useQuery(undefined, {
    staleTime: 60_000,
  });
  const thresholds = useMemo(
    () => thresholdsQuery.data ?? [],
    [thresholdsQuery.data],
  );
  const { getThresholdLevel } = useThresholdColor(thresholds);

  // ---- Column definitions ----
  const columns = useMemo(() => {
    return TV_VISIBLE_COLUMNS
      .map((key) => COLUMN_DEFINITIONS.find((def) => def.key === key))
      .filter((def): def is ColumnDefinition => def !== undefined);
  }, []);

  // ---- Wake Lock ----
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let active = true;

    async function requestWakeLock() {
      if (!active) return;
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          wakeLockRef.current.addEventListener('release', () => {
            // Re-acquire on release (e.g., tab visibility change)
            if (active) {
              requestWakeLock();
            }
          });
        }
      } catch {
        // Wake Lock not available or denied -- silently ignore
      }
    }

    requestWakeLock();

    // Re-acquire on visibility change (browsers release on tab hide)
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && active) {
        requestWakeLock();
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
  }, []);

  // ---- Escape key handler ----
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Exit fullscreen first if active
        if (document.fullscreenElement) {
          document.exitFullscreen();
        }
        router.push('/wallboard');
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router]);

  // ---- Fullscreen toggle ----
  const handleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {
        // Fullscreen not available
      });
    }
  }, []);

  // ---- Auto-scroll ----
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollDirectionRef = useRef<'down' | 'up'>('down');
  const scrollPausedUntilRef = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      const el = gridRef.current;
      if (!el) return;

      const now = Date.now();
      if (now < scrollPausedUntilRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = el;
      const maxScroll = scrollHeight - clientHeight;

      // No scrolling needed if content fits
      if (maxScroll <= 0) return;

      if (scrollDirectionRef.current === 'down') {
        if (scrollTop >= maxScroll - 2) {
          // Reached bottom -- pause then scroll up
          scrollPausedUntilRef.current = now + SCROLL_PAUSE_MS;
          scrollDirectionRef.current = 'up';
        } else {
          el.scrollTop = Math.min(scrollTop + SCROLL_STEP_PX, maxScroll);
        }
      } else {
        if (scrollTop <= 2) {
          // Reached top -- pause then scroll down
          scrollPausedUntilRef.current = now + SCROLL_PAUSE_MS;
          scrollDirectionRef.current = 'down';
        } else {
          el.scrollTop = Math.max(scrollTop - SCROLL_STEP_PX, 0);
        }
      }
    }, SCROLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  // ---- Last update text ----
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const lastUpdateText = useMemo(() => {
    if (!lastUpdate) return 'Waiting...';
    const diffMs = Date.now() - lastUpdate.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 5) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    return `${diffMin}m ago`;
  }, [lastUpdate]);

  // ---- Loading state ----
  if (!data) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <p className="text-lg font-medium text-foreground">
            Connecting to wallboard...
          </p>
        </div>
      </div>
    );
  }

  const totals = data.totals;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      {/* ---- Top Bar: Fullscreen + Title + Clock ---- */}
      <div className="flex shrink-0 items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={handleFullscreen}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
            title="Toggle fullscreen (press Escape to exit TV mode)"
          >
            <Maximize className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <Phone className="h-5 w-5 text-muted-foreground" />
            <span className="text-lg font-semibold text-foreground">
              3CX Wallboard
            </span>
          </div>
        </div>

        {/* Clock */}
        <div className="font-mono text-3xl font-bold tabular-nums text-foreground">
          {clock}
        </div>
      </div>

      {/* ---- Summary Bar ---- */}
      <div className="shrink-0 px-6 pb-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <TVStatCard
            icon={<Phone className="h-6 w-6 text-muted-foreground" />}
            label="Calls Waiting"
            value={totals.totalCallsWaiting}
            thresholdLevel={getThresholdLevel(
              totals.totalCallsWaiting,
              'callsQueued',
            )}
          />
          <TVStatCard
            icon={<Users className="h-6 w-6 text-muted-foreground" />}
            label="Agents Available"
            value={totals.totalAgentsAvailable}
            thresholdLevel={getThresholdLevel(
              totals.totalAgentsAvailable,
              'agentsAvailable',
            )}
          />
          <TVStatCard
            icon={<PhoneCall className="h-6 w-6 text-muted-foreground" />}
            label="Agents Talking"
            value={totals.totalAgentsTalking}
          />
          <TVStatCard
            icon={
              <PhoneIncoming className="h-6 w-6 text-muted-foreground" />
            }
            label="Answered Today"
            value={totals.totalAnsweredToday}
          />
          <TVStatCard
            icon={
              <PhoneMissed className="h-6 w-6 text-muted-foreground" />
            }
            label="Abandoned Today"
            value={totals.totalAbandonedToday}
            thresholdLevel={getThresholdLevel(
              totals.totalAbandonedToday,
              'callsAbandoned',
            )}
          />
          <TVStatCard
            icon={
              <TrendingDown className="h-6 w-6 text-muted-foreground" />
            }
            label="Abandon Rate"
            value={
              totals.overallAbandonRate === 0
                ? '0%'
                : `${totals.overallAbandonRate.toFixed(1)}%`
            }
            thresholdLevel={getThresholdLevel(
              totals.overallAbandonRate,
              'abandonRate',
            )}
          />
        </div>
      </div>

      {/* ---- Queue Grid ---- */}
      <div
        ref={gridRef}
        className="flex-1 overflow-auto px-6 pb-2"
      >
        <table className="w-full caption-bottom text-base">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
            <tr className="border-b-2 border-border/60">
              {columns.map((col) => {
                const isTextCol = col.format === 'text';
                return (
                  <th
                    key={col.key}
                    className={cn(
                      'whitespace-nowrap px-5 py-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground',
                      !isTextCol && 'text-right',
                    )}
                  >
                    {col.shortLabel}
                  </th>
                );
              })}
            </tr>
          </thead>

          {data.queues.map((queue) => (
            <tbody key={queue.queueId} className="group">
              <tr className="border-b border-border/40 transition-colors hover:bg-accent/20">
                {columns.map((col) => {
                  const rawValue = getColumnValue(queue, col.key);
                  const displayValue = formatValue(rawValue, col.format);

                  let thresholdCls = '';
                  if (col.thresholdMetric && typeof rawValue === 'number') {
                    const level = getThresholdLevel(
                      rawValue,
                      col.thresholdMetric,
                      String(queue.queueId),
                    );
                    thresholdCls = getThresholdClass(level);
                  }

                  if (col.key === 'queueName') {
                    return (
                      <td
                        key={col.key}
                        className="px-5 py-3 text-base font-semibold text-foreground"
                      >
                        <div className="flex items-center gap-3">
                          <span className="truncate">{displayValue}</span>
                          <span className="shrink-0 font-mono text-sm text-muted-foreground">
                            #{queue.queueNumber}
                          </span>
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                            {queue.agentsLoggedIn}/{queue.agentsTotal}
                          </span>
                        </div>
                      </td>
                    );
                  }

                  return (
                    <td
                      key={col.key}
                      className={cn(
                        'px-5 py-3 text-base font-medium tabular-nums',
                        thresholdCls,
                        col.format !== 'text' && 'text-right',
                      )}
                    >
                      {displayValue}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          ))}

          {data.queues.length === 0 && (
            <tbody>
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-16 text-center text-lg text-muted-foreground"
                >
                  No queues configured
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>

      {/* ---- Status Footer (minimal) ---- */}
      <footer className="flex shrink-0 items-center justify-between border-t border-border/30 bg-card/30 px-6 py-1.5">
        {/* Left: Connection status */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            {isConnected ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <Wifi className="h-3 w-3 text-emerald-500" />
              </>
            ) : (
              <>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                <WifiOff className="h-3 w-3 text-red-500" />
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {dataMode === 'realtime' ? (
              <Radio className="h-3 w-3 text-emerald-500" />
            ) : (
              <Activity className="h-3 w-3" />
            )}
          </div>
        </div>

        {/* Center: hint */}
        <span className="text-[10px] text-muted-foreground/50">
          Press Escape to exit TV mode
        </span>

        {/* Right: last updated */}
        <span className="text-xs text-muted-foreground">
          Updated {lastUpdateText}
        </span>
      </footer>
    </div>
  );
}
