/**
 * WebSocket server for relay agent connections.
 *
 * Runs on a separate port (default 3100) alongside the Next.js HTTP server.
 * The relay agent connects via `ws://wallboard:3100?key=<api-key>` and
 * pushes state changes in real-time. Only one relay agent can be connected
 * at a time (new connections replace the old one).
 *
 * This is the "proper" real-time path — event-driven, not polled.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { setRelayData, setRelayConnected, setRelayDisconnected } from '@/lib/relay-store';
import type { RelayPushPayload } from '@/types/relay';

const RELAY_WS_PORT = parseInt(process.env.RELAY_WS_PORT || '3100', 10);
const HEARTBEAT_DB_THROTTLE_MS = 30_000;

let wss: WebSocketServer | null = null;
let relaySocket: WebSocket | null = null;
let _lastHeartbeatDbUpdate = 0;

/**
 * Start the relay WebSocket server.
 * Safe to call multiple times (idempotent).
 */
export function startRelayWsServer(): void {
  if (wss) return;

  wss = new WebSocketServer({ port: RELAY_WS_PORT });
  console.log(`[RelayWS] WebSocket server listening on port ${RELAY_WS_PORT}`);

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const apiKey = url.searchParams.get('key');

    // ── Authenticate ──
    if (!apiKey) {
      ws.close(4001, 'Missing API key');
      return;
    }

    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    let config: { relayApiKeyHash: string | null } | null = null;
    try {
      config = await prisma.systemConfig.findUnique({
        where: { id: 'singleton' },
        select: { relayApiKeyHash: true },
      });
    } catch (err) {
      console.error('[RelayWS] DB error during auth:', err);
      ws.close(4003, 'Server error');
      return;
    }

    if (!config?.relayApiKeyHash || keyHash !== config.relayApiKeyHash) {
      console.warn('[RelayWS] Connection rejected — invalid API key');
      ws.close(4001, 'Invalid API key');
      return;
    }

    // ── Accept connection ──
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';

    // Replace existing relay connection (only one agent at a time)
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
      console.log('[RelayWS] Replacing existing relay connection');
      relaySocket.close(4002, 'Replaced by new connection');
    }
    relaySocket = ws;

    console.log(`[RelayWS] Relay agent connected from ${clientIp}`);
    setRelayConnected(clientIp);

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));

    // ── Handle messages ──
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'state' && msg.payload) {
          const payload = msg.payload as RelayPushPayload;
          if (payload.version === 1 && Array.isArray(payload.queues)) {
            setRelayData(payload, clientIp);
            throttledHeartbeatUpdate(clientIp);
          }
        }
        // Ignore unknown message types (forward-compatible)
      } catch {
        // Ignore malformed messages
      }
    });

    // ── Handle disconnect ──
    ws.on('close', (code, reason) => {
      if (relaySocket === ws) {
        relaySocket = null;
        setRelayDisconnected();
        console.log(`[RelayWS] Relay agent disconnected (code=${code}, reason=${reason.toString()})`);
      }
    });

    ws.on('error', (err) => {
      console.error('[RelayWS] Socket error:', err.message);
    });

    // ── WebSocket-level ping/pong for connection health ──
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 10_000);

    ws.on('close', () => clearInterval(pingInterval));
  });

  wss.on('error', (err) => {
    console.error('[RelayWS] Server error:', err.message);
  });
}

/** Throttled DB heartbeat update */
function throttledHeartbeatUpdate(clientIp: string): void {
  const now = Date.now();
  if (now - _lastHeartbeatDbUpdate > HEARTBEAT_DB_THROTTLE_MS) {
    _lastHeartbeatDbUpdate = now;
    prisma.systemConfig.update({
      where: { id: 'singleton' },
      data: {
        relayLastHeartbeat: new Date(),
        relayLastIp: clientIp,
      },
    }).catch((err) => {
      console.error('[RelayWS] Heartbeat DB update failed:', err.message);
    });
  }
}

/** Check if a relay agent is currently connected */
export function isRelayWsConnected(): boolean {
  return relaySocket !== null && relaySocket.readyState === WebSocket.OPEN;
}

/** Stop the WebSocket server */
export function stopRelayWsServer(): void {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (relaySocket) {
    relaySocket.close();
    relaySocket = null;
  }
}
