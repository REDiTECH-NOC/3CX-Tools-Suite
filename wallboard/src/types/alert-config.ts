/**
 * Per-metric alert configuration supporting per-queue filtering
 * and both sound + push notification channels.
 */
export interface AlertConfig {
  /** Play audible beep when threshold fires */
  sound: boolean;
  /** Show browser push notification */
  push: boolean;
  /** Queue IDs to monitor — ["all"] or specific IDs */
  queues: string[];
}

/**
 * Full alert settings keyed by metric name.
 * Stored as JSON in UserPreference.soundAlerts field.
 *
 * Backward compatible: old format `{ metric: true }` is auto-converted
 * to `{ metric: { sound: true, push: false, queues: ["all"] } }`.
 */
export type AlertSettings = Record<string, AlertConfig>;

/**
 * Convert legacy simple boolean alerts to new AlertConfig shape.
 */
export function normalizeAlertSettings(
  raw: Record<string, unknown>,
): AlertSettings {
  const result: AlertSettings = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') {
      // Legacy format: { metric: true/false }
      result[key] = {
        sound: value,
        push: false,
        queues: ['all'],
      };
    } else if (
      typeof value === 'object' &&
      value !== null &&
      'sound' in value
    ) {
      // New format: already an AlertConfig
      const cfg = value as AlertConfig;
      result[key] = {
        sound: cfg.sound ?? false,
        push: cfg.push ?? false,
        queues: cfg.queues ?? ['all'],
      };
    }
  }

  return result;
}
