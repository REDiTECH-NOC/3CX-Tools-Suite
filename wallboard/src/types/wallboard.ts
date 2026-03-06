// Types for the wallboard state broadcast via SSE

export interface WallboardState {
  lastUpdated: string; // ISO timestamp
  pollIntervalMs: number;
  connectionStatus: 'connected' | 'error' | 'connecting';
  dataMode: 'polling' | 'realtime'; // polling vs relay
  queues: QueueWallboardData[];
  totals: WallboardTotals;
  avgWaitWindowMinutes: number; // configurable window for Avg Wait column
}

export interface WallboardTotals {
  totalCallsWaiting: number;
  totalAgentsAvailable: number;
  totalAgentsTalking: number;
  totalAgentsLoggedIn: number;
  totalAnsweredToday: number;
  totalAbandonedToday: number;
  overallAbandonRate: number;
  // Wait time metrics from 3CX Report API (QueuePerformanceOverview)
  longestWaitWindow: number;  // max longest wait across queues for configurable window
  longestWaitToday: number;   // max longest wait across queues for today
  avgWaitWindow: number;      // avg wait across queues for configurable window
  avgWaitToday: number;       // avg wait across queues for today
}

export interface QueueWallboardData {
  queueId: number;
  queueNumber: string;
  queueName: string;
  // Real-time from ActiveCalls cross-reference
  callsWaiting: number;
  longestWaitSec: number;
  // From Queues/Agents
  agentsLoggedIn: number;
  agentsTotal: number;
  agentsTalking: number;
  agentsAvailable: number;
  // From ReportQueuePerformanceOverview (today)
  callsAnswered: number;
  callsAbandoned: number;
  avgWaitSec: number;
  totalAvgWaitSec: number; // 24h average
  abandonRate: number;
  // Agent details for expandable rows + context menu
  agents: QueueAgentStatus[];
  // Manager extension numbers (for checking if current user is a manager)
  managerExtensions: string[];
}

export interface QueueAgentStatus {
  extensionNumber: string;
  displayName: string;
  queueStatus: 'LoggedIn' | 'LoggedOut';
  callState: 'available' | 'talking' | 'ringing' | 'offline';
  profileName: string; // "Available", "DND", "Away", etc.
  isRegistered: boolean; // has an active phone/client connected
  isManager: boolean;
}

// Column definitions for the wallboard grid
export type WallboardColumn =
  | 'queueName'
  | 'currentWait'
  | 'avgWait'
  | 'totalAvgWait'
  | 'agentsAvailable'
  | 'agentsTalking'
  | 'agentsLoggedIn'
  | 'callsQueued'
  | 'callsAnswered'
  | 'callsAbandoned'
  | 'abandonRate';

export interface ColumnDefinition {
  key: WallboardColumn;
  label: string;
  shortLabel: string;
  thresholdMetric?: string; // metric key for threshold lookup
  format: 'number' | 'time' | 'percent' | 'text';
  invertThreshold?: boolean; // true for agentsAvailable (lower = worse)
  defaultVisible: boolean;
}

export const COLUMN_DEFINITIONS: ColumnDefinition[] = [
  { key: 'queueName', label: 'Queue Name', shortLabel: 'Queue', format: 'text', defaultVisible: true },
  { key: 'currentWait', label: 'Current Wait', shortLabel: 'Wait', thresholdMetric: 'currentWait', format: 'time', defaultVisible: true },
  { key: 'avgWait', label: 'Avg Wait (Window)', shortLabel: 'Avg Wait', thresholdMetric: 'avgWait', format: 'time', defaultVisible: true },
  { key: 'totalAvgWait', label: 'Total Avg Wait (24h)', shortLabel: '24h Avg', thresholdMetric: 'totalAvgWait', format: 'time', defaultVisible: true },
  { key: 'agentsAvailable', label: 'Agents Available', shortLabel: 'Avail', thresholdMetric: 'agentsAvailable', format: 'number', invertThreshold: true, defaultVisible: true },
  { key: 'agentsTalking', label: 'Agents Talking', shortLabel: 'Talking', format: 'number', defaultVisible: true },
  { key: 'agentsLoggedIn', label: 'Agents Logged In', shortLabel: 'Logged In', format: 'number', defaultVisible: true },
  { key: 'callsQueued', label: 'Calls Queued', shortLabel: 'Queued', thresholdMetric: 'callsQueued', format: 'number', defaultVisible: true },
  { key: 'callsAnswered', label: 'Calls Answered', shortLabel: 'Answered', format: 'number', defaultVisible: true },
  { key: 'callsAbandoned', label: 'Abandoned Calls', shortLabel: 'Abandoned', thresholdMetric: 'callsAbandoned', format: 'number', defaultVisible: true },
  { key: 'abandonRate', label: 'Abandon Rate', shortLabel: 'Rate', thresholdMetric: 'abandonRate', format: 'percent', defaultVisible: true },
];

// Threshold types
export interface ThresholdConfig {
  metric: string;
  yellowValue: number;
  redValue: number;
  invertLogic: boolean;
}

export type ThresholdLevel = 'green' | 'yellow' | 'red';

// Default global thresholds seeded on setup
export const DEFAULT_THRESHOLDS: Omit<ThresholdConfig, 'invertLogic'>[] = [
  { metric: 'currentWait', yellowValue: 30, redValue: 90 },
  { metric: 'avgWait', yellowValue: 20, redValue: 60 },
  { metric: 'totalAvgWait', yellowValue: 30, redValue: 90 },
  { metric: 'callsQueued', yellowValue: 3, redValue: 8 },
  { metric: 'callsAbandoned', yellowValue: 5, redValue: 15 },
  { metric: 'abandonRate', yellowValue: 5, redValue: 15 },
  { metric: 'agentsAvailable', yellowValue: 3, redValue: 1 },
];
