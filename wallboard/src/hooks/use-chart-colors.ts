'use client';

import { useMemo } from 'react';
import { useTheme } from '@/components/theme-provider';

/**
 * Returns resolved HSL color strings for Recharts components
 * that need JS color values (not CSS var references).
 * Re-computes when the theme changes.
 */
export function useChartColors() {
  const { resolvedTheme } = useTheme();

  return useMemo(() => {
    const isDark = resolvedTheme === 'dark';
    return {
      grid: isDark ? 'hsl(216 34% 17%)' : 'hsl(214.3 31.8% 91.4%)',
      muted: isDark ? 'hsl(215.4 16.3% 56.9%)' : 'hsl(215.4 16.3% 46.9%)',
      bg: isDark ? 'hsl(224 71% 4%)' : 'hsl(0 0% 100%)',
      tooltipCursor: isDark
        ? 'hsl(216 34% 17% / 0.5)'
        : 'hsl(214.3 31.8% 91.4% / 0.5)',
    };
  }, [resolvedTheme]);
}
