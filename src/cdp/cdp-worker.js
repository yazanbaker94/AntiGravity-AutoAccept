const { parentPort } = require('worker_threads');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 🛑 SECURITY: Hash username into temp filenames to prevent cross-user DoS on shared machines
// 🛑 STABILITY: os.userInfo() can throw ENOENT in Docker/WSL — must be wrapped
let _sysUser = 'shared';
try { _sysUser = os.userInfo().username || 'shared'; } catch(e) {}
const _userHash = crypto.createHash('md5').update(_sysUser).digest('hex').substring(0, 8);
const SWARM_LOCK_FILE = path.join(os.tmpdir(), `aa-swarm-pause-${_userHash}.json`);
const FP_LOCK_FILE = path.join(os.tmpdir(), `aa-swarm-clicks-${_userHash}.json`);

// 🛑 STABILITY: Atomic file write via temp+rename
function atomicWriteSync(filePath, data) {
    const tmp = filePath + '.' + Math.random().toString(36).substring(2) + '.tmp';
    try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, filePath);
    } catch(e) {
        try { fs.writeFileSync(filePath, data); } catch(e2) {}
        try { fs.unlinkSync(tmp); } catch(e3) {}
    }
}

// 🛑 THE ULTIMATE CROSS-PROCESS PAUSE CHECK
function isCrossProcessPaused() {
    try {
        if (fs.existsSync(SWARM_LOCK_FILE)) {
            const data = JSON.parse(fs.readFileSync(SWARM_LOCK_FILE, 'utf8'));
            if (data && data.paused && (Date.now() - data.ts < 12 * 60 * 60 * 1000)) return true;
        }
    } catch(e) {}
    return false;
}

setInterval(() => {
    try {
        const mem = process.memoryUsage();
        parentPort.postMessage({ type: 'memory-report', heapUsed: Math.round(mem.heapUsed / 1024 / 1024), rss: Math.round(mem.rss / 1024 / 1024) });
    } catch (e) { }
}, 60000);

let _cachedScript = null;
let pauseFlags = null; // ⚡ Shared RAM: [0]=isPaused, [1]=swarmPaused
let isGlobalPaused = false;
let isSwarmPaused = false;

// ⚡ LEVEL 2 DRM: The core scanner function compiled in RAM from server payload.
// This variable holds a compiled AsyncFunction. It is NEVER saved to disk.
let _compiledScanner = null;

// ────────────────────────────────────────────────────────────────────────────────
// ⚡ PERSISTENT WS POOL: Multiplexes all CDP calls through 1 WS per target URL.
// Eliminates 4-6 WebSocket creates/sec that caused 1.1GB native memory bloat.
// ────────────────────────────────────────────────────────────────────────────────
const wsPool = new Map(); // wsUrl -> CdpConnection

class CdpConnection {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = new WebSocket(wsUrl);
        this.pending = new Map();
        this.msgId = 0;
        this._dead = false;

        this.ready = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { this._dead = true; reject(new Error('socket timeout')); }, 5000);
            this.ws.on('open', () => { clearTimeout(timeout); resolve(); });
            this.ws.on('error', (err) => { clearTimeout(timeout); this.cleanup(err); reject(err); });
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.id && this.pending.has(msg.id)) {
                    const handler = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    clearTimeout(handler.timer);
                    if (msg.error) handler.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    else handler.resolve(msg);
                }
            } catch (e) {} finally {
                raw = null; // Explicitly null to hint V8's Scavenger GC
            }
        });

        this.ws.on('close', () => this.cleanup(new Error('ws closed')));
    }

    cleanup(err) {
        if (this._dead) return;
        this._dead = true;
        for (const handler of this.pending.values()) {
            clearTimeout(handler.timer);
            handler.reject(err || new Error('connection cleanup'));
        }
        this.pending.clear();
        wsPool.delete(this.wsUrl);
        try { this.ws.terminate(); } catch (e) {}
    }

    async send(method, params = {}, timeoutMs = 10000) {
        await this.ready;
        if (this._dead) throw new Error('connection dead');
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout: ${method}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            try {
                this.ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }
}

function getCdpConnection(wsUrl) {
    let conn = wsPool.get(wsUrl);
    if (conn && !conn._dead && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) return conn;
    if (conn) { conn.cleanup(new Error('stale connection')); }
    conn = new CdpConnection(wsUrl);
    wsPool.set(wsUrl, conn);
    return conn;
}

// ────────────────────────────────────────────────────────────────────────────────

parentPort.on('message', async (msg) => {
    if (msg.type === 'init-pause-buffer') {
        pauseFlags = new Uint8Array(msg.buffer);
        parentPort.postMessage({ type: 'eval-result', id: 0, result: { status: 'diag', message: `[WORKER-DIAG] pause buffer initialized, hasPauseFlags=${!!pauseFlags}` } });
        return;
    }
    if (msg.type === 'sync-pause') {
        isGlobalPaused = !!msg.isPaused;
        isSwarmPaused = !!msg.swarmPaused;
        parentPort.postMessage({ type: 'eval-result', id: 0, result: { status: 'diag', message: `[WORKER-DIAG] sync-pause: global=${isGlobalPaused} swarm=${isSwarmPaused}` } });
        return;
    }
    switch (msg.type) {
        case 'cache-script': {
            _cachedScript = msg.script;
            parentPort.postMessage({ type: 'cache-script-ack', id: msg.id });
            break;
        }
        case 'compile-core': {
            // ⚡ LEVEL 2 DRM: Receive Base64 payload from main thread, compile in RAM.
            // 🔐 SECURITY: Verify Ed25519 signature before compiling (prevents KV poisoning / MITM RCE)
            try {
                const PAYLOAD_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAevf+dABofMi3wmyYEPocJtMyz42O/zS0oO9No1pOc/8=\n-----END PUBLIC KEY-----`;
                
                // 🛑 STRICT ENFORCEMENT: Block Downgrade Attacks — signature is MANDATORY
                if (!msg.signature) {
                    parentPort.postMessage({ type: 'eval-result', id: msg.id, result: { status: 'error', message: 'CRITICAL: Missing payload signature — refusing to compile (Downgrade Attack prevention)' } });
                    break;
                }
                
                const isValid = crypto.verify(null, Buffer.from(msg.payload), PAYLOAD_PUBLIC_KEY, Buffer.from(msg.signature, 'hex'));
                if (!isValid) {
                    parentPort.postMessage({ type: 'eval-result', id: msg.id, result: { status: 'error', message: 'CRITICAL: Payload signature verification FAILED — refusing to compile' } });
                    break;
                }
                parentPort.postMessage({ type: 'eval-result', id: 0, result: { status: 'diag', message: '[WORKER-DIAG] Ed25519 signature verified ✓' } });
                
                const decoded = Buffer.from(msg.payload, 'base64').toString('utf8');
                // Compile the async function in worker memory — never touches disk
                const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                _compiledScanner = new AsyncFunction(
                    'wsUrl', 'recentClicks', 'config',
                    'openSocket', 'WebSocket', 'fs', 'path', 'os',
                    'isCrossProcessPaused', 'pauseFlags', 'isGlobalPaused', 'isSwarmPaused',
                    'parentPort', 'Atomics', 'FP_LOCK_FILE', 'SWARM_LOCK_FILE',
                    'atomicWriteSync',
                    decoded
                );
                parentPort.postMessage({ type: 'eval-result', id: msg.id, result: { status: 'diag', message: '[WORKER-DIAG] Core scanner compiled in RAM ✓' } });
            } catch (e) {
                parentPort.postMessage({ type: 'eval-result', id: msg.id, result: { status: 'error', message: `Core compile failed: ${e.message}` } });
            }
            break;
        }
        case 'eval': {
            try {
                const result = await burstEval(msg.wsUrl, msg.expression);
                parentPort.postMessage({ type: 'eval-result', id: msg.id, result });
            } catch (e) { parentPort.postMessage({ type: 'eval-result', id: msg.id, error: e.message }); }
            break;
        }
        case 'cdp-raw': {
            // Send any CDP method (not just Runtime.evaluate) — used by TelegramBridge for Input.dispatchKeyEvent
            try {
                const result = await burstRawCdp(msg.wsUrl, msg.method, msg.params || {});
                parentPort.postMessage({ type: 'eval-result', id: msg.id, result });
            } catch (e) { parentPort.postMessage({ type: 'eval-result', id: msg.id, error: e.message }); }
            break;
        }
        case 'burst-inject': {
            const script = msg.script || _cachedScript;
            if (!script) { parentPort.postMessage({ type: 'burst-inject-result', id: msg.id, targetId: msg.targetId, error: 'no script cached' }); break; }
            try {
                const result = await burstInject(msg.wsUrl, msg.targetId, script, msg.isPaused);
                parentPort.postMessage({ type: 'burst-inject-result', id: msg.id, targetId: msg.targetId, result });
            } catch (e) { parentPort.postMessage({ type: 'burst-inject-result', id: msg.id, targetId: msg.targetId, error: e.message }); }
            break;
        }
        case 'pure-cdp-swarm-scan': {
            const { id, wsUrl, recentClicks, config, isPaused, swarmPaused, sentAt } = msg;
            const _diagAge = Date.now() - (sentAt || 0);
            parentPort.postMessage({ type: 'eval-result', id: 0, result: { status: 'diag', message: `[WORKER-DIAG] scan-recv: ipc.paused=${isPaused} ipc.swarm=${swarmPaused} worker.global=${isGlobalPaused} worker.swarm=${isSwarmPaused} hasBuf=${!!pauseFlags} buf=[${pauseFlags ? pauseFlags[0]+','+pauseFlags[1] : 'null'}] age=${_diagAge}ms` } });
            try {
                // 🛑 IMMEDIATE BACKLOG ABORT
                if (isPaused || swarmPaused || isGlobalPaused || isSwarmPaused) {
                    parentPort.postMessage({ type: 'eval-result', id, result: { status: 'aborted', message: 'IPC snapshot paused' } });
                    break;
                }
                if (isCrossProcessPaused()) {
                    parentPort.postMessage({ type: 'eval-result', id, result: { status: 'aborted', message: 'Cross-process file lock: Swarm paused.' } });
                    break;
                }
                if (_diagAge > 4000) {
                    parentPort.postMessage({ type: 'eval-result', id, result: { status: 'aborted', message: 'Stale message in worker queue' } });
                    break;
                }

                // ⚡ LEVEL 2 DRM: Execute the scanner compiled from server payload.
                // If no payload was compiled, the scanner simply doesn't exist — there's nothing to crack.
                if (!_compiledScanner) {
                    parentPort.postMessage({ type: 'eval-result', id, result: { status: 'unauthorized', message: 'Core engine not loaded' } });
                    break;
                }

                const result = await _compiledScanner(
                    wsUrl, recentClicks, config,
                    openSocket, WebSocket, fs, path, os,
                    isCrossProcessPaused, pauseFlags, isGlobalPaused, isSwarmPaused,
                    parentPort, Atomics, FP_LOCK_FILE, SWARM_LOCK_FILE,
                    atomicWriteSync
                );
                parentPort.postMessage({ type: 'eval-result', id, result });
            } catch(e) { parentPort.postMessage({ type: 'eval-result', id: msg.id, error: e.message }); }
            break;
        }
        case 'pure-cdp-pause': {
            parentPort.postMessage({ type: 'eval-result', id: msg.id, result: 'ok' });
            break;
        }
        case 'shutdown': {
            // Close all pooled connections on shutdown
            for (const conn of wsPool.values()) conn.cleanup(new Error('shutdown'));
            wsPool.clear();
            process.exit(0);
            break;
        }
    }
});

// ⚡ POOLED: All CDP calls go through the persistent connection pool
async function burstEval(wsUrl, expression) {
    return getCdpConnection(wsUrl).send('Runtime.evaluate', { expression, returnByValue: true }, 5000);
}

async function burstRawCdp(wsUrl, method, params) {
    return getCdpConnection(wsUrl).send(method, params, 5000);
}

// ⚡ POOLED: burstInject now uses the pool instead of opening nested sockets
async function burstInject(wsUrl, targetId, script, isPaused) {
    const conn = getCdpConnection(wsUrl);
    try {
        const windowCheck = await conn.send('Runtime.evaluate', { expression: 'typeof window !== "undefined" && typeof document !== "undefined"', returnByValue: true }, 5000);
        if (windowCheck.result?.result?.value !== true) return 'no-window';
        await conn.send('Runtime.evaluate', { expression: 'if (typeof window !== "undefined") { if (typeof window.__AA_CLEANUP === "function") window.__AA_CLEANUP(); window.__AA_OBSERVER_ACTIVE = false; }' }, 5000);

        const evalMsg = await conn.send('Runtime.evaluate', { expression: script }, 15000);
        if (evalMsg.error) return 'cdp-error';
        if (evalMsg.result?.exceptionDetails) return 'script-exception';

        const result = evalMsg.result?.result?.value || 'undefined';
        if (isPaused && (result === 'observer-installed' || result === 'already-active')) {
            await conn.send('Runtime.evaluate', { expression: 'window.__AA_PAUSED = true; "paused-on-inject"' }, 2000);
        }
        return result;
    } catch (e) { throw e; }
}

// ⚡ TRANSPARENT MOCK: openSocket returns a mock WS that pipes through the pool.
// The compiled scanner calls openSocket() and uses ws.send()/ws.on('message') directly.
// This mock translates those calls into multiplexed JSON-RPC through the pooled connection.
function openSocket(wsUrl) {
    return new Promise(async (resolve, reject) => {
        try {
            const conn = getCdpConnection(wsUrl);
            await conn.ready;

            // Mock WS object that the scanner can use as if it were a real WebSocket
            const mockWs = {
                readyState: WebSocket.OPEN,
                _listeners: { message: [], close: [], error: [] },
                on(evt, cb) {
                    if (this._listeners[evt]) this._listeners[evt].push(cb);
                },
                send(rawStr) {
                    try {
                        const msg = JSON.parse(rawStr);
                        conn.send(msg.method, msg.params || {}, 5000)
                            .then(res => {
                                // Route response back through the mock's message listeners
                                const reply = JSON.stringify({ id: msg.id, result: res.result || res });
                                this._listeners.message.forEach(cb => cb(reply));
                            })
                            .catch(err => {
                                const reply = JSON.stringify({ id: msg.id, error: { message: err.message } });
                                this._listeners.message.forEach(cb => cb(reply));
                            });
                    } catch(e) {}
                },
                terminate() {} // NO-OP: Prevent scanner from closing the pooled connection
            };

            // Forward pool-level events to mock listeners
            conn.ws.on('close', () => {
                mockWs.readyState = WebSocket.CLOSED;
                mockWs._listeners.close.forEach(cb => cb());
            });

            resolve(mockWs);
        } catch (e) { reject(e); }
    });
}

// ────────────────────────────────────────────────────────────────────────────────
// The executePureCdpSwarmScan function is NOT here.
// It is delivered at runtime from the Cloudflare Worker as a Base64 payload,
// compiled in RAM via AsyncFunction constructor, and executed dynamically.
// A pirate who bypasses the local license check gets an empty shell — there is
// no scanner logic on disk to patch.
// ────────────────────────────────────────────────────────────────────────────────
