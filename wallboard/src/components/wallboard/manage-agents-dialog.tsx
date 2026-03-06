'use client';

import { useState, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, UserPlus, UserMinus, Loader2 } from 'lucide-react';
import type { QueueWallboardData } from '@/types/wallboard';

interface ManageAgentsDialogProps {
  queue: QueueWallboardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Admin dialog for managing queue agent membership.
 * Shows current agents with remove buttons, and a searchable
 * user picker for adding new agents.
 */
export function ManageAgentsDialog({
  queue,
  open,
  onOpenChange,
}: ManageAgentsDialogProps) {
  const [search, setSearch] = useState('');

  const pbxUsersQuery = trpc.queueActions.getPbxUsers.useQuery(undefined, {
    enabled: open,
    staleTime: 30_000,
  });

  const addMutation = trpc.queueActions.addAgentToQueue.useMutation({
    onSuccess: () => {
      // Data will refresh via SSE poller forcePoll on the server
    },
  });

  const removeMutation = trpc.queueActions.removeAgentFromQueue.useMutation({
    onSuccess: () => {
      // Data will refresh via SSE poller forcePoll on the server
    },
  });

  // Current agent extension numbers in this queue
  const currentAgentExtensions = useMemo(
    () => new Set(queue.agents.map((a) => a.extensionNumber)),
    [queue.agents],
  );

  // Available users = PBX users NOT already in the queue, filtered by search
  const availableUsers = useMemo(() => {
    if (!pbxUsersQuery.data) return [];
    const searchLower = search.toLowerCase();
    return pbxUsersQuery.data.filter((u) => {
      if (currentAgentExtensions.has(u.extensionNumber)) return false;
      if (!search) return true;
      return (
        u.displayName.toLowerCase().includes(searchLower) ||
        u.extensionNumber.includes(search)
      );
    });
  }, [pbxUsersQuery.data, currentAgentExtensions, search]);

  const handleAdd = (extensionNumber: string) => {
    addMutation.mutate({ queueId: queue.queueId, extensionNumber });
  };

  const handleRemove = (extensionNumber: string) => {
    removeMutation.mutate({ queueId: queue.queueId, extensionNumber });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Manage Agents
            <span className="font-mono text-sm font-normal text-muted-foreground">
              {queue.queueName} #{queue.queueNumber}
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* Current Agents */}
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Current Agents ({queue.agents.length})
          </h4>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {queue.agents.length === 0 && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                No agents assigned
              </p>
            )}
            {queue.agents.map((agent) => (
              <div
                key={agent.extensionNumber}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/30"
              >
                <span
                  className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                    agent.queueStatus === 'LoggedIn'
                      ? agent.callState === 'available'
                        ? 'bg-emerald-500'
                        : agent.callState === 'talking'
                          ? 'bg-amber-500'
                          : 'bg-blue-500'
                      : 'bg-zinc-500'
                  }`}
                />
                <span className="flex-1 truncate text-sm">
                  {agent.displayName}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {agent.extensionNumber}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  onClick={() => handleRemove(agent.extensionNumber)}
                  disabled={removeMutation.isPending}
                >
                  {removeMutation.isPending &&
                  removeMutation.variables?.extensionNumber === agent.extensionNumber ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <UserMinus className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Add Agent */}
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Add Agent
          </h4>
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or extension..."
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {pbxUsersQuery.isLoading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {availableUsers.length === 0 && !pbxUsersQuery.isLoading && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                {search ? 'No matching users found' : 'All users are already in this queue'}
              </p>
            )}
            {availableUsers.map((user) => (
              <div
                key={user.extensionNumber}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/30"
              >
                <span
                  className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                    user.isRegistered ? 'bg-emerald-500' : 'bg-zinc-500'
                  }`}
                />
                <span className="flex-1 truncate text-sm">
                  {user.displayName}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {user.extensionNumber}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                  onClick={() => handleAdd(user.extensionNumber)}
                  disabled={addMutation.isPending}
                >
                  {addMutation.isPending &&
                  addMutation.variables?.extensionNumber === user.extensionNumber ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <UserPlus className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Error feedback */}
        {addMutation.isError && (
          <p className="text-xs text-red-400">{addMutation.error.message}</p>
        )}
        {removeMutation.isError && (
          <p className="text-xs text-red-400">{removeMutation.error.message}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
