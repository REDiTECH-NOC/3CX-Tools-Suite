'use client';

import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useChartColors } from '@/hooks/use-chart-colors';

interface QueueSnapshot {
  id: string;
  queueId: number;
  timestamp: Date;
  callsWaiting: number;
  callsAnswered: number;
  callsAbandoned: number;
  agentsLoggedIn: number;
  agentsTalking: number;
  agentsAvailable: number;
  longestWaitSec: number;
  avgWaitSec: number;
  abandonRate: number;
}

interface AvgWaitTimeHourChartProps {
  snapshots: QueueSnapshot[];
}

interface DataPoint {
  time: string;
  timestamp: number;
  avgWait: number;
}

/**
 * Format a Date into HH:MM for the X-axis.
 */
function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Custom tooltip for the 1-hour average wait time chart.
 */
function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const secs = payload[0].value;
  const mins = Math.floor(secs / 60);
  const remainder = Math.floor(secs % 60);
  const display = mins > 0 ? `${mins}m ${remainder}s` : `${secs.toFixed(0)}s`;

  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2 shadow-lg">
      <p className="mb-1 text-xs font-medium text-foreground">{label}</p>
      <p className="text-xs text-amber-400">
        Avg Wait: {display}
      </p>
    </div>
  );
}

/**
 * Area chart showing total average wait time across all queues for the past 1 hour.
 *
 * Filters the full snapshot dataset to only the last 60 minutes, then buckets
 * into 2-minute intervals for a detailed short-range view.
 */
export function AvgWaitTimeHourChart({
  snapshots,
}: AvgWaitTimeHourChartProps) {
  const chartColors = useChartColors();
  const data = useMemo<DataPoint[]>(() => {
    if (!snapshots || snapshots.length === 0) return [];

    // Filter to last 60 minutes
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentSnapshots = snapshots.filter(
      (s) => new Date(s.timestamp).getTime() >= oneHourAgo,
    );

    if (recentSnapshots.length === 0) return [];

    // Bucket into 2-minute intervals and average across all queues
    const INTERVAL_MS = 2 * 60 * 1000;
    const buckets = new Map<number, { total: number; count: number }>();

    for (const snap of recentSnapshots) {
      const ts = new Date(snap.timestamp).getTime();
      const bucket = Math.floor(ts / INTERVAL_MS) * INTERVAL_MS;

      const existing = buckets.get(bucket);
      if (existing) {
        existing.total += snap.avgWaitSec;
        existing.count += 1;
      } else {
        buckets.set(bucket, { total: snap.avgWaitSec, count: 1 });
      }
    }

    // Sort by time and build data points
    const sortedBuckets = Array.from(buckets.entries()).sort(
      ([a], [b]) => a - b,
    );

    return sortedBuckets.map(([ts, { total, count }]) => ({
      time: formatTimeLabel(new Date(ts)),
      timestamp: ts,
      avgWait: Number((total / count).toFixed(1)),
    }));
  }, [snapshots]);

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No snapshot data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={data}
        margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
      >
        <defs>
          <linearGradient id="waitHourGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(48 96% 53%)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(48 96% 53%)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={chartColors.grid}
          vertical={false}
        />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: chartColors.muted }}
          axisLine={{ stroke: chartColors.grid }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: chartColors.muted }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}s`}
        />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone"
          dataKey="avgWait"
          stroke="hsl(48 96% 53%)"
          strokeWidth={2}
          fill="url(#waitHourGradient)"
          dot={false}
          activeDot={{
            r: 4,
            fill: 'hsl(48 96% 53%)',
            stroke: chartColors.bg,
            strokeWidth: 2,
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
