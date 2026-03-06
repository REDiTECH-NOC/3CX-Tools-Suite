"use strict";
/**
 * Lightweight 3CX API collector for the relay agent.
 * Connects to the local PBX and fetches queue/call/user data.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Collector = void 0;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS = 45_000;
class Collector {
    baseUrl;
    extension;
    password;
    cachedToken = null;
    constructor(pbxUrl, extension, password) {
        const cleaned = pbxUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        this.baseUrl = `https://${cleaned}`;
        this.extension = extension;
        this.password = password;
    }
    async authenticate() {
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
            if (!res.ok)
                throw new Error(`Auth HTTP ${res.status}: ${res.statusText}`);
            const data = await res.json();
            if (data.Status !== 'AuthSuccess' || !data.Token) {
                throw new Error(`Auth failed: ${data.Status}`);
            }
            this.cachedToken = {
                accessToken: data.Token.access_token,
                obtainedAt: Date.now(),
            };
            return this.cachedToken.accessToken;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async request(path) {
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
                if (!retryRes.ok)
                    throw new Error(`HTTP ${retryRes.status}: ${retryRes.statusText}`);
                const retryData = await retryRes.json();
                return retryData.value ?? retryData;
            }
            if (!res.ok)
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            const data = await res.json();
            return data.value ?? data;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async getQueues() {
        return this.request('/xapi/v1/Queues?$select=Id,Number,Name');
    }
    async getActiveCalls() {
        return this.request('/xapi/v1/ActiveCalls');
    }
    async getUsers() {
        return this.request('/xapi/v1/Users?$select=Number,FirstName,LastName,IsRegistered,QueueStatus,CurrentProfileName');
    }
    async getQueueAgents(queueId) {
        return this.request(`/xapi/v1/Queues(${queueId})/Agents`);
    }
    async getQueueDetailedStats(startDt, endDt) {
        return this.request(`/xapi/v1/ReportDetailedQueueStatistics/Pbx.GetDetailedQueueStatisticsData` +
            `(queueDnStr='',startDt=${encodeURIComponent(startDt)},` +
            `endDt=${encodeURIComponent(endDt)},` +
            `waitInterval='0%3A00%3A0')`);
    }
}
exports.Collector = Collector;
