import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { setRelayData } from '@/lib/relay-store';
import type { RelayPushPayload } from '@/types/relay';

// Throttle DB heartbeat updates to avoid write spam (relay pushes every 2s)
const HEARTBEAT_DB_THROTTLE_MS = 30_000;
let _lastHeartbeatDbUpdate = 0;

/**
 * POST /api/relay/push
 *
 * Accepts real-time queue state from the PBX relay agent.
 * Authenticates via Bearer token (API key generated in admin settings).
 * Stores payload in memory for the poller to consume.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Extract and validate API key ──
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
  }
  const apiKey = authHeader.substring(7);

  // Hash the provided key and compare against stored hash
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  const config = await prisma.systemConfig.findUnique({
    where: { id: 'singleton' },
    select: { relayApiKeyHash: true },
  });

  if (!config?.relayApiKeyHash || keyHash !== config.relayApiKeyHash) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  // ── 2. Parse and validate payload ──
  let payload: RelayPushPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (payload.version !== 1 || !Array.isArray(payload.queues) || typeof payload.ts !== 'number') {
    return NextResponse.json({ error: 'Invalid payload format' }, { status: 400 });
  }

  // ── 3. Store in memory ──
  const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  setRelayData(payload, clientIp);

  // ── 4. Update heartbeat in DB (throttled) ──
  const now = Date.now();
  if (now - _lastHeartbeatDbUpdate > HEARTBEAT_DB_THROTTLE_MS) {
    _lastHeartbeatDbUpdate = now;
    // Fire-and-forget — don't block the response
    prisma.systemConfig.update({
      where: { id: 'singleton' },
      data: {
        relayLastHeartbeat: new Date(),
        relayLastIp: clientIp,
      },
    }).catch((err) => {
      console.error('[Relay] Failed to update heartbeat:', err.message);
    });
  }

  return NextResponse.json({
    ok: true,
    queuesReceived: payload.queues.length,
  });
}

export const dynamic = 'force-dynamic';
