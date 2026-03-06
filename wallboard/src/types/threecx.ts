// All types for 3CX XAPI v1 responses used by the wallboard

export interface ThreecxLoginResponse {
  Status: string; // "AuthSuccess" | "AuthFailed" | etc.
  Token?: {
    token_type: string;
    expires_in: number;
    access_token: string;
    refresh_token: string;
  };
}

export interface ThreecxQueue {
  Id: number;
  Number: string;
  Name: string;
  PollingStrategy: string;
  RingTimeout: number;
  MaxCallersInQueue: number;
  MaxCallerWaitTime: number;
  MasterTimeout: number;
  WrapUpTime: number;
  SLATime: number;
}

export interface ThreecxQueueAgent {
  Number: string;
  Name?: string;
  SkillGroup?: string;
  Id?: number;
  // Note: QueueStatus is on the User entity, not QueueAgent
}

export interface ThreecxQueueManager {
  Number: string;
}

export interface ThreecxActiveCall {
  Id: number;
  Caller: string;
  Callee: string;
  Status: string;
  LastChangeStatus: string;
  EstablishedAt?: string;
  ServerNow?: string;
  Segments?: Array<{
    CallerNumber?: string;
    CalleeNumber?: string;
    Dn?: string;
    DialedDn?: string;
    Status?: string;
  }>;
}

export interface ThreecxUser {
  Id: number;
  Number: string;
  FirstName: string;
  LastName: string;
  EmailAddress: string;
  IsRegistered: boolean;
  CurrentProfileName: string;
  QueueStatus?: string;
  Enabled: boolean;
}

export interface ThreecxQueuePerformance {
  QueueDn: string;
  QueueName: string;
  Answered: number;
  Abandoned: number;
  AverageWaitingTimeSec: number;
  AverageTalkTimeSec: number;
  TotalCallsHandled: number;
  LongestWaitingTimeSec: number;
}

/** DetailedQueueStatistics from the 3CX Report API — authoritative day totals. */
export interface ThreecxQueueDetailedStats {
  QueueDnNumber: string;       // e.g. "8003"
  QueueDn: string;             // e.g. "8003 - Queue 1"
  CallsCount: number;          // Total calls received (offered)
  AnsweredCount: number;       // Calls answered
  RingTime: string;            // ISO 8601 duration e.g. "PT8M42S" (total wait/ring time)
  AvgRingTime: string;         // ISO 8601 duration e.g. "PT30.7S" (avg wait time)
  TalkTime: string;            // ISO 8601 duration e.g. "PT20S"
  AvgTalkTime: string;         // ISO 8601 duration
  CallbacksCount: number;
}

/** Abandoned queue call record from ReportAbandonedQueueCalls API. */
export interface ThreecxAbandonedQueueCall {
  QueueDn: string;          // e.g. "8003 - Queue 1" or "8003"
  CallTime: string;         // ISO datetime
  WaitTime: string;         // Wait duration — could be ISO 8601 ("PT1M22S") or "HH:MM:SS"
  CallerId: string;
  PollingAttempts: number;
}

export interface ThreecxODataResponse<T> {
  value: T[];
}
