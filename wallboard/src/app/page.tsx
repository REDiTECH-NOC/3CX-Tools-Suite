import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  let setupComplete = false;
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { id: 'singleton' },
      select: { setupComplete: true },
    });
    setupComplete = config?.setupComplete ?? false;
  } catch {
    // DB not available yet (first startup before migration)
  }

  if (!setupComplete) {
    redirect('/setup');
  }

  redirect('/wallboard');
}
