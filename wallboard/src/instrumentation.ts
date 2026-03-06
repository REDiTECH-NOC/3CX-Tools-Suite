/**
 * Next.js instrumentation hook.
 * Runs once when the server starts (both dev and production).
 * Used to start the relay WebSocket server alongside the HTTP server.
 */

export async function register(): Promise<void> {
  // Only run on the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startRelayWsServer } = await import('@/lib/relay-ws-server');
    startRelayWsServer();
  }
}
