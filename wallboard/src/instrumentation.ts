/**
 * Next.js instrumentation hook.
 * Runs once when the server starts (both dev and production).
 */

export async function register(): Promise<void> {
  // No-op — relay agent pushes data via HTTP POST to /api/relay/push
  // No additional server-side setup needed.
}
