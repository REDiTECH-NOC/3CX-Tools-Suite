import { config } from "./config.js";
import { pollForTask, reportResult, sendHeartbeat } from "./api-client.js";
import { deploySsoFiles, removeSsoFiles, deploy3cxTools, remove3cxTools } from "./ssh-deployer.js";
import { log } from "./logger.js";
import type { AgentTask } from "./api-client.js";

let busy = false;

async function processTask(task: AgentTask): Promise<void> {
  log.info(`Processing task ${task.id} (type: ${task.type})`);

  try {
    if (task.type === "deploy_sso") {
      await deploySsoFiles(task.payload);
      await reportResult(task.id, { success: true });
      log.info(`Task ${task.id} completed successfully`);
    } else if (task.type === "remove_sso") {
      await removeSsoFiles(task.payload);
      await reportResult(task.id, { success: true });
      log.info(`Task ${task.id} completed successfully`);
    } else if (task.type === "deploy_3cx_tools") {
      await deploy3cxTools(task.payload);
      await reportResult(task.id, { success: true });
      log.info(`Task ${task.id} completed successfully`);
    } else if (task.type === "remove_3cx_tools") {
      await remove3cxTools(task.payload);
      await reportResult(task.id, { success: true });
      log.info(`Task ${task.id} completed successfully`);
    } else {
      log.warn(`Unknown task type: ${task.type}`);
      await reportResult(task.id, {
        success: false,
        error: `Unknown task type: ${task.type}`,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Task ${task.id} failed: ${message}`);
    await reportResult(task.id, {
      success: false,
      error: message,
    }).catch((reportErr) => {
      log.error(`Failed to report task failure: ${reportErr}`);
    });
  }
}

async function poll(): Promise<void> {
  if (busy) return; // Skip if still processing a task

  try {
    const task = await pollForTask();
    if (task) {
      busy = true;
      try {
        await processTask(task);
      } finally {
        busy = false;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Poll error: ${message}`);
  }
}

async function main(): Promise<void> {
  log.info("═══════════════════════════════════════════════");
  log.info(`REDiTECH Relay Agent v${config.agentVersion}`);
  log.info(`API: ${config.apiBaseUrl}`);
  log.info(`Poll interval: ${config.pollIntervalMs}ms`);
  log.info("═══════════════════════════════════════════════");

  // Verify connectivity with initial heartbeat
  try {
    await sendHeartbeat();
    log.info("Connected to Command Center");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Initial heartbeat failed: ${message}`);
    log.error("Check RCC_API_URL and RCC_AGENT_API_KEY in your .env file");
    process.exit(1);
  }

  // Start polling loop
  setInterval(poll, config.pollIntervalMs);
  log.info("Polling for tasks...");
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
