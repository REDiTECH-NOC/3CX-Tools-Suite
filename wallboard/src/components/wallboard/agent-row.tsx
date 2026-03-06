'use client';

import { useState, useCallback, useEffect } from 'react';
import type { QueueAgentStatus } from '@/types/wallboard';
import { trpc } from '@/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Shield, Wifi, WifiOff, Loader2 } from 'lucide-react';

interface AgentRowProps {
  agent: QueueAgentStatus;
  colSpan: number;
  queueId: number;
  currentUserIsManager: boolean;
  currentUserExtension?: string | null;
  /** Parent-level permission denied flag (survives expand/collapse) */
  permissionDenied: boolean;
  /** Callback to notify parent when server returns FORBIDDEN */
  onPermissionDenied: () => void;
}

function getAgentIndicator(
  queueStatus: string,
  callState: QueueAgentStatus['callState'],
): {
  dotClass: string;
  label: string;
  labelClass: string;
} {
  if (queueStatus === 'LoggedOut') {
    return {
      dotClass: 'bg-zinc-500',
      label: 'Logged Out',
      labelClass: 'text-zinc-600 dark:text-zinc-400',
    };
  }

  switch (callState) {
    case 'available':
      return {
        dotClass: 'bg-emerald-500',
        label: 'Available',
        labelClass: 'text-emerald-600 dark:text-emerald-400',
      };
    case 'talking':
      return {
        dotClass: 'bg-amber-500 animate-pulse',
        label: 'On Call',
        labelClass: 'text-amber-600 dark:text-amber-400',
      };
    case 'ringing':
      return {
        dotClass: 'bg-blue-500 animate-pulse',
        label: 'Ringing',
        labelClass: 'text-blue-600 dark:text-blue-400',
      };
    case 'offline':
      return {
        dotClass: 'bg-red-500',
        label: 'Offline',
        labelClass: 'text-red-600 dark:text-red-400',
      };
    default:
      return {
        dotClass: 'bg-zinc-500',
        label: 'Unknown',
        labelClass: 'text-zinc-600 dark:text-zinc-400',
      };
  }
}

export function AgentRow({ agent, colSpan, queueId, currentUserIsManager, currentUserExtension, permissionDenied, onPermissionDenied }: AgentRowProps) {
  const isSelf = currentUserExtension === agent.extensionNumber;

  const canToggle = (currentUserIsManager && !permissionDenied) || isSelf;

  // Optimistic status: immediately flip UI on click, clear when real data arrives
  const [optimisticStatus, setOptimisticStatus] = useState<'LoggedIn' | 'LoggedOut' | null>(null);

  // Clear optimistic override when real data updates from SSE
  useEffect(() => {
    setOptimisticStatus(null);
  }, [agent.queueStatus]);

  const effectiveQueueStatus = optimisticStatus ?? agent.queueStatus;
  const effectiveCallState =
    optimisticStatus === 'LoggedIn' && agent.queueStatus === 'LoggedOut'
      ? 'available' as const // Optimistically show as available when signing in
      : optimisticStatus === 'LoggedOut'
        ? 'offline' as const // Optimistically show as offline when signing out
        : agent.callState;

  const indicator = getAgentIndicator(effectiveQueueStatus, effectiveCallState);

  // Manager mutations (for toggling other agents)
  const signInAgentMutation = trpc.queueActions.signInAgent.useMutation();
  const signOutAgentMutation = trpc.queueActions.signOutAgent.useMutation();
  // Self mutations (for toggling own status)
  const signInSelfMutation = trpc.queueActions.signIn.useMutation();
  const signOutSelfMutation = trpc.queueActions.signOut.useMutation();

  const isToggling =
    signInAgentMutation.isPending || signOutAgentMutation.isPending ||
    signInSelfMutation.isPending || signOutSelfMutation.isPending;
  const toggleError =
    signInAgentMutation.error || signOutAgentMutation.error ||
    signInSelfMutation.error || signOutSelfMutation.error;

  const handleStatusClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canToggle || isToggling) return;

      // Optimistic update: immediately flip the displayed status
      const newStatus = effectiveQueueStatus === 'LoggedOut' ? 'LoggedIn' : 'LoggedOut';
      setOptimisticStatus(newStatus);

      const onError = (err: unknown) => {
        // Revert optimistic update on failure
        setOptimisticStatus(null);
        // If server says we're not a manager, notify parent to persist the denial
        const trpcErr = err as { data?: { code?: string } } | undefined;
        if (trpcErr?.data?.code === 'FORBIDDEN') {
          onPermissionDenied();
        }
      };

      if (isSelf) {
        if (effectiveQueueStatus === 'LoggedOut') {
          signInSelfMutation.mutate({ queueId }, { onError });
        } else {
          signOutSelfMutation.mutate({ queueId }, { onError });
        }
      } else {
        if (effectiveQueueStatus === 'LoggedOut') {
          signInAgentMutation.mutate({
            queueId,
            targetExtensionNumber: agent.extensionNumber,
          }, { onError });
        } else {
          signOutAgentMutation.mutate({
            queueId,
            targetExtensionNumber: agent.extensionNumber,
          }, { onError });
        }
      }
    },
    [canToggle, isSelf, isToggling, effectiveQueueStatus, agent.extensionNumber, queueId, signInSelfMutation, signOutSelfMutation, signInAgentMutation, signOutAgentMutation, onPermissionDenied],
  );

  return (
    <tr className="border-b border-border/30 bg-muted/20 last:border-b-0">
      <td colSpan={colSpan} className="px-4 py-1.5">
        <div className="ml-8 flex items-center gap-6">
          {/* Agent name */}
          <div className="flex min-w-[180px] items-center gap-2">
            <span className="text-xs text-foreground/90">
              {agent.displayName}
            </span>
            {agent.isManager && (
              <Badge
                variant="outline"
                className="h-4 gap-0.5 border-amber-600/40 px-1 py-0 text-[10px] text-amber-600 dark:text-amber-400"
              >
                <Shield className="h-2.5 w-2.5" />
                Mgr
              </Badge>
            )}
          </div>

          {/* Extension */}
          <span className="min-w-[60px] font-mono text-xs text-muted-foreground">
            Ext {agent.extensionNumber}
          </span>

          {/* Status indicator — clickable for managers and self */}
          {canToggle ? (
            <button
              onClick={handleStatusClick}
              disabled={isToggling}
              className="flex items-center gap-1.5 rounded-md px-2 py-0.5 transition-colors hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              title={
                effectiveQueueStatus === 'LoggedOut'
                  ? `Sign ${isSelf ? 'yourself' : agent.displayName} into this queue`
                  : `Sign ${isSelf ? 'yourself' : agent.displayName} out of this queue`
              }
            >
              {isToggling ? (
                <Loader2 className="h-2 w-2 animate-spin text-muted-foreground" />
              ) : (
                <span className={`inline-flex h-2 w-2 rounded-full ${indicator.dotClass}`} />
              )}
              <span className={`text-xs ${indicator.labelClass}`}>
                {isToggling ? 'Updating...' : indicator.label}
              </span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className={`inline-flex h-2 w-2 rounded-full ${indicator.dotClass}`} />
              <span className={`text-xs ${indicator.labelClass}`}>
                {indicator.label}
              </span>
            </div>
          )}

          {/* Error display */}
          {toggleError && (
            <span className="text-[10px] text-red-600 dark:text-red-400 max-w-[200px] truncate" title={toggleError.message}>
              {toggleError.message}
            </span>
          )}

          {/* Profile (Available, DND, Away, etc.) */}
          {effectiveQueueStatus === 'LoggedIn' && agent.profileName !== 'Available' && (
            <span className="text-xs text-muted-foreground">
              ({agent.profileName})
            </span>
          )}

          {/* Registration (phone connected) */}
          <div className="flex items-center gap-1" title={agent.isRegistered ? 'Phone connected' : 'Phone not connected'}>
            {agent.isRegistered ? (
              <Wifi className="h-3 w-3 text-emerald-500/60" />
            ) : (
              <WifiOff className="h-3 w-3 text-zinc-500/60" />
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
