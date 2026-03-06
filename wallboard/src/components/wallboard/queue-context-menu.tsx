'use client';

import { useCallback } from 'react';
import type { QueueWallboardData } from '@/types/wallboard';
import { trpc } from '@/lib/trpc';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '@/components/ui/context-menu';
import {
  LogIn,
  LogOut,
  Pin,
  PinOff,
  Users,
  Loader2,
  UserPlus,
  UserMinus,
  Settings2,
} from 'lucide-react';

interface QueueContextMenuProps {
  queue: QueueWallboardData;
  isSignedIn: boolean;
  isPinned: boolean;
  pinnedQueues: string[];
  /** Whether the current user is an agent in this queue */
  isMember: boolean;
  /** Whether the current user is an admin */
  isAdmin: boolean;
  /** Callback to open the manage agents dialog */
  onManageAgents?: () => void;
  children: React.ReactNode;
}

/**
 * Right-click context menu wrapping each queue row.
 * Provides sign in/out, join/leave queue, pin/unpin,
 * manage agents (admin), and agent list at a glance.
 */
export function QueueContextMenu({
  queue,
  isSignedIn,
  isPinned,
  pinnedQueues,
  isMember,
  isAdmin,
  onManageAgents,
  children,
}: QueueContextMenuProps) {
  const utils = trpc.useUtils();

  const signInMutation = trpc.queueActions.signIn.useMutation({
    onSuccess: () => {
      utils.queueActions.getMyQueueStatus.invalidate();
    },
  });

  const signOutMutation = trpc.queueActions.signOut.useMutation({
    onSuccess: () => {
      utils.queueActions.getMyQueueStatus.invalidate();
    },
  });

  const joinMutation = trpc.queueActions.addSelfToQueue.useMutation({
    onSuccess: () => {
      utils.queueActions.getMyQueueStatus.invalidate();
    },
  });

  const leaveMutation = trpc.queueActions.removeSelfFromQueue.useMutation({
    onSuccess: () => {
      utils.queueActions.getMyQueueStatus.invalidate();
    },
  });

  const updatePrefsMutation = trpc.wallboard.updatePreferences.useMutation({
    onSuccess: () => {
      utils.wallboard.getPreferences.invalidate();
    },
  });

  const isActioning =
    signInMutation.isPending ||
    signOutMutation.isPending ||
    joinMutation.isPending ||
    leaveMutation.isPending;

  const handleSignIn = useCallback(() => {
    if (isActioning) return;
    signInMutation.mutate({ queueId: queue.queueId });
  }, [isActioning, signInMutation, queue.queueId]);

  const handleSignOut = useCallback(() => {
    if (isActioning) return;
    signOutMutation.mutate({ queueId: queue.queueId });
  }, [isActioning, signOutMutation, queue.queueId]);

  const handleJoinQueue = useCallback(() => {
    if (isActioning) return;
    joinMutation.mutate({ queueId: queue.queueId });
  }, [isActioning, joinMutation, queue.queueId]);

  const handleLeaveQueue = useCallback(() => {
    if (isActioning) return;
    leaveMutation.mutate({ queueId: queue.queueId });
  }, [isActioning, leaveMutation, queue.queueId]);

  const handleTogglePin = useCallback(() => {
    const queueIdStr = String(queue.queueId);
    const newPinned = isPinned
      ? pinnedQueues.filter((id) => id !== queueIdStr)
      : [...pinnedQueues, queueIdStr];

    updatePrefsMutation.mutate({ pinnedQueues: newPinned });
  }, [isPinned, pinnedQueues, queue.queueId, updatePrefsMutation]);

  // Count logged-in and logged-out agents
  const loggedInAgents = queue.agents.filter(
    (a) => a.queueStatus === 'LoggedIn',
  );
  const loggedOutAgents = queue.agents.filter(
    (a) => a.queueStatus === 'LoggedOut',
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        {/* Queue name header */}
        <ContextMenuLabel className="flex items-center gap-2 text-sm">
          <span className="truncate">{queue.queueName}</span>
          <span className="font-mono text-xs text-muted-foreground">
            #{queue.queueNumber}
          </span>
        </ContextMenuLabel>

        <ContextMenuSeparator />

        {/* Sign In / Sign Out (only visible if member) */}
        {isMember && (
          <>
            {!isSignedIn ? (
              <ContextMenuItem
                onClick={handleSignIn}
                disabled={isActioning}
                className="gap-2"
              >
                {signInMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                <span>Sign In to Queue</span>
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                onClick={handleSignOut}
                disabled={isActioning}
                className="gap-2"
              >
                {signOutMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" />
                )}
                <span>Sign Out of Queue</span>
              </ContextMenuItem>
            )}
          </>
        )}

        {/* Join / Leave Queue */}
        {isMember ? (
          <ContextMenuItem
            onClick={handleLeaveQueue}
            disabled={isActioning}
            className="gap-2"
          >
            {leaveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserMinus className="h-4 w-4" />
            )}
            <span>Leave Queue</span>
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            onClick={handleJoinQueue}
            disabled={isActioning}
            className="gap-2"
          >
            {joinMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            <span>Join Queue</span>
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {/* Pin / Unpin */}
        <ContextMenuItem onClick={handleTogglePin} className="gap-2">
          {isPinned ? (
            <>
              <PinOff className="h-4 w-4" />
              <span>Unpin Queue</span>
            </>
          ) : (
            <>
              <Pin className="h-4 w-4" />
              <span>Pin Queue</span>
            </>
          )}
        </ContextMenuItem>

        {/* Manage Queue Agents (admin only) */}
        {isAdmin && onManageAgents && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onManageAgents} className="gap-2">
              <Settings2 className="h-4 w-4" />
              <span>Manage Queue Agents...</span>
            </ContextMenuItem>
          </>
        )}

        <ContextMenuSeparator />

        {/* Agent list summary */}
        <ContextMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          Agents ({queue.agents.length})
        </ContextMenuLabel>

        {/* Logged in agents */}
        {loggedInAgents.length > 0 && (
          <div className="px-2 py-1">
            {loggedInAgents.map((agent) => (
              <div
                key={agent.extensionNumber}
                className="flex items-center gap-2 py-0.5"
              >
                <span
                  className={`inline-flex h-1.5 w-1.5 rounded-full ${
                    agent.callState === 'available'
                      ? 'bg-emerald-500'
                      : agent.callState === 'talking'
                        ? 'bg-amber-500'
                        : agent.callState === 'ringing'
                          ? 'bg-blue-500'
                          : 'bg-red-500'
                  }`}
                />
                <span className="truncate text-xs text-foreground/80">
                  {agent.displayName}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {agent.extensionNumber}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Logged out agents */}
        {loggedOutAgents.length > 0 && (
          <div className="border-t border-border/30 px-2 py-1">
            {loggedOutAgents.map((agent) => (
              <div
                key={agent.extensionNumber}
                className="flex items-center gap-2 py-0.5 opacity-50"
              >
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-zinc-500" />
                <span className="truncate text-xs text-foreground/60">
                  {agent.displayName}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {agent.extensionNumber}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Mutation feedback */}
        {signInMutation.isError && (
          <div className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
            Failed to sign in: {signInMutation.error.message}
          </div>
        )}
        {signOutMutation.isError && (
          <div className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
            Failed to sign out: {signOutMutation.error.message}
          </div>
        )}
        {joinMutation.isError && (
          <div className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
            Failed to join: {joinMutation.error.message}
          </div>
        )}
        {leaveMutation.isError && (
          <div className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
            Failed to leave: {leaveMutation.error.message}
          </div>
        )}
        {signInMutation.isSuccess && (
          <div className="px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400">
            Signed in successfully
          </div>
        )}
        {signOutMutation.isSuccess && (
          <div className="px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400">
            Signed out successfully
          </div>
        )}
        {joinMutation.isSuccess && (
          <div className="px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400">
            Joined queue successfully
          </div>
        )}
        {leaveMutation.isSuccess && (
          <div className="px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400">
            Left queue successfully
          </div>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
