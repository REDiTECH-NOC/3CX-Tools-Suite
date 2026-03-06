import WebSocket from "ws";
import { Client as SSHClient } from "ssh2";
import { log } from "./logger.js";
import { config } from "./config.js";

interface SshSession {
  ssh: SSHClient;
  sessionId: string;
}

const activeSshSessions = new Map<string, SshSession>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const RECONNECT_DELAY_MS = 5000;

/**
 * Start persistent outbound WebSocket connection to RCC terminal broker.
 * The relay agent connects OUT to RCC — no inbound ports needed.
 *
 * Protocol:
 *   RCC → Agent: { type: "open_ssh", sessionId, sshCreds: { localIp, sshUsername, sshPassword, instanceName } }
 *   RCC → Agent: { type: "session_data", sessionId, data: "<JSON string from browser>" }
 *   RCC → Agent: { type: "close_ssh", sessionId }
 *   RCC → Agent: { type: "ping" }
 *   Agent → RCC: { type: "ssh_connected", sessionId }
 *   Agent → RCC: { type: "ssh_error", sessionId, message }
 *   Agent → RCC: { type: "ssh_closed", sessionId }
 *   Agent → RCC: { type: "session_data", sessionId, data: "<JSON string for browser>" }
 *   Agent → RCC: { type: "pong" }
 */
export function startTerminalClient(): void {
  connect();
}

function connect(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return;
  }

  const wsUrl = config.apiBaseUrl
    .replace(/^http/, "ws")
    .replace(/\/$/, "");

  const url = `${wsUrl}/api/terminal/agent?apiKey=${encodeURIComponent(config.apiKey)}`;

  log.info(`Connecting to RCC terminal broker...`);

  ws = new WebSocket(url);

  ws.on("open", () => {
    log.info("Connected to RCC terminal broker");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "open_ssh" && msg.sessionId && msg.sshCreds) {
        openSshSession(msg.sessionId, msg.sshCreds);
      } else if (msg.type === "session_data" && msg.sessionId && msg.data) {
        handleSessionData(msg.sessionId, msg.data);
      } else if (msg.type === "close_ssh" && msg.sessionId) {
        closeSshSession(msg.sessionId, "rcc_requested");
      } else if (msg.type === "ping") {
        ws?.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // ignore malformed
    }
  });

  ws.on("close", () => {
    log.warn("Disconnected from RCC terminal broker, reconnecting...");
    ws = null;
    closeAllSessions("broker_disconnected");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    log.error(`Terminal broker WS error: ${err.message}`);
    // close event will fire after this, triggering reconnect
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function openSshSession(
  sessionId: string,
  creds: { localIp: string; sshUsername: string; sshPassword: string; instanceName: string }
): void {
  if (activeSshSessions.has(sessionId)) {
    log.warn(`Session ${sessionId} already exists, closing old one`);
    closeSshSession(sessionId, "replaced");
  }

  log.info(`Opening SSH to ${creds.instanceName} (${creds.localIp}) for session ${sessionId}`);

  const ssh = new SSHClient();

  ssh.on("ready", () => {
    log.info(`SSH connected to ${creds.localIp} for session ${sessionId}`);

    ssh.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (err, stream) => {
      if (err) {
        log.error(`SSH shell error for ${sessionId}: ${err.message}`);
        sendToRcc({ type: "ssh_error", sessionId, message: `Shell error: ${err.message}` });
        ssh.end();
        activeSshSessions.delete(sessionId);
        return;
      }

      activeSshSessions.set(sessionId, { ssh, sessionId });
      sendToRcc({ type: "ssh_connected", sessionId });

      // SSH output → RCC
      stream.on("data", (data: Buffer) => {
        sendToRcc({
          type: "session_data",
          sessionId,
          data: JSON.stringify({ type: "output", data: data.toString("utf-8") }),
        });
      });

      stream.stderr.on("data", (data: Buffer) => {
        sendToRcc({
          type: "session_data",
          sessionId,
          data: JSON.stringify({ type: "output", data: data.toString("utf-8") }),
        });
      });

      stream.on("close", () => {
        log.info(`SSH shell closed for session ${sessionId}`);
        sendToRcc({ type: "ssh_closed", sessionId });
        activeSshSessions.delete(sessionId);
      });

      // Store stream ref on the session for input handling
      (activeSshSessions.get(sessionId) as unknown as { stream: typeof stream }).stream = stream;
    });
  });

  ssh.on("error", (err) => {
    log.error(`SSH error for ${sessionId}: ${err.message}`);
    sendToRcc({ type: "ssh_error", sessionId, message: err.message });
    activeSshSessions.delete(sessionId);
  });

  ssh.connect({
    host: creds.localIp,
    username: creds.sshUsername,
    password: creds.sshPassword,
    readyTimeout: 10_000,
    algorithms: {
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
      ],
    },
  });

  // Temporary session entry while connecting (no stream yet)
  activeSshSessions.set(sessionId, { ssh, sessionId });
}

function handleSessionData(sessionId: string, rawData: string): void {
  const session = activeSshSessions.get(sessionId) as { ssh: SSHClient; stream?: import("ssh2").ClientChannel } | undefined;
  if (!session?.stream) return;

  try {
    const msg = JSON.parse(rawData);

    if (msg.type === "input" && typeof msg.data === "string") {
      session.stream.write(msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      session.stream.setWindow(msg.rows, msg.cols, 0, 0);
    }
  } catch {
    // ignore
  }
}

function closeSshSession(sessionId: string, reason: string): void {
  const session = activeSshSessions.get(sessionId);
  if (!session) return;

  activeSshSessions.delete(sessionId);
  log.info(`Closing SSH session ${sessionId} (${reason})`);

  try {
    session.ssh.end();
  } catch {
    // already closed
  }
}

function closeAllSessions(reason: string): void {
  for (const [sid] of activeSshSessions) {
    closeSshSession(sid, reason);
  }
}

function sendToRcc(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
