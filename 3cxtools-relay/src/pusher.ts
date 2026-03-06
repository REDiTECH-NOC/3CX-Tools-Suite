/**
 * HTTP push module for the relay agent.
 * POSTs RelayPushPayload to the wallboard's /api/relay/push endpoint.
 */

const PUSH_TIMEOUT_MS = 5_000;

export interface PushResult {
  success: boolean;
  status?: number;
  error?: string;
}

export class Pusher {
  private readonly url: string;
  private readonly apiKey: string;
  private authFailed = false;
  private consecutiveErrors = 0;

  constructor(wallboardUrl: string, apiKey: string) {
    const base = wallboardUrl.replace(/\/+$/, '');
    this.url = `${base}/api/relay/push`;
    this.apiKey = apiKey;
  }

  /**
   * Returns true if the wallboard rejected the API key (401).
   * Once set, the agent should stop pushing.
   */
  isAuthFailed(): boolean {
    return this.authFailed;
  }

  /**
   * Push a payload to the wallboard.
   */
  async push(payload: unknown): Promise<PushResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (res.status === 401) {
        this.authFailed = true;
        console.error('[Pusher] API key rejected (401). Check your API key and regenerate if needed.');
        return { success: false, status: 401, error: 'Unauthorized — invalid API key' };
      }

      if (!res.ok) {
        this.consecutiveErrors++;
        const body = await res.text().catch(() => '');
        return { success: false, status: res.status, error: body || res.statusText };
      }

      this.consecutiveErrors = 0;
      return { success: true, status: res.status };
    } catch (err) {
      this.consecutiveErrors++;
      const message = err instanceof Error ? err.message : String(err);

      // Only log network errors periodically to avoid spam
      if (this.consecutiveErrors <= 3 || this.consecutiveErrors % 30 === 0) {
        console.error(`[Pusher] Push failed (${this.consecutiveErrors} consecutive): ${message}`);
      }

      return { success: false, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }
}
