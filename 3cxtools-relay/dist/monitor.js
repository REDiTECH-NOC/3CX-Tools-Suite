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
exports.QueueMonitor = void 0;
/**
 * Simplified 3CX WebSocket Queue Monitor for the relay agent.
 * Connects to the PBX MyPhone WebSocket and tracks per-queue agent login status.
 * Based on the wallboard's ThreecxQueueMonitor but stripped down for relay use.
 */
const https = __importStar(require("https"));
const crypto = __importStar(require("crypto"));
function encodeVarint(value) {
    const bytes = [];
    let v = value >>> 0;
    while (v > 0x7f) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return bytes;
}
function varintField(fn, v) {
    return encodeVarint((fn << 3) | 0).concat(encodeVarint(v));
}
function stringField(fn, s) {
    const b = Buffer.from(s, 'utf8');
    return encodeVarint((fn << 3) | 2).concat(encodeVarint(b.length)).concat(Array.from(b));
}
function submsgField(fn, d) {
    return encodeVarint((fn << 3) | 2).concat(encodeVarint(d.length)).concat(d);
}
function buildMsg(id, payload) {
    return Buffer.from(varintField(1, id).concat(submsgField(id, payload)));
}
function decodeFields(buf) {
    const fields = [];
    let i = 0;
    while (i < buf.length) {
        let tag = 0, shift = 0;
        while (i < buf.length) {
            const b = buf[i++];
            tag |= (b & 0x7f) << shift;
            shift += 7;
            if ((b & 0x80) === 0)
                break;
        }
        const fn = tag >> 3;
        const wt = tag & 7;
        if (fn === 0)
            break;
        if (wt === 0) {
            let val = 0;
            shift = 0;
            while (i < buf.length) {
                const b = buf[i++];
                val |= (b & 0x7f) << shift;
                shift += 7;
                if ((b & 0x80) === 0)
                    break;
            }
            fields.push({ fn, type: 'varint', value: val });
        }
        else if (wt === 2) {
            let len = 0;
            shift = 0;
            while (i < buf.length) {
                const b = buf[i++];
                len |= (b & 0x7f) << shift;
                shift += 7;
                if ((b & 0x80) === 0)
                    break;
            }
            const data = buf.slice(i, i + len);
            i += len;
            fields.push({ fn, type: 'bytes', value: data });
        }
        else if (wt === 1) {
            i += 8;
        }
        else if (wt === 5) {
            i += 4;
        }
        else {
            break;
        }
    }
    return fields;
}
function getVarint(fields, fn) {
    const f = fields.find(x => x.fn === fn && x.type === 'varint');
    return f ? f.value : undefined;
}
function getString(fields, fn) {
    const f = fields.find(x => x.fn === fn && x.type === 'bytes');
    if (!f)
        return undefined;
    return Buffer.from(f.value).toString('utf8');
}
function getSubmsg(fields, fn) {
    const f = fields.find(x => x.fn === fn && x.type === 'bytes');
    if (!f)
        return undefined;
    return decodeFields(f.value);
}
function getAllSubmsg(fields, fn) {
    return fields.filter(x => x.fn === fn && x.type === 'bytes').map(x => decodeFields(x.value));
}
// ─── WS Frame Helpers ───────────────────────────────────────────
function sendWsFrame(socket, opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++)
        masked[i] ^= mask[i % 4];
    let header;
    if (payload.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
    }
    else if (payload.length < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
    }
    else {
        header = Buffer.alloc(14);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
    }
    socket.write(Buffer.concat([header, masked]));
}
function sendWsText(socket, text) {
    sendWsFrame(socket, 0x01, Buffer.from(text, 'utf8'));
}
// ─── Queue Monitor ──────────────────────────────────────────────
class QueueMonitor {
    pbxHost;
    extension;
    password;
    socket = null;
    connected = false;
    stopped = false;
    isConnecting = false;
    reconnectTimer = null;
    staleTimer = null;
    refreshTimer = null;
    gotInitialData = false;
    currentSessionKey = null;
    data = { byNumber: new Map(), lastUpdated: 0 };
    constructor(pbxHost, extension, password) {
        this.pbxHost = pbxHost.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        this.extension = extension;
        this.password = password;
    }
    hasData() { return this.data.lastUpdated > 0; }
    isAgentLoggedIn(queueNumber, ext) {
        const agents = this.data.byNumber.get(queueNumber);
        if (!agents)
            return undefined;
        const agent = agents.find(a => a.extensionNumber === ext);
        return agent?.loggedIn;
    }
    async start() {
        this.stopped = false;
        await this.connect();
    }
    stop() {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.disconnect();
    }
    disconnect() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.currentSessionKey = null;
        if (this.socket) {
            this.socket.removeAllListeners();
            try {
                sendWsFrame(this.socket, 0x08, Buffer.alloc(0));
            }
            catch { }
            try {
                this.socket.destroy();
            }
            catch { }
            this.socket = null;
        }
        this.connected = false;
    }
    scheduleReconnect(delayMs) {
        if (this.stopped)
            return;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped)
                return;
            this.disconnect();
            setTimeout(() => { if (!this.stopped)
                void this.connect(); }, 3000);
        }, delayMs);
    }
    async connect() {
        if (this.stopped || this.connected || this.isConnecting)
            return;
        this.isConnecting = true;
        try {
            const token = await this.restLogin();
            if (!token) {
                this.scheduleReconnect(15000);
                return;
            }
            const session = await this.getSession(token);
            if (!session) {
                this.scheduleReconnect(15000);
                return;
            }
            this.gotInitialData = false;
            this.currentSessionKey = session.sessionKey;
            await this.connectWebSocket(session.sessionKey, session.pass, token);
            // Start periodic refresh — re-request QueuesInfo every 3s
            // The PBX doesn't push updates for REST API-initiated login/logout changes,
            // so we need to actively poll for fresh queue data.
            this.startPeriodicRefresh(session.sessionKey);
            setTimeout(() => {
                if (!this.stopped && !this.gotInitialData && this.connected) {
                    console.log('[Monitor] No data timeout, reconnecting');
                    this.scheduleReconnect(2000);
                }
            }, 8000);
        }
        catch (err) {
            console.error('[Monitor] Connection error:', err instanceof Error ? err.message : String(err));
            this.scheduleReconnect(15000);
        }
        finally {
            this.isConnecting = false;
        }
    }
    restLogin() {
        return new Promise(resolve => {
            const body = JSON.stringify({ Username: this.extension, Password: this.password, SecurityCode: '' });
            const req = https.request(`https://${this.pbxHost}/webclient/api/Login/GetAccessToken`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                rejectUnauthorized: false,
            }, res => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try {
                        const p = JSON.parse(data);
                        resolve(p.Status === 'AuthSuccess' && p.Token?.access_token ? p.Token.access_token : null);
                    }
                    catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(15000, () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }
    getSession(token) {
        return new Promise(resolve => {
            const body = JSON.stringify({ Name: 'RelayAgent', Version: '18.0.10.0', fingerprint: crypto.randomUUID() });
            const req = https.request(`https://${this.pbxHost}/webclient/api/MyPhone/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` },
                rejectUnauthorized: false,
            }, res => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try {
                        const p = JSON.parse(data);
                        resolve(p.sessionKey && p.pass ? { sessionKey: p.sessionKey, pass: p.pass } : null);
                    }
                    catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(15000, () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }
    connectWebSocket(sessionKey, pass, token) {
        return new Promise((resolve, reject) => {
            const wsKey = crypto.randomBytes(16).toString('base64');
            const path = `/ws/webclient?sessionId=${encodeURIComponent(sessionKey)}&pass=${encodeURIComponent(pass)}`;
            const req = https.request({
                hostname: this.pbxHost, port: 443, path, method: 'GET',
                headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': wsKey, 'Sec-WebSocket-Version': '13' },
                rejectUnauthorized: false,
            });
            req.on('upgrade', (_res, socket) => {
                this.socket = socket;
                this.connected = true;
                console.log('[Monitor] WebSocket connected');
                // Reset stale timer
                if (this.staleTimer)
                    clearTimeout(this.staleTimer);
                this.staleTimer = setTimeout(() => {
                    if (!this.stopped && this.connected) {
                        console.log('[Monitor] Stale data, reconnecting');
                        this.scheduleReconnect(2000);
                    }
                }, 120_000);
                let buffer = Buffer.alloc(0);
                let loginSent = false;
                socket.on('data', (chunk) => {
                    buffer = Buffer.concat([buffer, chunk]);
                    while (buffer.length >= 2) {
                        const opcode = buffer[0] & 0x0f;
                        const masked = (buffer[1] & 0x80) !== 0;
                        let payloadLen = buffer[1] & 0x7f;
                        let offset = 2;
                        if (payloadLen === 126) {
                            if (buffer.length < 4)
                                return;
                            payloadLen = buffer.readUInt16BE(2);
                            offset = 4;
                        }
                        else if (payloadLen === 127) {
                            if (buffer.length < 10)
                                return;
                            payloadLen = Number(buffer.readBigUInt64BE(2));
                            offset = 10;
                        }
                        if (masked)
                            offset += 4;
                        if (buffer.length < offset + payloadLen)
                            return;
                        let payload = buffer.subarray(offset, offset + payloadLen);
                        if (masked) {
                            const maskKey = buffer.subarray(offset - 4, offset);
                            payload = Buffer.from(payload);
                            for (let i = 0; i < payload.length; i++)
                                payload[i] ^= maskKey[i % 4];
                        }
                        buffer = buffer.subarray(offset + payloadLen);
                        if (opcode === 0x01) {
                            const text = payload.toString('utf8');
                            if (text === 'START' && !loginSent) {
                                loginSent = true;
                                this.sendLogin(token, sessionKey);
                            }
                            else if (text === 'ADDP') {
                                sendWsText(socket, 'ADDP');
                            }
                        }
                        else if (opcode === 0x02) {
                            this.handleBinaryMessage(payload);
                        }
                        else if (opcode === 0x08) {
                            this.scheduleReconnect(5000);
                        }
                    }
                });
                socket.on('close', () => {
                    this.connected = false;
                    this.scheduleReconnect(15000);
                });
                socket.on('error', (err) => {
                    console.error('[Monitor] WS error:', err.message);
                    this.scheduleReconnect(15000);
                });
                resolve();
            });
            req.on('error', (err) => {
                console.error('[Monitor] WS upgrade error:', err.message);
                this.isConnecting = false;
                reject(err);
            });
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('WS timeout')); });
            req.end();
        });
    }
    sendLogin(token, sessionKey) {
        // Send Login (100) then GetMyInfo (102) via HTTP POST.
        // Server pushes QueuesInfo (211) via WebSocket in response.
        this.sendHttpCommand(sessionKey, 100)
            .then(() => this.sendHttpCommand(sessionKey, 102))
            .catch((err) => {
            console.error('[Monitor] HTTP login/setup error:', err instanceof Error ? err.message : String(err));
        });
    }
    sendHttpCommand(sessionKey, messageId) {
        return new Promise((resolve, reject) => {
            const msg = buildMsg(messageId, []);
            const req = https.request(`https://${this.pbxHost}/MyPhone/MPWebService.asmx`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    Accept: 'application/octet-stream',
                    'Content-Length': msg.length,
                    MyPhoneSession: sessionKey,
                },
                rejectUnauthorized: false,
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks);
                    if (res.statusCode === 200 && raw.length > 0) {
                        this.handleBinaryMessage(raw);
                    }
                    resolve();
                });
            });
            req.on('error', (err) => reject(err));
            req.setTimeout(15000, () => { req.destroy(); reject(new Error(`HTTP command ${messageId} timeout`)); });
            req.write(msg);
            req.end();
        });
    }
    startPeriodicRefresh(sessionKey) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        const refresh = () => {
            if (this.stopped || !this.connected)
                return;
            this.sendHttpCommand(sessionKey, 102).catch(() => { });
            this.refreshTimer = setTimeout(refresh, 3_000);
        };
        this.refreshTimer = setTimeout(refresh, 3_000);
    }
    handleBinaryMessage(payload) {
        const outer = decodeFields(payload);
        const msgId = getVarint(outer, 1);
        if (msgId !== 211)
            return; // Only care about QueuesInfo
        const queuesWrapper = getSubmsg(outer, 211);
        if (!queuesWrapper)
            return;
        const queueItems = getAllSubmsg(queuesWrapper, 2);
        let updated = false;
        for (const queueFields of queueItems) {
            const queueNumber = getString(queueFields, 4);
            if (!queueNumber)
                continue;
            const agentsWrapper = getSubmsg(queueFields, 5);
            if (!agentsWrapper)
                continue;
            const agents = [];
            const agentItems = getAllSubmsg(agentsWrapper, 2);
            for (const af of agentItems) {
                const ext = getString(af, 3);
                const id = getVarint(af, 2) ?? 0;
                const loggedIn = getVarint(af, 8) === 1;
                if (ext)
                    agents.push({ extensionNumber: ext, agentId: id, loggedIn });
            }
            if (agents.length > 0) {
                this.data.byNumber.set(queueNumber, agents);
                updated = true;
            }
        }
        if (updated) {
            this.data.lastUpdated = Date.now();
            this.gotInitialData = true;
            // Reset stale timer
            if (this.staleTimer)
                clearTimeout(this.staleTimer);
            this.staleTimer = setTimeout(() => {
                if (!this.stopped && this.connected) {
                    console.log('[Monitor] Stale data, reconnecting');
                    this.scheduleReconnect(2000);
                }
            }, 120_000);
        }
    }
}
exports.QueueMonitor = QueueMonitor;
