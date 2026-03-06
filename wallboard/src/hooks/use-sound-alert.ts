'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { WallboardState, ThresholdLevel } from '@/types/wallboard';
import type { AlertSettings } from '@/types/alert-config';
import { normalizeAlertSettings } from '@/types/alert-config';

/**
 * Threshold evaluator function signature, matching what useThresholdColor returns.
 */
type GetThresholdLevel = (
  value: number,
  metric: string,
  queueId?: string,
) => ThresholdLevel;

interface UseSoundAlertOptions {
  /** Current wallboard state with all queue data */
  state: WallboardState | null;
  /** Threshold evaluation function */
  getThresholdLevel: GetThresholdLevel;
  /** Per-metric alert config from user preferences (may be legacy or new format) */
  soundAlerts: Record<string, unknown>;
  /** Whether any sound alerts are enabled at all (performance optimization) */
  enabled: boolean;
}

/**
 * Metric keys that can trigger sound alerts, mapped to the value accessor
 * from QueueWallboardData.
 */
const ALERTABLE_METRICS: {
  metric: string;
  getValue: (queue: WallboardState['queues'][0]) => number;
}[] = [
  { metric: 'currentWait', getValue: (q) => q.longestWaitSec },
  { metric: 'avgWait', getValue: (q) => q.avgWaitSec },
  { metric: 'callsQueued', getValue: (q) => q.callsWaiting },
  { metric: 'callsAbandoned', getValue: (q) => q.callsAbandoned },
  { metric: 'abandonRate', getValue: (q) => q.abandonRate },
  { metric: 'agentsAvailable', getValue: (q) => q.agentsAvailable },
];

/** Minimum interval between repeated alerts for the same metric (ms). */
const DEBOUNCE_MS = 30_000;

/** Beep duration in seconds. */
const BEEP_DURATION = 0.2;

/** Beep frequency in Hz. */
const BEEP_FREQUENCY = 440;

/**
 * Play a short beep tone using the Web Audio API.
 */
function playBeep(audioCtx: AudioContext): void {
  const oscillator = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(BEEP_FREQUENCY, audioCtx.currentTime);

  gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
  gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime + BEEP_DURATION - 0.02);
  gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + BEEP_DURATION);

  oscillator.start(audioCtx.currentTime);
  oscillator.stop(audioCtx.currentTime + BEEP_DURATION);
}

/**
 * Fire a browser push notification.
 */
function showPushNotification(
  queueName: string,
  metric: string,
  value: string,
): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  const metricLabels: Record<string, string> = {
    currentWait: 'Current Wait',
    avgWait: 'Avg Wait',
    callsQueued: 'Calls Queued',
    callsAbandoned: 'Abandoned Calls',
    abandonRate: 'Abandon Rate',
    agentsAvailable: 'Agents Available',
  };

  new Notification(`${queueName} — ${metricLabels[metric] ?? metric}`, {
    body: `Threshold exceeded: ${value}`,
    icon: '/favicon.ico',
    tag: `wallboard-${metric}`,
  });
}

/**
 * Hook that monitors wallboard state and plays audio alerts / sends push
 * notifications when metrics transition into the red threshold zone.
 *
 * Supports per-queue filtering and dual-channel alerts (sound + push).
 * Backward compatible with legacy `{ metric: true }` format.
 */
export function useSoundAlert({
  state,
  getThresholdLevel,
  soundAlerts,
  enabled,
}: UseSoundAlertOptions): void {
  const previousLevelsRef = useRef<Map<string, ThresholdLevel>>(new Map());
  const lastAlertTimeRef = useRef<Map<string, number>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);

  const getAudioContext = useCallback((): AudioContext | null => {
    if (audioCtxRef.current) {
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      return audioCtxRef.current;
    }

    try {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextClass) return null;
      audioCtxRef.current = new AudioContextClass();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!enabled || !state || !state.queues || state.queues.length === 0) {
      return;
    }

    const settings: AlertSettings = normalizeAlertSettings(
      soundAlerts as Record<string, unknown>,
    );

    const now = Date.now();
    const prevLevels = previousLevelsRef.current;
    const lastAlertTimes = lastAlertTimeRef.current;
    let shouldBeep = false;
    const pushQueue: { queueName: string; metric: string; value: string }[] = [];

    for (const queue of state.queues) {
      const queueIdStr = String(queue.queueId);

      for (const { metric, getValue } of ALERTABLE_METRICS) {
        const config = settings[metric];
        if (!config || (!config.sound && !config.push)) continue;

        // Per-queue filter
        if (
          !config.queues.includes('all') &&
          !config.queues.includes(queueIdStr)
        ) {
          continue;
        }

        const value = getValue(queue);
        const level = getThresholdLevel(value, metric, queueIdStr);

        const key = `${queue.queueId}:${metric}`;
        const previousLevel = prevLevels.get(key);
        prevLevels.set(key, level);

        // Transition INTO red
        if (
          level === 'red' &&
          previousLevel !== undefined &&
          previousLevel !== 'red'
        ) {
          const lastAlert = lastAlertTimes.get(metric) ?? 0;
          if (now - lastAlert >= DEBOUNCE_MS) {
            if (config.sound) shouldBeep = true;
            if (config.push) {
              pushQueue.push({
                queueName: queue.queueName,
                metric,
                value: String(value),
              });
            }
            lastAlertTimes.set(metric, now);
          }
        }
      }
    }

    if (shouldBeep) {
      const ctx = getAudioContext();
      if (ctx) playBeep(ctx);
    }

    for (const n of pushQueue) {
      showPushNotification(n.queueName, n.metric, n.value);
    }
  }, [state, getThresholdLevel, soundAlerts, enabled, getAudioContext]);
}
