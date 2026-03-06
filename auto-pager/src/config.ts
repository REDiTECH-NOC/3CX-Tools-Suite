/** Environment + runtime configuration for the Auto-Pager. */

export const CONFIG = {
  /** HTTP server port */
  port: parseInt(process.env.PORT || '3001', 10),

  /** Admin extensions allowed to log in (comma-separated from env) */
  adminExtensions: (process.env.ADMIN_EXTENSIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Session cookie name */
  sessionCookie: 'ap_session',

  /** Session TTL in ms (24 hours) */
  sessionTtlMs: 24 * 60 * 60 * 1000,

  /** Path to SQLite database */
  dbPath: process.env.DB_PATH || '/data/pager.db',

  /** Path for uploaded audio files */
  audioDir: process.env.AUDIO_DIR || '/data/audio',

  /** Asterisk Manager Interface */
  ami: {
    host: '127.0.0.1',
    port: 5038,
    username: 'autopager',
    password: 'autopager_internal',
  },

  /** Default poll interval for queue monitoring (ms) */
  defaultPollIntervalMs: 5000,

  /** Asterisk PJSIP config output path */
  asteriskConfigDir: '/etc/asterisk',
};
