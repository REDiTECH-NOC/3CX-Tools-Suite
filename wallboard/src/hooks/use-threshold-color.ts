'use client';

import { useMemo, useCallback } from 'react';
import type { ThresholdLevel } from '@/types/wallboard';

/**
 * Shape of a threshold record returned from the tRPC query.
 * Matches the WallboardThreshold Prisma model fields we need.
 */
interface ThresholdRecord {
  wallboardQueueId: string | null;
  metric: string;
  yellowValue: number;
  redValue: number;
  invertLogic: boolean;
}

/**
 * Hook that returns a function for computing threshold levels.
 *
 * @param thresholds - Full array of threshold records from the DB (tRPC query)
 * @returns `getThresholdLevel` function
 *
 * @example
 * ```tsx
 * const { getThresholdLevel } = useThresholdColor(thresholds);
 * const level = getThresholdLevel(45, 'avgWait', 'cuid_123');
 * const cls = getThresholdClass(level);
 * ```
 */
export function useThresholdColor(thresholds: ThresholdRecord[]) {
  // Build lookup maps for O(1) access during rendering
  const { globalMap, queueMap } = useMemo(() => {
    const gMap = new Map<string, ThresholdRecord>();
    const qMap = new Map<string, ThresholdRecord>(); // key: `${queueId}:${metric}`

    for (const t of thresholds) {
      if (t.wallboardQueueId) {
        qMap.set(`${t.wallboardQueueId}:${t.metric}`, t);
      } else {
        gMap.set(t.metric, t);
      }
    }

    return { globalMap: gMap, queueMap: qMap };
  }, [thresholds]);

  const getThresholdLevel = useCallback(
    (value: number, metric: string, queueId?: string): ThresholdLevel => {
      // 1. Try queue-specific threshold first
      let threshold: ThresholdRecord | undefined;
      if (queueId) {
        threshold = queueMap.get(`${queueId}:${metric}`);
      }

      // 2. Fall back to global threshold
      if (!threshold) {
        threshold = globalMap.get(metric);
      }

      // 3. No threshold configured -- default to green
      if (!threshold) {
        return 'green';
      }

      // 4. Evaluate
      if (threshold.invertLogic) {
        // Inverted: lower values are worse (e.g., agentsAvailable)
        // redValue is the lower bound, yellowValue is slightly above
        if (value <= threshold.redValue) return 'red';
        if (value <= threshold.yellowValue) return 'yellow';
        return 'green';
      }

      // Normal: higher values are worse (e.g., avgWait, abandonRate)
      if (value >= threshold.redValue) return 'red';
      if (value >= threshold.yellowValue) return 'yellow';
      return 'green';
    },
    [globalMap, queueMap],
  );

  return { getThresholdLevel };
}

/**
 * Map a threshold level to Tailwind CSS classes.
 *
 * Returns semantic class names that should be defined in your global CSS:
 * - `threshold-green` -- normal/healthy state
 * - `threshold-yellow` -- warning state
 * - `threshold-red` -- critical/alert state
 */
export function getThresholdClass(level: ThresholdLevel): string {
  switch (level) {
    case 'green':
      return 'threshold-green';
    case 'yellow':
      return 'threshold-yellow';
    case 'red':
      return 'threshold-red';
    default:
      return 'threshold-green';
  }
}
