/**
 * 3CX Queue Monitor — Persistent WebSocket connection for real-time per-queue agent status.
 *
 * The 3CX XAPI only provides a global User.QueueStatus, not per-queue status.
 * The MyPhone WebSocket protocol pushes QueuesInfo (MessageId 211) with per-queue
 * agent QueueStatus (field 8, bool) — this is the same data the 3CX web client uses.
 *
 * Protocol (from reverse-engineering 3CX v20 web client main.js):
 *
 * 1. REST login → JWT token
 * 2. POST /webclient/api/MyPhone/session → sessionKey + pass
 * 3. WebSocket connect /ws/webclient?sessionId={}&pass={} (receive-only channel)
 * 4. On "START" text → send Login (MessageId 100) via HTTP POST to /MyPhone/MPWebService.asmx
 * 5. WebSocket receives push messages including QueuesInfo (211)
 * 6. Respond to "ADDP" text with "ADDP" (keep-alive, every ~10s)
 *
 * QueuesInfo (MessageId 211):
 *   field 1: Action (int32) — 0=FullUpdate, 1=Updated, 2=Inserted, 3=Deleted
 *   field 2: Items[] (QueueStat)
 *     field 2: Id (int32) — queue internal ID
 *     field 3: Name (string)
 *     field 4: Number (string) — queue extension number
 *     field 5: Agents (QueueAgents)
 *       field 1: Action (int32)
 *       field 2: Items[] (QueueAgent)
 *         field 2: Id (int32) — agent internal ID
 *         field 3: Number (string) — extension number
 *         field 8: QueueStatus (bool) — true = logged in, false = logged out
 */
import https from 'https';
import crypto from 'crypto';
import type { Socket } from 'net';

// ─── Types ──────────────────────────────────────────────────────

export interface QueueAgentQueueStatus {
  extensionNumber: string;
  agentId: number;
  loggedIn: boolean;
}

export interface QueueMonitorData {
  /** Map from queue internal ID to array of agent statuses */
  queues: Map<number, QueueAgentQueueStatus[]>;
  /** Map from queue extension number (e.g. "8003") to array of agent statuses */
  byNumber: Map<string, QueueAgentQueueStatus[]>;
  /** Map from queue extension number to call stats from WebSocket */
  callStats: Map<string, QueueCallStats>;
  lastUpdated: number;
}

// ─── Protobuf Helpers ───────────────────────────────────────────

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes;
}

function varintField(fn: number, v: number): number[] {
  return encodeVarint((fn << 3) | 0).concat(encodeVarint(v));
}

function stringField(fn: number, s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  return encodeVarint((fn << 3) | 2)
    .concat(encodeVarint(b.length))
    .concat(Array.from(b));
}

function submsgField(fn: number, d: number[]): number[] {
  return encodeVarint((fn << 3) | 2)
    .concat(encodeVarint(d.length))
    .concat(d);
}

function buildMsg(id: number, payload: number[]): Buffer {
  return Buffer.from(varintField(1, id).concat(submsgField(id, payload)));
}

// ─── Protobuf Decoder ───────────────────────────────────────────

interface ProtoField {
  fn: number;
  type: 'varint' | 'string' | 'bytes';
  value: number | string | Uint8Array;
}

function decodeFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0, shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const fn = tag >> 3;
    const wt = tag & 7;
    if (fn === 0) break;

    if (wt === 0) {
      let val = 0;
      shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      fields.push({ fn, type: 'varint', value: val });
    } else if (wt === 2) {
      let len = 0;
      shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const data = buf.slice(i, i + len);
      i += len;
      fields.push({ fn, type: 'bytes', value: data });
    } else if (wt === 1) {
      i += 8;
    } else if (wt === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return fields;
}

function getVarint(fields: ProtoField[], fn: number): number | undefined {
  const f = fields.find((x) => x.fn === fn && x.type === 'varint');
  return f ? (f.value as number) : undefined;
}

function getString(fields: ProtoField[], fn: number): string | undefined {
  const f = fields.find((x) => x.fn === fn && x.type === 'bytes');
  if (!f) return undefined;
  return Buffer.from(f.value as Uint8Array).toString('utf8');
}

function getSubmsg(fields: ProtoField[], fn: number): ProtoField[] | undefined {
  const f = fields.find((x) => x.fn === fn && x.type === 'bytes');
  if (!f) return undefined;
  return decodeFields(f.value as Uint8Array);
}

function getAllSubmsg(fields: ProtoField[], fn: number): ProtoField[][] {
  return fields
    .filter((x) => x.fn === fn && x.type === 'bytes')
    .map((x) => decodeFields(x.value as Uint8Array));
}

// ─── Parse QueuesInfo (MessageId 211) ───────────────────────────

/** Call statistics from the QueueStat protobuf message. */
export interface QueueCallStats {
  callsWaiting: number;
  longestWaitSec: number;
  callsAnswered: number;
  callsAbandoned: number;
  avgWaitSec: number;
  totalOffered: number;
}

/** Call event detected from WebSocket state changes, persisted to DB by poller. */
export type QueueCallEvent =
  | { type: 'baseline'; queueNumber: string; queueId: number; answered: number; abandoned: number; avgWaitSec: number; longestWaitSec: number; timestamp: number }
  | { type: 'resolved'; queueNumber: string; queueId: number; result: 'answered' | 'abandoned'; waitSec: number; timestamp: number };

interface ParsedQueueUpdate {
  queueId: number;
  queueName?: string;
  queueNumber?: string;
  /** Action: 0=FullUpdate, 1=Updated, 2=Inserted, 3=Deleted */
  action: number;
  agentAction: number;
  agents: QueueAgentQueueStatus[];
  /** Call stats extracted from field 6 submessage */
  callStats?: QueueCallStats;
}

function parseQueuesInfo(buf: Uint8Array): ParsedQueueUpdate[] {
  const results: ParsedQueueUpdate[] = [];
  const outerFields = decodeFields(buf);

  // Look for field 211 (the QueuesInfo wrapper submessage)
  const queuesWrapper = getSubmsg(outerFields, 211);
  if (!queuesWrapper) return results;

  // field 1 = outer Action (0=FullUpdate, 1=Updated, etc.)
  const outerAction = getVarint(queuesWrapper, 1) ?? 0;

  // field 2 in QueuesInfo = QueueStat items (repeated)
  const queueItems = getAllSubmsg(queuesWrapper, 2);
  for (const queueFields of queueItems) {
    const queueId = getVarint(queueFields, 2);
    if (queueId === undefined) continue;

    const queueName = getString(queueFields, 3);
    const queueNumber = getString(queueFields, 4);

    // field 5 = Agents (QueueAgents wrapper)
    const agentsWrapper = getSubmsg(queueFields, 5);
    const agentAction = agentsWrapper ? (getVarint(agentsWrapper, 1) ?? 0) : -1;

    const agents: QueueAgentQueueStatus[] = [];
    if (agentsWrapper) {
      const agentItems = getAllSubmsg(agentsWrapper, 2);
      for (const agentFields of agentItems) {
        const agentId = getVarint(agentFields, 2);
        const extNumber = getString(agentFields, 3);
        const queueStatus = getVarint(agentFields, 8); // bool: 1=logged in, 0=logged out

        if (extNumber) {
          agents.push({
            extensionNumber: extNumber,
            agentId: agentId ?? 0,
            loggedIn: queueStatus === 1,
          });
        }
      }
    }

    // field 6 = QueueStat.Stats submessage (call statistics)
    let callStats: QueueCallStats | undefined;
    const statsSubmsg = getSubmsg(queueFields, 6);
    if (statsSubmsg) {
      // Field mapping (verified via live call testing 2026-03-05):
      //   s4  = calls waiting (no agent ringing)  |  s5  = calls ringing agents
      //   s8  = total offered (cumulative)        |  s9  = answered (cumulative)
      //   s11 = abandoned (cumulative)            |  s12 = avg wait (session-scoped)
      //   s13 = longest wait (session-scoped)     |  s14 = avg talk (session-scoped)
      const waiting = parseInt(getString(statsSubmsg, 4) ?? '0', 10) || 0;
      const ringing = parseInt(getString(statsSubmsg, 5) ?? '0', 10) || 0;
      callStats = {
        callsWaiting: waiting + ringing,
        callsAnswered: parseInt(getString(statsSubmsg, 9) ?? '0', 10) || 0,
        callsAbandoned: parseInt(getString(statsSubmsg, 11) ?? '0', 10) || 0,
        avgWaitSec: parseInt(getString(statsSubmsg, 12) ?? '0', 10) || 0,
        longestWaitSec: parseInt(getString(statsSubmsg, 13) ?? '0', 10) || 0,
        totalOffered: parseInt(getString(statsSubmsg, 8) ?? '0', 10) || 0,
      };
    }

    results.push({
      queueId,
      queueName,
      queueNumber,
      action: outerAction,
      agentAction,
      agents,
      callStats,
    });
  }

  return results;
}

// ─── WebSocket Frame Helpers ────────────────────────────────────

function sendWsFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= mask[i % 4];
  }

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }

  socket.write(Buffer.concat([header, masked]));
}

function sendWsText(socket: Socket, text: string): void {
  sendWsFrame(socket, 0x01, Buffer.from(text, 'utf8'));
}

// ─── Queue Monitor Class ────────────────────────────────────────

export class ThreecxQueueMonitor {
  private readonly pbxHost: string;
  private readonly extensionNumber: string;
  private readonly password: string;
  private socket: Socket | null = null;
  private connected = false;
  private data: QueueMonitorData = { queues: new Map(), byNumber: new Map(), callStats: new Map(), lastUpdated: 0 };
  /** Cached mapping: protobuf queue ID → queue extension number (from full updates) */
  private queueIdToNumber = new Map<number, string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private stopped = false;
  /** Set to true on each new WebSocket connection; cleared after first QueuesInfo */
  private freshConnection = false;
  /** Safety reconnect: if no QueuesInfo push for this long, reconnect */
  private static readonly STALE_TIMEOUT_MS = 120_000;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  /** ISO date string for daily stats reset */
  private callStatsDate = '';
  /** Set to true when QueuesInfo data arrives; used to cancel the initial safety timeout */
  private gotInitialData = false;
  /** Previous call stats per queue for delta detection */
  private prevCallStats = new Map<string, { totalOffered: number; callsAnswered: number; callsAbandoned: number }>();
  /** FIFO queue of call entry timestamps per queue for wait time computation */
  private pendingCallEntries = new Map<string, number[]>();
  /** Buffer of call events detected since last read */
  private callEventBuffer: QueueCallEvent[] = [];

  constructor(pbxHost: string, extensionNumber: string, password: string) {
    // Sanitize: strip protocol prefix and trailing slashes (same as ThreecxClient)
    this.pbxHost = pbxHost
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    this.extensionNumber = extensionNumber;
    this.password = password;
  }

  /** Get the current per-queue agent status data. */
  getData(): QueueMonitorData {
    return this.data;
  }

  /** Check if an agent is logged into a specific queue by internal ID. */
  isAgentLoggedIn(queueId: number, extensionNumber: string): boolean | undefined {
    const agents = this.data.queues.get(queueId);
    if (!agents) return undefined; // No data for this queue ID
    const agent = agents.find((a) => a.extensionNumber === extensionNumber);
    if (!agent) return undefined; // Agent not in this queue
    return agent.loggedIn;
  }

  /** Check if an agent is logged into a specific queue by queue extension number (e.g. "8003"). */
  isAgentLoggedInByNumber(queueNumber: string, extensionNumber: string): boolean | undefined {
    const agents = this.data.byNumber.get(queueNumber);
    if (!agents) return undefined;
    const agent = agents.find((a) => a.extensionNumber === extensionNumber);
    if (!agent) return undefined;
    return agent.loggedIn;
  }

  /** Get the list of agent extension numbers for a queue (by queue number). */
  getQueueAgentNumbers(queueNumber: string): string[] | undefined {
    const agents = this.data.byNumber.get(queueNumber);
    if (!agents) return undefined;
    return agents.map((a) => a.extensionNumber);
  }

  /** Whether the monitor has received queue data at least once. */
  hasData(): boolean {
    return this.data.lastUpdated > 0;
  }

  /** Get call stats for a specific queue by extension number (e.g. "8003"). */
  getCallStats(queueNumber: string): QueueCallStats | undefined {
    return this.data.callStats.get(queueNumber);
  }

  /** Get and clear pending call events (consumed by poller for DB persistence). */
  getAndClearCallEvents(): QueueCallEvent[] {
    const events = [...this.callEventBuffer];
    this.callEventBuffer = [];
    return events;
  }

  /** Whether the monitor data is fresh enough to trust (within maxAgeMs). */
  isFresh(maxAgeMs: number = 15_000): boolean {
    if (this.data.lastUpdated === 0) return false;
    return Date.now() - this.data.lastUpdated < maxAgeMs;
  }

  /** Start the monitor — connects and auto-reconnects. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Force an immediate full reconnect for fresh per-queue data. */
  forceReconnect(): void {
    if (this.stopped) return;
    // Cancel any scheduled reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Full disconnect + reconnect with 3s delay for server cleanup
    this.disconnect();
    setTimeout(() => {
      if (!this.stopped) void this.connect();
    }, 3000);
  }

  /** Stop the monitor and close the connection. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    this.disconnect();
  }

  // ─── Connection Management ────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped || this.connected || this.isConnecting) return;
    this.isConnecting = true;

    try {
      // Step 1: REST login for JWT
      const token = await this.restLogin();
      if (!token) {
        this.scheduleReconnect(15000);
        return;
      }

      // Step 2: Get MyPhone session
      const session = await this.getSession(token);
      if (!session) {
        this.scheduleReconnect(15000);
        return;
      }

      // Step 3: Connect WebSocket
      this.gotInitialData = false;
      await this.connectWebSocket(session.sessionKey, session.pass);

      // Safety timeout: if no QueuesInfo arrives within 8s, force reconnect.
      // Once data arrives, gotInitialData is set and this timeout becomes a no-op.
      setTimeout(() => {
        if (!this.stopped && !this.gotInitialData && this.connected) {
          console.log('[QueueMonitor] No data timeout, scheduling reconnect');
          this.scheduleReconnect(2000);
        }
      }, 8000);
    } catch (err) {
      console.error('[QueueMonitor] Connection error:', err instanceof Error ? err.message : String(err));
      this.scheduleReconnect(15000);
    } finally {
      this.isConnecting = false;
    }
  }

  private disconnect(): void {
    if (this.socket) {
      // Remove event listeners BEFORE destroying to prevent close handler from
      // scheduling competing reconnects during intentional disconnects
      this.socket.removeAllListeners('close');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('data');
      try { sendWsFrame(this.socket, 0x08, Buffer.alloc(0)); } catch { /* ignore */ }
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return;
    // Clear any existing timer (newer schedule takes priority)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      // Disconnect first (no-op if already disconnected), then reconnect
      // 3s delay gives the 3CX server time to clean up the old session
      this.disconnect();
      setTimeout(() => {
        if (!this.stopped) void this.connect();
      }, 3000);
    }, delayMs);
  }

  // ─── REST Login ───────────────────────────────────────────────

  private restLogin(): Promise<string | null> {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        Username: this.extensionNumber,
        Password: this.password,
        SecurityCode: '',
      });

      const req = https.request(
        `https://${this.pbxHost}/webclient/api/Login/GetAccessToken`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.Status === 'AuthSuccess' && parsed.Token?.access_token) {
                resolve(parsed.Token.access_token);
              } else {
                console.error('[QueueMonitor] Auth failed:', parsed.Status);
                resolve(null);
              }
            } catch {
              console.error('[QueueMonitor] Auth parse error');
              resolve(null);
            }
          });
        },
      );

      req.on('error', (err) => {
        console.error('[QueueMonitor] Auth network error:', err.message);
        resolve(null);
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  // ─── MyPhone Session ──────────────────────────────────────────

  private getSession(
    token: string,
  ): Promise<{ sessionKey: string; pass: string } | null> {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        Name: 'WallboardMonitor',
        Version: '18.0.10.0',
        fingerprint: crypto.randomUUID(),
      });

      const req = https.request(
        `https://${this.pbxHost}/webclient/api/MyPhone/session`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${token}`,
          },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.sessionKey && parsed.pass) {
                resolve({ sessionKey: parsed.sessionKey, pass: parsed.pass });
              } else {
                console.error('[QueueMonitor] Session response missing keys');
                resolve(null);
              }
            } catch {
              console.error('[QueueMonitor] Session parse error');
              resolve(null);
            }
          });
        },
      );

      req.on('error', (err) => {
        console.error('[QueueMonitor] Session error:', err.message);
        resolve(null);
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  // ─── WebSocket Connection ─────────────────────────────────────

  private connectWebSocket(sessionKey: string, pass: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsKey = crypto.randomBytes(16).toString('base64');
      const path = `/ws/webclient?sessionId=${encodeURIComponent(sessionKey)}&pass=${encodeURIComponent(pass)}`;

      const req = https.request({
        hostname: this.pbxHost,
        port: 443,
        path,
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': wsKey,
          'Sec-WebSocket-Version': '13',
        },
        rejectUnauthorized: false,
      });

      req.on('upgrade', (_res, socket, _head) => {
        this.socket = socket;
        this.connected = true;
        this.freshConnection = true;
        console.log('[QueueMonitor] WebSocket connected');

        let buffer = Buffer.alloc(0);
        let loginSent = false;

        socket.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);

          while (buffer.length >= 2) {
            const opcode = buffer[0] & 0x0f;
            const masked = (buffer[1] & 0x80) !== 0;
            let payloadLen = buffer[1] & 0x7f;
            let offset = 2;

            if (payloadLen === 126) {
              if (buffer.length < 4) return;
              payloadLen = buffer.readUInt16BE(2);
              offset = 4;
            } else if (payloadLen === 127) {
              if (buffer.length < 10) return;
              payloadLen = Number(buffer.readBigUInt64BE(2));
              offset = 10;
            }

            if (masked) offset += 4;
            if (buffer.length < offset + payloadLen) return;

            let payload = buffer.slice(offset, offset + payloadLen);
            if (masked) {
              const mk = buffer.slice(offset - 4, offset);
              payload = Buffer.from(payload);
              for (let i = 0; i < payload.length; i++) {
                payload[i] ^= mk[i % 4];
              }
            }

            buffer = buffer.slice(offset + payloadLen);

            if (opcode === 0x01) {
              // Text frame
              const text = payload.toString('utf8');

              if (text === 'START' && !loginSent) {
                loginSent = true;
                // Send Login (100) then GetMyInfo (102) via HTTP POST.
                // Server will push QueuesInfo (211) via WebSocket in response.
                this.sendHttpLogin(sessionKey)
                  .then(() => this.sendHttpCommand(sessionKey, 102)) // GetMyInfo
                  .catch((err) => {
                    console.error('[QueueMonitor] HTTP login/setup error:', err instanceof Error ? err.message : String(err));
                  });
              }

              // ADDP keep-alive: server sends "ADDP" every ~10s, must reply
              if (text === 'ADDP') {
                sendWsText(socket, 'ADDP');
              }
            } else if (opcode === 0x02) {
              // Binary frame — protobuf message
              this.handleProtobufMessage(new Uint8Array(payload));
            } else if (opcode === 0x08) {
              // Close
              console.log('[QueueMonitor] WebSocket closed by server');
              this.connected = false;
              this.socket = null;
              if (!this.reconnectTimer && !this.isConnecting) {
                this.scheduleReconnect(15000);
              }
            } else if (opcode === 0x09) {
              // Ping → Pong
              sendWsFrame(socket, 0x0a, payload);
            }
          }
        });

        socket.on('close', () => {
          this.connected = false;
          this.socket = null;
          // Only schedule reconnect if not already planned by periodic cycle
          if (!this.reconnectTimer && !this.isConnecting) {
            console.log('[QueueMonitor] Socket closed unexpectedly, scheduling reconnect');
            this.scheduleReconnect(15000);
          }
        });

        socket.on('error', (err) => {
          console.error('[QueueMonitor] Socket error:', err.message);
          this.connected = false;
          this.socket = null;
          if (!this.reconnectTimer && !this.isConnecting) {
            this.scheduleReconnect(30000);
          }
        });

        resolve();
      });

      req.on('error', (err) => {
        console.error('[QueueMonitor] WS connect error:', err.message);
        this.scheduleReconnect(15000);
        reject(err);
      });

      req.on('response', (res) => {
        console.error('[QueueMonitor] WS upgrade failed:', res.statusCode);
        this.scheduleReconnect(15000);
        reject(new Error(`WS upgrade failed: ${res.statusCode}`));
      });

      req.setTimeout(15000, () => {
        req.destroy();
        this.scheduleReconnect(15000);
        reject(new Error('WS connection timeout'));
      });

      req.end();
    });
  }

  // ─── HTTP Login (triggers server to push data via WebSocket) ───

  private sendHttpLogin(sessionKey: string): Promise<void> {
    return this.sendHttpCommand(sessionKey, 100); // MessageId 100 = Login
  }

  /** Send a protobuf command via HTTP POST to MyPhone endpoint. Parses response for queue data. */
  private sendHttpCommand(sessionKey: string, messageId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const msg = buildMsg(messageId, []);
      const req = https.request(
        `https://${this.pbxHost}/MyPhone/MPWebService.asmx`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            Accept: 'application/octet-stream',
            'Content-Length': msg.length,
            MyPhoneSession: sessionKey,
          },
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            if (res.statusCode === 200 && raw.length > 0) {
              // Process the response as a protobuf message (may contain queue data)
              this.handleProtobufMessage(new Uint8Array(raw));
            }
            resolve();
          });
        },
      );

      req.on('error', (err) => reject(err));
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error(`HTTP command ${messageId} timeout`));
      });
      req.write(msg);
      req.end();
    });
  }

  // ─── Protobuf Message Handler ─────────────────────────────────

  private handleProtobufMessage(buf: Uint8Array): void {
    const fields = decodeFields(buf);

    // Get MessageId from field 1
    const msgId = getVarint(fields, 1);

    if (msgId === 211) {
      // QueuesInfo — parse per-queue agent status
      this.gotInitialData = true;
      const updates = parseQueuesInfo(buf);
      if (updates.length === 0) {
        // No queue data in this message — just reset stale timer and wait for next push
        if (this.staleTimer) clearTimeout(this.staleTimer);
        this.staleTimer = setTimeout(() => {
          if (!this.stopped && this.connected) {
            console.log('[QueueMonitor] No data for 2min, reconnecting');
            this.disconnect();
            void this.connect();
          }
        }, ThreecxQueueMonitor.STALE_TIMEOUT_MS);
        return;
      }

      // On a fresh connection, clear ALL stored data so stale entries can't persist.
      // Each fresh Login(100) triggers a full QueuesInfo push — whatever's in it is
      // the complete current state. Queues not included = no longer have agents.
      if (this.freshConnection) {
        this.data.queues.clear();
        this.data.byNumber.clear();
        // Do NOT clear callStats — keep previous values visible until replaced
        // Clear delta tracking so first push is treated as baseline
        this.prevCallStats.clear();
        this.pendingCallEntries.clear();
        this.freshConnection = false;
      }

      // Daily reset: clear call stats high-water marks at midnight
      const today = new Date().toISOString().slice(0, 10);
      if (this.callStatsDate && this.callStatsDate !== today) {
        console.log(`[QueueMonitor] New day (${today}), resetting call stats`);
        this.data.callStats.clear();
      }
      this.callStatsDate = today;

      for (const upd of updates) {
        // Cache queue number mapping from full updates
        if (upd.queueNumber) {
          this.queueIdToNumber.set(upd.queueId, upd.queueNumber);
        }
        const queueNumber = upd.queueNumber ?? this.queueIdToNumber.get(upd.queueId);

        // Only update agents on FullUpdate (action=0) or when agents are present.
        // Incremental updates (action=1 "Updated") only carry changed stats, not agents.
        // Replacing with empty array would wipe out the agent list incorrectly.
        if (upd.agents.length > 0 || upd.action === 0) {
          this.data.queues.set(upd.queueId, upd.agents);
          if (queueNumber) this.data.byNumber.set(queueNumber, upd.agents);
        }

        // Merge call stats — cumulative counters use high-water marks to survive
        // reconnections, but snapshot values (wait times) always use latest from 3CX.
        if (queueNumber && upd.callStats) {
          const existing = this.data.callStats.get(queueNumber);
          if (existing) {
            this.data.callStats.set(queueNumber, {
              callsWaiting: upd.callStats.callsWaiting, // live count — use latest
              callsAnswered: Math.max(upd.callStats.callsAnswered, existing.callsAnswered),
              callsAbandoned: Math.max(upd.callStats.callsAbandoned, existing.callsAbandoned),
              avgWaitSec: upd.callStats.avgWaitSec,        // snapshot — always use latest
              longestWaitSec: upd.callStats.longestWaitSec, // snapshot — always use latest
              totalOffered: Math.max(upd.callStats.totalOffered, existing.totalOffered),
            });
          } else {
            this.data.callStats.set(queueNumber, upd.callStats);
          }
        }

        // ── Call Event Detection ──────────────────────────────────
        // Track deltas in cumulative stats to detect individual call events.
        // Events are persisted to QueueDailySummary by the poller for restart-safe day-totals.
        if (queueNumber && upd.callStats) {
          const prev = this.prevCallStats.get(queueNumber);
          if (prev) {
            const now = Date.now();
            const deltaOffered = Math.max(0, upd.callStats.totalOffered - prev.totalOffered);
            const deltaAnswered = Math.max(0, upd.callStats.callsAnswered - prev.callsAnswered);
            const deltaAbandoned = Math.max(0, upd.callStats.callsAbandoned - prev.callsAbandoned);

            // New calls entered the queue
            const entries = this.pendingCallEntries.get(queueNumber) ?? [];
            for (let i = 0; i < deltaOffered; i++) {
              entries.push(now);
            }

            // Answered calls — pop oldest entry from FIFO for wait time
            for (let i = 0; i < deltaAnswered; i++) {
              const entryTime = entries.shift() ?? now;
              this.callEventBuffer.push({
                type: 'resolved',
                queueNumber,
                queueId: upd.queueId,
                result: 'answered',
                waitSec: Math.max(0, Math.round((now - entryTime) / 1000)),
                timestamp: now,
              });
            }

            // Abandoned calls — pop oldest entry from FIFO for wait time
            for (let i = 0; i < deltaAbandoned; i++) {
              const entryTime = entries.shift() ?? now;
              this.callEventBuffer.push({
                type: 'resolved',
                queueNumber,
                queueId: upd.queueId,
                result: 'abandoned',
                waitSec: Math.max(0, Math.round((now - entryTime) / 1000)),
                timestamp: now,
              });
            }

            this.pendingCallEntries.set(queueNumber, entries);
          } else {
            // First push after connection — emit baseline to seed DB if empty
            this.callEventBuffer.push({
              type: 'baseline',
              queueNumber,
              queueId: upd.queueId,
              answered: upd.callStats.callsAnswered,
              abandoned: upd.callStats.callsAbandoned,
              avgWaitSec: upd.callStats.avgWaitSec,
              longestWaitSec: upd.callStats.longestWaitSec,
              timestamp: Date.now(),
            });
          }
          this.prevCallStats.set(queueNumber, {
            totalOffered: upd.callStats.totalOffered,
            callsAnswered: upd.callStats.callsAnswered,
            callsAbandoned: upd.callStats.callsAbandoned,
          });
        }

        // Log agent status and call stats
        const label = upd.agents.length > 0
          ? upd.agents.map((a) => `${a.extensionNumber}=${a.loggedIn ? 'IN' : 'OUT'}`).join(', ')
          : '(empty)';
        const stats = this.data.callStats.get(queueNumber ?? '');
        const statsLabel = stats
          ? ` | W:${stats.callsWaiting} A:${stats.callsAnswered} Ab:${stats.callsAbandoned} AvgW:${stats.avgWaitSec}s LW:${stats.longestWaitSec}s`
          : '';
        console.log(`[QueueMonitor] Queue #${queueNumber ?? '?'}: ${label}${statsLabel}`);
      }
      this.data.lastUpdated = Date.now();

      // Log every refresh
      const agentSummary = updates.map((u) => {
        const qn = u.queueNumber ?? this.queueIdToNumber.get(u.queueId) ?? '?';
        return `#${qn}(${u.agents.length})`;
      }).join(' ');
      console.log(`[QueueMonitor] Data refreshed: ${agentSummary}`);

      // Reset stale timer — if no QueuesInfo push for 2 minutes, force reconnect.
      // Connection is kept alive (no periodic reconnect) so stats accumulate properly.
      if (this.staleTimer) clearTimeout(this.staleTimer);
      this.staleTimer = setTimeout(() => {
        if (!this.stopped && this.connected) {
          console.log('[QueueMonitor] No data for 2min, reconnecting');
          this.disconnect();
          void this.connect();
        }
      }, ThreecxQueueMonitor.STALE_TIMEOUT_MS);
    }
  }
}
