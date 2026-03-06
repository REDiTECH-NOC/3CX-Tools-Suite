// Types for the PBX relay agent push protocol

/** Top-level payload sent by the relay agent via HTTP POST */
export interface RelayPushPayload {
  version: 1;
  ts: number; // unix ms timestamp from relay agent
  queues: RelayQueueData[];
  /** Report API stats collected locally by the relay agent. Absent if not yet fetched. */
  reportStats?: {
    windowedStats: RelayReportStats[];
    fullDayStats: RelayReportStats[];
    windowMinutes: number;
    pbxTimezone: string;
  };
}

/** Report API queue stats collected by the relay agent from the local PBX. */
export interface RelayReportStats {
  queueNumber: string;
  callsCount: number;
  answeredCount: number;
  avgRingTime: string;   // ISO 8601 duration e.g. "PT30.7S"
  avgTalkTime: string;   // ISO 8601 duration
  ringTime: string;      // ISO 8601 total ring time
  talkTime: string;      // ISO 8601 total talk time
}

/** Per-queue real-time data from the relay agent */
export interface RelayQueueData {
  id: number; // 3CX queue internal ID
  number: string; // queue extension number, e.g. "8003"
  name: string; // queue display name
  callsWaiting: number;
  longestWaitSec: number; // computed from ActiveCalls with ~2s precision
  agents: RelayAgentData[];
  queuedCalls: RelayQueuedCall[];
}

/** Per-agent status from the relay agent */
export interface RelayAgentData {
  ext: string; // extension number
  name: string; // display name
  loggedIn: boolean; // per-queue login status (from WebSocket monitor)
  callState: 'available' | 'talking' | 'ringing' | 'offline';
  profileName: string; // "Available", "DND", "Away", etc.
  isRegistered: boolean; // has active phone/client
}

/** Individual queued call from the relay agent */
export interface RelayQueuedCall {
  id: number; // 3CX call ID
  caller: string; // caller number
  callerName: string; // caller display name
  waitSec: number; // current wait time in seconds
  startedAt: string; // ISO timestamp when call entered queue
}
