'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { QueueRow, type QueueRowProps } from './queue-row';

interface SortableQueueRowProps extends QueueRowProps {
  sortableId: string;
}

export function SortableQueueRow({ sortableId, ...props }: SortableQueueRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });

  return (
    <QueueRow
      {...props}
      dragRef={setNodeRef}
      dragStyle={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 40 : undefined,
        position: isDragging ? 'relative' as const : undefined,
      }}
      dragHandleProps={{ ...attributes, ...listeners }}
    />
  );
}
