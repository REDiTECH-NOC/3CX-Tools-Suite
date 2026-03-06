'use client';

import { useMemo } from 'react';
import { Activity, Wifi, WifiOff, Radio, Clock } from 'lucide-react';

interface StatusFooterProps {
  isConnected: boolean;
  lastUpdate: Date | null;
  dataMode: 'polling' | 'realtime';
  pollIntervalMs?: number;
  error: string | null;
}

/**
 * Sticky footer bar showing connection status, data mode, last update time,
 * and poll interval. Provides at-a-glance system health.
 */
export function StatusFooter({
  isConnected,
  lastUpdate,
  dataMode,
  pollIntervalMs,
  error,
}: StatusFooterProps) {
  const lastUpdateText = useMemo(() => {
    if (!lastUpdate) return 'Waiting for data...';

    const now = Date.now();
    const diffMs = now - lastUpdate.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 5) return 'Updated just now';
    if (diffSec < 60) return `Updated ${diffSec}s ago`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `Updated ${diffMin}m ago`;

    return `Updated ${Math.floor(diffMin / 60)}h ago`;
  }, [lastUpdate]);

  const pollIntervalText = useMemo(() => {
    if (!pollIntervalMs) return null;
    const sec = Math.round(pollIntervalMs / 1000);
    return `${sec}s interval`;
  }, [pollIntervalMs]);

  return (
    <footer className="sticky bottom-0 z-10 flex h-8 shrink-0 items-center justify-between border-t border-border/50 bg-card/80 px-4 backdrop-blur-sm">
      {/* Left: Connection status */}
      <div className="flex items-center gap-4">
        {/* Connected / Disconnected indicator */}
        <div className="flex items-center gap-1.5">
          {isConnected ? (
            <>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <Wifi className="h-3 w-3 text-emerald-500" />
              <span className="text-xs text-emerald-600 dark:text-emerald-400">Connected</span>
            </>
          ) : (
            <>
              <span className="relative flex h-2 w-2">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
              <WifiOff className="h-3 w-3 text-red-500" />
              <span className="text-xs text-red-600 dark:text-red-400">Disconnected</span>
            </>
          )}
        </div>

        {/* Data mode */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {dataMode === 'realtime' ? (
            <>
              <Radio className="h-3 w-3 text-emerald-500" />
              <span>Real-time</span>
            </>
          ) : (
            <>
              <Activity className="h-3 w-3" />
              <span>Polling{pollIntervalText ? ` (${pollIntervalText})` : ''}</span>
            </>
          )}
        </div>

        {/* Error message */}
        {error && (
          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>

      {/* Right: Last updated */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span>{lastUpdateText}</span>
      </div>
    </footer>
  );
}
