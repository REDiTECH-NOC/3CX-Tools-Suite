/**
 * WebSocket client — persistent connection to the wallboard.
 *
 * Connects to ws(s)://wallboard:port?key=<api-key>, auto-reconnects on
 * disconnect, and sends state payloads as JSON messages.
 *
 * Connection lifecycle:
 * 1. Connect → server authenticates via URL query parameter
 * 2. Server sends { type: 'connected' } on success
 * 3. Client sends { type: 'state', payload: {...} } on state changes
 * 4. Built-in ping/pong for health detection
 * 5. On disconnect → reconnect with exponential backoff
 */

import WebSocket from 'ws';
import type { RelayPushPayload } from './state-manager';

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = MIN_RECONNECT_MS;
  private _connected = false;
  private _authFailed = false;
  private _stopped = false;
  private _connectAttempts = 0;

  constructor(wallboardWsUrl: string, apiKey: string) {
    // Ensure ws:// or wss:// prefix
    let wsUrl = wallboardWsUrl;
    if (wsUrl.startsWith('http://')) wsUrl = wsUrl.replace('http://', 'ws://');
    else if (wsUrl.startsWith('https://')) wsUrl = wsUrl.replace('https://', 'wss://');
    else if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) wsUrl = `ws://${wsUrl}`;

    // Remove trailing slash, append query param
    wsUrl = wsUrl.replace(/\/+$/, '');
    this.url = `${wsUrl}?key=${encodeURIComponent(apiKey)}`;
  }

  /** Start the connection (non-blocking). */
  connect(): void {
    if (this._stopped || this._authFailed) return;
    this._connectAttempts++;

    try {
      this.ws = new WebSocket(this.url, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        // Skip TLS verification for self-signed certs (common in PBX environments)
        rejectUnauthorized: false,
      });

      this.ws.on('open', () => {
        this._connected = true;
        this.reconnectDelay = MIN_RECONNECT_MS;
        this._connectAttempts = 0;
        console.log('[WsClient] Connected to wallboard');
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            console.log('[WsClient] Authentication accepted');
          }
        } catch {
          // Ignore malformed server messages
        }
      });

      this.ws.on('close', (code, reason) => {
        this._connected = false;

        if (code === 4001) {
          // Auth failure — don't reconnect
          this._authFailed = true;
          console.error('[WsClient] Authentication failed — check API key. Not reconnecting.');
          return;
        }

        if (!this._stopped) {
          const reasonStr = reason?.toString() || '';
          if (this._connectAttempts <= 3 || this._connectAttempts % 30 === 0) {
            console.log(`[WsClient] Disconnected (code=${code}${reasonStr ? `, reason=${reasonStr}` : ''}), reconnecting in ${this.reconnectDelay}ms`);
          }
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        // Only log periodically to avoid spam
        if (this._connectAttempts <= 3 || this._connectAttempts % 30 === 0) {
          console.error(`[WsClient] Error: ${err.message}`);
        }
      });

      // Respond to server pings
      this.ws.on('ping', () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.pong();
        }
      });

    } catch (err) {
      console.error('[WsClient] Connection error:', err instanceof Error ? err.message : err);
      this.scheduleReconnect();
    }
  }

  /** Send a state update. Returns true if sent, false if not connected. */
  send(payload: RelayPushPayload): boolean {
    if (!this._connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify({ type: 'state', payload }));
      return true;
    } catch {
      return false;
    }
  }

  /** Is the WebSocket currently connected and authenticated? */
  isConnected(): boolean {
    return this._connected;
  }

  /** Did the server reject our API key? */
  isAuthFailed(): boolean {
    return this._authFailed;
  }

  /** Stop the client and don't reconnect. */
  stop(): void {
    this._stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Agent shutting down');
      this.ws = null;
    }
    this._connected = false;
  }

  private scheduleReconnect(): void {
    if (this._stopped || this._authFailed) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_MS);
  }
}
