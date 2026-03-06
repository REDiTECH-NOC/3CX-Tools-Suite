'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ColumnDefinition, WallboardColumn } from '@/types/wallboard';
import { ArrowUp, ArrowDown, ArrowUpDown, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SortableColumnHeaderProps {
  column: ColumnDefinition;
  headerPadding: string;
  sortColumn: WallboardColumn | null;
  sortDirection: 'asc' | 'desc';
  onSortChange: (column: WallboardColumn) => void;
  isDragDisabled?: boolean;
  isSortDisabled?: boolean;
}

export function SortableColumnHeader({
  column,
  headerPadding,
  sortColumn,
  sortDirection,
  onSortChange,
  isDragDisabled = false,
  isSortDisabled = false,
}: SortableColumnHeaderProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.key,
    disabled: isDragDisabled,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? 'relative' : undefined,
  };

  const isSorted = sortColumn === column.key;
  const isTextCol = column.format === 'text';

  return (
    <th
      ref={setNodeRef}
      style={style}
      className={cn(
        headerPadding,
        'group/header select-none whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors',
        !isTextCol && 'text-right',
        isDragging && 'bg-accent/50 rounded',
      )}
      title={column.label}
    >
      <div className={cn('flex items-center gap-1', !isTextCol && 'justify-end')}>
        {/* Drag handle — visible on hover when dragging is enabled */}
        {!isDragDisabled && (
          <span
            {...attributes}
            {...listeners}
            className="cursor-grab opacity-0 transition-opacity group-hover/header:opacity-40 hover:!opacity-100 active:cursor-grabbing"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="h-3 w-3" />
          </span>
        )}

        {/* Clickable sort label */}
        <span
          className={cn(
            'transition-colors',
            !isSortDisabled && 'cursor-pointer hover:text-foreground',
            isSortDisabled && 'cursor-default',
          )}
          onClick={() => !isSortDisabled && onSortChange(column.key)}
        >
          {column.shortLabel}
        </span>

        {/* Sort direction indicators */}
        {isSorted ? (
          sortDirection === 'asc' ? (
            <ArrowUp className="h-3 w-3 text-foreground" />
          ) : (
            <ArrowDown className="h-3 w-3 text-foreground" />
          )
        ) : (
          !isSortDisabled && (
            <ArrowUpDown className="h-3 w-3 opacity-0 transition-opacity group-hover/header:opacity-100" />
          )
        )}
      </div>
    </th>
  );
}
