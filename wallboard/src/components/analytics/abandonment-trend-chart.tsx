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
  ReferenceLine,
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

interface AbandonmentTrendChartProps {
  snapshots: QueueSnapshot[];
  yellowThreshold?: number;
  redThreshold?: number;
}

interface DataPoint {
  time: string;
  timestamp: number;
  abandonRate: number;
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
 * Custom tooltip for the abandonment trend chart.
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

  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2 shadow-lg">
      <p className="mb-1 text-xs font-medium text-foreground">{label}</p>
      <p className="text-xs text-red-400">
        Abandon Rate: {payload[0].value.toFixed(1)}%
      </p>
    </div>
  );
}

/**
 * Area chart showing abandonment rate trend over the last 4 hours.
 *
 * Data is sampled at 5-minute intervals, averaging across all queues per
 * interval bucket.
 */
export function AbandonmentTrendChart({
  snapshots,
  yellowThreshold,
  redThreshold,
}: AbandonmentTrendChartProps) {
  const chartColors = useChartColors();
  const data = useMemo<DataPoint[]>(() => {
    if (!snapshots || snapshots.length === 0) return [];

    // Bucket snapshots into 5-minute intervals and average abandon rate across queues
    const INTERVAL_MS = 5 * 60 * 1000;
    const buckets = new Map<number, { total: number; count: number }>();

    for (const snap of snapshots) {
      const ts = new Date(snap.timestamp).getTime();
      const bucket = Math.floor(ts / INTERVAL_MS) * INTERVAL_MS;

      const existing = buckets.get(bucket);
      if (existing) {
        existing.total += snap.abandonRate;
        existing.count += 1;
      } else {
        buckets.set(bucket, { total: snap.abandonRate, count: 1 });
      }
    }

    // Sort by time and build data points
    const sortedBuckets = Array.from(buckets.entries()).sort(
      ([a], [b]) => a - b,
    );

    return sortedBuckets.map(([ts, { total, count }]) => ({
      time: formatTimeLabel(new Date(ts)),
      timestamp: ts,
      abandonRate: Number((total / count).toFixed(1)),
    }));
  }, [snapshots]);

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No snapshot data available
      </div>
    );
  }

  // Determine Y-axis max to ensure threshold lines are visible
  const maxRate = Math.max(
    ...data.map((d) => d.abandonRate),
    redThreshold ?? 0,
    yellowThreshold ?? 0,
  );
  const yMax = Math.ceil(maxRate * 1.2) || 20;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={data}
        margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
      >
        <defs>
          <linearGradient id="abandonGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(0 84% 60%)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(0 84% 60%)" stopOpacity={0.02} />
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
          domain={[0, yMax]}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip content={<CustomTooltip />} />

        {/* Yellow threshold reference line */}
        {yellowThreshold != null && (
          <ReferenceLine
            y={yellowThreshold}
            stroke="hsl(48 96% 53%)"
            strokeDasharray="6 3"
            strokeWidth={1}
            label={{
              value: `${yellowThreshold}%`,
              position: 'right',
              fill: 'hsl(48 96% 53%)',
              fontSize: 10,
            }}
          />
        )}

        {/* Red threshold reference line */}
        {redThreshold != null && (
          <ReferenceLine
            y={redThreshold}
            stroke="hsl(0 84% 60%)"
            strokeDasharray="6 3"
            strokeWidth={1}
            label={{
              value: `${redThreshold}%`,
              position: 'right',
              fill: 'hsl(0 84% 60%)',
              fontSize: 10,
            }}
          />
        )}

        <Area
          type="monotone"
          dataKey="abandonRate"
          stroke="hsl(0 84% 60%)"
          strokeWidth={2}
          fill="url(#abandonGradient)"
          dot={false}
          activeDot={{
            r: 4,
            fill: 'hsl(0 84% 60%)',
            stroke: chartColors.bg,
            strokeWidth: 2,
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
