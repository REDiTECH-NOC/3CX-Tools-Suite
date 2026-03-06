'use client';

import { useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { useClock } from '@/hooks/use-clock';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SettingsPopover } from '@/components/wallboard/settings-popover';
import { Settings, LogOut, Phone, Loader2, Monitor, Sun, Moon, MonitorSmartphone } from 'lucide-react';
import type { WallboardColumn } from '@/types/wallboard';
import { COLUMN_DEFINITIONS } from '@/types/wallboard';
import { useTheme, type Theme } from '@/components/theme-provider';

/**
 * Default visible columns used when user preferences have not been set.
 */
const DEFAULT_VISIBLE_COLUMNS: WallboardColumn[] = COLUMN_DEFINITIONS
  .filter((col) => col.defaultVisible)
  .map((col) => col.key);

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const clock = useClock();
  const { theme, setTheme } = useTheme();

  const { data: user, isLoading, isError } = trpc.auth.me.useQuery(undefined, {
    retry: false,
  });

  const prefsQuery = trpc.wallboard.getPreferences.useQuery(undefined, {
    staleTime: 30_000,
  });

  const updateThemeMutation = trpc.wallboard.updatePreferences.useMutation();

  // Sync theme from saved preferences on initial load
  useEffect(() => {
    const savedTheme = prefsQuery.data?.theme as Theme | undefined;
    if (savedTheme && savedTheme !== theme) {
      setTheme(savedTheme);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsQuery.data?.theme]);

  const cycleTheme = useCallback(() => {
    const order: Theme[] = ['dark', 'light', 'system'];
    const nextIdx = (order.indexOf(theme) + 1) % order.length;
    const next = order[nextIdx];
    setTheme(next);
    updateThemeMutation.mutate({ theme: next });
  }, [theme, setTheme, updateThemeMutation]);

  useEffect(() => {
    if (isError) {
      router.push('/login');
    }
  }, [isError, router]);

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      router.push('/login');
    },
  });

  function handleLogout() {
    logoutMutation.mutate();
  }

  // ---- Extract preferences for the settings popover ----
  const prefs = prefsQuery.data;

  const visibleColumns = useMemo<WallboardColumn[]>(() => {
    if (prefs?.visibleColumns && Array.isArray(prefs.visibleColumns) && prefs.visibleColumns.length > 0) {
      return prefs.visibleColumns as WallboardColumn[];
    }
    return DEFAULT_VISIBLE_COLUMNS;
  }, [prefs?.visibleColumns]);

  const columnOrder = useMemo<WallboardColumn[]>(() => {
    if (prefs?.columnOrder && Array.isArray(prefs.columnOrder) && prefs.columnOrder.length > 0) {
      return prefs.columnOrder as WallboardColumn[];
    }
    return COLUMN_DEFINITIONS.map((col) => col.key);
  }, [prefs?.columnOrder]);

  const rowDensity = useMemo<'compact' | 'comfortable' | 'spacious'>(() => {
    return (prefs?.rowDensity as 'compact' | 'comfortable' | 'spacious') ?? 'comfortable';
  }, [prefs?.rowDensity]);

  const fontSize = useMemo<'small' | 'medium' | 'large'>(() => {
    return (prefs?.fontSize as 'small' | 'medium' | 'large') ?? 'medium';
  }, [prefs?.fontSize]);

  const autoExpandRows = useMemo(() => {
    return prefs?.autoExpandRows ?? false;
  }, [prefs?.autoExpandRows]);

  const soundAlerts = useMemo<Record<string, unknown>>(() => {
    if (prefs?.soundAlerts && typeof prefs.soundAlerts === 'object') {
      return prefs.soundAlerts as Record<string, unknown>;
    }
    return {};
  }, [prefs?.soundAlerts]);

  const queueOrderMode = useMemo<'default' | 'manual' | 'watch'>(() => {
    return (prefs?.queueOrderMode as 'default' | 'manual' | 'watch') ?? 'default';
  }, [prefs?.queueOrderMode]);

  const watchColumn = useMemo<WallboardColumn | null>(() => {
    return (prefs?.watchColumn as WallboardColumn | null) ?? null;
  }, [prefs?.watchColumn]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Slim header bar */}
      <header className="sticky top-0 z-20 flex h-10 shrink-0 items-center justify-between border-b border-border/50 bg-card/80 px-4 backdrop-blur-sm">
        {/* Left: Title */}
        <div className="flex items-center gap-2">
          <Phone className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">
            3CX Wallboard
          </span>
        </div>

        {/* Right: Clock, user, settings, TV, admin, logout */}
        <div className="flex items-center gap-2">
          {/* Real-time clock */}
          <span className="font-mono text-xs text-muted-foreground">
            {clock}
          </span>

          {/* User badge */}
          {user && (
            <Badge variant="secondary" className="text-xs font-normal">
              Ext {user.extensionNumber}
            </Badge>
          )}

          {/* Wallboard settings popover */}
          <SettingsPopover
            visibleColumns={visibleColumns}
            columnOrder={columnOrder}
            rowDensity={rowDensity}
            fontSize={fontSize}
            autoExpandRows={autoExpandRows}
            soundAlerts={soundAlerts}
            queueOrderMode={queueOrderMode}
            watchColumn={watchColumn}
          />

          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={cycleTheme}
            title={`Theme: ${theme} (click to cycle)`}
          >
            {theme === 'dark' ? (
              <Moon className="h-3.5 w-3.5" />
            ) : theme === 'light' ? (
              <Sun className="h-3.5 w-3.5" />
            ) : (
              <MonitorSmartphone className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* TV Mode link */}
          <Link href="/tv" target="_blank">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="TV / Kiosk Mode"
            >
              <Monitor className="h-3.5 w-3.5" />
            </Button>
          </Link>

          {/* Admin link */}
          {user?.role === 'ADMIN' && (
            <Link href="/admin/queues">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Admin Settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </Link>
          )}

          {/* Logout */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            title="Sign Out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* Content area -- fills remaining space */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
