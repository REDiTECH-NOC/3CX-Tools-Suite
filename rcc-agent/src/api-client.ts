import { config } from "./config.js";
import { log } from "./logger.js";

const headers = {
  Authorization: `Bearer ${config.apiKey}`,
  "Content-Type": "application/json",
};

export interface TaskPayload {
  localIp: string;
  sshUsername: string;
  sshPassword: string;
  targetPath?: string;
  files?: Array<{ name: string; content: string }>;
  fileNames?: string[];
  instanceName?: string;
  fqdn?: string;
  // 3CX Tools Suite deployment
  taskType?: string;
  pbxExtension?: string;
  pbxPassword?: string;
  wallboardUrl?: string;
  wallboardApiKey?: string;
  autoPagerUrl?: string;
  autoPagerApiKey?: string;
}

export interface AgentTask {
  id: string;
  type: string;
  targetInstanceId: string;
  payload: TaskPayload;
}

export async function pollForTask(): Promise<AgentTask | null> {
  const res = await fetch(`${config.apiBaseUrl}/api/agent/tasks`, {
    headers,
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Poll failed: ${res.status} ${res.statusText} ${text}`);
  }

  const data = await res.json();
  return data.task ?? null;
}

export async function reportResult(
  taskId: string,
  result: { success: boolean; error?: string; details?: unknown }
): Promise<void> {
  const res = await fetch(
    `${config.apiBaseUrl}/api/agent/tasks/${taskId}/result`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(result),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Report failed: ${res.status} ${text}`);
  }
}

export async function sendHeartbeat(): Promise<void> {
  const res = await fetch(`${config.apiBaseUrl}/api/agent/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version: config.agentVersion }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Heartbeat failed: ${res.status} ${text}`);
  }
}
