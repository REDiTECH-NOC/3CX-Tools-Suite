'use client';

import { useMemo, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import type {
  QueueWallboardData,
  WallboardColumn,
  ColumnDefinition,
  ThresholdLevel,
} from '@/types/wallboard';
import { COLUMN_DEFINITIONS } from '@/types/wallboard';
import { QueueRow } from './queue-row';
import { SortableQueueRow } from './sortable-queue-row';
import { SortableColumnHeader } from './sortable-column-header';
import { cn } from '@/lib/utils';

type QueueOrderMode = 'default' | 'manual' | 'watch';

interface QueueGridProps {
  queues: QueueWallboardData[];
  getThresholdLevel: (
    value: number,
    metric: string,
    queueId?: string,
  ) => ThresholdLevel;
  visibleColumns: WallboardColumn[];
  columnOrder: WallboardColumn[];
  onColumnReorder: (newOrder: WallboardColumn[]) => void;
  pinnedQueues: string[];
  myQueueStatus: Record<number, boolean>;
  sortColumn: WallboardColumn | null;
  sortDirection: 'asc' | 'desc';
  onSortChange: (column: WallboardColumn) => void;
  autoExpandRows: boolean;
  density: 'compact' | 'comfortable' | 'spacious';
  // Queue ordering
  queueOrderMode: QueueOrderMode;
  manualQueueOrder: string[];
  watchColumn: WallboardColumn | null;
  onManualQueueReorder: (newOrder: string[]) => void;
  onWatchColumnChange: (column: WallboardColumn) => void;
  // Manager agent management
  currentUserExtension: string | null;
  currentUserRole: string | null;
}

/**
 * Get a sortable numeric value for a queue by column key.
 */
function getSortValue(queue: QueueWallboardData, key: WallboardColumn): number | string {
  switch (key) {
    case 'queueName':
      return queue.queueName.toLowerCase();
    case 'currentWait':
      return queue.longestWaitSec;
    case 'avgWait':
      return queue.avgWaitSec;
    case 'totalAvgWait':
      return queue.totalAvgWaitSec;
    case 'agentsAvailable':
      return queue.agentsAvailable;
    case 'agentsTalking':
      return queue.agentsTalking;
    case 'agentsLoggedIn':
      return queue.agentsLoggedIn;
    case 'callsQueued':
      return queue.callsWaiting;
    case 'callsAnswered':
      return queue.callsAnswered;
    case 'callsAbandoned':
      return queue.callsAbandoned;
    case 'abandonRate':
      return queue.abandonRate;
    default:
      return 0;
  }
}

/**
 * Padding classes for table headers based on density.
 */
function getHeaderPadding(density: QueueGridProps['density']): string {
  switch (density) {
    case 'compact':
      return 'py-1.5 px-3';
    case 'comfortable':
      return 'py-2 px-4';
    case 'spacious':
      return 'py-2.5 px-4';
    default:
      return 'py-2 px-4';
  }
}

/**
 * Main queue data grid with draggable column headers, three-mode queue sorting,
 * and expandable rows for agent details with manager controls.
 */
export function QueueGrid({
  queues,
  getThresholdLevel,
  visibleColumns,
  columnOrder,
  onColumnReorder,
  pinnedQueues,
  myQueueStatus,
  sortColumn,
  sortDirection,
  onSortChange,
  autoExpandRows,
  density,
  queueOrderMode,
  manualQueueOrder,
  watchColumn,
  onManualQueueReorder,
  onWatchColumnChange,
  currentUserExtension,
  currentUserRole,
}: QueueGridProps) {
  // ── Sensors for dnd-kit ─────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // ── Resolve visible columns in user's preferred order ───────────────
  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);

  const columns = useMemo(() => {
    return columnOrder
      .filter((key) => visibleSet.has(key))
      .map((key) => COLUMN_DEFINITIONS.find((def) => def.key === key))
      .filter((def): def is ColumnDefinition => def !== undefined);
  }, [columnOrder, visibleSet]);

  // Column keys for the SortableContext (only the visible ones, in order)
  const columnKeys = useMemo(() => columns.map((c) => c.key), [columns]);

  // ── Column drag end handler ─────────────────────────────────────────
  const handleColumnDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = columnOrder.indexOf(active.id as WallboardColumn);
      const newIndex = columnOrder.indexOf(over.id as WallboardColumn);
      if (oldIndex === -1 || newIndex === -1) return;

      let newOrder = arrayMove(columnOrder, oldIndex, newIndex);
      // Enforce queueName stays first
      newOrder = ['queueName' as WallboardColumn, ...newOrder.filter((k) => k !== 'queueName')];
      onColumnReorder(newOrder);
    },
    [columnOrder, onColumnReorder],
  );

  // ── Sort header click handler (mode-aware) ──────────────────────────
  const handleHeaderSortClick = useCallback(
    (column: WallboardColumn) => {
      if (queueOrderMode === 'manual') return; // disabled in manual mode
      if (queueOrderMode === 'watch') {
        // In watch mode, clicking a header changes the watch column
        onWatchColumnChange(column);
        return;
      }
      // Default mode: normal sort toggle
      onSortChange(column);
    },
    [queueOrderMode, onSortChange, onWatchColumnChange],
  );

  // ── Three-mode queue sorting ────────────────────────────────────────
  const sortedQueues = useMemo(() => {
    const pinnedSet = new Set(pinnedQueues);
    const pinned = queues.filter((q) => pinnedSet.has(String(q.queueId)));
    const unpinned = queues.filter((q) => !pinnedSet.has(String(q.queueId)));

    let sortFn: (a: QueueWallboardData, b: QueueWallboardData) => number;

    if (queueOrderMode === 'manual') {
      // Manual mode: sort by saved order
      const orderMap = new Map(manualQueueOrder.map((id, idx) => [id, idx]));
      sortFn = (a, b) => {
        const aIdx = orderMap.get(String(a.queueId)) ?? 999;
        const bIdx = orderMap.get(String(b.queueId)) ?? 999;
        return aIdx - bIdx;
      };
    } else if (queueOrderMode === 'watch' && watchColumn) {
      // Watch mode: sort by threshold level (red first) then by raw value
      const colDef = COLUMN_DEFINITIONS.find((c) => c.key === watchColumn);
      const levelPriority: Record<ThresholdLevel, number> = { red: 3, yellow: 2, green: 1 };

      sortFn = (a, b) => {
        const aVal = getSortValue(a, watchColumn);
        const bVal = getSortValue(b, watchColumn);

        // Get threshold levels for comparison
        const aLevel =
          typeof aVal === 'number' && colDef?.thresholdMetric
            ? getThresholdLevel(aVal, colDef.thresholdMetric, String(a.queueId))
            : 'green';
        const bLevel =
          typeof bVal === 'number' && colDef?.thresholdMetric
            ? getThresholdLevel(bVal, colDef.thresholdMetric, String(b.queueId))
            : 'green';

        // Sort by severity first (red > yellow > green)
        const levelDiff = levelPriority[bLevel] - levelPriority[aLevel];
        if (levelDiff !== 0) return levelDiff;

        // Within same level, sort by value (worst-first)
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return colDef?.invertThreshold ? aVal - bVal : bVal - aVal;
        }
        return 0;
      };
    } else {
      // Default mode: existing sort logic
      sortFn = (a, b) => {
        if (!sortColumn) return 0;
        const aVal = getSortValue(a, sortColumn);
        const bVal = getSortValue(b, sortColumn);
        let cmp: number;
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          cmp = aVal.localeCompare(bVal);
        } else {
          cmp = (aVal as number) - (bVal as number);
        }
        return sortDirection === 'desc' ? -cmp : cmp;
      };
    }

    pinned.sort(sortFn);
    unpinned.sort(sortFn);
    return [...pinned, ...unpinned];
  }, [
    queues,
    pinnedQueues,
    queueOrderMode,
    manualQueueOrder,
    watchColumn,
    sortColumn,
    sortDirection,
    getThresholdLevel,
  ]);

  // ── Queue row drag end handler (manual mode) ───────────────────────
  const handleQueueDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = sortedQueues.map((q) => String(q.queueId));
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;

      onManualQueueReorder(arrayMove(ids, oldIndex, newIndex));
    },
    [sortedQueues, onManualQueueReorder],
  );

  const headerPadding = useMemo(() => getHeaderPadding(density), [density]);
  const pinnedSet = useMemo(() => new Set(pinnedQueues), [pinnedQueues]);

  // ── Effective sort indicator for watch mode ─────────────────────────
  const effectiveSortColumn = queueOrderMode === 'watch' ? watchColumn : sortColumn;

  // ── Shared queue row props ──────────────────────────────────────────
  const renderQueueRow = useCallback(
    (queue: QueueWallboardData) => (
      <QueueRow
        key={queue.queueId}
        queue={queue}
        visibleColumns={columns}
        getThresholdLevel={getThresholdLevel}
        isPinned={pinnedSet.has(String(queue.queueId))}
        pinnedQueues={pinnedQueues}
        isSignedIn={myQueueStatus[queue.queueId] ?? false}
        defaultExpanded={autoExpandRows}
        density={density}
        currentUserExtension={currentUserExtension}
        currentUserRole={currentUserRole}
      />
    ),
    [columns, getThresholdLevel, pinnedSet, pinnedQueues, myQueueStatus, autoExpandRows, density, currentUserExtension, currentUserRole],
  );

  return (
    <div className="flex-1 overflow-auto px-4 pb-2">
      <table className="w-full caption-bottom text-sm">
        {/* ── Column Headers (draggable) ─────────────────────────── */}
        <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleColumnDragEnd}
          >
            <SortableContext items={columnKeys} strategy={horizontalListSortingStrategy}>
              <tr className="border-b border-border/60">
                {/* Expand chevron / drag handle column */}
                <th className={cn('w-10', headerPadding)} />

                {columns.map((col) => (
                  <SortableColumnHeader
                    key={col.key}
                    column={col}
                    headerPadding={headerPadding}
                    sortColumn={effectiveSortColumn}
                    sortDirection={sortDirection}
                    onSortChange={handleHeaderSortClick}
                    isDragDisabled={col.key === 'queueName'}
                    isSortDisabled={queueOrderMode === 'manual'}
                  />
                ))}
              </tr>
            </SortableContext>
          </DndContext>
        </thead>

        {/* ── Queue Rows ─────────────────────────────────────────── */}
        {queueOrderMode === 'manual' ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleQueueDragEnd}
          >
            <SortableContext
              items={sortedQueues.map((q) => String(q.queueId))}
              strategy={verticalListSortingStrategy}
            >
              {sortedQueues.map((queue) => (
                <SortableQueueRow
                  key={queue.queueId}
                  sortableId={String(queue.queueId)}
                  queue={queue}
                  visibleColumns={columns}
                  getThresholdLevel={getThresholdLevel}
                  isPinned={pinnedSet.has(String(queue.queueId))}
                  pinnedQueues={pinnedQueues}
                  isSignedIn={myQueueStatus[queue.queueId] ?? false}
                  defaultExpanded={autoExpandRows}
                  density={density}
                  currentUserExtension={currentUserExtension}
                  currentUserRole={currentUserRole}
                />
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          sortedQueues.map(renderQueueRow)
        )}

        {/* ── Empty State ────────────────────────────────────────── */}
        {sortedQueues.length === 0 && (
          <tbody>
            <tr>
              <td
                colSpan={columns.length + 1}
                className="py-12 text-center text-sm text-muted-foreground"
              >
                No queues configured. Contact an administrator to set up queue
                monitoring.
              </td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}
