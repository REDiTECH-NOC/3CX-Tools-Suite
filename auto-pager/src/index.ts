/**
 * 3CX Auto-Pager — main entry point.
 * Wires together: Express server, 3CX client, queue monitor, Asterisk pager.
 */

import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG } from './config';
import { getDb, getSetting } from './db';
import { ThreecxClient } from './threecx-client';
import { QueueMonitor, PageEvent } from './queue-monitor';
import { Pager } from './pager';
import { createApiRouter } from './api';
import {
  getSipSettings,
  writePjsipConfig,
  reloadAsterisk,
} from './asterisk-config';

// ── State ──
let threecxClient: ThreecxClient | null = null;
let queueMonitor: QueueMonitor | null = null;
let pager: Pager | null = null;

async function startServices(): Promise<void> {
  // Read 3CX connection settings
  const pbxUrl = getSetting('pbx_url');
  const pbxExtension = getSetting('pbx_extension');
  const pbxPassword = getSetting('pbx_password');

  if (!pbxUrl || !pbxExtension || !pbxPassword) {
    console.log('[Main] 3CX not configured — waiting for settings via web UI');
    return;
  }

  // Create 3CX API client
  threecxClient = new ThreecxClient(pbxUrl, pbxExtension, pbxPassword);
  console.log(`[Main] 3CX client created for ${pbxUrl}`);

  // Test connection
  const test = await threecxClient.testConnection();
  if (!test.success) {
    console.error(`[Main] 3CX connection failed: ${test.error}`);
    threecxClient = null;
    return;
  }
  console.log('[Main] 3CX connection verified');

  // Start queue monitor
  queueMonitor = new QueueMonitor(threecxClient);
  queueMonitor.start();

  // Configure and start Asterisk (if SIP settings provided)
  const sipSettings = getSipSettings();
  if (sipSettings) {
    await writePjsipConfig(sipSettings);
    await reloadAsterisk();

    // Create pager (AMI Originate — direct SIP call via Asterisk)
    pager = new Pager();
    await pager.connect();

    // Wire monitor → pager
    queueMonitor.on('page', (event: PageEvent) => {
      if (pager) {
        pager.executePage(event).catch((err) =>
          console.error('[Main] Page execution error:', err),
        );
      }
    });
  } else {
    console.log('[Main] SIP not configured — paging disabled (monitor-only mode)');

    // Still wire the event for logging
    queueMonitor.on('page', (event: PageEvent) => {
      console.log(
        `[Main] Page would be triggered for queue ${event.queueName} ` +
        `(${event.queueNumber}) — ${event.callsWaiting} calls, longest ${event.longestWaitSeconds}s — ` +
        `but SIP/paging not configured`,
      );
    });
  }
}

async function stopServices(): Promise<void> {
  if (queueMonitor) {
    queueMonitor.stop();
    queueMonitor.removeAllListeners();
    queueMonitor = null;
  }
  if (pager) {
    pager.disconnect();
    pager = null;
  }
  threecxClient = null;
}

async function restartServices(): Promise<void> {
  console.log('[Main] Restarting services...');
  await stopServices();
  await startServices();
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════');
  console.log('   3CX Auto-Pager v1.0.0');
  console.log('═══════════════════════════════════════');

  // Ensure data directories exist
  fs.mkdirSync(CONFIG.audioDir, { recursive: true });
  fs.mkdirSync(path.dirname(CONFIG.dbPath), { recursive: true });

  // Initialize database
  getDb();
  console.log(`[Main] Database initialized at ${CONFIG.dbPath}`);

  // Set up Express server
  const app = express();
  app.use(express.json());

  // Serve static web UI
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // API routes
  const apiRouter = createApiRouter({
    get threecxClient() { return threecxClient; },
    get queueMonitor() { return queueMonitor; },
    get pager() { return pager; },
    restartServices,
  });
  app.use('/api', apiRouter);

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Start HTTP server
  app.listen(CONFIG.port, () => {
    console.log(`[Main] Web UI listening on http://0.0.0.0:${CONFIG.port}`);
  });

  // Start background services
  await startServices();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[Main] SIGTERM received, shutting down...');
    await stopServices();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[Main] SIGINT received, shutting down...');
    await stopServices();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
