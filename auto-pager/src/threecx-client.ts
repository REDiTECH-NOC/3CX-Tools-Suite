/**
 * Lightweight 3CX client for the Auto-Pager.
 * Supports XAPI REST (OData) + MyPhone protobuf protocol for MakeCall.
 */

import fetch from 'node-fetch';
import * as crypto from 'crypto';

// ─── Protobuf Encoding (3CX MyPhone Protocol) ──────────────────

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

function varintField(fieldNumber: number, value: number): number[] {
  return encodeVarint((fieldNumber << 3) | 0).concat(encodeVarint(value));
}

function boolField(fieldNumber: number, value: boolean): number[] {
  return varintField(fieldNumber, value ? 1 : 0);
}

function stringField(fieldNumber: number, value: string): number[] {
  const b = Buffer.from(value, 'utf8');
  return encodeVarint((fieldNumber << 3) | 2)
    .concat(encodeVarint(b.length))
    .concat(Array.from(b));
}

function submsgField(fieldNumber: number, data: number[]): number[] {
  return encodeVarint((fieldNumber << 3) | 2)
    .concat(encodeVarint(data.length))
    .concat(data);
}

function buildGenericMsg(messageId: number, payload: number[]): Buffer {
  return Buffer.from(
    varintField(1, messageId).concat(submsgField(messageId, payload)),
  );
}

// ────────────────────────────────────────────────────────────────

interface TokenResponse {
  Status: string;
  Token?: { token_type: string; access_token: string; expires_in: number };
}

interface ODataResponse<T> {
  value: T[];
}

export interface ThreecxQueue {
  Id: number;
  Number: string;
  Name: string;
}

export interface ThreecxRingGroup {
  Id: number;
  Number: string;
  Name: string;
}

export interface ThreecxActiveCall {
  Id: number;
  Caller: string;
  Callee: string;
  Status: string;
  EstablishedAt: string | null;
  LastChangeStatus?: string;
  Segments?: {
    CalleeNumber?: string;
    CallerNumber?: string;
    DialedDn?: string;
    Dn?: string;
    Status?: string;
    DestinationNumber?: string;
  }[];
  [key: string]: unknown; // capture any extra fields for debugging
}

/** Cached MyPhone session */
interface MyPhoneSession {
  sessionKey: string;
  obtainedAt: number;
}

const SESSION_TTL_MS = 45_000; // 45 seconds (conservative, JWT is 60s)

export class ThreecxClient {
  private baseUrl: string;
  private extension: string;
  private password: string;
  private token: string | null = null;
  private tokenExpiry = 0;
  private cachedSession: MyPhoneSession | null = null;

  constructor(pbxUrl: string, extension: string, password: string) {
    // Normalize URL
    const host = pbxUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.baseUrl = `https://${host}`;
    this.extension = extension;
    this.password = password;
  }

  private async authenticate(): Promise<string> {
    const url = `${this.baseUrl}/webclient/api/Login/GetAccessToken`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SecurityCode: '',
        Password: this.password,
        Username: this.extension,
      }),
    });

    if (!res.ok) {
      throw new Error(`3CX auth failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as TokenResponse;
    if (data.Status !== 'AuthSuccess' || !data.Token) {
      throw new Error(`3CX auth rejected: ${data.Status}`);
    }

    this.token = data.Token.access_token;
    this.tokenExpiry = Date.now() + (data.Token.expires_in - 5) * 1000;
    return this.token;
  }

  private async getToken(): Promise<string> {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      await this.authenticate();
    }
    return this.token!;
  }

  // ── XAPI REST ──

  async request<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/xapi/v1/${path}`;
    const method = options?.method || 'GET';
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (options?.body) headers['Content-Type'] = 'application/json';

    const fetchOpts: import('node-fetch').RequestInit = { method, headers };
    if (options?.body) fetchOpts.body = JSON.stringify(options.body);

    const res = await fetch(url, fetchOpts);

    if (res.status === 401) {
      this.token = null;
      const newToken = await this.getToken();
      headers.Authorization = `Bearer ${newToken}`;
      const retry = await fetch(url, { ...fetchOpts, headers });
      if (!retry.ok) {
        const text = await retry.text();
        throw new Error(`3CX API error: ${retry.status} — ${text}`);
      }
      if (retry.status === 204) return {} as T;
      return (await retry.json()) as T;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`3CX API error: ${res.status} — ${text}`);
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  /** Get all queues from the PBX. */
  async getQueues(): Promise<ThreecxQueue[]> {
    const data = await this.request<ODataResponse<ThreecxQueue>>(
      "Queues?$select=Id,Number,Name",
    );
    return data.value;
  }

  /** Get all ring groups from the PBX. */
  async getRingGroups(): Promise<ThreecxRingGroup[]> {
    const data = await this.request<ODataResponse<ThreecxRingGroup>>(
      "RingGroups?$select=Id,Number,Name",
    );
    return data.value;
  }

  /** Get all active calls. */
  async getActiveCalls(): Promise<ThreecxActiveCall[]> {
    const data = await this.request<ODataResponse<ThreecxActiveCall>>(
      "ActiveCalls",
    );
    return data.value;
  }

  // ── MyPhone Protobuf Protocol ──

  /**
   * Get or create a MyPhone session for protobuf commands.
   * Sessions are short-lived (~45s) and cached.
   */
  private async getMyPhoneSession(): Promise<string> {
    if (this.cachedSession && Date.now() - this.cachedSession.obtainedAt < SESSION_TTL_MS) {
      return this.cachedSession.sessionKey;
    }

    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}/webclient/api/MyPhone/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        Name: 'AutoPager',
        Version: '18.0.10.0',
        fingerprint: crypto.randomUUID(),
      }),
    });

    if (res.status === 401) {
      this.token = null;
      this.cachedSession = null;
      throw new Error('MyPhone session: JWT expired or invalid');
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MyPhone session failed: ${res.status} ${body || res.statusText}`);
    }

    const data = (await res.json()) as Record<string, string>;
    const sessionKey = data.sessionKey ?? data.SessionKey;
    if (!sessionKey) {
      throw new Error('MyPhone session response missing sessionKey');
    }

    this.cachedSession = { sessionKey, obtainedAt: Date.now() };
    console.log('[3CX] MyPhone session established');
    return sessionKey;
  }

  /**
   * Send a protobuf command to MyPhone/MPWebService.asmx.
   * Auto-retries once on session expiry.
   */
  private async sendMyPhoneCommand(message: Buffer): Promise<void> {
    const send = async (sessionKey: string) => {
      return fetch(`${this.baseUrl}/MyPhone/MPWebService.asmx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
          MyPhoneSession: sessionKey,
        },
        body: message,
      });
    };

    const checkResponse = async (res: import('node-fetch').Response): Promise<void> => {
      const buf = Buffer.from(await res.arrayBuffer());
      const decoded = buf.toString('utf8');
      const hex = buf.toString('hex');
      console.log(`[3CX] MPWebService response (${res.status}): text="${decoded.substring(0, 200)}" hex=${hex.substring(0, 100)}`);
      if (decoded.includes('Login is required') || decoded.includes('NOT AUTH')) {
        throw Object.assign(new Error('MyPhone session expired'), { retryable: true });
      }
      if (res.status >= 400) {
        throw new Error(`MyPhone command failed: HTTP ${res.status}`);
      }
    };

    // First attempt
    let sessionKey = await this.getMyPhoneSession();
    let res = await send(sessionKey);

    try {
      await checkResponse(res);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'retryable' in err) {
        // Session expired — get fresh session and retry
        this.cachedSession = null;
        sessionKey = await this.getMyPhoneSession();
        res = await send(sessionKey);
        await checkResponse(res);
      } else {
        throw err;
      }
    }
  }

  /**
   * Initiate a call via MyPhone protobuf protocol (MessageId 119).
   * This is the same mechanism the 3CX webclient uses, so dial codes
   * like *72 (paging/intercom) are processed correctly by the PBX.
   *
   * MakeCall (119) fields:
   *   field 1: Destination (string)
   *   field 2: UseIntercomToSource (bool, optional)
   *   field 3: EnableCallControl (bool, optional)
   */
  /**
   * Send Login (100) to activate the MyPhone session.
   * Required before sending other commands like MakeCall.
   */
  private async sendLogin(): Promise<void> {
    console.log('[3CX] Sending Login (100) to activate session');
    const msg = buildGenericMsg(100, []);
    await this.sendMyPhoneCommand(msg);
  }

  /**
   * Initiate a call via MyPhone protobuf protocol (MessageId 119).
   * Sends Login first to activate the session, then MakeCall.
   *
   * MakeCall (119) fields:
   *   field 1: Destination (string)
   *   field 2: UseIntercomToSource (bool, optional)
   *   field 3: DeviceID (string, optional)
   *   field 4: EnableCallControl (bool, optional)
   */
  async makeCall(destination: string): Promise<void> {
    // Activate session with Login first
    await this.sendLogin();

    console.log(`[3CX] MakeCall (protobuf 119): destination=${destination}`);
    const payload = stringField(1, destination);
    const msg = buildGenericMsg(119, payload);
    console.log(`[3CX] MakeCall hex: ${msg.toString('hex')}`);
    await this.sendMyPhoneCommand(msg);
  }

  /**
   * Drop all active calls originating from MakeCall (our paging calls).
   * Uses XAPI ActiveCalls + DropCall to force-disconnect after audio finishes.
   */
  async dropPageCalls(): Promise<number> {
    const calls = await this.getActiveCalls();
    let dropped = 0;
    for (const call of calls) {
      // MakeCall-originated calls show "MakeCall" as Caller
      if (call.Caller === 'MakeCall' || call.Callee?.includes('MakeCall')) {
        try {
          await this.request(`ActiveCalls(${call.Id})/Pbx.DropCall`, { method: 'POST', body: {} });
          console.log(`[3CX] Dropped page call #${call.Id}`);
          dropped++;
        } catch (err) {
          console.warn(`[3CX] Failed to drop call #${call.Id}:`, err);
        }
      }
    }
    return dropped;
  }

  /** Test the connection. Returns true if successful. */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.getQueues();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
