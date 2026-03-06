'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import type {
  QueueWallboardData,
  ColumnDefinition,
  ThresholdLevel,
  WallboardColumn,
} from '@/types/wallboard';
import { getThresholdClass } from '@/hooks/use-threshold-color';
import { AgentRow } from './agent-row';
import { QueueContextMenu } from './queue-context-menu';
import { ManageAgentsDialog } from './manage-agents-dialog';
import { ChevronRight, ChevronDown, Pin, Headphones, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface QueueRowProps {
  queue: QueueWallboardData;
  visibleColumns: ColumnDefinition[];
  getThresholdLevel: (
    value: number,
    metric: string,
    queueId?: string,
  ) => ThresholdLevel;
  isPinned: boolean;
  pinnedQueues: string[];
  isSignedIn: boolean;
  defaultExpanded?: boolean;
  density: 'compact' | 'comfortable' | 'spacious';
  currentUserExtension?: string | null;
  currentUserRole?: string | null;
  // Drag props (from SortableQueueRow in manual mode)
  dragRef?: (node: HTMLElement | null) => void;
  dragStyle?: React.CSSProperties;
  dragHandleProps?: Record<string, unknown>;
}

// ---- Value formatting helpers ----

/**
 * Format seconds into "M:SS" display string.
 */
function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format a number as "X.X%" display string.
 */
function formatPercent(value: number): string {
  if (value === 0) return '0.0%';
  return `${value.toFixed(1)}%`;
}

/**
 * Format a plain integer.
 */
function formatNumber(value: number): string {
  return String(value);
}

/**
 * Get the raw numeric value for a given column key from queue data.
 */
function getColumnValue(
  queue: QueueWallboardData,
  key: WallboardColumn,
): number | string {
  switch (key) {
    case 'queueName':
      return queue.queueName;
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
 * Format a cell value based on its column format type.
 */
function formatValue(
  value: number | string,
  format: ColumnDefinition['format'],
): string {
  if (typeof value === 'string') return value;
  switch (format) {
    case 'time':
      return formatTime(value);
    case 'percent':
      return formatPercent(value);
    case 'number':
      return formatNumber(value);
    case 'text':
      return String(value);
    default:
      return String(value);
  }
}

/**
 * Padding classes based on density setting.
 */
function getDensityPadding(density: QueueRowProps['density']): string {
  switch (density) {
    case 'compact':
      return 'py-1.5 px-3';
    case 'comfortable':
      return 'py-2.5 px-4';
    case 'spacious':
      return 'py-3.5 px-4';
    default:
      return 'py-2.5 px-4';
  }
}

/**
 * Individual queue row in the wallboard grid.
 * Expandable to show agent details, right-click context menu for actions.
 */
export function QueueRow({
  queue,
  visibleColumns,
  getThresholdLevel,
  isPinned,
  pinnedQueues,
  isSignedIn,
  defaultExpanded = false,
  density,
  currentUserExtension,
  currentUserRole,
  dragRef,
  dragStyle,
  dragHandleProps,
}: QueueRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [manageAgentsOpen, setManageAgentsOpen] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const cellPadding = useMemo(() => getDensityPadding(density), [density]);

  // Total column count for agent row colspan (visible columns + 1 for expand chevron)
  const totalCols = visibleColumns.length + 1;

  // Determine if current user is a manager of this queue
  const currentUserIsManager = useMemo(() => {
    if (!currentUserExtension) return false;
    // Check managerExtensions list (works even if user isn't an agent in the queue)
    if (queue.managerExtensions?.includes(currentUserExtension)) return true;
    // Fallback: check agents array
    return queue.agents.some(
      (a) => a.extensionNumber === currentUserExtension && a.isManager,
    );
  }, [queue.managerExtensions, queue.agents, currentUserExtension]);

  // Permission denied tracking — lives here (QueueRow stays mounted on expand/collapse)
  // so AgentRows can unmount/remount without losing this state.
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Clear when SSE data updates managerExtensions (actual server data changed)
  useEffect(() => {
    setPermissionDenied(false);
  }, [currentUserIsManager]);

  // Auto-clear after 30s to allow retrying
  useEffect(() => {
    if (!permissionDenied) return;
    const timer = setTimeout(() => setPermissionDenied(false), 30_000);
    return () => clearTimeout(timer);
  }, [permissionDenied]);

  const handlePermissionDenied = useCallback(() => {
    setPermissionDenied(true);
  }, []);

  const isDraggable = !!dragHandleProps;

  // Determine if the current user is an agent (member) of this queue
  const isMember = useMemo(() => {
    if (!currentUserExtension) return false;
    return queue.agents.some((a) => a.extensionNumber === currentUserExtension);
  }, [queue.agents, currentUserExtension]);

  const isAdmin = currentUserRole === 'ADMIN';

  const handleManageAgents = useCallback(() => {
    setManageAgentsOpen(true);
  }, []);

  return (
    <>
    <QueueContextMenu
      queue={queue}
      isSignedIn={isSignedIn}
      isPinned={isPinned}
      pinnedQueues={pinnedQueues}
      isMember={isMember}
      isAdmin={isAdmin}
      onManageAgents={isAdmin ? handleManageAgents : undefined}
    >
      <tbody ref={dragRef} style={dragStyle} className="group">
        {/* Main queue row */}
        <tr
          className={cn(
            'cursor-pointer border-b border-border/40 transition-colors hover:bg-accent/30',
            expanded && 'bg-accent/20',
            isPinned && 'border-l-2 border-l-amber-500/60',
          )}
          onClick={toggleExpanded}
        >
          {/* Expand chevron / drag handle cell */}
          <td className={cn('w-10 text-center', cellPadding)}>
            <div className="flex items-center justify-center gap-1">
              {isDraggable && (
                <span
                  {...dragHandleProps}
                  className="cursor-grab opacity-40 transition-opacity hover:opacity-100 active:cursor-grabbing"
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              )}
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </div>
          </td>

          {/* Data cells */}
          {visibleColumns.map((col) => {
            const rawValue = getColumnValue(queue, col.key);
            const displayValue = formatValue(rawValue, col.format);

            // Compute threshold class for numeric cells with a threshold metric
            let thresholdCls = '';
            if (col.thresholdMetric && typeof rawValue === 'number') {
              const level = getThresholdLevel(
                rawValue,
                col.thresholdMetric,
                String(queue.queueId),
              );
              thresholdCls = getThresholdClass(level);
            }

            // Queue name column gets special treatment
            if (col.key === 'queueName') {
              return (
                <td key={col.key} className={cn(cellPadding, 'font-medium')}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-foreground">
                      {displayValue}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      #{queue.queueNumber}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                      {queue.agentsLoggedIn}/{queue.agentsTotal}
                    </span>
                    {isPinned && (
                      <Pin className="h-3 w-3 shrink-0 text-amber-500/70" />
                    )}
                    {isSignedIn && (
                      <Headphones className="h-3 w-3 shrink-0 text-emerald-500/70" />
                    )}
                  </div>
                </td>
              );
            }

            return (
              <td
                key={col.key}
                className={cn(
                  cellPadding,
                  'tabular-nums text-sm transition-colors duration-300',
                  thresholdCls,
                  // Right-align numeric columns
                  col.format !== 'text' && 'text-right',
                )}
              >
                {displayValue}
              </td>
            );
          })}
        </tr>

        {/* Expanded agent rows */}
        {expanded && queue.agents.length > 0 && (
          <>
            {/* Agent header */}
            <tr className="border-b border-border/20 bg-muted/30">
              <td colSpan={totalCols} className="px-4 py-1">
                <span className="ml-8 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Agents ({queue.agentsLoggedIn}/{queue.agentsTotal} logged in)
                </span>
              </td>
            </tr>
            {queue.agents.map((agent) => (
              <AgentRow
                key={agent.extensionNumber}
                agent={agent}
                colSpan={totalCols}
                queueId={queue.queueId}
                currentUserIsManager={currentUserIsManager}
                currentUserExtension={currentUserExtension}
                permissionDenied={permissionDenied}
                onPermissionDenied={handlePermissionDenied}
              />
            ))}
          </>
        )}

        {/* Expanded but no agents */}
        {expanded && queue.agents.length === 0 && (
          <tr className="border-b border-border/20 bg-muted/30">
            <td
              colSpan={totalCols}
              className="px-4 py-3 text-center text-xs text-muted-foreground"
            >
              No agents assigned to this queue
            </td>
          </tr>
        )}
      </tbody>
    </QueueContextMenu>

    {/* Manage Agents Dialog (admin only) — rendered outside context menu via portal */}
    {isAdmin && (
      <ManageAgentsDialog
        queue={queue}
        open={manageAgentsOpen}
        onOpenChange={setManageAgentsOpen}
      />
    )}
    </>
  );
}
