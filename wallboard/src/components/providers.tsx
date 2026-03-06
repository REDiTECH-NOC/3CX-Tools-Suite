'use client';

import { TRPCProvider } from '@/lib/trpc';
import { ThemeProvider } from '@/components/theme-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider defaultTheme="dark">
      <TRPCProvider>{children}</TRPCProvider>
    </ThemeProvider>
  );
}
