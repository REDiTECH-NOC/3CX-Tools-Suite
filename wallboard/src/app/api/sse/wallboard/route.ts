import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { poller } from '@/lib/threecx-poller';
import type { WallboardState } from '@/types/wallboard';

const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_COOKIE = 'wb_session';

/**
 * GET /api/sse/wallboard
 *
 * Server-Sent Events endpoint that streams WallboardState to connected clients.
 * Requires a valid session cookie (wb_session).
 */
export async function GET(request: NextRequest): Promise<Response> {
  // ── 1. Validate session ───────────────────────────────────────
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await prisma.session.findUnique({
    where: { token },
  });

  if (!session || session.expiresAt < new Date()) {
    // Clean up expired session
    if (session) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 2. Create SSE stream ──────────────────────────────────────
  const encoder = new TextEncoder();
  let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  let listener: ((state: WallboardState) => void) | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      // Helper to safely enqueue data
      const send = (data: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Stream may have been closed by the client
          cleanup();
        }
      };

      // Register broadcast listener
      listener = (state: WallboardState) => {
        send(JSON.stringify(state));
      };
      poller.hub.addClient(listener);

      // Send current state immediately if available
      const currentState = poller.getCurrentState();
      if (currentState) {
        send(JSON.stringify(currentState));
      }

      // Start poller if not already running
      if (!poller.isRunning()) {
        poller.start();
      }

      // Heartbeat to keep connection alive
      heartbeatHandle = setInterval(() => {
        send(JSON.stringify({ type: 'heartbeat' }));
      }, HEARTBEAT_INTERVAL_MS);
    },

    cancel() {
      cleanup();
    },
  });

  function cleanup(): void {
    if (closed) return;
    closed = true;

    if (heartbeatHandle) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }

    if (listener) {
      poller.hub.removeClient(listener);
      listener = null;
    }

    // If no clients remain, begin graceful shutdown
    poller.stopGraceful();
  }

  // ── 3. Return SSE response ────────────────────────────────────
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// Disable body parsing and static generation for this route
export const dynamic = 'force-dynamic';
