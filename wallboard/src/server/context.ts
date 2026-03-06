import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import type { TRPCContext } from './trpc';

/**
 * Creates the tRPC context for each request.
 * Called by the tRPC API route handler.
 */
export async function createContext(): Promise<TRPCContext> {
  const session = await getSession();

  return {
    prisma,
    user: session?.user ?? null,
  };
}
