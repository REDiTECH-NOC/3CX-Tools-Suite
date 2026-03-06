import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import { ThreecxClient } from '@/lib/threecx-client';
import { encrypt, decrypt } from '@/lib/crypto';
import { createSession, destroySession } from '@/lib/session';
import { DEFAULT_THRESHOLDS } from '@/types/wallboard';

export const authRouter = router({
  /**
   * Check if the initial setup wizard has been completed.
   * Used by the app shell to redirect to /setup if needed.
   */
  checkSetup: publicProcedure.query(async ({ ctx }) => {
    const config = await ctx.prisma.systemConfig.findUnique({
      where: { id: 'singleton' },
      select: { setupComplete: true },
    });
    return { setupComplete: config?.setupComplete ?? false };
  }),

  /**
   * Initial setup wizard — validates 3CX credentials, creates the system config,
   * the first admin user, auto-discovers queues, and seeds default thresholds.
   */
  setup: publicProcedure
    .input(
      z.object({
        pbxUrl: z.string().min(1, 'PBX URL is required'),
        extensionNumber: z.string().min(1, 'Extension number is required'),
        password: z.string().min(1, 'Password is required'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Prevent re-running setup
      const existing = await ctx.prisma.systemConfig.findUnique({
        where: { id: 'singleton' },
        select: { setupComplete: true },
      });
      if (existing?.setupComplete) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Setup has already been completed.',
        });
      }

      // Validate credentials against the 3CX PBX
      const client = new ThreecxClient(input.pbxUrl, input.extensionNumber, input.password);
      const healthy = await client.healthCheck();
      if (!healthy) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Could not connect to the 3CX PBX. Verify the URL, extension number, and password.',
        });
      }

      // Encrypt the password for storage
      const encryptedPassword = encrypt(input.password);

      // Create the system config
      await ctx.prisma.systemConfig.upsert({
        where: { id: 'singleton' },
        update: {
          pbxUrl: input.pbxUrl,
          extensionNumber: input.extensionNumber,
          encryptedPassword,
          setupComplete: true,
        },
        create: {
          id: 'singleton',
          pbxUrl: input.pbxUrl,
          extensionNumber: input.extensionNumber,
          encryptedPassword,
          setupComplete: true,
        },
      });

      // Create the first user as ADMIN
      const user = await ctx.prisma.user.create({
        data: {
          extensionNumber: input.extensionNumber,
          displayName: `Admin (Ext ${input.extensionNumber})`,
          role: 'ADMIN',
          lastLoginAt: new Date(),
        },
      });

      // Create default user preferences
      await ctx.prisma.userPreference.create({
        data: { userId: user.id },
      });

      // Auto-discover queues from the PBX
      try {
        const queues = await client.getQueues();
        for (let i = 0; i < queues.length; i++) {
          const q = queues[i];
          await ctx.prisma.wallboardQueue.create({
            data: {
              queueId: q.Id,
              queueNumber: q.Number,
              queueName: q.Name,
              visible: true,
              sortOrder: i,
            },
          });
        }
      } catch {
        // Queue discovery is non-fatal — admin can sync later
      }

      // Seed default global thresholds
      for (const threshold of DEFAULT_THRESHOLDS) {
        const invertLogic = threshold.metric === 'agentsAvailable';
        await ctx.prisma.wallboardThreshold.create({
          data: {
            wallboardQueueId: null, // global
            metric: threshold.metric,
            yellowValue: threshold.yellowValue,
            redValue: threshold.redValue,
            invertLogic,
          },
        });
      }

      // Create session for the admin user
      await createSession(user.id);

      return { success: true };
    }),

  /**
   * Login — validates the user's 3CX extension credentials.
   * Creates or updates the user record on each login.
   */
  login: publicProcedure
    .input(
      z.object({
        extensionNumber: z.string().min(1, 'Extension number is required'),
        password: z.string().min(1, 'Password is required'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Get system config for the PBX URL
      const config = await ctx.prisma.systemConfig.findUnique({
        where: { id: 'singleton' },
      });
      if (!config?.setupComplete) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'System setup has not been completed.',
        });
      }

      // Validate the user's credentials against 3CX using a temporary client
      const userClient = new ThreecxClient(
        config.pbxUrl,
        input.extensionNumber,
        input.password,
      );
      const valid = await userClient.healthCheck();
      if (!valid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid extension number or password.',
        });
      }

      // Fetch display name from 3CX using system owner credentials
      let displayName = `Extension ${input.extensionNumber}`;
      try {
        const systemOwnerPassword = decrypt(config.encryptedPassword);
        const systemClient = new ThreecxClient(
          config.pbxUrl,
          config.extensionNumber,
          systemOwnerPassword,
        );
        const users = await systemClient.getUsers();
        const matchedUser = users.find((u) => u.Number === input.extensionNumber);
        if (matchedUser) {
          displayName = `${matchedUser.FirstName} ${matchedUser.LastName}`.trim() || displayName;
        }
      } catch {
        // Non-fatal — fall back to generic display name
      }

      // Determine role from ADMIN_EXTENSIONS env var
      const adminExtensions = (process.env.ADMIN_EXTENSIONS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const isAdmin =
        adminExtensions.includes(input.extensionNumber) ||
        input.extensionNumber === config.extensionNumber; // System owner is always admin
      const role = isAdmin ? 'ADMIN' : 'USER';

      // Look up or create user
      const user = await ctx.prisma.user.upsert({
        where: { extensionNumber: input.extensionNumber },
        update: {
          displayName,
          role,
          lastLoginAt: new Date(),
        },
        create: {
          extensionNumber: input.extensionNumber,
          displayName,
          role,
          lastLoginAt: new Date(),
        },
      });

      // Create default preferences if first login
      const existingPrefs = await ctx.prisma.userPreference.findUnique({
        where: { userId: user.id },
      });
      if (!existingPrefs) {
        await ctx.prisma.userPreference.create({
          data: { userId: user.id },
        });
      }

      // Create session
      await createSession(user.id);

      return {
        success: true,
        user: {
          extensionNumber: user.extensionNumber,
          displayName: user.displayName,
          role: user.role,
        },
      };
    }),

  /**
   * Logout — destroys the current session.
   */
  logout: protectedProcedure.mutation(async () => {
    await destroySession();
    return { success: true };
  }),

  /**
   * Get current user info from session.
   */
  me: protectedProcedure.query(async ({ ctx }) => {
    return {
      id: ctx.user.id,
      extensionNumber: ctx.user.extensionNumber,
      displayName: ctx.user.displayName,
      role: ctx.user.role,
      isActive: ctx.user.isActive,
      lastLoginAt: ctx.user.lastLoginAt,
      createdAt: ctx.user.createdAt,
    };
  }),
});
