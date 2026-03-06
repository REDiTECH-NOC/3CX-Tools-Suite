'use client';

import type { WallboardTotals, ThresholdLevel } from '@/types/wallboard';
import {
  Phone,
  Headset,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  TrendingDown,
  Clock,
  Timer,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SummaryBarProps {
  totals: WallboardTotals;
  getThresholdLevel: (
    value: number,
    metric: string,
    queueId?: string,
  ) => ThresholdLevel;
  avgWaitWindowMinutes?: number;
  dataMode?: 'polling' | 'realtime';
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  thresholdLevel?: ThresholdLevel;
}

interface DualStatCardProps {
  icon: React.ReactNode;
  label: string;
  value1: string;
  label1: string;
  value2: string;
  label2: string;
  thresholdLevel?: ThresholdLevel;
}

/**
 * Tailwind classes for each threshold level used on summary stat cards.
 */
function getStatThresholdClasses(level?: ThresholdLevel): string {
  switch (level) {
    case 'red':
      return 'border-red-500/40 bg-red-500/10';
    case 'yellow':
      return 'border-amber-500/40 bg-amber-500/10';
    case 'green':
      return 'border-emerald-500/30 bg-emerald-500/5';
    default:
      return 'border-border/50 bg-card/50';
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

/**
 * Format seconds into "M:SS" display string.
 */
function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function StatCard({ icon, label, value, thresholdLevel }: StatCardProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4 py-2.5 transition-all duration-200 hover:shadow-md hover:scale-[1.02]',
        getStatThresholdClasses(thresholdLevel),
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/50">
        {icon}
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'text-lg font-bold tabular-nums leading-tight',
            getStatValueColor(thresholdLevel),
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

function DualStatCard({ icon, label, value1, label1, value2, label2, thresholdLevel }: DualStatCardProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4 py-2.5 transition-all duration-200 hover:shadow-md hover:scale-[1.02]',
        getStatThresholdClasses(thresholdLevel),
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/50">
        {icon}
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'text-lg font-bold tabular-nums leading-tight',
              getStatValueColor(thresholdLevel),
            )}
          >
            {value1}
          </span>
          <span className="text-[10px] text-muted-foreground">{label1}</span>
          <span className="text-[10px] text-muted-foreground/40">/</span>
          <span className="text-sm font-semibold tabular-nums text-muted-foreground">
            {value2}
          </span>
          <span className="text-[10px] text-muted-foreground">{label2}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Horizontal summary bar showing aggregate totals across all queues.
 * Each stat card can be color-coded based on threshold evaluation.
 * Cards are centered on the page.
 */
/** Format window minutes into a compact label: "30m", "1hr", "6hr", etc. */
function formatWindowLabel(minutes: number): string {
  if (minutes >= 60) {
    const hrs = Math.floor(minutes / 60);
    return `${hrs}hr`;
  }
  return `${minutes}m`;
}

export function SummaryBar({ totals, getThresholdLevel, avgWaitWindowMinutes = 60, dataMode }: SummaryBarProps) {
  const windowLabel = formatWindowLabel(avgWaitWindowMinutes);
  const waitingLevel = getThresholdLevel(
    totals.totalCallsWaiting,
    'callsQueued',
  );
  const abandonRateLevel = getThresholdLevel(
    totals.overallAbandonRate,
    'abandonRate',
  );
  const abandonedLevel = getThresholdLevel(
    totals.totalAbandonedToday,
    'callsAbandoned',
  );

  const abandonRateDisplay =
    totals.overallAbandonRate === 0
      ? '0%'
      : `${totals.overallAbandonRate.toFixed(1)}%`;

  return (
    <div className="flex flex-wrap items-stretch justify-center gap-3 px-4 py-3">
      {dataMode === 'realtime' && (
        <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">Live</span>
        </div>
      )}
      <StatCard
        icon={<Phone className="h-4 w-4 text-muted-foreground" />}
        label="Calls Waiting"
        value={totals.totalCallsWaiting}
        thresholdLevel={waitingLevel}
      />
      <StatCard
        icon={<Headset className="h-4 w-4 text-muted-foreground" />}
        label="Agents Logged In"
        value={totals.totalAgentsLoggedIn}
      />
      <StatCard
        icon={<PhoneCall className="h-4 w-4 text-muted-foreground" />}
        label="Agents Talking"
        value={totals.totalAgentsTalking}
      />
      <StatCard
        icon={<PhoneIncoming className="h-4 w-4 text-muted-foreground" />}
        label="Answered Today"
        value={totals.totalAnsweredToday}
      />
      <StatCard
        icon={<PhoneMissed className="h-4 w-4 text-muted-foreground" />}
        label="Abandoned Today"
        value={totals.totalAbandonedToday}
        thresholdLevel={abandonedLevel}
      />
      <StatCard
        icon={<TrendingDown className="h-4 w-4 text-muted-foreground" />}
        label="Abandon Rate"
        value={abandonRateDisplay}
        thresholdLevel={abandonRateLevel}
      />
      <DualStatCard
        icon={<Clock className="h-4 w-4 text-muted-foreground" />}
        label="Longest Wait"
        value1={formatTime(totals.longestWaitWindow)}
        label1={windowLabel}
        value2={formatTime(totals.longestWaitToday)}
        label2="today"
      />
      <DualStatCard
        icon={<Timer className="h-4 w-4 text-muted-foreground" />}
        label={`Avg Wait (${windowLabel})`}
        value1={formatTime(totals.avgWaitWindow)}
        label1={windowLabel}
        value2={formatTime(totals.avgWaitToday)}
        label2="today"
      />
    </div>
  );
}
