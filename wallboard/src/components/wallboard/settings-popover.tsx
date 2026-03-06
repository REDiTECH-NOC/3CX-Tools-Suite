'use client';

import { useCallback, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Settings, RotateCcw, Volume2, Bell, BellOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COLUMN_DEFINITIONS, type WallboardColumn } from '@/types/wallboard';
import { normalizeAlertSettings, type AlertConfig, type AlertSettings } from '@/types/alert-config';

/**
 * Metrics that support alerts.
 */
const ALERT_METRICS = [
  { key: 'currentWait', label: 'Current Wait Time' },
  { key: 'avgWait', label: 'Average Wait Time' },
  { key: 'callsQueued', label: 'Calls Queued' },
  { key: 'callsAbandoned', label: 'Abandoned Calls' },
  { key: 'abandonRate', label: 'Abandon Rate' },
  { key: 'agentsAvailable', label: 'Agents Available' },
] as const;

/** Columns that have threshold metrics (valid for watch column) */
const WATCH_COLUMN_OPTIONS = COLUMN_DEFINITIONS.filter((c) => c.thresholdMetric);

type RowDensity = 'compact' | 'comfortable' | 'spacious';
type FontSize = 'small' | 'medium' | 'large';
type QueueOrderMode = 'default' | 'manual' | 'watch';

interface SettingsPopoverProps {
  visibleColumns: WallboardColumn[];
  columnOrder: WallboardColumn[];
  rowDensity: RowDensity;
  fontSize: FontSize;
  autoExpandRows: boolean;
  soundAlerts: Record<string, unknown>;
  queueOrderMode: QueueOrderMode;
  watchColumn: WallboardColumn | null;
}

const DEFAULT_COLUMN_ORDER: WallboardColumn[] = COLUMN_DEFINITIONS.map((c) => c.key);

export function SettingsPopover({
  visibleColumns,
  columnOrder,
  rowDensity,
  fontSize,
  autoExpandRows,
  soundAlerts,
  queueOrderMode,
  watchColumn,
}: SettingsPopoverProps) {
  const utils = trpc.useUtils();

  const updatePrefsMutation = trpc.wallboard.updatePreferences.useMutation({
    onSuccess: () => {
      utils.wallboard.getPreferences.invalidate();
    },
  });

  // Normalize alert settings (backward compatible)
  const alertSettings = useMemo<AlertSettings>(
    () => normalizeAlertSettings(soundAlerts),
    [soundAlerts],
  );

  // Notification permission state
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'default',
  );

  // ---- Column Visibility ----

  const handleColumnToggle = useCallback(
    (columnKey: WallboardColumn, checked: boolean) => {
      let newColumns: WallboardColumn[];
      if (checked) {
        newColumns = columnOrder.filter(
          (key) => key === columnKey || visibleColumns.includes(key),
        );
      } else {
        newColumns = visibleColumns.filter((key) => key !== columnKey);
        if (newColumns.length === 0) return;
      }
      updatePrefsMutation.mutate({ visibleColumns: newColumns });
    },
    [visibleColumns, columnOrder, updatePrefsMutation],
  );

  // ---- Reset Column Order ----

  const handleResetColumnOrder = useCallback(() => {
    updatePrefsMutation.mutate({ columnOrder: DEFAULT_COLUMN_ORDER });
  }, [updatePrefsMutation]);

  const isDefaultOrder = useMemo(() => {
    return columnOrder.every((key, i) => key === DEFAULT_COLUMN_ORDER[i]);
  }, [columnOrder]);

  // ---- Row Density ----

  const handleDensityChange = useCallback(
    (density: RowDensity) => {
      updatePrefsMutation.mutate({ rowDensity: density });
    },
    [updatePrefsMutation],
  );

  // ---- Font Size ----

  const handleFontSizeChange = useCallback(
    (size: FontSize) => {
      updatePrefsMutation.mutate({ fontSize: size });
    },
    [updatePrefsMutation],
  );

  // ---- Auto-expand Rows ----

  const handleAutoExpandToggle = useCallback(
    (checked: boolean) => {
      updatePrefsMutation.mutate({ autoExpandRows: checked });
    },
    [updatePrefsMutation],
  );

  // ---- Queue Order Mode ----

  const handleQueueOrderModeChange = useCallback(
    (mode: QueueOrderMode) => {
      updatePrefsMutation.mutate({ queueOrderMode: mode });
    },
    [updatePrefsMutation],
  );

  // ---- Watch Column ----

  const handleWatchColumnChange = useCallback(
    (column: string) => {
      updatePrefsMutation.mutate({ watchColumn: column as WallboardColumn });
    },
    [updatePrefsMutation],
  );

  // ---- Alert Config Updates ----

  const updateAlert = useCallback(
    (metric: string, patch: Partial<AlertConfig>) => {
      const current = alertSettings[metric] ?? {
        sound: false,
        push: false,
        queues: ['all'],
      };
      const updated = { ...current, ...patch };

      // Build the full alerts object to save
      const newAlerts: Record<string, AlertConfig> = { ...alertSettings };
      newAlerts[metric] = updated;

      // Convert to the format the mutation expects (Record<string, boolean> schema)
      // We store the full AlertConfig objects as JSON in the soundAlerts field
      updatePrefsMutation.mutate({
        soundAlerts: newAlerts as unknown as Record<string, boolean>,
      });
    },
    [alertSettings, updatePrefsMutation],
  );

  const handleRequestNotificationPermission = useCallback(async () => {
    if (!('Notification' in window)) return;
    const permission = await Notification.requestPermission();
    setNotifPermission(permission);
  }, []);

  const visibleSet = useMemo(
    () => new Set(visibleColumns),
    [visibleColumns],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Wallboard Settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-h-[80vh] overflow-y-auto p-0"
      >
        {/* ---- Columns Section ---- */}
        <div className="border-b border-border/40 px-4 py-3">
          <div className="mb-2.5 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Columns
            </p>
            {!isDefaultOrder && (
              <button
                onClick={handleResetColumnOrder}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                title="Reset column order to default"
              >
                <RotateCcw className="h-2.5 w-2.5" />
                Reset Order
              </button>
            )}
          </div>
          <p className="mb-2 text-[10px] text-muted-foreground/70">
            Drag column headers in the grid to reorder.
          </p>
          <div className="space-y-2">
            {COLUMN_DEFINITIONS.map((col) => (
              <div key={col.key} className="flex items-center gap-2.5">
                <Checkbox
                  id={`col-${col.key}`}
                  checked={visibleSet.has(col.key)}
                  onCheckedChange={(checked) =>
                    handleColumnToggle(col.key, checked === true)
                  }
                  disabled={col.key === 'queueName'}
                />
                <Label
                  htmlFor={`col-${col.key}`}
                  className="cursor-pointer text-xs text-foreground"
                >
                  {col.label}
                </Label>
              </div>
            ))}
          </div>
        </div>

        {/* ---- Queue Ordering Section ---- */}
        <div className="border-b border-border/40 px-4 py-3">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Queue Ordering
          </p>
          <div className="mb-3">
            <div className="flex gap-1">
              {([
                { key: 'default' as const, label: 'Default Sort' },
                { key: 'manual' as const, label: 'Manual Lock' },
                { key: 'watch' as const, label: 'Watch Column' },
              ]).map((option) => (
                <button
                  key={option.key}
                  onClick={() => handleQueueOrderModeChange(option.key)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                    queueOrderMode === option.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Watch column picker */}
          {queueOrderMode === 'watch' && (
            <div>
              <p className="mb-1.5 text-[10px] text-muted-foreground">
                Sort queues by severity of:
              </p>
              <select
                value={watchColumn ?? ''}
                onChange={(e) => handleWatchColumnChange(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="" disabled>
                  Select a column...
                </option>
                {WATCH_COLUMN_OPTIONS.map((col) => (
                  <option key={col.key} value={col.key}>
                    {col.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Manual mode hint */}
          {queueOrderMode === 'manual' && (
            <p className="text-[10px] text-muted-foreground/70">
              Drag queue rows up and down to set your preferred order.
            </p>
          )}

          {/* Default mode hint */}
          {queueOrderMode === 'default' && (
            <p className="text-[10px] text-muted-foreground/70">
              Click column headers to sort. Pinned queues always appear at the top.
            </p>
          )}
        </div>

        {/* ---- Display Section ---- */}
        <div className="border-b border-border/40 px-4 py-3">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Display
          </p>

          {/* Row Density */}
          <div className="mb-3">
            <p className="mb-1.5 text-[11px] text-muted-foreground">
              Row Density
            </p>
            <div className="flex gap-1">
              {(['compact', 'comfortable', 'spacious'] as const).map(
                (option) => (
                  <button
                    key={option}
                    onClick={() => handleDensityChange(option)}
                    className={cn(
                      'flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors',
                      rowDensity === option
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {option}
                  </button>
                ),
              )}
            </div>
          </div>

          {/* Font Size */}
          <div className="mb-3">
            <p className="mb-1.5 text-[11px] text-muted-foreground">
              Font Size
            </p>
            <div className="flex gap-1">
              {(['small', 'medium', 'large'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => handleFontSizeChange(option)}
                  className={cn(
                    'flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors',
                    fontSize === option
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-expand rows */}
          <div className="flex items-center justify-between">
            <Label
              htmlFor="auto-expand"
              className="cursor-pointer text-xs text-foreground"
            >
              Auto-expand all rows
            </Label>
            <Switch
              id="auto-expand"
              checked={autoExpandRows}
              onCheckedChange={handleAutoExpandToggle}
            />
          </div>
        </div>

        {/* ---- Alerts Section ---- */}
        <div className="px-4 py-3">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Alerts
          </p>
          <p className="mb-2 text-[10px] text-muted-foreground/70">
            Trigger when a metric crosses the red threshold.
          </p>

          {/* Push notification permission */}
          {notifPermission !== 'granted' && (
            <button
              onClick={handleRequestNotificationPermission}
              className="mb-3 flex w-full items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              {notifPermission === 'denied' ? (
                <>
                  <BellOff className="h-3.5 w-3.5 text-red-500" />
                  <span>Push notifications blocked by browser</span>
                </>
              ) : (
                <>
                  <Bell className="h-3.5 w-3.5" />
                  <span>Enable push notifications</span>
                </>
              )}
            </button>
          )}

          {/* Per-metric alert config */}
          <div className="space-y-2.5">
            {ALERT_METRICS.map((metric) => {
              const config = alertSettings[metric.key];
              const soundEnabled = config?.sound ?? false;
              const pushEnabled = config?.push ?? false;

              return (
                <div key={metric.key} className="flex items-center justify-between gap-2">
                  <span className="flex-1 text-xs text-foreground">
                    {metric.label}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {/* Sound toggle */}
                    <button
                      onClick={() =>
                        updateAlert(metric.key, { sound: !soundEnabled })
                      }
                      className={cn(
                        'rounded-md p-1.5 transition-colors',
                        soundEnabled
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground/40 hover:text-muted-foreground',
                      )}
                      title={soundEnabled ? 'Sound alert on' : 'Sound alert off'}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                    </button>
                    {/* Push toggle */}
                    <button
                      onClick={() =>
                        updateAlert(metric.key, { push: !pushEnabled })
                      }
                      disabled={notifPermission === 'denied'}
                      className={cn(
                        'rounded-md p-1.5 transition-colors',
                        pushEnabled
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground/40 hover:text-muted-foreground',
                        notifPermission === 'denied' && 'opacity-30 cursor-not-allowed',
                      )}
                      title={pushEnabled ? 'Push notification on' : 'Push notification off'}
                    >
                      <Bell className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="mt-3 flex items-center gap-3 text-[10px] text-muted-foreground/60">
            <span className="flex items-center gap-1">
              <Volume2 className="h-3 w-3" /> Sound
            </span>
            <span className="flex items-center gap-1">
              <Bell className="h-3 w-3" /> Push
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
