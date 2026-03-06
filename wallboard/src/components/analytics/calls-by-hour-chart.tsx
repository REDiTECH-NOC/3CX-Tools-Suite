'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
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

interface CallsByHourChartProps {
  snapshots: QueueSnapshot[];
}

interface HourlyDataPoint {
  hour: string;
  answered: number;
  abandoned: number;
}

/**
 * Format an hour number (0-23) into a display label like "6AM", "12PM", etc.
 */
function formatHourLabel(hour: number): string {
  if (hour === 0) return '12AM';
  if (hour === 12) return '12PM';
  if (hour < 12) return `${hour}AM`;
  return `${hour - 12}PM`;
}

/**
 * Custom tooltip for the calls by hour bar chart.
 */
function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2 shadow-lg">
      <p className="mb-1 text-xs font-medium text-foreground">{label}</p>
      {payload.map((entry) => (
        <p
          key={entry.name}
          className="text-xs"
          style={{ color: entry.color }}
        >
          {entry.name}: {entry.value}
        </p>
      ))}
    </div>
  );
}

/**
 * Bar chart showing answered vs. abandoned calls grouped by hour of day.
 *
 * Aggregates snapshots by hour, using the latest snapshot values per hour
 * (since snapshot values are cumulative counters for the day).
 */
export function CallsByHourChart({ snapshots }: CallsByHourChartProps) {
  const chartColors = useChartColors();
  const data = useMemo<HourlyDataPoint[]>(() => {
    if (!snapshots || snapshots.length === 0) return [];

    const now = new Date();
    const currentHour = now.getHours();
    const startHour = 6; // Start at 6 AM

    // Group snapshots by hour and take the latest entry per hour (max values)
    const hourlyMap = new Map<
      number,
      { answered: number; abandoned: number }
    >();

    for (const snap of snapshots) {
      const ts = new Date(snap.timestamp);
      const hour = ts.getHours();

      if (hour < startHour) continue;

      const existing = hourlyMap.get(hour);
      if (
        !existing ||
        new Date(snap.timestamp).getTime() >
          (existing as unknown as { _ts?: number })._ts!
      ) {
        // Keep the latest snapshot per hour (highest cumulative values)
        const prev = hourlyMap.get(hour);
        hourlyMap.set(hour, {
          answered: Math.max(prev?.answered ?? 0, snap.callsAnswered),
          abandoned: Math.max(prev?.abandoned ?? 0, snap.callsAbandoned),
        });
      }
    }

    // Build ordered data points from startHour to current hour
    const result: HourlyDataPoint[] = [];
    for (let h = startHour; h <= currentHour; h++) {
      const entry = hourlyMap.get(h);
      result.push({
        hour: formatHourLabel(h),
        answered: entry?.answered ?? 0,
        abandoned: entry?.abandoned ?? 0,
      });
    }

    return result;
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
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={chartColors.grid}
          vertical={false}
        />
        <XAxis
          dataKey="hour"
          tick={{ fontSize: 11, fill: chartColors.muted }}
          axisLine={{ stroke: chartColors.grid }}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: chartColors.muted }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: chartColors.tooltipCursor }} />
        <Legend
          wrapperStyle={{ fontSize: 11, color: chartColors.muted }}
          iconSize={10}
        />
        <Bar
          dataKey="answered"
          name="Answered"
          fill="hsl(142 71% 45%)"
          radius={[2, 2, 0, 0]}
          maxBarSize={40}
        />
        <Bar
          dataKey="abandoned"
          name="Abandoned"
          fill="hsl(0 84% 60%)"
          radius={[2, 2, 0, 0]}
          maxBarSize={40}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
