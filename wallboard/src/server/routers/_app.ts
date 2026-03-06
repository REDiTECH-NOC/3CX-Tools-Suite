import { router } from '../trpc';
import { authRouter } from './auth';
import { wallboardRouter } from './wallboard';
import { adminRouter } from './admin';
import { queueActionsRouter } from './queue-actions';

export const appRouter = router({
  auth: authRouter,
  wallboard: wallboardRouter,
  admin: adminRouter,
  queueActions: queueActionsRouter,
});

export type AppRouter = typeof appRouter;
