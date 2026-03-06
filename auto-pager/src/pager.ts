/**
 * Pager — initiates pages via Asterisk AMI Originate (direct SIP call).
 *
 * Flow:
 * 1. Prepares audio file → generates /data/audio/_current_page.sln16
 *    (with play_count repetitions and silence gaps if configured)
 * 2. AMI Originate: Asterisk calls target via PJSIP trunk to 3CX
 *    - For paging adapters/speakers: auto-answer natively
 *    - For phones: auto-answer via SIP headers or 3CX paging groups
 * 3. 3CX routes call to target extension → device answers
 * 4. Asterisk plays audio via Playback application on the channel
 * 5. Playback completes → Asterisk sends BYE → phone disconnects
 *
 * Direct call from Asterisk — no transfer, no MakeCall middleman.
 */

import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG } from './config';
import { addPageLog, updateLastPaged, getSetting } from './db';
import { PageEvent } from './queue-monitor';

const execFileAsync = promisify(execFile);

/**
 * Path to the "current page" audio file (WITHOUT extension).
 * Asterisk Playback auto-appends the format extension (.sln16).
 */
const CURRENT_PAGE_PATH = '/data/audio/_current_page';
const CURRENT_PAGE_SLN16 = CURRENT_PAGE_PATH + '.sln16';

/** Bytes per second for sln16 (16kHz, 16-bit, mono) */
const SLN16_BYTES_PER_SEC = 16000 * 2;

// asterisk-manager types
interface AmiConnection extends EventEmitter {
  connect(): void;
  disconnect(): void;
  login(cb?: (err: Error | null) => void): void;
  action(
    action: Record<string, string>,
    cb: (err: Error | null, res: Record<string, string>) => void,
  ): void;
  connected: boolean;
}

export class Pager {
  private ami: AmiConnection | null = null;
  private amiConnected = false;
  private amiConnecting = false;

  /** Connect to Asterisk AMI. */
  async connect(): Promise<void> {
    if (this.amiConnected || this.amiConnecting) return;
    this.amiConnecting = true;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AsteriskManager = require('asterisk-manager');
      this.ami = new AsteriskManager(
        CONFIG.ami.port,
        CONFIG.ami.host,
        CONFIG.ami.username,
        CONFIG.ami.password,
        true, // Events on
      ) as AmiConnection;

      this.ami.on('connect', () => {
        console.log('[Pager] Connected to Asterisk AMI');
        this.amiConnected = true;
        this.amiConnecting = false;
      });

      this.ami.on('error', (err: Error) => {
        console.error('[Pager] AMI error:', err.message);
        this.amiConnected = false;
      });

      this.ami.on('close', () => {
        console.log('[Pager] AMI connection closed');
        this.amiConnected = false;
      });

      // asterisk-manager auto-connects in constructor
    } catch (err) {
      this.amiConnecting = false;
      console.error('[Pager] Failed to connect to AMI:', err);
    }
  }

  /** Disconnect from AMI. */
  disconnect(): void {
    if (this.ami) {
      try {
        this.ami.disconnect();
      } catch {
        // ignore
      }
      this.ami = null;
      this.amiConnected = false;
    }
  }

  /** Whether AMI is connected (for status display). */
  isConnected(): boolean {
    return this.amiConnected;
  }

  /**
   * Execute a paging event — prepare audio and AMI Originate.
   */
  async executePage(event: PageEvent): Promise<void> {
    const {
      queueNumber, queueName, callsWaiting, longestWaitSeconds,
      wavFile, pagingExtension, playCount,
    } = event;

    if (!this.amiConnected || !this.ami) {
      console.error('[Pager] AMI not connected — cannot page');
      addPageLog({
        queue_number: queueNumber,
        queue_name: queueName,
        calls_waiting: callsWaiting,
        longest_wait_seconds: longestWaitSeconds,
        wav_file: wavFile?.original_name,
        paging_extension: pagingExtension,
        result: 'FAILED: AMI not connected',
      });
      return;
    }

    // Prepend paging dial code if configured (e.g. *72 for intercom)
    const pagingDialCode = getSetting('paging_dial_code') || '';
    const dialTarget = pagingDialCode + pagingExtension;

    console.log(
      `[Pager] Executing page — queue ${queueName} (${queueNumber}), ` +
      `${callsWaiting} calls waiting, longest ${longestWaitSeconds}s, ` +
      `dialing ${dialTarget}, wav: ${wavFile?.original_name || 'default beep'}, ` +
      `play count: ${playCount}`,
    );

    // Update last_paged_at immediately
    updateLastPaged(queueNumber);

    // Step 1: Prepare audio (with play_count repetitions)
    try {
      await this.preparePageAudio(wavFile, playCount);
    } catch (err) {
      console.error('[Pager] Audio preparation failed:', err);
      addPageLog({
        queue_number: queueNumber,
        queue_name: queueName,
        calls_waiting: callsWaiting,
        longest_wait_seconds: longestWaitSeconds,
        wav_file: wavFile?.original_name,
        paging_extension: dialTarget,
        result: `FAILED: Audio preparation error — ${err}`,
      });
      return;
    }

    // Step 2: AMI Originate — direct call via PJSIP trunk to 3CX
    try {
      await this.originate(dialTarget, queueName);

      console.log(`[Pager] Originate sent — dialing ${dialTarget}`);
      addPageLog({
        queue_number: queueNumber,
        queue_name: queueName,
        calls_waiting: callsWaiting,
        longest_wait_seconds: longestWaitSeconds,
        wav_file: wavFile?.original_name,
        paging_extension: dialTarget,
        result: 'SUCCESS',
      });
    } catch (err) {
      console.error('[Pager] Originate failed:', err);
      addPageLog({
        queue_number: queueNumber,
        queue_name: queueName,
        calls_waiting: callsWaiting,
        longest_wait_seconds: longestWaitSeconds,
        wav_file: wavFile?.original_name,
        paging_extension: dialTarget,
        result: `FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * AMI Originate — call target via PJSIP trunk, play audio, auto-hangup.
   * Direct call: Asterisk → 3CX → target device. No transfer.
   * When Playback finishes, Asterisk sends BYE and device disconnects.
   */
  private originate(dialTarget: string, callerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ami) {
        reject(new Error('AMI not connected'));
        return;
      }

      console.log(`[Pager] AMI Originate: Channel=PJSIP/${dialTarget}@3cx-endpoint, Application=Playback`);

      this.ami.action(
        {
          Action: 'Originate',
          Channel: `PJSIP/${dialTarget}@3cx-endpoint`,
          Application: 'Playback',
          Data: CURRENT_PAGE_PATH, // without extension — Asterisk auto-appends .sln16
          Timeout: '30000',
          Async: 'true',
        },
        (err, res) => {
          if (err) {
            reject(err);
          } else if (res?.Response === 'Error') {
            reject(new Error(res.Message || 'Originate failed'));
          } else {
            resolve();
          }
        },
      );
    });
  }

  /**
   * Prepare audio file — convert to sln16 and repeat playCount times.
   */
  private async preparePageAudio(
    wavFile: import('./db').WavFile | null,
    playCount: number = 1,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(CURRENT_PAGE_SLN16), { recursive: true });

    let singlePlayBuffer: Buffer;

    if (wavFile) {
      const srcPath = path.join(CONFIG.audioDir, wavFile.filename);
      const sln16Path = srcPath.replace(/\.[^.]+$/, '.sln16');

      if (!fs.existsSync(sln16Path)) {
        await this.convertForAsterisk(srcPath, sln16Path);
      }

      singlePlayBuffer = fs.readFileSync(sln16Path);
      console.log(`[Pager] Audio source: ${wavFile.original_name} (${singlePlayBuffer.length} bytes)`);
    } else {
      const tmpBeep = '/tmp/_autopager_beep.sln16';
      await execFileAsync('sox', [
        '-n', '-r', '16000', '-c', '1', '-b', '16',
        '-e', 'signed-integer', '-t', 'raw',
        tmpBeep,
        'synth', '0.5', 'sine', '1000',
      ]);
      singlePlayBuffer = fs.readFileSync(tmpBeep);
      try { fs.unlinkSync(tmpBeep); } catch { /* ignore */ }
      console.log('[Pager] Audio source: generated beep');
    }

    const count = Math.max(1, Math.min(playCount, 10));
    if (count > 1) {
      const silenceGap = Buffer.alloc(SLN16_BYTES_PER_SEC * 1.5, 0);
      const parts: Buffer[] = [];
      for (let i = 0; i < count; i++) {
        if (i > 0) parts.push(silenceGap);
        parts.push(singlePlayBuffer);
      }
      const combined = Buffer.concat(parts);
      fs.writeFileSync(CURRENT_PAGE_SLN16, combined);
      console.log(`[Pager] Audio prepared: ${count}x repeat, ${combined.length} bytes total`);
    } else {
      fs.writeFileSync(CURRENT_PAGE_SLN16, singlePlayBuffer);
      console.log(`[Pager] Audio prepared: single play, ${singlePlayBuffer.length} bytes`);
    }
  }

  private async convertForAsterisk(inputPath: string, outputPath: string): Promise<void> {
    console.log(`[Pager] Converting audio: ${inputPath} → ${outputPath}`);
    await execFileAsync('sox', [
      inputPath,
      '-r', '16000', '-c', '1', '-b', '16',
      '-e', 'signed-integer', '-t', 'raw',
      outputPath,
    ]);
  }
}

/**
 * Convert an uploaded WAV file for Asterisk playback.
 * Returns the duration in seconds.
 */
export async function convertUploadedWav(inputPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('soxi', ['-D', inputPath]);
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? undefined : duration;
  } catch {
    return undefined;
  }
}
