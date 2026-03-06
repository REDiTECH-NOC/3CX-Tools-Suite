import type {
  ThreecxLoginResponse,
  ThreecxQueue,
  ThreecxQueueAgent,
  ThreecxQueueManager,
  ThreecxActiveCall,
  ThreecxUser,
  ThreecxQueuePerformance,
  ThreecxQueueDetailedStats,
  ThreecxAbandonedQueueCall,
  ThreecxODataResponse,
} from '@/types/threecx';
import crypto from 'crypto';

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_TTL_MS = 45_000; // Refresh 15s before the 60s expiry
const SESSION_TTL_MS = 45_000; // MyPhone session TTL (same as JWT)

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  obtainedAt: number;
}

interface CachedMyPhoneSession {
  sessionKey: string;
  obtainedAt: number;
}

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

function decodeProtoString(buf: Uint8Array): string {
  const fields: string[] = [];
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
      let val = 0; shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      fields.push(`f${fn}=${val}`);
    } else if (wt === 2) {
      let len = 0; shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const data = buf.slice(i, i + len);
      i += len;
      const str = Buffer.from(data).toString('utf8');
      const printable = str.length > 0 && str.split('').every(
        (c: string) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127,
      );
      if (printable) {
        fields.push(`f${fn}="${str}"`);
      } else {
        fields.push(`f${fn}={${decodeProtoString(data)}}`);
      }
    } else if (wt === 1) { i += 8; }
    else if (wt === 5) { i += 4; }
    else { break; }
  }
  return fields.join(', ');
}

export class ThreecxClient {
  private readonly baseUrl: string;
  private readonly extensionNumber: string;
  private readonly password: string;
  private cachedToken: CachedToken | null = null;
  private cachedSession: CachedMyPhoneSession | null = null;

  constructor(pbxUrl: string, extensionNumber: string, password: string) {
    // Sanitize: strip protocol prefix and trailing slashes so users can paste full URLs
    const cleaned = pbxUrl
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    this.baseUrl = `https://${cleaned}`;
    this.extensionNumber = extensionNumber;
    this.password = password;
  }

  // ─── Authentication ──────────────────────────────────────────────

  /**
   * Authenticate against the 3CX PBX and cache the token.
   * Called automatically by `request()` — you rarely need to call this directly.
   */
  async authenticate(): Promise<string> {
    // Return cached token if still fresh
    if (this.cachedToken && Date.now() - this.cachedToken.obtainedAt < TOKEN_TTL_MS) {
      return this.cachedToken.accessToken;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.baseUrl}/webclient/api/Login/GetAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Username: this.extensionNumber,
          Password: this.password,
          SecurityCode: '',
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new ThreecxApiError(
          `Authentication HTTP error: ${res.status} ${res.statusText}`,
          res.status,
        );
      }

      const data: ThreecxLoginResponse = await res.json();

      if (data.Status !== 'AuthSuccess' || !data.Token) {
        throw new ThreecxAuthError(
          `Authentication failed: ${data.Status}. Check extension number and password.`,
        );
      }

      this.cachedToken = {
        accessToken: data.Token.access_token,
        refreshToken: data.Token.refresh_token,
        obtainedAt: Date.now(),
      };

      return this.cachedToken.accessToken;
    } catch (err) {
      if (err instanceof ThreecxApiError || err instanceof ThreecxAuthError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ThreecxApiError(
          `Authentication request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          0,
        );
      }
      throw new ThreecxApiError(
        `Authentication network error: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Test credentials without caching the token.
   * Useful for the setup wizard's "Test Connection" button.
   */
  static async validateCredentials(
    pbxUrl: string,
    extensionNumber: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    const url = `https://${pbxUrl}/webclient/api/Login/GetAccessToken`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Username: extensionNumber,
          Password: password,
          SecurityCode: '',
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const data: ThreecxLoginResponse = await res.json();

      if (data.Status !== 'AuthSuccess' || !data.Token) {
        return { success: false, error: `Auth status: ${data.Status}` };
      }

      return { success: true };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: `Connection timed out after ${REQUEST_TIMEOUT_MS}ms` };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Generic Request ─────────────────────────────────────────────

  /**
   * Make an authenticated request to the 3CX XAPI.
   * Auto-authenticates and retries once on 401.
   */
  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';

    const makeRequest = async (token: string): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
        };
        if (options.body !== undefined) {
          headers['Content-Type'] = 'application/json';
        }

        const res = await fetch(`${this.baseUrl}/xapi/v1/${path}`, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
          cache: 'no-store' as RequestCache,
        });

        return res;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new ThreecxApiError(
            `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`,
            0,
          );
        }
        throw new ThreecxApiError(
          `Network error requesting ${path}: ${err instanceof Error ? err.message : String(err)}`,
          0,
        );
      } finally {
        clearTimeout(timeout);
      }
    };

    // First attempt
    let token = await this.authenticate();
    let res = await makeRequest(token);

    // If 401, invalidate cache and retry once
    if (res.status === 401) {
      this.cachedToken = null;
      token = await this.authenticate();
      res = await makeRequest(token);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ThreecxApiError(
        `XAPI ${method} /${path} returned ${res.status}: ${body || res.statusText}`,
        res.status,
      );
    }

    // Some POST endpoints return 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  // ─── Public API Methods ──────────────────────────────────────────

  /** Get all call queues configured on the PBX. */
  async getQueues(): Promise<ThreecxQueue[]> {
    const data = await this.request<ThreecxODataResponse<ThreecxQueue>>('Queues');
    return data.value;
  }

  /** Get agents assigned to a specific queue. */
  async getQueueAgents(queueId: number): Promise<ThreecxQueueAgent[]> {
    const data = await this.request<ThreecxODataResponse<ThreecxQueueAgent>>(
      `Queues(${queueId})/Agents`,
    );
    return data.value;
  }

  /** Get managers assigned to a specific queue. */
  async getQueueManagers(queueId: number): Promise<ThreecxQueueManager[]> {
    const data = await this.request<ThreecxODataResponse<ThreecxQueueManager>>(
      `Queues(${queueId})/Managers`,
    );
    return data.value;
  }

  /** Get a single queue with managers expanded inline (different OData code path). */
  async getQueueWithManagers(queueId: number): Promise<{ Managers?: ThreecxQueueManager[] }> {
    const data = await this.request<{ Managers?: ThreecxQueueManager[] }>(
      `Queues(${queueId})?$expand=Managers`,
    );
    return data;
  }

  /**
   * Force-clear the cached auth token so the next request gets a fresh session.
   * Useful to avoid stale cached responses from 3CX (e.g., Managers endpoint).
   */
  invalidateToken(): void {
    this.cachedToken = null;
  }

  /** Get all currently active calls on the PBX. */
  async getActiveCalls(): Promise<ThreecxActiveCall[]> {
    const data = await this.request<ThreecxODataResponse<ThreecxActiveCall>>('ActiveCalls');
    return data.value;
  }

  /** Get all users/extensions on the PBX. */
  async getUsers(): Promise<ThreecxUser[]> {
    const data = await this.request<ThreecxODataResponse<ThreecxUser>>('Users');
    return data.value;
  }

  /**
   * Get queue performance statistics for a date range (legacy — may 404 on some PBX versions).
   */
  /**
   * Get authoritative queue stats from the 3CX Report API (DetailedQueueStatistics).
   * Returns per-queue totals: calls received, answered, avg wait time, avg talk time.
   * The PBX resets these according to its ResetQueueStatisticsSchedule.
   *
   * @param startDt - UTC ISO date for day start (e.g. "2026-03-04T06:00:00.000Z" for CST midnight)
   * @param endDt   - UTC ISO date for day end (e.g. "2026-03-05T06:00:00.000Z")
   */
  async getQueueDetailedStats(
    startDt: string,
    endDt: string,
    waitInterval = '0%3A00%3A0',
  ): Promise<ThreecxQueueDetailedStats[]> {
    const path =
      `ReportDetailedQueueStatistics/Pbx.GetDetailedQueueStatisticsData` +
      `(queueDnStr='',startDt=${encodeURIComponent(startDt)},` +
      `endDt=${encodeURIComponent(endDt)},` +
      `waitInterval='${waitInterval}')`;

    const data = await this.request<ThreecxODataResponse<ThreecxQueueDetailedStats>>(path);
    return data.value;
  }

  /**
   * Resolve an extension number to the internal 3CX User ID.
   * Required because PATCH Users() only works with internal IDs, not extension numbers.
   */
  private async resolveUserId(extensionNumber: string): Promise<number> {
    const users = await this.getUsers();
    const user = users.find((u) => u.Number === extensionNumber);
    if (!user) {
      throw new ThreecxApiError(
        `User with extension ${extensionNumber} not found on PBX`,
        404,
      );
    }
    return user.Id;
  }

  // ─── MyPhone Session (Protobuf API) ─────────────────────────────

  /**
   * Establish a MyPhone session for per-queue protobuf operations.
   * Protocol: POST /webclient/api/MyPhone/session with JWT Bearer auth.
   * Returns a sessionKey GUID used as the MyPhoneSession header.
   */
  private async getMyPhoneSession(): Promise<string> {
    if (this.cachedSession && Date.now() - this.cachedSession.obtainedAt < SESSION_TTL_MS) {
      return this.cachedSession.sessionKey;
    }

    const token = await this.authenticate();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.baseUrl}/webclient/api/MyPhone/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          Name: 'WallboardBot',
          Version: '18.0.10.0',
          fingerprint: crypto.randomUUID(),
        }),
        signal: controller.signal,
      });

      if (res.status === 401) {
        this.cachedToken = null;
        this.cachedSession = null;
        throw new ThreecxApiError('MyPhone session: JWT expired or invalid', 401);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ThreecxApiError(
          `MyPhone session failed: ${res.status} ${body || res.statusText}`,
          res.status,
        );
      }

      const data = await res.json();
      const sessionKey: string | undefined = data.sessionKey ?? data.SessionKey;
      if (!sessionKey) {
        throw new ThreecxApiError(
          `MyPhone session response missing sessionKey`,
          0,
        );
      }

      this.cachedSession = { sessionKey, obtainedAt: Date.now() };
      return sessionKey;
    } catch (err) {
      if (err instanceof ThreecxApiError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ThreecxApiError(
          `MyPhone session timed out after ${REQUEST_TIMEOUT_MS}ms`,
          0,
        );
      }
      throw new ThreecxApiError(
        `MyPhone session error: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a protobuf command to MyPhone/MPWebService.asmx.
   * Auto-retries once on session expiry.
   */
  private async sendMyPhoneCommand(message: Buffer): Promise<void> {
    const send = async (sessionKey: string): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetch(`${this.baseUrl}/MyPhone/MPWebService.asmx`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            Accept: 'application/octet-stream',
            MyPhoneSession: sessionKey,
          },
          body: message as unknown as BodyInit,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    const checkResponse = async (res: Response): Promise<void> => {
      const buf = new Uint8Array(await res.arrayBuffer());
      const decoded = decodeProtoString(buf);
      if (decoded.includes('Login is required') || decoded.includes('NOT AUTH')) {
        throw new ThreecxApiError('MyPhone session expired', 401);
      }
      if (!decoded.includes('successfully processed') && res.status !== 200) {
        throw new ThreecxApiError(
          `MyPhone command failed (HTTP ${res.status}): ${decoded}`,
          res.status,
        );
      }
    };

    // First attempt
    let sessionKey = await this.getMyPhoneSession();
    let res = await send(sessionKey);

    try {
      await checkResponse(res);
    } catch (err) {
      if (err instanceof ThreecxApiError && err.statusCode === 401) {
        // Session expired — get fresh session and retry once
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
   * Log an agent into a SPECIFIC queue using the MyPhone protobuf protocol.
   * SetQueueStatus (MessageId=132): field 1=QueueId, field 2=AgentId, field 3=true.
   * @param queueId - The queue's internal 3CX ID (not the extension number)
   * @param extensionNumber - The agent's extension number (resolved to internal user ID)
   */
  async queueAgentLogin(queueId: number, extensionNumber: string): Promise<void> {
    const userId = await this.resolveUserId(extensionNumber);
    const payload = varintField(1, queueId)
      .concat(varintField(2, userId))
      .concat(boolField(3, true));
    await this.sendMyPhoneCommand(buildGenericMsg(132, payload));
  }

  /**
   * Log an agent out of a SPECIFIC queue using the MyPhone protobuf protocol.
   * SetQueueStatus (MessageId=132): field 1=QueueId, field 2=AgentId, field 3=false.
   * @param queueId - The queue's internal 3CX ID (not the extension number)
   * @param extensionNumber - The agent's extension number (resolved to internal user ID)
   */
  async queueAgentLogout(queueId: number, extensionNumber: string): Promise<void> {
    const userId = await this.resolveUserId(extensionNumber);
    const payload = varintField(1, queueId)
      .concat(varintField(2, userId))
      .concat(boolField(3, false));
    await this.sendMyPhoneCommand(buildGenericMsg(132, payload));
  }

  // ─── Queue Membership Management (XAPI PATCH) ──────────────────

  /**
   * Add an agent to a queue by extension number.
   * Uses the PATCH full-replace pattern: GET current agents, append, PATCH back.
   * Idempotent — no-op if agent is already in the queue.
   */
  async addAgentToQueue(queueId: number, extensionNumber: string): Promise<void> {
    const agents = await this.getQueueAgents(queueId);
    if (agents.some((a) => a.Number === extensionNumber)) return;

    const updatedAgents = [...agents.map((a) => ({ Number: a.Number })), { Number: extensionNumber }];
    await this.request(`Queues(${queueId})`, {
      method: 'PATCH',
      body: { Agents: updatedAgents },
    });
  }

  /**
   * Remove an agent from a queue by extension number.
   * Uses the PATCH full-replace pattern: GET current agents, filter out, PATCH back.
   * Idempotent — no-op if agent is not in the queue.
   */
  async removeAgentFromQueue(queueId: number, extensionNumber: string): Promise<void> {
    const agents = await this.getQueueAgents(queueId);
    if (!agents.some((a) => a.Number === extensionNumber)) return;

    const updatedAgents = agents
      .filter((a) => a.Number !== extensionNumber)
      .map((a) => ({ Number: a.Number }));
    await this.request(`Queues(${queueId})`, {
      method: 'PATCH',
      body: { Agents: updatedAgents },
    });
  }

  /**
   * Get queue performance overview from the 3CX Report API.
   * May return more fields than PerfTotals (e.g., wait time distributions).
   */
  async getQueuePerformanceOverview(
    startDt: string,
    endDt: string,
  ): Promise<Record<string, unknown>[]> {
    const path =
      `ReportQueuePerformanceOverview/Pbx.GetQueuePerformanceOverviewData` +
      `(periodFrom=${encodeURIComponent(startDt)},` +
      `periodTo=${encodeURIComponent(endDt)},` +
      `queueDns='',waitInterval='0%3A00%3A0')`;
    const data = await this.request<ThreecxODataResponse<Record<string, unknown>>>(path);
    return data.value;
  }

  /**
   * Get queue performance totals from the 3CX Report API.
   * May return LongestWaitingTimeSec and AverageWaitingTimeSec on some PBX versions.
   */
  async getQueuePerformanceTotals(
    startDt: string,
    endDt: string,
  ): Promise<ThreecxQueuePerformance[]> {
    // OData signature: (periodFrom:DateTimeOffset, periodTo:DateTimeOffset, queueDns:String, waitInterval:String)
    const path =
      `ReportQueuePerformanceTotals/Pbx.GetQueuePerformanceTotalsData` +
      `(periodFrom=${encodeURIComponent(startDt)},` +
      `periodTo=${encodeURIComponent(endDt)},` +
      `queueDns='',waitInterval='0%3A00%3A0')`;
    const data = await this.request<ThreecxODataResponse<ThreecxQueuePerformance>>(path);
    return data.value;
  }

  /**
   * Get abandoned queue calls for a date range.
   * Returns individual call records with WaitTime — useful for computing max wait.
   */
  async getAbandonedQueueCalls(
    startDt: string,
    endDt: string,
  ): Promise<ThreecxAbandonedQueueCall[]> {
    // OData signature: (periodFrom:DateTimeOffset, periodTo:DateTimeOffset, queueDns:String, waitInterval:String)
    // Try with large waitInterval first (23:59:59 = everything in one bucket)
    try {
      const path =
        `ReportAbandonedQueueCalls/Pbx.GetAbandonedQueueCallsData` +
        `(periodFrom=${encodeURIComponent(startDt)},` +
        `periodTo=${encodeURIComponent(endDt)},` +
        `queueDns='',waitInterval='23%3A59%3A59')`;
      const data = await this.request<ThreecxODataResponse<ThreecxAbandonedQueueCall>>(path);
      if (data.value.length > 0) return data.value;
    } catch { /* try next */ }
    // Fallback with 0:00:0
    const path =
      `ReportAbandonedQueueCalls/Pbx.GetAbandonedQueueCallsData` +
      `(periodFrom=${encodeURIComponent(startDt)},` +
      `periodTo=${encodeURIComponent(endDt)},` +
      `queueDns='',waitInterval='0%3A00%3A0')`;
    const data = await this.request<ThreecxODataResponse<ThreecxAbandonedQueueCall>>(path);
    return data.value;
  }

  /**
   * Get queue answered calls by wait time distribution.
   * Returns bucketed wait time data — useful for estimating max wait.
   */
  async getQueueAnsweredCallsByWaitTime(
    startDt: string,
    endDt: string,
  ): Promise<unknown[]> {
    // Signature likely matches other queue reports: periodFrom, periodTo, queueDns, waitInterval
    const path =
      `ReportQueueAnsweredCallsByWaitTime/Pbx.GetQueueAnsweredCallsByWaitTimeData` +
      `(periodFrom=${encodeURIComponent(startDt)},` +
      `periodTo=${encodeURIComponent(endDt)},` +
      `queueDns='',waitInterval='0%3A00%3A30')`;
    const data = await this.request<ThreecxODataResponse<unknown>>(path);
    return data.value;
  }

  /**
   * Discover available Report API endpoints by checking the OData metadata.
   * Returns a list of report entity set names that exist on this PBX.
   */
  async discoverReportEndpoints(): Promise<string[]> {
    const token = await this.authenticate();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/xapi/v1/$metadata`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/xml' },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const xml = await res.text();
      // Extract all EntitySet names matching Report*
      const results: string[] = [];
      const re = /EntitySet\s+Name="(Report[^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(xml)) !== null) {
        results.push(match[1]);
      }

      // Extract function signatures for key report endpoints
      const funcNames = ['GetAbandonedQueueCallsData', 'GetQueuePerformanceTotalsData', 'GetQueuePerformanceOverviewData', 'GetAverageQueueWaitingTimeData'];
      for (const fn of funcNames) {
        // Look for Function or FunctionImport definitions with this name
        const fnRe = new RegExp(`<(?:Function|FunctionImport)[^>]*Name="${fn}"[^>]*>([\\s\\S]*?)</(?:Function|FunctionImport)>`, 'g');
        let fnMatch: RegExpExecArray | null;
        while ((fnMatch = fnRe.exec(xml)) !== null) {
          // Extract parameter names from the body
          const paramRe = /Parameter\s+Name="([^"]+)"\s+Type="([^"]+)"/g;
          const params: string[] = [];
          let pMatch: RegExpExecArray | null;
          while ((pMatch = paramRe.exec(fnMatch[0])) !== null) {
            params.push(`${pMatch[1]}:${pMatch[2]}`);
          }
          console.log(`[ThreecxClient] Function ${fn}(${params.join(', ')})`);
        }
      }

      return results;
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Quick health check — authenticates and returns true if successful.
   * Does not throw; returns false on any error.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch {
      return false;
    }
  }

  /** Invalidate the cached token and MyPhone session. */
  clearTokenCache(): void {
    this.cachedToken = null;
    this.cachedSession = null;
  }
}

// ─── Error Classes ───────────────────────────────────────────────

export class ThreecxApiError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ThreecxApiError';
    this.statusCode = statusCode;
  }
}

export class ThreecxAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreecxAuthError';
  }
}
