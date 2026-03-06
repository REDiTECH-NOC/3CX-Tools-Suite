'use client';

import { useMemo, useCallback, useState, useEffect } from 'react';
import { useWallboardSSE } from '@/hooks/use-wallboard-sse';
import { useThresholdColor } from '@/hooks/use-threshold-color';
import { useSoundAlert } from '@/hooks/use-sound-alert';
import { trpc } from '@/lib/trpc';
import type { WallboardColumn } from '@/types/wallboard';
import { COLUMN_DEFINITIONS } from '@/types/wallboard';
import { AnalyticsPanel } from '@/components/analytics/analytics-panel';
import { SummaryBar } from '@/components/wallboard/summary-bar';
import { QueueGrid } from '@/components/wallboard/queue-grid';
import { StatusFooter } from '@/components/wallboard/status-footer';
import { Loader2, AlertTriangle } from 'lucide-react';

/**
 * Default visible columns used when user preferences have not been set.
 */
const DEFAULT_VISIBLE_COLUMNS: WallboardColumn[] = COLUMN_DEFINITIONS
  .filter((col) => col.defaultVisible)
  .map((col) => col.key);

/**
 * Main wallboard page.
 *
 * Layout (top to bottom):
 * 1. AnalyticsPanel (collapsible charts)
 * 2. SummaryBar (aggregate totals)
 * 3. QueueGrid (sortable table with expandable rows)
 * 4. StatusFooter (connection status, last update)
 */
export default function WallboardPage() {
  // ---- SSE data feed ----
  const { data, isConnected, lastUpdate, error, dataMode } = useWallboardSSE();

  // ---- Server queries ----
  const thresholdsQuery = trpc.wallboard.getThresholds.useQuery(undefined, {
    staleTime: 60_000, // thresholds change rarely
  });

  const prefsQuery = trpc.wallboard.getPreferences.useQuery(undefined, {
    staleTime: 30_000,
  });

  const myQueueStatusQuery = trpc.queueActions.getMyQueueStatus.useQuery(
    undefined,
    {
      refetchInterval: 30_000, // refresh every 30s
    },
  );

  const updatePrefsMutation = trpc.wallboard.updatePreferences.useMutation({
    onSuccess: () => {
      prefsQuery.refetch();
    },
  });

  // ---- Threshold color hook ----
  const thresholds = useMemo(
    () => thresholdsQuery.data ?? [],
    [thresholdsQuery.data],
  );
  const { getThresholdLevel } = useThresholdColor(thresholds);

  // ---- User preferences ----
  const prefs = prefsQuery.data;

  const visibleColumns = useMemo<WallboardColumn[]>(() => {
    if (prefs?.visibleColumns && Array.isArray(prefs.visibleColumns) && prefs.visibleColumns.length > 0) {
      return prefs.visibleColumns as WallboardColumn[];
    }
    return DEFAULT_VISIBLE_COLUMNS;
  }, [prefs?.visibleColumns]);

  const pinnedQueues = useMemo<string[]>(() => {
    if (prefs?.pinnedQueues && Array.isArray(prefs.pinnedQueues)) {
      return prefs.pinnedQueues as string[];
    }
    return [];
  }, [prefs?.pinnedQueues]);

  const sortColumn = useMemo<WallboardColumn | null>(() => {
    return (prefs?.sortColumn as WallboardColumn | null) ?? null;
  }, [prefs?.sortColumn]);

  const sortDirection = useMemo<'asc' | 'desc'>(() => {
    return (prefs?.sortDirection as 'asc' | 'desc') ?? 'asc';
  }, [prefs?.sortDirection]);

  const density = useMemo<'compact' | 'comfortable' | 'spacious'>(() => {
    return (prefs?.rowDensity as 'compact' | 'comfortable' | 'spacious') ?? 'comfortable';
  }, [prefs?.rowDensity]);

  const fontSize = useMemo<'small' | 'medium' | 'large'>(() => {
    return (prefs?.fontSize as 'small' | 'medium' | 'large') ?? 'medium';
  }, [prefs?.fontSize]);

  const autoExpandRows = useMemo(() => {
    return prefs?.autoExpandRows ?? false;
  }, [prefs?.autoExpandRows]);

  const analyticsCollapsed = useMemo(() => {
    return prefs?.analyticsCollapsed ?? true;
  }, [prefs?.analyticsCollapsed]);

  const columnOrder = useMemo<WallboardColumn[]>(() => {
    if (prefs?.columnOrder && Array.isArray(prefs.columnOrder) && prefs.columnOrder.length > 0) {
      return prefs.columnOrder as WallboardColumn[];
    }
    return COLUMN_DEFINITIONS.map((col) => col.key);
  }, [prefs?.columnOrder]);

  const queueOrderMode = useMemo<'default' | 'manual' | 'watch'>(() => {
    return (prefs?.queueOrderMode as 'default' | 'manual' | 'watch') ?? 'default';
  }, [prefs?.queueOrderMode]);

  const manualQueueOrder = useMemo<string[]>(() => {
    if (prefs?.manualQueueOrder && Array.isArray(prefs.manualQueueOrder)) {
      return prefs.manualQueueOrder as string[];
    }
    return [];
  }, [prefs?.manualQueueOrder]);

  const watchColumn = useMemo<WallboardColumn | null>(() => {
    return (prefs?.watchColumn as WallboardColumn | null) ?? null;
  }, [prefs?.watchColumn]);

  const soundAlerts = useMemo<Record<string, unknown>>(() => {
    if (prefs?.soundAlerts && typeof prefs.soundAlerts === 'object') {
      return prefs.soundAlerts as Record<string, unknown>;
    }
    return {};
  }, [prefs?.soundAlerts]);

  // ---- Sound alerts ----
  const soundEnabled = useMemo(() => {
    // Check if any metric has sound or push enabled (supports both old and new format)
    return Object.values(soundAlerts).some((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'object' && v !== null) {
        const cfg = v as { sound?: boolean; push?: boolean };
        return cfg.sound || cfg.push;
      }
      return false;
    });
  }, [soundAlerts]);

  useSoundAlert({
    state: data,
    getThresholdLevel,
    soundAlerts,
    enabled: soundEnabled,
  });

  // ---- Queue status map ----
  const myQueueStatus = useMemo<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    if (myQueueStatusQuery.data) {
      for (const qs of myQueueStatusQuery.data) {
        map[qs.queueId] = qs.loggedIn;
      }
    }
    return map;
  }, [myQueueStatusQuery.data]);

  // ---- Current user (for manager detection) ----
  const meQuery = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  const currentUserExtension = meQuery.data?.extensionNumber ?? null;
  const currentUserRole = meQuery.data?.role ?? null;

  // ---- Sort handler ----
  const handleSortChange = useCallback(
    (column: WallboardColumn) => {
      let newDirection: 'asc' | 'desc' = 'asc';
      if (sortColumn === column) {
        newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      }
      updatePrefsMutation.mutate({
        sortColumn: column,
        sortDirection: newDirection,
      });
    },
    [sortColumn, sortDirection, updatePrefsMutation],
  );

  // ---- Column reorder handler ----
  const handleColumnReorder = useCallback(
    (newOrder: WallboardColumn[]) => {
      updatePrefsMutation.mutate({ columnOrder: newOrder });
    },
    [updatePrefsMutation],
  );

  // ---- Manual queue reorder handler ----
  const handleManualQueueReorder = useCallback(
    (newOrder: string[]) => {
      updatePrefsMutation.mutate({ manualQueueOrder: newOrder });
    },
    [updatePrefsMutation],
  );

  // ---- Watch column change handler ----
  const handleWatchColumnChange = useCallback(
    (column: WallboardColumn) => {
      updatePrefsMutation.mutate({ watchColumn: column });
    },
    [updatePrefsMutation],
  );

  // ---- Analytics panel toggle ----
  const handleToggleAnalytics = useCallback(() => {
    updatePrefsMutation.mutate({
      analyticsCollapsed: !analyticsCollapsed,
    });
  }, [analyticsCollapsed, updatePrefsMutation]);

  // ---- Threshold values for abandon rate reference lines ----
  const abandonThresholds = useMemo(() => {
    const globalAbandon = thresholds.find(
      (t) =>
        t.metric === 'abandonRate' && t.wallboardQueueId === null,
    );
    return {
      yellow: globalAbandon?.yellowValue,
      red: globalAbandon?.redValue,
    };
  }, [thresholds]);

  // ---- Last update timer (re-render every second for relative time) ----
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // ---- Loading state ----
  if (!data && !error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            Connecting to wallboard...
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Establishing real-time data feed
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Connection lost banner */}
      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 px-4 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
          <span className="text-red-300">{error}</span>
          <span className="text-xs text-red-400/70">
            {lastUpdate
              ? `Last data received ${formatRelativeTime(lastUpdate)}`
              : 'No data received yet'}
          </span>
        </div>
      )}

      {/* 1. Analytics Panel (collapsible charts) */}
      <AnalyticsPanel
        collapsed={analyticsCollapsed}
        onToggle={handleToggleAnalytics}
        abandonYellowThreshold={abandonThresholds.yellow}
        abandonRedThreshold={abandonThresholds.red}
      />

      {/* 2. Summary Bar */}
      {data?.totals && (
        <SummaryBar
          totals={data.totals}
          getThresholdLevel={getThresholdLevel}
          avgWaitWindowMinutes={data.avgWaitWindowMinutes}
          dataMode={dataMode}
        />
      )}

      {/* 3. Queue Grid */}
      {data?.queues && (
        <QueueGrid
          queues={data.queues}
          getThresholdLevel={getThresholdLevel}
          visibleColumns={visibleColumns}
          columnOrder={columnOrder}
          onColumnReorder={handleColumnReorder}
          pinnedQueues={pinnedQueues}
          myQueueStatus={myQueueStatus}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSortChange={handleSortChange}
          autoExpandRows={autoExpandRows}
          density={density}
          queueOrderMode={queueOrderMode}
          manualQueueOrder={manualQueueOrder}
          watchColumn={watchColumn}
          onManualQueueReorder={handleManualQueueReorder}
          onWatchColumnChange={handleWatchColumnChange}
          currentUserExtension={currentUserExtension}
          currentUserRole={currentUserRole}
          avgWaitWindowMinutes={data.avgWaitWindowMinutes}
        />
      )}

      {/* 4. Status Footer */}
      <StatusFooter
        isConnected={isConnected}
        lastUpdate={lastUpdate}
        dataMode={dataMode}
        pollIntervalMs={data?.pollIntervalMs}
        error={error}
      />
    </div>
  );
}

// ---- Helper ----

/**
 * Format a Date to a human-readable relative time string.
 */
function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  return `${Math.floor(diffMin / 60)}h ago`;
}
