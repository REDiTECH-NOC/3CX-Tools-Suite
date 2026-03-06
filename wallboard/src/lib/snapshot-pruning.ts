import { prisma } from '@/lib/prisma';

const RETENTION_DAYS = 7;

/**
 * Delete QueueSnapshot rows older than the retention period.
 * Called periodically by the poller (once per hour).
 */
export async function pruneOldSnapshots(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await prisma.queueSnapshot.deleteMany({
    where: {
      timestamp: { lt: cutoff },
    },
  });

  return result.count;
}
