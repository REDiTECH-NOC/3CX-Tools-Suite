/**
 * Express REST API for the Auto-Pager web UI.
 * All routes prefixed with /api.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG } from './config';
import {
  getAllSettings,
  getSetting,
  setSetting,
  getWavFiles,
  addWavFile,
  deleteWavFile,
  getMonitoredQueues,
  upsertMonitoredQueue,
  updateMonitoredQueue,
  deleteMonitoredQueue,
  getPageLog,
  WavFile,
} from './db';
import { ThreecxClient } from './threecx-client';
import { convertUploadedWav } from './pager';
import {
  getSipSettings,
  writePjsipConfig,
  reloadAsterisk,
  isAsteriskRunning,
  getRegistrationStatus,
} from './asterisk-config';
import { QueueMonitor } from './queue-monitor';
import { Pager } from './pager';
import {
  validateRelayKey,
  setRelayKeyHash,
  setRelayData,
  getRelayStatus,
  type RelayPushPayload,
} from './relay-receiver';

// Multer storage — save with UUID filenames to /data/audio
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(CONFIG.audioDir, { recursive: true });
    cb(null, CONFIG.audioDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = randomId();
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.wav', '.mp3', '.ogg', '.gsm'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files (.wav, .mp3, .ogg, .gsm) are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

function randomId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createApiRouter(deps: {
  threecxClient: ThreecxClient | null;
  queueMonitor: QueueMonitor | null;
  pager: Pager | null;
  restartServices: () => Promise<void>;
}): Router {
  const router = Router();

  // ── Settings ──

  router.get('/settings', (_req: Request, res: Response) => {
    const settings = getAllSettings();
    res.json(settings);
  });

  router.put('/settings', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      setSetting(key, value);
    }

    // If SIP settings changed, regenerate Asterisk config
    if (body.pbx_url || body.sip_extension || body.sip_auth_id || body.sip_password || body.sip_port || body.sip_transport) {
      const sipSettings = getSipSettings();
      if (sipSettings) {
        try {
          await writePjsipConfig(sipSettings);
          await reloadAsterisk();
        } catch (err) {
          console.error('[API] Failed to update Asterisk config:', err);
        }
      }
    }

    // Restart services if connection settings changed
    if (body.pbx_url || body.pbx_extension || body.pbx_password) {
      try {
        await deps.restartServices();
      } catch (err) {
        console.error('[API] Failed to restart services:', err);
      }
    }

    res.json({ ok: true });
  });

  // ── 3CX Connection Test ──

  router.post('/test-connection', async (req: Request, res: Response) => {
    const { pbx_url, pbx_extension, pbx_password } = req.body as Record<string, string>;

    if (!pbx_url || !pbx_extension || !pbx_password) {
      res.status(400).json({ success: false, error: 'Missing connection details' });
      return;
    }

    const testClient = new ThreecxClient(pbx_url, pbx_extension, pbx_password);
    const result = await testClient.testConnection();
    res.json(result);
  });

  // ── Queues from 3CX ──

  router.get('/pbx-queues', async (_req: Request, res: Response) => {
    if (!deps.threecxClient) {
      res.status(503).json({ error: 'Not connected to 3CX' });
      return;
    }

    try {
      const [queues, ringGroups] = await Promise.all([
        deps.threecxClient.getQueues(),
        deps.threecxClient.getRingGroups(),
      ]);
      res.json({ queues, ringGroups });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Monitored Queues ──

  router.get('/monitored-queues', (_req: Request, res: Response) => {
    const queues = getMonitoredQueues();
    // Join with WAV file info
    const wavFiles = getWavFiles();
    const wavMap = new Map<number, WavFile>();
    for (const w of wavFiles) wavMap.set(w.id, w);

    const enriched = queues.map((q) => ({
      ...q,
      wav_file: q.wav_file_id ? wavMap.get(q.wav_file_id) || null : null,
    }));
    res.json(enriched);
  });

  router.post('/monitored-queues', (req: Request, res: Response) => {
    const body = req.body;
    if (!body.queue_number || !body.queue_name) {
      res.status(400).json({ error: 'queue_number and queue_name required' });
      return;
    }
    upsertMonitoredQueue(body);
    res.json({ ok: true });
  });

  router.patch('/monitored-queues/:queueNumber', (req: Request, res: Response) => {
    const queueNumber = req.params.queueNumber as string;
    updateMonitoredQueue(queueNumber, req.body);
    res.json({ ok: true });
  });

  router.delete('/monitored-queues/:queueNumber', (req: Request, res: Response) => {
    const queueNumber = req.params.queueNumber as string;
    deleteMonitoredQueue(queueNumber);
    res.json({ ok: true });
  });

  // ── WAV Files ──

  router.get('/wav-files', (_req: Request, res: Response) => {
    res.json(getWavFiles());
  });

  router.post('/wav-files', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const duration = await convertUploadedWav(req.file.path);
    const wavFile = addWavFile(req.file.filename, req.file.originalname, duration);
    res.json(wavFile);
  });

  router.delete('/wav-files/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    // Also delete the actual file
    const files = getWavFiles();
    const file = files.find((f) => f.id === id);
    if (file) {
      const filePath = path.join(CONFIG.audioDir, file.filename);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore if already deleted
      }
      // Also remove the converted version
      const convertedPath = filePath.replace(/\.[^.]+$/, '.sln16');
      try {
        fs.unlinkSync(convertedPath);
      } catch {
        // ignore
      }
    }

    deleteWavFile(id);
    res.json({ ok: true });
  });

  // ── Page Log ──

  router.get('/page-log', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string, 10) || 100;
    res.json(getPageLog(limit));
  });

  // ── Status ──

  router.get('/status', async (_req: Request, res: Response) => {
    const asteriskRunning = await isAsteriskRunning();
    const sipRegistration = asteriskRunning ? await getRegistrationStatus() : 'Asterisk not running';

    res.json({
      monitorRunning: deps.queueMonitor?.isRunning() || false,
      asteriskRunning,
      sipRegistration,
      amiConnected: deps.pager?.isConnected() || false,
      trackedCalls: deps.queueMonitor?.getStatus().trackedCalls || [],
      relay: getRelayStatus(),
      settings: {
        pbxUrl: getSetting('pbx_url') || '',
        pbxExtension: getSetting('pbx_extension') || '',
        sipExtension: getSetting('sip_extension') || '',
        configured: !!(getSetting('pbx_url') && getSetting('pbx_extension') && getSetting('pbx_password')),
      },
    });
  });

  // ── Manual Page Test ──

  router.post('/test-page', async (req: Request, res: Response) => {
    if (!deps.pager) {
      res.status(503).json({ error: 'Pager not initialized — check SIP settings' });
      return;
    }

    const { wav_file_id, paging_extension, play_count, queue_number } = req.body as {
      wav_file_id?: number;
      paging_extension?: string;
      play_count?: number;
      queue_number?: string;
    };

    // If queue_number provided, look up its settings
    let targetExtension = paging_extension;
    let targetWavFileId = wav_file_id;
    let targetPlayCount = play_count;
    let queueName = 'Manual Test';

    if (queue_number && queue_number !== 'TEST') {
      const queues = getMonitoredQueues();
      const queue = queues.find(q => q.queue_number === queue_number);
      if (queue) {
        targetExtension = targetExtension || queue.paging_extension || undefined;
        targetWavFileId = targetWavFileId ?? queue.wav_file_id ?? undefined;
        targetPlayCount = targetPlayCount ?? queue.play_count ?? 1;
        queueName = queue.queue_name || queue_number;
      }
    }

    if (!targetExtension) {
      res.status(400).json({ error: 'paging_extension required (set on queue or in request body)' });
      return;
    }

    let wavFile: WavFile | null = null;
    if (targetWavFileId) {
      const files = getWavFiles();
      wavFile = files.find((f) => f.id === targetWavFileId) || null;
    }

    await deps.pager.executePage({
      queueNumber: queue_number || 'TEST',
      queueName,
      callsWaiting: 0,
      longestWaitSeconds: 0,
      wavFile,
      pagingExtension: targetExtension,
      playCount: targetPlayCount || 1,
    });

    res.json({ ok: true });
  });

  // ── Relay Agent ──

  /**
   * POST /api/relay/push — accepts real-time data from the relay agent.
   * Same contract as the wallboard's /api/relay/push endpoint.
   */
  router.post('/relay/push', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    const apiKey = authHeader.substring(7);

    if (!validateRelayKey(apiKey)) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    const payload = req.body as RelayPushPayload;
    if (payload.version !== 1 || !Array.isArray(payload.queues) || typeof payload.ts !== 'number') {
      res.status(400).json({ error: 'Invalid payload format' });
      return;
    }

    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || (req.headers['x-real-ip'] as string)
      || req.socket.remoteAddress
      || 'unknown';

    setRelayData(payload, clientIp);
    res.json({ ok: true, queuesReceived: payload.queues.length });
  });

  /** GET /api/relay/status — relay agent connection status */
  router.get('/relay/status', (_req: Request, res: Response) => {
    res.json(getRelayStatus());
  });

  /** PUT /api/relay/config — enable/disable relay and set API key */
  router.put('/relay/config', (req: Request, res: Response) => {
    const { enabled, apiKey } = req.body as { enabled?: boolean; apiKey?: string };

    if (enabled !== undefined) {
      setSetting('relay_enabled', enabled ? 'true' : 'false');
    }

    if (apiKey) {
      setRelayKeyHash(apiKey);
    }

    res.json({
      ok: true,
      relay: getRelayStatus(),
    });
  });

  return router;
}
