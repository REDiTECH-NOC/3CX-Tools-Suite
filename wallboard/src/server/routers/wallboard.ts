import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { WallboardState } from '@/types/wallboard';

export const wallboardRouter = router({
  /**
   * Returns the current wallboard state for initial load / fallback.
   * In production, the SSE stream is the primary data source; this endpoint
   * provides a one-shot snapshot for hydration or reconnection.
   */
  getState: protectedProcedure.query(async ({ ctx }): Promise<WallboardState> => {
    // Fetch visible queues to build a minimal state
    const queues = await ctx.prisma.wallboardQueue.findMany({
      where: { visible: true },
      orderBy: { sortOrder: 'asc' },
    });

    return {
      lastUpdated: new Date().toISOString(),
      pollIntervalMs: 10000,
      connectionStatus: 'connecting',
      dataMode: 'polling',
      avgWaitWindowMinutes: 60,
      queues: queues.map((q) => ({
        queueId: q.queueId,
        queueNumber: q.queueNumber,
        queueName: q.queueName,
        callsWaiting: 0,
        longestWaitSec: 0,
        agentsLoggedIn: 0,
        agentsTotal: 0,
        agentsTalking: 0,
        agentsAvailable: 0,
        callsAnswered: 0,
        callsAbandoned: 0,
        avgWaitSec: 0,
        totalAvgWaitSec: 0,
        abandonRate: 0,
        agents: [],
        managerExtensions: [],
      })),
      totals: {
        totalCallsWaiting: 0,
        totalAgentsAvailable: 0,
        totalAgentsTalking: 0,
        totalAgentsLoggedIn: 0,
        totalAnsweredToday: 0,
        totalAbandonedToday: 0,
        overallAbandonRate: 0,
        longestWaitWindow: 0,
        longestWaitToday: 0,
        avgWaitWindow: 0,
        avgWaitToday: 0,
      },
    };
  }),

  /**
   * Fetch queue snapshots for charting (sampled at 5-minute intervals).
   */
  getSnapshots: protectedProcedure
    .input(
      z.object({
        queueId: z.number().int().optional(),
        hours: z.number().min(1).max(72).default(4),
      }),
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.hours * 60 * 60 * 1000);

      const snapshots = await ctx.prisma.queueSnapshot.findMany({
        where: {
          ...(input.queueId != null ? { queueId: input.queueId } : {}),
          timestamp: { gte: since },
        },
        orderBy: { timestamp: 'asc' },
      });

      // Sample at 5-minute intervals per queue to reduce payload for charts
      const INTERVAL_MS = 5 * 60 * 1000;
      const sampled: typeof snapshots = [];
      const lastBucketPerQueue = new Map<number, number>();

      for (const snap of snapshots) {
        const bucket = Math.floor(snap.timestamp.getTime() / INTERVAL_MS);
        if (bucket !== lastBucketPerQueue.get(snap.queueId)) {
          sampled.push(snap);
          lastBucketPerQueue.set(snap.queueId, bucket);
        }
      }

      return sampled;
    }),

  /**
   * Fetch daily summaries for historical charts.
   */
  getDailySummary: protectedProcedure
    .input(
      z.object({
        queueId: z.number().int().optional(),
        days: z.number().min(1).max(365).default(7),
      }),
    )
    .query(async ({ ctx, input }) => {
      const since = new Date();
      since.setDate(since.getDate() - input.days);
      since.setHours(0, 0, 0, 0);

      return ctx.prisma.queueDailySummary.findMany({
        where: {
          ...(input.queueId != null ? { queueId: input.queueId } : {}),
          date: { gte: since },
        },
        orderBy: { date: 'asc' },
      });
    }),

  /**
   * Returns all threshold rows (global + per-queue) with related queue info.
   */
  getThresholds: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.wallboardThreshold.findMany({
      include: { queue: true },
      orderBy: [{ wallboardQueueId: 'asc' }, { metric: 'asc' }],
    });
  }),

  /**
   * Returns the current user's preferences, creating defaults if none exist.
   */
  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    let prefs = await ctx.prisma.userPreference.findUnique({
      where: { userId: ctx.user.id },
    });

    if (!prefs) {
      prefs = await ctx.prisma.userPreference.create({
        data: { userId: ctx.user.id },
      });
    }

    return prefs;
  }),

  /**
   * Updates the current user's wallboard preferences.
   */
  updatePreferences: protectedProcedure
    .input(
      z.object({
        visibleColumns: z.array(z.string()).optional(),
        columnOrder: z.array(z.string()).optional(),
        rowDensity: z.enum(['compact', 'comfortable', 'spacious']).optional(),
        fontSize: z.enum(['small', 'medium', 'large']).optional(),
        analyticsCollapsed: z.boolean().optional(),
        autoExpandRows: z.boolean().optional(),
        soundAlerts: z.record(z.any()).optional(),
        theme: z.enum(['dark', 'light', 'system']).optional(),
        pushNotifications: z.boolean().optional(),
        pinnedQueues: z.array(z.string()).optional(),
        sortColumn: z.string().nullable().optional(),
        sortDirection: z.enum(['asc', 'desc']).optional(),
        queueOrderMode: z.enum(['default', 'manual', 'watch']).optional(),
        manualQueueOrder: z.array(z.string()).optional(),
        watchColumn: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Ensure preferences row exists
      await ctx.prisma.userPreference.upsert({
        where: { userId: ctx.user.id },
        create: { userId: ctx.user.id },
        update: {},
      });

      return ctx.prisma.userPreference.update({
        where: { userId: ctx.user.id },
        data: {
          ...(input.visibleColumns !== undefined && { visibleColumns: input.visibleColumns }),
          ...(input.columnOrder !== undefined && { columnOrder: input.columnOrder }),
          ...(input.rowDensity !== undefined && { rowDensity: input.rowDensity }),
          ...(input.fontSize !== undefined && { fontSize: input.fontSize }),
          ...(input.analyticsCollapsed !== undefined && {
            analyticsCollapsed: input.analyticsCollapsed,
          }),
          ...(input.autoExpandRows !== undefined && { autoExpandRows: input.autoExpandRows }),
          ...(input.soundAlerts !== undefined && { soundAlerts: input.soundAlerts }),
          ...(input.theme !== undefined && { theme: input.theme }),
          ...(input.pushNotifications !== undefined && { pushNotifications: input.pushNotifications }),
          ...(input.pinnedQueues !== undefined && { pinnedQueues: input.pinnedQueues }),
          ...(input.sortColumn !== undefined && { sortColumn: input.sortColumn }),
          ...(input.sortDirection !== undefined && { sortDirection: input.sortDirection }),
          ...(input.queueOrderMode !== undefined && { queueOrderMode: input.queueOrderMode }),
          ...(input.manualQueueOrder !== undefined && { manualQueueOrder: input.manualQueueOrder }),
          ...(input.watchColumn !== undefined && { watchColumn: input.watchColumn }),
        },
      });
    }),
});
