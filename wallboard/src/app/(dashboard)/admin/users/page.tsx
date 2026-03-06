'use client';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Loader2,
  Shield,
  ShieldCheck,
  Trash2,
  Clock,
  User,
  MonitorSmartphone,
} from 'lucide-react';
import { useState } from 'react';

// ─── Helper: format relative time ────────────────────────────────────────

function formatRelativeTime(date: Date | string | null): string {
  if (!date) return 'Never';
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Users Table ──────────────────────────────────────────────────────────

function UsersTable() {
  const utils = trpc.useUtils();
  const { data: users, isLoading, isError } = trpc.admin.getUsers.useQuery();

  const updateRoleMutation = trpc.admin.updateUserRole.useMutation({
    onSuccess: () => utils.admin.getUsers.invalidate(),
  });

  function handleRoleChange(userId: string, role: 'ADMIN' | 'USER') {
    updateRoleMutation.mutate({ userId, role });
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
        Failed to load users.
      </div>
    );
  }

  if (!users || users.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No users found. Users are created automatically on first login.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="rounded-md border">
      <table className="w-full">
        <thead>
          <tr className="border-b bg-muted/30 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2.5">Extension</th>
            <th className="px-3 py-2.5">Name</th>
            <th className="w-36 px-3 py-2.5">Role</th>
            <th className="w-32 px-3 py-2.5">Status</th>
            <th className="w-32 px-3 py-2.5">Last Login</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr
              key={user.id}
              className="border-b border-border/30 transition-colors last:border-b-0 hover:bg-muted/10"
            >
              {/* Extension */}
              <td className="px-3 py-2.5">
                <span className="font-mono text-sm">{user.extensionNumber}</span>
              </td>

              {/* Display Name */}
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {user.displayName}
                  </span>
                </div>
              </td>

              {/* Role */}
              <td className="px-3 py-2.5">
                <Select
                  value={user.role}
                  onValueChange={(val) =>
                    handleRoleChange(user.id, val as 'ADMIN' | 'USER')
                  }
                  disabled={updateRoleMutation.isPending}
                >
                  <SelectTrigger className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADMIN">
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className="h-3 w-3" />
                        Admin
                      </div>
                    </SelectItem>
                    <SelectItem value="USER">
                      <div className="flex items-center gap-1.5">
                        <Shield className="h-3 w-3" />
                        User
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </td>

              {/* Active status */}
              <td className="px-3 py-2.5">
                <Badge
                  variant={user.isActive ? 'default' : 'secondary'}
                  className="text-xs font-normal"
                >
                  {user.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </td>

              {/* Last login */}
              <td className="px-3 py-2.5">
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(user.lastLoginAt)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Active Sessions Table ────────────────────────────────────────────────

function SessionsTable() {
  const utils = trpc.useUtils();
  const {
    data: sessions,
    isLoading,
    isError,
  } = trpc.admin.getSessions.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const revokeMutation = trpc.admin.revokeSession.useMutation({
    onSuccess: () => utils.admin.getSessions.invalidate(),
  });

  const [revokeTarget, setRevokeTarget] = useState<{
    id: string;
    userName: string;
  } | null>(null);

  function handleRevoke(sessionId: string) {
    revokeMutation.mutate(
      { sessionId },
      {
        onSuccess: () => setRevokeTarget(null),
      },
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load sessions.
      </div>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No active sessions.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-md border">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/30 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2.5">User</th>
              <th className="w-32 px-3 py-2.5">Role</th>
              <th className="w-36 px-3 py-2.5">Created</th>
              <th className="w-36 px-3 py-2.5">Expires</th>
              <th className="w-20 px-3 py-2.5 text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr
                key={session.id}
                className="border-b border-border/30 transition-colors last:border-b-0 hover:bg-muted/10"
              >
                {/* User */}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <MonitorSmartphone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {session.user.displayName}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      Ext {session.user.extensionNumber}
                    </span>
                  </div>
                </td>

                {/* Role */}
                <td className="px-3 py-2.5">
                  <Badge
                    variant={
                      session.user.role === 'ADMIN' ? 'default' : 'secondary'
                    }
                    className="text-xs font-normal"
                  >
                    {session.user.role}
                  </Badge>
                </td>

                {/* Created */}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {formatDateTime(session.createdAt)}
                  </div>
                </td>

                {/* Expires */}
                <td className="px-3 py-2.5">
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(session.expiresAt)}
                  </span>
                </td>

                {/* Revoke */}
                <td className="px-3 py-2.5 text-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setRevokeTarget({
                        id: session.id,
                        userName: session.user.displayName,
                      })
                    }
                    title="Revoke session"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Revoke confirmation dialog */}
      <Dialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke Session</DialogTitle>
            <DialogDescription>
              This will immediately log out{' '}
              <strong>{revokeTarget?.userName}</strong> from this session. They
              will need to log in again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => revokeTarget && handleRevoke(revokeTarget.id)}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-3.5 w-3.5" />
              )}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Main Users Page ──────────────────────────────────────────────────────

export default function AdminUsersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">
          User Management
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage user roles and active sessions.
        </p>
      </div>

      {/* Users */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Users</CardTitle>
          <CardDescription>
            All registered users. Users are auto-created on first login via
            extension authentication.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UsersTable />
        </CardContent>
      </Card>

      {/* Active Sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Sessions</CardTitle>
          <CardDescription>
            Currently active user sessions. Revoke a session to force logout.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SessionsTable />
        </CardContent>
      </Card>
    </div>
  );
}
