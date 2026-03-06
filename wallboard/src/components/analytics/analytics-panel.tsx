'use client';

import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CallsByHourChart } from './calls-by-hour-chart';
import { AbandonmentTrendChart } from './abandonment-trend-chart';
import { WaitTimeTrendChart } from './wait-time-trend-chart';
import { AvgWaitTimeHourChart } from './agent-availability-chart';
import {
  ChevronDown,
  ChevronUp,
  BarChart3,
  TrendingDown,
  Clock,
  Timer,
} from 'lucide-react';

interface AnalyticsPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Optional threshold values for abandon rate reference lines */
  abandonYellowThreshold?: number;
  abandonRedThreshold?: number;
}

/**
 * Collapsible analytics panel that displays four performance charts:
 * 1. Calls by Hour (bar chart)
 * 2. Abandonment Rate Trend (area chart)
 * 3. Average Wait Time — All Queues, 24h (area chart)
 * 4. Average Wait Time — All Queues, Last Hour (area chart)
 *
 * Fetches 24-hour snapshot data with a 60-second refetch interval.
 * Collapse state is managed by the parent and persisted to user preferences.
 */
export function AnalyticsPanel({
  collapsed,
  onToggle,
  abandonYellowThreshold,
  abandonRedThreshold,
}: AnalyticsPanelProps) {
  // Fetch 24-hour snapshot data, refresh every 60 seconds
  const snapshotsQuery = trpc.wallboard.getSnapshots.useQuery(
    { hours: 24 },
    {
      refetchInterval: 60_000,
      staleTime: 30_000,
      // Don't fetch when collapsed to save bandwidth
      enabled: !collapsed,
    },
  );

  const snapshots = useMemo(
    () => snapshotsQuery.data ?? [],
    [snapshotsQuery.data],
  );

  return (
    <div className="border-b border-border/30">
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground"
      >
        {collapsed ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" />
        )}
        <BarChart3 className="h-3.5 w-3.5" />
        <span>Analytics</span>
        {!collapsed && snapshotsQuery.isFetching && (
          <span className="ml-auto text-[10px] font-normal normal-case text-muted-foreground/50">
            Refreshing...
          </span>
        )}
      </button>

      {/* Chart grid */}
      {!collapsed && (
        <div className="border-t border-border/20 px-4 pb-4 pt-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* Calls by Hour */}
            <Card className="border-border/40 bg-card/50">
              <CardHeader className="px-4 pb-0 pt-3">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <BarChart3 className="h-3.5 w-3.5" />
                  Calls by Hour
                </CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-2 pt-2">
                <div className="h-[180px]">
                  <CallsByHourChart snapshots={snapshots} />
                </div>
              </CardContent>
            </Card>

            {/* Abandonment Rate Trend */}
            <Card className="border-border/40 bg-card/50">
              <CardHeader className="px-4 pb-0 pt-3">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <TrendingDown className="h-3.5 w-3.5" />
                  Abandonment Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-2 pt-2">
                <div className="h-[180px]">
                  <AbandonmentTrendChart
                    snapshots={snapshots}
                    yellowThreshold={abandonYellowThreshold}
                    redThreshold={abandonRedThreshold}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Avg Wait Time — All Queues, 24h */}
            <Card className="border-border/40 bg-card/50">
              <CardHeader className="px-4 pb-0 pt-3">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  Avg Wait Time (24h)
                </CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-2 pt-2">
                <div className="h-[180px]">
                  <WaitTimeTrendChart snapshots={snapshots} />
                </div>
              </CardContent>
            </Card>

            {/* Avg Wait Time — All Queues, Last Hour */}
            <Card className="border-border/40 bg-card/50">
              <CardHeader className="px-4 pb-0 pt-3">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Timer className="h-3.5 w-3.5" />
                  Avg Wait Time (Last Hour)
                </CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-2 pt-2">
                <div className="h-[180px]">
                  <AvgWaitTimeHourChart snapshots={snapshots} />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
