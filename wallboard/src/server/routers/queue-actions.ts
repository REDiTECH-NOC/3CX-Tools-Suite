import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { ThreecxClient } from '@/lib/threecx-client';
import { decrypt } from '@/lib/crypto';
import { poller } from '@/lib/threecx-poller';
import { setAgentOverride } from '@/lib/relay-store';

/**
 * Creates a ThreecxClient using the system owner credentials from SystemConfig.
 * Queue login/logout operations must be performed with system-level access.
 */
async function getSystemClient(prisma: typeof import('@prisma/client').PrismaClient.prototype) {
  const config = await prisma.systemConfig.findUnique({
    where: { id: 'singleton' },
  });
  if (!config?.setupComplete) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'System configuration not found or setup incomplete.',
    });
  }

  const password = decrypt(config.encryptedPassword);
  return new ThreecxClient(config.pbxUrl, config.extensionNumber, password);
}

export const queueActionsRouter = router({
  /**
   * Sign the current user into a queue.
   * Uses system owner credentials to perform the queue login action.
   */
  signIn: protectedProcedure
    .input(
      z.object({
        queueId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);

      try {
        await client.queueAgentLogin(input.queueId, ctx.user.extensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to sign into queue: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Optimistic override so UI updates immediately (relay may take 30s)
      const q = await ctx.prisma.wallboardQueue.findUnique({ where: { queueId: input.queueId }, select: { queueNumber: true } });
      if (q) setAgentOverride(q.queueNumber, ctx.user.extensionNumber, true);
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Sign the current user out of a queue.
   * Uses system owner credentials to perform the queue logout action.
   */
  signOut: protectedProcedure
    .input(
      z.object({
        queueId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);

      try {
        await client.queueAgentLogout(input.queueId, ctx.user.extensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to sign out of queue: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const q = await ctx.prisma.wallboardQueue.findUnique({ where: { queueId: input.queueId }, select: { queueNumber: true } });
      if (q) setAgentOverride(q.queueNumber, ctx.user.extensionNumber, false);
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Sign a specific agent into a queue (manager action).
   * Verifies the caller is a manager of the target queue.
   */
  signInAgent: protectedProcedure
    .input(
      z.object({
        queueId: z.number().int().positive(),
        targetExtensionNumber: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);

      // Verify the caller is a manager of this queue
      const managers = await client.getQueueManagers(input.queueId);
      const isManager = managers.some((m) => m.Number === ctx.user.extensionNumber);

      if (!isManager) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only queue managers can sign other agents in or out.',
        });
      }

      try {
        await client.queueAgentLogin(input.queueId, input.targetExtensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to sign agent ${input.targetExtensionNumber} into queue: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      const q = await ctx.prisma.wallboardQueue.findUnique({ where: { queueId: input.queueId }, select: { queueNumber: true } });
      if (q) setAgentOverride(q.queueNumber, input.targetExtensionNumber, true);
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Sign a specific agent out of a queue (manager action).
   * Verifies the caller is a manager of the target queue.
   */
  signOutAgent: protectedProcedure
    .input(
      z.object({
        queueId: z.number().int().positive(),
        targetExtensionNumber: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);

      // Verify the caller is a manager of this queue
      const managers = await client.getQueueManagers(input.queueId);
      const isManager = managers.some((m) => m.Number === ctx.user.extensionNumber);

      if (!isManager) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only queue managers can sign other agents in or out.',
        });
      }

      try {
        await client.queueAgentLogout(input.queueId, input.targetExtensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to sign agent ${input.targetExtensionNumber} out of queue: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      const q = await ctx.prisma.wallboardQueue.findUnique({ where: { queueId: input.queueId }, select: { queueNumber: true } });
      if (q) setAgentOverride(q.queueNumber, input.targetExtensionNumber, false);
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Get the current user's queue membership status.
   * Uses the WebSocket queue monitor for real per-queue agent status.
   */
  getMyQueueStatus: protectedProcedure.query(async ({ ctx }) => {
    const client = await getSystemClient(ctx.prisma);
    const extensionNumber = ctx.user.extensionNumber;
    const monitor = poller.getQueueMonitor();

    // Get all configured queues from the database
    const dbQueues = await ctx.prisma.wallboardQueue.findMany({
      where: { visible: true },
      orderBy: { sortOrder: 'asc' },
    });

    const results: Array<{
      queueId: number;
      queueNumber: string;
      queueName: string;
      loggedIn: boolean;
    }> = [];

    // Get user's global queue status as fallback
    let userQueueStatus = 'LoggedOut';
    try {
      const users = await client.getUsers();
      const me = users.find((u) => u.Number === extensionNumber);
      userQueueStatus = me?.QueueStatus ?? 'LoggedOut';
    } catch {
      // Fall back to logged out
    }

    // Check each queue for the user's agent membership
    for (const dbQueue of dbQueues) {
      try {
        const agents = await client.getQueueAgents(dbQueue.queueId);
        const myAgent = agents.find((a) => a.Number === extensionNumber);

        let loggedIn = false;
        if (myAgent) {
          // Monitor is the only reliable per-queue source
          if (monitor?.hasData()) {
            const monitorStatus =
              monitor.isAgentLoggedInByNumber(dbQueue.queueNumber, extensionNumber) ??
              monitor.isAgentLoggedIn(dbQueue.queueId, extensionNumber);
            loggedIn = monitorStatus ?? userQueueStatus === 'LoggedIn';
          } else {
            loggedIn = userQueueStatus === 'LoggedIn';
          }
        }

        results.push({
          queueId: dbQueue.queueId,
          queueNumber: dbQueue.queueNumber,
          queueName: dbQueue.queueName,
          loggedIn,
        });
      } catch {
        results.push({
          queueId: dbQueue.queueId,
          queueNumber: dbQueue.queueNumber,
          queueName: dbQueue.queueName,
          loggedIn: false,
        });
      }
    }

    return results;
  }),

  // ─── Queue Membership (Add/Remove Agents) ──────────────────────

  /**
   * Add the current user to a queue as an agent.
   * Any authenticated user can join a queue themselves.
   */
  addSelfToQueue: protectedProcedure
    .input(z.object({ queueId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);
      try {
        await client.addAgentToQueue(input.queueId, ctx.user.extensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to join queue: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Remove the current user from a queue.
   * Any authenticated user can leave a queue themselves.
   */
  removeSelfFromQueue: protectedProcedure
    .input(z.object({ queueId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);
      try {
        await client.removeAgentFromQueue(input.queueId, ctx.user.extensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to leave queue: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Add any user to a queue (admin only).
   */
  addAgentToQueue: adminProcedure
    .input(z.object({
      queueId: z.number().int().positive(),
      extensionNumber: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);
      try {
        await client.addAgentToQueue(input.queueId, input.extensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to add agent ${input.extensionNumber}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Remove any user from a queue (admin only).
   */
  removeAgentFromQueue: adminProcedure
    .input(z.object({
      queueId: z.number().int().positive(),
      extensionNumber: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const client = await getSystemClient(ctx.prisma);
      try {
        await client.removeAgentFromQueue(input.queueId, input.extensionNumber);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to remove agent ${input.extensionNumber}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      poller.forcePoll();
      return { success: true };
    }),

  /**
   * Get all enabled PBX users (admin only).
   * Used by the manage agents dialog to show available users to add.
   */
  getPbxUsers: adminProcedure.query(async ({ ctx }) => {
    const client = await getSystemClient(ctx.prisma);
    const users = await client.getUsers();
    return users
      .filter((u) => u.Enabled)
      .map((u) => ({
        extensionNumber: u.Number,
        displayName: `${u.FirstName} ${u.LastName}`.trim() || `Ext ${u.Number}`,
        isRegistered: u.IsRegistered,
      }))
      .sort((a, b) => a.extensionNumber.localeCompare(b.extensionNumber, undefined, { numeric: true }));
  }),
});
