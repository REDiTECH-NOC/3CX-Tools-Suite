/**
 * Simplified 3CX WebSocket Queue Monitor for the relay agent.
 * Connects to the PBX MyPhone WebSocket and tracks per-queue agent login status.
 * Based on the wallboard's ThreecxQueueMonitor but stripped down for relay use.
 */
import * as https from 'https';
import * as crypto from 'crypto';
import type { Socket } from 'net';

// ─── Types ──────────────────────────────────────────────────────

export interface AgentStatus {
  extensionNumber: string;
  agentId: number;
  loggedIn: boolean;
}

export interface MonitorData {
  /** queueNumber → agent statuses */
  byNumber: Map<string, AgentStatus[]>;
  lastUpdated: number;
}

// ─── Protobuf Helpers ───────────────────────────────────────────

interface ProtoField {
  fn: number;
  type: 'varint' | 'bytes';
  value: number | Uint8Array;
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
  bytes.push(v & 0x7f);
  return bytes;
}

function varintField(fn: number, v: number): number[] {
  return encodeVarint((fn << 3) | 0).concat(encodeVarint(v));
}

function stringField(fn: number, s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  return encodeVarint((fn << 3) | 2).concat(encodeVarint(b.length)).concat(Array.from(b));
}

function submsgField(fn: number, d: number[]): number[] {
  return encodeVarint((fn << 3) | 2).concat(encodeVarint(d.length)).concat(d);
}

function buildMsg(id: number, payload: number[]): Buffer {
  return Buffer.from(varintField(1, id).concat(submsgField(id, payload)));
}

function decodeFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0, shift = 0;
    while (i < buf.length) { const b = buf[i++]; tag |= (b & 0x7f) << shift; shift += 7; if ((b & 0x80) === 0) break; }
    const fn = tag >> 3;
    const wt = tag & 7;
    if (fn === 0) break;
    if (wt === 0) {
      let val = 0; shift = 0;
      while (i < buf.length) { const b = buf[i++]; val |= (b & 0x7f) << shift; shift += 7; if ((b & 0x80) === 0) break; }
      fields.push({ fn, type: 'varint', value: val });
    } else if (wt === 2) {
      let len = 0; shift = 0;
      while (i < buf.length) { const b = buf[i++]; len |= (b & 0x7f) << shift; shift += 7; if ((b & 0x80) === 0) break; }
      const data = buf.slice(i, i + len); i += len;
      fields.push({ fn, type: 'bytes', value: data });
    } else if (wt === 1) { i += 8; }
    else if (wt === 5) { i += 4; }
    else { break; }
  }
  return fields;
}

function getVarint(fields: ProtoField[], fn: number): number | undefined {
  const f = fields.find(x => x.fn === fn && x.type === 'varint');
  return f ? (f.value as number) : undefined;
}

function getString(fields: ProtoField[], fn: number): string | undefined {
  const f = fields.find(x => x.fn === fn && x.type === 'bytes');
  if (!f) return undefined;
  return Buffer.from(f.value as Uint8Array).toString('utf8');
}

function getSubmsg(fields: ProtoField[], fn: number): ProtoField[] | undefined {
  const f = fields.find(x => x.fn === fn && x.type === 'bytes');
  if (!f) return undefined;
  return decodeFields(f.value as Uint8Array);
}

function getAllSubmsg(fields: ProtoField[], fn: number): ProtoField[][] {
  return fields.filter(x => x.fn === fn && x.type === 'bytes').map(x => decodeFields(x.value as Uint8Array));
}

// ─── WS Frame Helpers ───────────────────────────────────────────

function sendWsFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
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

// ─── Queue Monitor ──────────────────────────────────────────────

export class QueueMonitor {
  private readonly pbxHost: string;
  private readonly extension: string;
  private readonly password: string;
  private socket: Socket | null = null;
  private connected = false;
  private stopped = false;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private gotInitialData = false;

  data: MonitorData = { byNumber: new Map(), lastUpdated: 0 };

  constructor(pbxHost: string, extension: string, password: string) {
    this.pbxHost = pbxHost.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.extension = extension;
    this.password = password;
  }

  hasData(): boolean { return this.data.lastUpdated > 0; }

  isAgentLoggedIn(queueNumber: string, ext: string): boolean | undefined {
    const agents = this.data.byNumber.get(queueNumber);
    if (!agents) return undefined;
    const agent = agents.find(a => a.extensionNumber === ext);
    return agent?.loggedIn;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; }
    this.disconnect();
  }

  private disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      try { sendWsFrame(this.socket, 0x08, Buffer.alloc(0)); } catch {}
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.disconnect();
      setTimeout(() => { if (!this.stopped) void this.connect(); }, 3000);
    }, delayMs);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connected || this.isConnecting) return;
    this.isConnecting = true;

    try {
      const token = await this.restLogin();
      if (!token) { this.scheduleReconnect(15000); return; }

      const session = await this.getSession(token);
      if (!session) { this.scheduleReconnect(15000); return; }

      this.gotInitialData = false;
      await this.connectWebSocket(session.sessionKey, session.pass, token);

      setTimeout(() => {
        if (!this.stopped && !this.gotInitialData && this.connected) {
          console.log('[Monitor] No data timeout, reconnecting');
          this.scheduleReconnect(2000);
        }
      }, 8000);
    } catch (err) {
      console.error('[Monitor] Connection error:', err instanceof Error ? err.message : String(err));
      this.scheduleReconnect(15000);
    } finally {
      this.isConnecting = false;
    }
  }

  private restLogin(): Promise<string | null> {
    return new Promise(resolve => {
      const body = JSON.stringify({ Username: this.extension, Password: this.password, SecurityCode: '' });
      const req = https.request(`https://${this.pbxHost}/webclient/api/Login/GetAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        rejectUnauthorized: false,
      }, res => {
        let data = '';
        res.on('data', (c: Buffer) => data += c);
        res.on('end', () => {
          try {
            const p = JSON.parse(data);
            resolve(p.Status === 'AuthSuccess' && p.Token?.access_token ? p.Token.access_token : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });
  }

  private getSession(token: string): Promise<{ sessionKey: string; pass: string } | null> {
    return new Promise(resolve => {
      const body = JSON.stringify({ Name: 'RelayAgent', Version: '18.0.10.0', fingerprint: crypto.randomUUID() });
      const req = https.request(`https://${this.pbxHost}/webclient/api/MyPhone/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` },
        rejectUnauthorized: false,
      }, res => {
        let data = '';
        res.on('data', (c: Buffer) => data += c);
        res.on('end', () => {
          try {
            const p = JSON.parse(data);
            resolve(p.sessionKey && p.pass ? { sessionKey: p.sessionKey, pass: p.pass } : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });
  }

  private connectWebSocket(sessionKey: string, pass: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsKey = crypto.randomBytes(16).toString('base64');
      const path = `/ws/webclient?sessionId=${encodeURIComponent(sessionKey)}&pass=${encodeURIComponent(pass)}`;

      const req = https.request({
        hostname: this.pbxHost, port: 443, path, method: 'GET',
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': wsKey, 'Sec-WebSocket-Version': '13' },
        rejectUnauthorized: false,
      });

      req.on('upgrade', (_res, socket) => {
        this.socket = socket;
        this.connected = true;
        console.log('[Monitor] WebSocket connected');

        // Reset stale timer
        if (this.staleTimer) clearTimeout(this.staleTimer);
        this.staleTimer = setTimeout(() => {
          if (!this.stopped && this.connected) {
            console.log('[Monitor] Stale data, reconnecting');
            this.scheduleReconnect(2000);
          }
        }, 120_000);

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
              payloadLen = buffer.readUInt16BE(2); offset = 4;
            } else if (payloadLen === 127) {
              if (buffer.length < 10) return;
              payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10;
            }

            if (masked) offset += 4;
            if (buffer.length < offset + payloadLen) return;

            let payload = buffer.subarray(offset, offset + payloadLen);
            if (masked) {
              const maskKey = buffer.subarray(offset - 4, offset);
              payload = Buffer.from(payload);
              for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
            }

            buffer = buffer.subarray(offset + payloadLen);

            if (opcode === 0x01) {
              const text = payload.toString('utf8');
              if (text === 'START' && !loginSent) {
                loginSent = true;
                this.sendLogin(token, sessionKey);
              } else if (text === 'ADDP') {
                sendWsText(socket, 'ADDP');
              }
            } else if (opcode === 0x02) {
              this.handleBinaryMessage(payload);
            } else if (opcode === 0x08) {
              this.scheduleReconnect(5000);
            }
          }
        });

        socket.on('close', () => {
          this.connected = false;
          this.scheduleReconnect(15000);
        });

        socket.on('error', (err) => {
          console.error('[Monitor] WS error:', err.message);
          this.scheduleReconnect(15000);
        });

        resolve();
      });

      req.on('error', (err) => {
        console.error('[Monitor] WS upgrade error:', err.message);
        this.isConnecting = false;
        reject(err);
      });

      req.setTimeout(15000, () => { req.destroy(); reject(new Error('WS timeout')); });
      req.end();
    });
  }

  private sendLogin(token: string, sessionKey: string): void {
    // Send Login (100) then GetMyInfo (102) via HTTP POST.
    // Server pushes QueuesInfo (211) via WebSocket in response.
    this.sendHttpCommand(sessionKey, 100)
      .then(() => this.sendHttpCommand(sessionKey, 102))
      .catch((err) => {
        console.error('[Monitor] HTTP login/setup error:', err instanceof Error ? err.message : String(err));
      });
  }

  private sendHttpCommand(sessionKey: string, messageId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const msg = buildMsg(messageId, []);
      const req = https.request(`https://${this.pbxHost}/MyPhone/MPWebService.asmx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
          'Content-Length': msg.length,
          MyPhoneSession: sessionKey,
        },
        rejectUnauthorized: false,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          if (res.statusCode === 200 && raw.length > 0) {
            this.handleBinaryMessage(raw);
          }
          resolve();
        });
      });
      req.on('error', (err) => reject(err));
      req.setTimeout(15000, () => { req.destroy(); reject(new Error(`HTTP command ${messageId} timeout`)); });
      req.write(msg);
      req.end();
    });
  }

  private handleBinaryMessage(payload: Buffer): void {
    const outer = decodeFields(payload);
    const msgId = getVarint(outer, 1);
    if (msgId !== 211) return; // Only care about QueuesInfo

    const queuesWrapper = getSubmsg(outer, 211);
    if (!queuesWrapper) return;

    const queueItems = getAllSubmsg(queuesWrapper, 2);
    let updated = false;

    for (const queueFields of queueItems) {
      const queueNumber = getString(queueFields, 4);
      if (!queueNumber) continue;

      const agentsWrapper = getSubmsg(queueFields, 5);
      if (!agentsWrapper) continue;

      const agents: AgentStatus[] = [];
      const agentItems = getAllSubmsg(agentsWrapper, 2);
      for (const af of agentItems) {
        const ext = getString(af, 3);
        const id = getVarint(af, 2) ?? 0;
        const loggedIn = getVarint(af, 8) === 1;
        if (ext) agents.push({ extensionNumber: ext, agentId: id, loggedIn });
      }

      if (agents.length > 0) {
        this.data.byNumber.set(queueNumber, agents);
        updated = true;
      }
    }

    if (updated) {
      this.data.lastUpdated = Date.now();
      this.gotInitialData = true;

      // Reset stale timer
      if (this.staleTimer) clearTimeout(this.staleTimer);
      this.staleTimer = setTimeout(() => {
        if (!this.stopped && this.connected) {
          console.log('[Monitor] Stale data, reconnecting');
          this.scheduleReconnect(2000);
        }
      }, 120_000);
    }
  }
}
