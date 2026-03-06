"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const fs = __importStar(require("fs"));
const DEFAULT_CONFIG_PATH = '/etc/3cxtools-relay/config.json';
const DEFAULT_POLL_INTERVAL = 750;
/**
 * Load configuration from (in priority order):
 * 1. CLI arguments (--wallboard-url, --api-key, etc.)
 * 2. Config file (/etc/3cxtools-relay/config.json or --config path)
 * 3. Environment variables (WALLBOARD_URL, API_KEY, PBX_URL, etc.)
 */
function loadConfig() {
    const args = parseArgs(process.argv.slice(2));
    // Try config file
    const configPath = args['config'] || DEFAULT_CONFIG_PATH;
    let fileConfig = {};
    if (fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            console.log(`[Config] Loaded from ${configPath}`);
        }
        catch (err) {
            console.warn(`[Config] Failed to parse ${configPath}:`, err instanceof Error ? err.message : err);
        }
    }
    const config = {
        wallboardUrl: args['wallboard-url'] || fileConfig.wallboardUrl || process.env.WALLBOARD_URL || '',
        apiKey: args['api-key'] || fileConfig.apiKey || process.env.API_KEY || '',
        pbxUrl: args['pbx-url'] || fileConfig.pbxUrl || process.env.PBX_URL || '',
        pbxExtension: args['pbx-ext'] || fileConfig.pbxExtension || process.env.PBX_EXTENSION || '',
        pbxPassword: args['pbx-pass'] || fileConfig.pbxPassword || process.env.PBX_PASSWORD || '',
        pollIntervalMs: parseInt(args['poll-interval'] || '', 10) || fileConfig.pollIntervalMs || DEFAULT_POLL_INTERVAL,
        logLevel: (args['log-level'] || fileConfig.logLevel || process.env.LOG_LEVEL || 'info'),
        autoPagerUrl: args['autopager-url'] || fileConfig.autoPagerUrl || process.env.AUTOPAGER_URL || undefined,
        autoPagerApiKey: args['autopager-key'] || fileConfig.autoPagerApiKey || process.env.AUTOPAGER_API_KEY || undefined,
    };
    // Validate required fields
    const missing = [];
    if (!config.wallboardUrl)
        missing.push('wallboardUrl');
    if (!config.apiKey)
        missing.push('apiKey');
    if (!config.pbxUrl)
        missing.push('pbxUrl');
    if (!config.pbxExtension)
        missing.push('pbxExtension');
    if (!config.pbxPassword)
        missing.push('pbxPassword');
    if (missing.length > 0) {
        console.error(`[Config] Missing required fields: ${missing.join(', ')}`);
        console.error('Usage: 3cxtools-relay --wallboard-url URL --api-key KEY --pbx-url URL --pbx-ext EXT --pbx-pass PASS');
        console.error('Or create /etc/3cxtools-relay/config.json with those fields.');
        process.exit(1);
    }
    return config;
}
function parseArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
            result[arg.substring(2)] = argv[i + 1];
            i++;
        }
    }
    return result;
}
