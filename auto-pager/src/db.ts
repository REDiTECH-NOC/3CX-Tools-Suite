import Database from 'better-sqlite3';
import { CONFIG } from './config';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(CONFIG.dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wav_files (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      filename       TEXT NOT NULL UNIQUE,
      original_name  TEXT NOT NULL,
      duration_seconds REAL,
      uploaded_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS monitored_queues (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_number            TEXT NOT NULL UNIQUE,
      queue_name              TEXT NOT NULL,
      enabled                 INTEGER DEFAULT 1,
      threshold_seconds       INTEGER DEFAULT 30,
      min_calls               INTEGER DEFAULT 1,
      repeat_interval_seconds INTEGER DEFAULT 0,
      wav_file_id             INTEGER REFERENCES wav_files(id) ON DELETE SET NULL,
      paging_extension        TEXT,
      last_paged_at           TEXT
    );

    CREATE TABLE IF NOT EXISTS page_log (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_number          TEXT NOT NULL,
      queue_name            TEXT,
      triggered_at          TEXT DEFAULT (datetime('now')),
      calls_waiting         INTEGER,
      longest_wait_seconds  INTEGER,
      wav_file              TEXT,
      paging_extension      TEXT,
      result                TEXT
    );
  `);

  // Migrations for existing DBs
  const migrations = [
    `ALTER TABLE monitored_queues ADD COLUMN paging_extension TEXT`,
    `ALTER TABLE monitored_queues ADD COLUMN min_calls INTEGER DEFAULT 1`,
    `ALTER TABLE monitored_queues ADD COLUMN repeat_interval_seconds INTEGER DEFAULT 0`,
    `ALTER TABLE monitored_queues ADD COLUMN play_count INTEGER DEFAULT 1`,
    `ALTER TABLE page_log ADD COLUMN calls_waiting INTEGER`,
    `ALTER TABLE page_log ADD COLUMN longest_wait_seconds INTEGER`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Drop cooldown_seconds if it exists (replaced by repeat_interval_seconds)
  // SQLite doesn't support DROP COLUMN in older versions, so just ignore it
}

// ── Settings helpers ──

export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

// ── WAV files ──

export interface WavFile {
  id: number;
  filename: string;
  original_name: string;
  duration_seconds: number | null;
  uploaded_at: string;
}

export function getWavFiles(): WavFile[] {
  return getDb()
    .prepare('SELECT * FROM wav_files ORDER BY uploaded_at DESC')
    .all() as WavFile[];
}

export function addWavFile(
  filename: string,
  originalName: string,
  durationSeconds?: number,
): WavFile {
  const db = getDb();
  const info = db
    .prepare(
      'INSERT INTO wav_files (filename, original_name, duration_seconds) VALUES (?, ?, ?)',
    )
    .run(filename, originalName, durationSeconds ?? null);
  return db
    .prepare('SELECT * FROM wav_files WHERE id = ?')
    .get(info.lastInsertRowid) as WavFile;
}

export function deleteWavFile(id: number): void {
  getDb().prepare('DELETE FROM wav_files WHERE id = ?').run(id);
}

// ── Monitored queues ──

export interface MonitoredQueue {
  id: number;
  queue_number: string;
  queue_name: string;
  enabled: number;
  threshold_seconds: number;
  min_calls: number;
  repeat_interval_seconds: number;
  play_count: number;
  wav_file_id: number | null;
  paging_extension: string | null;
  last_paged_at: string | null;
}

export function getMonitoredQueues(): MonitoredQueue[] {
  return getDb()
    .prepare('SELECT * FROM monitored_queues ORDER BY queue_number')
    .all() as MonitoredQueue[];
}

export function upsertMonitoredQueue(data: {
  queue_number: string;
  queue_name: string;
  enabled?: boolean;
  threshold_seconds?: number;
  min_calls?: number;
  repeat_interval_seconds?: number;
  play_count?: number;
  wav_file_id?: number | null;
  paging_extension?: string | null;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO monitored_queues (queue_number, queue_name, enabled, threshold_seconds, min_calls, repeat_interval_seconds, play_count, wav_file_id, paging_extension)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue_number) DO UPDATE SET
      queue_name = excluded.queue_name,
      enabled = excluded.enabled,
      threshold_seconds = excluded.threshold_seconds,
      min_calls = excluded.min_calls,
      repeat_interval_seconds = excluded.repeat_interval_seconds,
      play_count = excluded.play_count,
      wav_file_id = excluded.wav_file_id,
      paging_extension = excluded.paging_extension
  `).run(
    data.queue_number,
    data.queue_name,
    data.enabled !== false ? 1 : 0,
    data.threshold_seconds ?? 30,
    data.min_calls ?? 1,
    data.repeat_interval_seconds ?? 0,
    data.play_count ?? 1,
    data.wav_file_id ?? null,
    data.paging_extension ?? null,
  );
}

export function updateMonitoredQueue(
  queueNumber: string,
  updates: Partial<{
    enabled: boolean;
    threshold_seconds: number;
    min_calls: number;
    repeat_interval_seconds: number;
    play_count: number;
    wav_file_id: number | null;
    paging_extension: string | null;
  }>,
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.threshold_seconds !== undefined) {
    sets.push('threshold_seconds = ?');
    values.push(updates.threshold_seconds);
  }
  if (updates.min_calls !== undefined) {
    sets.push('min_calls = ?');
    values.push(updates.min_calls);
  }
  if (updates.repeat_interval_seconds !== undefined) {
    sets.push('repeat_interval_seconds = ?');
    values.push(updates.repeat_interval_seconds);
  }
  if (updates.play_count !== undefined) {
    sets.push('play_count = ?');
    values.push(updates.play_count);
  }
  if (updates.wav_file_id !== undefined) {
    sets.push('wav_file_id = ?');
    values.push(updates.wav_file_id);
  }
  if (updates.paging_extension !== undefined) {
    sets.push('paging_extension = ?');
    values.push(updates.paging_extension);
  }

  if (sets.length > 0) {
    values.push(queueNumber);
    db.prepare(
      `UPDATE monitored_queues SET ${sets.join(', ')} WHERE queue_number = ?`,
    ).run(...values);
  }
}

export function deleteMonitoredQueue(queueNumber: string): void {
  getDb()
    .prepare('DELETE FROM monitored_queues WHERE queue_number = ?')
    .run(queueNumber);
}

export function updateLastPaged(queueNumber: string): void {
  getDb()
    .prepare(
      "UPDATE monitored_queues SET last_paged_at = datetime('now') WHERE queue_number = ?",
    )
    .run(queueNumber);
}

// ── Page log ──

export interface PageLogEntry {
  id: number;
  queue_number: string;
  queue_name: string | null;
  triggered_at: string;
  calls_waiting: number | null;
  longest_wait_seconds: number | null;
  wav_file: string | null;
  paging_extension: string | null;
  result: string | null;
}

export function addPageLog(data: {
  queue_number: string;
  queue_name?: string;
  calls_waiting?: number;
  longest_wait_seconds?: number;
  wav_file?: string;
  paging_extension?: string;
  result: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO page_log (queue_number, queue_name, calls_waiting, longest_wait_seconds, wav_file, paging_extension, result)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      data.queue_number,
      data.queue_name ?? null,
      data.calls_waiting ?? null,
      data.longest_wait_seconds ?? null,
      data.wav_file ?? null,
      data.paging_extension ?? null,
      data.result,
    );
}

export function getPageLog(limit = 100): PageLogEntry[] {
  return getDb()
    .prepare(
      'SELECT * FROM page_log ORDER BY triggered_at DESC LIMIT ?',
    )
    .all(limit) as PageLogEntry[];
}
