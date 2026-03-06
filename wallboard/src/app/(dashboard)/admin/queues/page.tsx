'use client';

import { useState, useCallback, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RefreshCw,
  ChevronUp,
  ChevronDown,
  Loader2,
  Save,
  RotateCcw,
  Eye,
  EyeOff,
} from 'lucide-react';
import { COLUMN_DEFINITIONS } from '@/types/wallboard';

// ─── Metric definitions for threshold editing ─────────────────────────────

const THRESHOLD_METRICS = COLUMN_DEFINITIONS.filter(
  (col) => col.thresholdMetric,
).map((col) => ({
  key: col.thresholdMetric!,
  label: col.label,
  shortLabel: col.shortLabel,
  format: col.format,
  invert: col.invertThreshold ?? false,
}));

// ─── Queue Visibility Tab ─────────────────────────────────────────────────

function QueueVisibilityTab() {
  const utils = trpc.useUtils();
  const {
    data: queues,
    isLoading,
    isError,
  } = trpc.admin.getQueues.useQuery();

  const syncMutation = trpc.admin.syncQueues.useMutation({
    onSuccess: (result) => {
      utils.admin.getQueues.invalidate();
      setSyncResult(result);
      setTimeout(() => setSyncResult(null), 5000);
    },
  });

  const visibilityMutation = trpc.admin.updateQueueVisibility.useMutation({
    onSuccess: () => utils.admin.getQueues.invalidate(),
  });

  const reorderMutation = trpc.admin.updateQueueOrder.useMutation({
    onSuccess: () => utils.admin.getQueues.invalidate(),
  });

  const [syncResult, setSyncResult] = useState<{
    added: number;
    updated: number;
  } | null>(null);

  const visibleCount = queues?.filter((q) => q.visible).length ?? 0;
  const totalCount = queues?.length ?? 0;

  function handleMoveUp(index: number) {
    if (!queues || index <= 0) return;
    const ids = queues.map((q) => q.id);
    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
    reorderMutation.mutate({ queueIds: ids });
  }

  function handleMoveDown(index: number) {
    if (!queues || index >= queues.length - 1) return;
    const ids = queues.map((q) => q.id);
    [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
    reorderMutation.mutate({ queueIds: ids });
  }

  function handleToggleVisibility(queueId: string, visible: boolean) {
    visibilityMutation.mutate({ queueId, visible });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load queues. Check your connection and try again.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="font-normal">
            {visibleCount} of {totalCount} queues visible
          </Badge>
          {syncResult && (
            <span className="text-xs text-muted-foreground">
              Synced: {syncResult.added} added, {syncResult.updated} updated
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
          )}
          Sync from PBX
        </Button>
      </div>

      {/* Queue table */}
      {queues && queues.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No queues found. Click &quot;Sync from PBX&quot; to import queues
            from your 3CX system.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/30 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <th className="w-20 px-3 py-2.5 text-center">Order</th>
                <th className="px-3 py-2.5">Queue</th>
                <th className="w-24 px-3 py-2.5 text-center">Thresholds</th>
                <th className="w-24 px-3 py-2.5 text-center">Visible</th>
              </tr>
            </thead>
            <tbody>
              {queues?.map((queue, index) => (
                <tr
                  key={queue.id}
                  className="border-b border-border/30 transition-colors last:border-b-0 hover:bg-muted/10"
                >
                  {/* Reorder buttons */}
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={index === 0 || reorderMutation.isPending}
                        onClick={() => handleMoveUp(index)}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        disabled={
                          index === (queues?.length ?? 0) - 1 ||
                          reorderMutation.isPending
                        }
                        onClick={() => handleMoveDown(index)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>

                  {/* Queue info */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {queue.queueNumber}
                      </span>
                      <span className="text-sm font-medium">
                        {queue.queueName}
                      </span>
                    </div>
                  </td>

                  {/* Threshold count */}
                  <td className="px-3 py-2 text-center">
                    <Badge variant="outline" className="text-xs font-normal">
                      {queue.thresholds.length}
                    </Badge>
                  </td>

                  {/* Visibility toggle */}
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-2">
                      {queue.visible ? (
                        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5 text-muted-foreground/50" />
                      )}
                      <Switch
                        checked={queue.visible}
                        onCheckedChange={(checked) =>
                          handleToggleVisibility(queue.id, checked)
                        }
                        disabled={visibilityMutation.isPending}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Thresholds Tab ───────────────────────────────────────────────────────

function ThresholdsTab() {
  const utils = trpc.useUtils();
  const { data: thresholds, isLoading: thresholdsLoading } =
    trpc.admin.getThresholds.useQuery();
  const { data: queues } = trpc.admin.getQueues.useQuery();

  const upsertMutation = trpc.admin.upsertThreshold.useMutation({
    onSuccess: () => {
      utils.admin.getThresholds.invalidate();
      utils.admin.getQueues.invalidate();
    },
  });

  const deleteMutation = trpc.admin.deleteThreshold.useMutation({
    onSuccess: () => {
      utils.admin.getThresholds.invalidate();
      utils.admin.getQueues.invalidate();
    },
  });

  const [selectedQueueId, setSelectedQueueId] = useState<string>('__global__');

  // Local edits keyed by "queueId|metric" or "global|metric"
  const [edits, setEdits] = useState<
    Record<string, { yellow: string; red: string }>
  >({});

  // Build a lookup of current thresholds
  const thresholdMap = useMemo(() => {
    const map = new Map<
      string,
      { id: string; yellow: number; red: number; isGlobal: boolean }
    >();
    if (!thresholds) return map;
    for (const t of thresholds) {
      const scope = t.wallboardQueueId ?? '__global__';
      map.set(`${scope}|${t.metric}`, {
        id: t.id,
        yellow: t.yellowValue,
        red: t.redValue,
        isGlobal: !t.wallboardQueueId,
      });
    }
    return map;
  }, [thresholds]);

  const getThresholdKey = useCallback(
    (metric: string) => `${selectedQueueId}|${metric}`,
    [selectedQueueId],
  );

  const getValues = useCallback(
    (metric: string) => {
      const key = getThresholdKey(metric);
      const edit = edits[key];
      if (edit) return edit;

      const existing = thresholdMap.get(key);
      if (existing) {
        return {
          yellow: String(existing.yellow),
          red: String(existing.red),
        };
      }

      // Fall back to global for per-queue views
      if (selectedQueueId !== '__global__') {
        const globalExisting = thresholdMap.get(`__global__|${metric}`);
        if (globalExisting) {
          return {
            yellow: String(globalExisting.yellow),
            red: String(globalExisting.red),
          };
        }
      }

      return { yellow: '', red: '' };
    },
    [edits, getThresholdKey, thresholdMap, selectedQueueId],
  );

  function handleEdit(metric: string, field: 'yellow' | 'red', value: string) {
    const key = getThresholdKey(metric);
    const current = getValues(metric);
    setEdits((prev) => ({
      ...prev,
      [key]: { ...current, [field]: value },
    }));
  }

  function handleSave(metric: string) {
    const values = getValues(metric);
    const yellow = parseFloat(values.yellow);
    const red = parseFloat(values.red);
    if (isNaN(yellow) || isNaN(red)) return;

    upsertMutation.mutate({
      wallboardQueueId:
        selectedQueueId === '__global__' ? null : selectedQueueId,
      metric,
      yellowValue: yellow,
      redValue: red,
    });

    // Clear local edit
    const key = getThresholdKey(metric);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleResetToGlobal(metric: string) {
    if (selectedQueueId === '__global__') return;
    const key = `${selectedQueueId}|${metric}`;
    const existing = thresholdMap.get(key);
    if (existing && !existing.isGlobal) {
      deleteMutation.mutate({ id: existing.id });
    }
    // Clear any local edits
    setEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  const isPerQueue = selectedQueueId !== '__global__';

  function hasOverride(metric: string): boolean {
    if (!isPerQueue) return false;
    return thresholdMap.has(`${selectedQueueId}|${metric}`);
  }

  function hasLocalEdits(metric: string): boolean {
    return !!edits[getThresholdKey(metric)];
  }

  if (thresholdsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Scope selector */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            Threshold Scope
          </Label>
          <Select value={selectedQueueId} onValueChange={setSelectedQueueId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select scope..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__global__">Global Defaults</SelectItem>
              {queues?.map((q) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.queueNumber} - {q.queueName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isPerQueue && (
          <p className="text-xs text-muted-foreground">
            Per-queue overrides. Metrics without overrides use global defaults.
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        The &quot;Avg Wait (Window)&quot; column uses a configurable rolling window. Change it in{' '}
        <a href="/admin/settings" className="text-primary underline underline-offset-2 hover:text-primary/80">
          Settings → Polling Settings
        </a>.
      </p>

      {/* Threshold grid */}
      <div className="space-y-3">
        {THRESHOLD_METRICS.map((metric) => {
          const values = getValues(metric.key);
          const override = hasOverride(metric.key);
          const dirty = hasLocalEdits(metric.key);
          const yellowNum = parseFloat(values.yellow) || 0;
          const redNum = parseFloat(values.red) || 0;

          // For display: figure out green/yellow/red zone widths
          const maxVal = Math.max(yellowNum, redNum, 1);
          const yellowPct = Math.min((yellowNum / (maxVal * 1.5)) * 100, 100);
          const redPct = Math.min((redNum / (maxVal * 1.5)) * 100, 100);

          return (
            <Card key={metric.key} className="overflow-hidden">
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                {/* Metric label */}
                <div className="w-40 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{metric.label}</span>
                    {override && (
                      <Badge
                        variant="outline"
                        className="text-[10px] font-normal"
                      >
                        Override
                      </Badge>
                    )}
                  </div>
                  {metric.invert && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Inverted: lower = worse
                    </p>
                  )}
                </div>

                {/* Inputs */}
                <div className="flex items-center gap-3">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-yellow-500/80">
                      Yellow
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      className="h-8 w-24 text-sm"
                      value={values.yellow}
                      onChange={(e) =>
                        handleEdit(metric.key, 'yellow', e.target.value)
                      }
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-red-500/80">Red</Label>
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      className="h-8 w-24 text-sm"
                      value={values.red}
                      onChange={(e) =>
                        handleEdit(metric.key, 'red', e.target.value)
                      }
                      placeholder="0"
                    />
                  </div>
                </div>

                {/* Color bar visualization */}
                <div className="flex-1">
                  <div className="h-3 overflow-hidden rounded-full bg-muted">
                    {metric.invert ? (
                      // Inverted: red on left, yellow in middle, green on right
                      <div className="flex h-full">
                        <div
                          className="h-full bg-red-500/60 transition-all"
                          style={{
                            width: `${Math.min((redNum / (maxVal * 1.5)) * 100, 33)}%`,
                          }}
                        />
                        <div
                          className="h-full bg-yellow-500/60 transition-all"
                          style={{
                            width: `${Math.min(((yellowNum - redNum) / (maxVal * 1.5)) * 100, 34)}%`,
                          }}
                        />
                        <div className="h-full flex-1 bg-green-500/40" />
                      </div>
                    ) : (
                      // Normal: green on left, yellow in middle, red on right
                      <div className="flex h-full">
                        <div
                          className="h-full bg-green-500/40 transition-all"
                          style={{ width: `${yellowPct}%` }}
                        />
                        <div
                          className="h-full bg-yellow-500/60 transition-all"
                          style={{
                            width: `${Math.max(redPct - yellowPct, 0)}%`,
                          }}
                        />
                        <div className="h-full flex-1 bg-red-500/60" />
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={!dirty || upsertMutation.isPending}
                    onClick={() => handleSave(metric.key)}
                  >
                    {upsertMutation.isPending ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="mr-1.5 h-3 w-3" />
                    )}
                    Save
                  </Button>
                  {isPerQueue && override && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-muted-foreground"
                      disabled={deleteMutation.isPending}
                      onClick={() => handleResetToGlobal(metric.key)}
                      title="Reset to global default"
                    >
                      <RotateCcw className="mr-1.5 h-3 w-3" />
                      Reset
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Queues Page ─────────────────────────────────────────────────────

export default function AdminQueuesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">
          Queue Configuration
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage queue visibility, ordering, and color thresholds.
        </p>
      </div>

      <Tabs defaultValue="visibility" className="space-y-4">
        <TabsList>
          <TabsTrigger value="visibility">Queue Visibility</TabsTrigger>
          <TabsTrigger value="thresholds">Thresholds</TabsTrigger>
        </TabsList>

        <TabsContent value="visibility">
          <QueueVisibilityTab />
        </TabsContent>

        <TabsContent value="thresholds">
          <ThresholdsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
