/**
 * Lightweight 3CX API collector for the relay agent.
 * Connects to the local PBX and fetches queue/call/user data.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS = 45_000;

interface CachedToken {
  accessToken: string;
  obtainedAt: number;
}

export interface ActiveCall {
  Id: number;
  Caller: string;
  Callee: string;
  Status: string;
  EstablishedAt?: string;
  LastChangeStatus?: string;
  ServerNow?: string;
  Segments?: CallSegment[];
}

export interface CallSegment {
  CallerNumber?: string;
  CalleeNumber?: string;
  Dn?: string;
  DialedDn?: string;
  Status?: string;
}

export interface PbxQueue {
  Id: number;
  Number: string;
  Name: string;
}

export interface QueueAgent {
  Number: string;
}

export interface PbxUser {
  Number: string;
  FirstName: string;
  LastName: string;
  IsRegistered: boolean;
  QueueStatus: string;
  CurrentProfileName: string;
}

export interface QueueDetailedStats {
  QueueDnNumber: string;
  QueueDn: string;
  CallsCount: number;
  AnsweredCount: number;
  RingTime: string;       // ISO 8601 duration "PT8M42S"
  AvgRingTime: string;    // ISO 8601 duration "PT30.7S"
  TalkTime: string;
  AvgTalkTime: string;
  CallbacksCount: number;
}

export class Collector {
  private readonly baseUrl: string;
  private readonly extension: string;
  private readonly password: string;
  private cachedToken: CachedToken | null = null;

  constructor(pbxUrl: string, extension: string, password: string) {
    const cleaned = pbxUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.baseUrl = `https://${cleaned}`;
    this.extension = extension;
    this.password = password;
  }

  async authenticate(): Promise<string> {
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
          Username: this.extension,
          Password: this.password,
          SecurityCode: '',
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Auth HTTP ${res.status}: ${res.statusText}`);

      const data = await res.json() as { Status?: string; Token?: { access_token: string } };
      if (data.Status !== 'AuthSuccess' || !data.Token) {
        throw new Error(`Auth failed: ${data.Status}`);
      }

      this.cachedToken = {
        accessToken: data.Token.access_token,
        obtainedAt: Date.now(),
      };

      return this.cachedToken.accessToken;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.authenticate();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (res.status === 401) {
        // Token expired — clear cache and retry once
        this.cachedToken = null;
        const newToken = await this.authenticate();
        const retryRes = await fetch(`${this.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${newToken}` },
          signal: controller.signal,
        });
        if (!retryRes.ok) throw new Error(`HTTP ${retryRes.status}: ${retryRes.statusText}`);
        const retryData = await retryRes.json() as { value?: T } & T;
        return (retryData as { value?: T }).value ?? retryData as T;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json() as { value?: T } & T;
      return (data as { value?: T }).value ?? data as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getQueues(): Promise<PbxQueue[]> {
    return this.request<PbxQueue[]>('/xapi/v1/Queues?$select=Id,Number,Name');
  }

  async getActiveCalls(): Promise<ActiveCall[]> {
    return this.request<ActiveCall[]>('/xapi/v1/ActiveCalls');
  }

  async getUsers(): Promise<PbxUser[]> {
    return this.request<PbxUser[]>('/xapi/v1/Users?$select=Number,FirstName,LastName,IsRegistered,QueueStatus,CurrentProfileName');
  }

  async getQueueAgents(queueId: number): Promise<QueueAgent[]> {
    return this.request<QueueAgent[]>(`/xapi/v1/Queues(${queueId})/Agents`);
  }

  async getQueueDetailedStats(startDt: string, endDt: string): Promise<QueueDetailedStats[]> {
    return this.request<QueueDetailedStats[]>(
      `/xapi/v1/ReportDetailedQueueStatistics/Pbx.GetDetailedQueueStatisticsData` +
      `(queueDnStr='',startDt=${encodeURIComponent(startDt)},` +
      `endDt=${encodeURIComponent(endDt)},` +
      `waitInterval='0%3A00%3A0')`
    );
  }
}
