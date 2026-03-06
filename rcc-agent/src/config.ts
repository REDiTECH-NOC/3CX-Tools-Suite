import { config as dotenvConfig } from "dotenv";
dotenvConfig();

export const config = {
  apiBaseUrl: process.env.RCC_API_URL!,
  apiKey: process.env.RCC_AGENT_API_KEY!,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  agentVersion: "1.0.0",
};

// Validate required env vars on startup
if (!config.apiBaseUrl) {
  console.error("[FATAL] RCC_API_URL is required in .env");
  process.exit(1);
}
if (!config.apiKey) {
  console.error("[FATAL] RCC_AGENT_API_KEY is required in .env");
  process.exit(1);
}

// Strip trailing slash
config.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
