import { z } from 'zod';
import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { ThreecxClient } from '@/lib/threecx-client';
import { encrypt, decrypt } from '@/lib/crypto';

/** How recent a relay heartbeat must be to count as "connected" (2 minutes). */
const RELAY_HEARTBEAT_STALE_MS = 2 * 60 * 1000;

export const adminRouter = router({
  /**
   * Returns all configured wallboard queues with their thresholds.
   */
  getQueues: adminProcedure.query(async ({ ctx }) => {
    return ctx.prisma.wallboardQueue.findMany({
      include: { thresholds: true },
      orderBy: { sortOrder: 'asc' },
    });
  }),

  /**
   * Syncs queues from the 3CX PBX API.
   * Adds new queues, updates names on existing ones, preserves visibility/order.
   */
  syncQueues: adminProcedure.mutation(async ({ ctx }) => {
    const config = await ctx.prisma.systemConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!config) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'System configuration not found.',
      });
    }

    const password = decrypt(config.encryptedPassword);
    const client = new ThreecxClient(config.pbxUrl, config.extensionNumber, password);

    const pbxQueues = await client.getQueues();
    const existingQueues = await ctx.prisma.wallboardQueue.findMany();
    const existingByQueueId = new Map(existingQueues.map((q) => [q.queueId, q]));

    let maxSortOrder = existingQueues.reduce((max, q) => Math.max(max, q.sortOrder), -1);

    const synced: { added: number; updated: number } = { added: 0, updated: 0 };

    for (const pq of pbxQueues) {
      const existing = existingByQueueId.get(pq.Id);
      if (existing) {
        // Update name only — preserve visibility and sort order
        if (existing.queueName !== pq.Name || existing.queueNumber !== pq.Number) {
          await ctx.prisma.wallboardQueue.update({
            where: { id: existing.id },
            data: {
              queueName: pq.Name,
              queueNumber: pq.Number,
            },
          });
          synced.updated++;
        }
      } else {
        // New queue — add with next sort order, visible by default
        maxSortOrder++;
        await ctx.prisma.wallboardQueue.create({
          data: {
            queueId: pq.Id,
            queueNumber: pq.Number,
            queueName: pq.Name,
            visible: true,
            sortOrder: maxSortOrder,
          },
        });
        synced.added++;
      }
    }

    return synced;
  }),

  /**
   * Toggle queue visibility on the wallboard.
   */
  updateQueueVisibility: adminProcedure
    .input(
      z.object({
        queueId: z.string().min(1),
        visible: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.wallboardQueue.update({
        where: { id: input.queueId },
        data: { visible: input.visible },
      });
    }),

  /**
   * Reorder queues by providing the queue IDs in desired order.
   */
  updateQueueOrder: adminProcedure
    .input(
      z.object({
        queueIds: z.array(z.string().min(1)),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updates = input.queueIds.map((id, index) =>
        ctx.prisma.wallboardQueue.update({
          where: { id },
          data: { sortOrder: index },
        }),
      );
      await ctx.prisma.$transaction(updates);
      return { success: true };
    }),

  /**
   * Returns all thresholds, groupable by queue (null wallboardQueueId = global).
   */
  getThresholds: adminProcedure.query(async ({ ctx }) => {
    return ctx.prisma.wallboardThreshold.findMany({
      include: { queue: true },
      orderBy: [{ wallboardQueueId: 'asc' }, { metric: 'asc' }],
    });
  }),

  /**
   * Create or update a threshold for a metric (globally or per-queue).
   */
  upsertThreshold: adminProcedure
    .input(
      z.object({
        wallboardQueueId: z.string().nullable().optional(),
        metric: z.string().min(1),
        yellowValue: z.number().min(0),
        redValue: z.number().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const queueId = input.wallboardQueueId ?? null;
      const invertLogic = input.metric === 'agentsAvailable';

      // Manual find + update/create because Prisma upsert can't match NULL
      // in compound unique where clauses (NULL != NULL in PostgreSQL).
      const existing = await ctx.prisma.wallboardThreshold.findFirst({
        where: {
          wallboardQueueId: queueId,
          metric: input.metric,
        },
      });

      if (existing) {
        return ctx.prisma.wallboardThreshold.update({
          where: { id: existing.id },
          data: {
            yellowValue: input.yellowValue,
            redValue: input.redValue,
            invertLogic,
          },
        });
      }

      return ctx.prisma.wallboardThreshold.create({
        data: {
          wallboardQueueId: queueId,
          metric: input.metric,
          yellowValue: input.yellowValue,
          redValue: input.redValue,
          invertLogic,
        },
      });
    }),

  /**
   * Delete a per-queue threshold override. Global thresholds cannot be deleted this way.
   */
  deleteThreshold: adminProcedure
    .input(
      z.object({
        id: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const threshold = await ctx.prisma.wallboardThreshold.findUnique({
        where: { id: input.id },
      });
      if (!threshold) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Threshold not found.',
        });
      }
      if (!threshold.wallboardQueueId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot delete global thresholds. Update them instead.',
        });
      }
      await ctx.prisma.wallboardThreshold.delete({
        where: { id: input.id },
      });
      return { success: true };
    }),

  /**
   * Returns system configuration (password is not decrypted — just indicates presence).
   */
  getSettings: adminProcedure.query(async ({ ctx }) => {
    const config = await ctx.prisma.systemConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!config) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'System configuration not found.',
      });
    }

    return {
      id: config.id,
      pbxUrl: config.pbxUrl,
      extensionNumber: config.extensionNumber,
      hasPassword: !!config.encryptedPassword,
      pollIntervalMs: config.pollIntervalMs,
      avgWaitWindowMinutes: config.avgWaitWindowMinutes,
      setupComplete: config.setupComplete,
      relayApiKeyPrefix: config.relayApiKeyPrefix,
      relayLastHeartbeat: config.relayLastHeartbeat,
      relayLastIp: config.relayLastIp,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }),

  /**
   * Update system configuration settings.
   * If a new password is provided, it will be encrypted.
   */
  updateSettings: adminProcedure
    .input(
      z.object({
        pbxUrl: z.string().min(1).optional(),
        extensionNumber: z.string().min(1).optional(),
        password: z.string().min(1).optional(),
        pollIntervalMs: z.number().int().min(2000).max(120000).optional(),
        avgWaitWindowMinutes: z.number().int().min(5).max(1440).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data: Record<string, unknown> = {};

      if (input.pbxUrl !== undefined) data.pbxUrl = input.pbxUrl;
      if (input.extensionNumber !== undefined) data.extensionNumber = input.extensionNumber;
      if (input.pollIntervalMs !== undefined) data.pollIntervalMs = input.pollIntervalMs;
      if (input.avgWaitWindowMinutes !== undefined)
        data.avgWaitWindowMinutes = input.avgWaitWindowMinutes;
      if (input.password !== undefined) data.encryptedPassword = encrypt(input.password);

      await ctx.prisma.systemConfig.update({
        where: { id: 'singleton' },
        data,
      });

      return { success: true };
    }),

  /**
   * Test the current PBX connection. Returns success and latency.
   */
  testConnection: adminProcedure.mutation(async ({ ctx }) => {
    const config = await ctx.prisma.systemConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!config) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'System configuration not found.',
      });
    }

    const password = decrypt(config.encryptedPassword);
    const client = new ThreecxClient(config.pbxUrl, config.extensionNumber, password);

    const start = Date.now();
    const success = await client.healthCheck();
    const latencyMs = Date.now() - start;

    return { success, latencyMs };
  }),

  /**
   * Returns all user records with last login info.
   */
  getUsers: adminProcedure.query(async ({ ctx }) => {
    return ctx.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        extensionNumber: true,
        displayName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }),

  /**
   * Update a user's role.
   */
  updateUserRole: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        role: z.enum(['ADMIN', 'USER']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({ where: { id: input.userId } });
      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found.',
        });
      }
      return ctx.prisma.user.update({
        where: { id: input.userId },
        data: { role: input.role },
      });
    }),

  /**
   * Returns all active sessions with their associated user info.
   */
  getSessions: adminProcedure.query(async ({ ctx }) => {
    return ctx.prisma.session.findMany({
      where: {
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          select: {
            id: true,
            extensionNumber: true,
            displayName: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }),

  /**
   * Revoke (delete) a specific session.
   */
  revokeSession: adminProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = await ctx.prisma.session.findUnique({
        where: { id: input.sessionId },
      });
      if (!session) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found.',
        });
      }
      await ctx.prisma.session.delete({
        where: { id: input.sessionId },
      });
      return { success: true };
    }),

  /**
   * Returns relay agent connection status based on heartbeat recency.
   */
  getRelayStatus: adminProcedure.query(async ({ ctx }) => {
    const config = await ctx.prisma.systemConfig.findUnique({
      where: { id: 'singleton' },
      select: {
        relayApiKeyPrefix: true,
        relayLastHeartbeat: true,
        relayLastIp: true,
      },
    });

    if (!config) {
      return { configured: false, connected: false };
    }

    const hasKey = !!config.relayApiKeyPrefix;
    const isConnected =
      hasKey &&
      config.relayLastHeartbeat != null &&
      Date.now() - config.relayLastHeartbeat.getTime() < RELAY_HEARTBEAT_STALE_MS;

    return {
      configured: hasKey,
      connected: isConnected,
      apiKeyPrefix: config.relayApiKeyPrefix,
      lastHeartbeat: config.relayLastHeartbeat,
      lastIp: config.relayLastIp,
    };
  }),

  /**
   * Generates a new relay API key.
   * Stores the bcrypt hash in SystemConfig and returns the plain key once.
   */
  generateRelayKey: adminProcedure.mutation(async ({ ctx }) => {
    // Generate a secure random key
    const plainKey = `wb_relay_${randomBytes(32).toString('hex')}`;
    const prefix = plainKey.substring(0, 16);

    // Hash the key for storage (using Node crypto for simplicity)
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(plainKey).digest('hex');

    await ctx.prisma.systemConfig.update({
      where: { id: 'singleton' },
      data: {
        relayApiKeyHash: hash,
        relayApiKeyPrefix: prefix,
        relayLastHeartbeat: null,
        relayLastIp: null,
      },
    });

    return { key: plainKey, prefix };
  }),
});
