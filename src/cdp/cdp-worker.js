// AntiGravity AutoAccept — CDP Worker Thread
// Runs in a worker_thread (NOT child_process.fork).
// Owns ALL ws WebSocket instances — the main extension thread has zero.
// Communicates via worker_threads.parentPort.

const { parentPort } = require('worker_threads');
const WebSocket = require('ws');

// ─── Memory Monitoring (60s) ─────────────────────────────────────

setInterval(() => {
    try {
        const mem = process.memoryUsage();
        parentPort.postMessage({
            type: 'memory-report',
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            rss: Math.round(mem.rss / 1024 / 1024)
        });
    } catch (e) { }
}, 60000);

// ─── Cached Script ───────────────────────────────────────────────
let _cachedScript = null;

// ─── Message Handler ─────────────────────────────────────────────

parentPort.on('message', async (msg) => {
    switch (msg.type) {
        case 'cache-script': {
            _cachedScript = msg.script;
            parentPort.postMessage({ type: 'cache-script-ack', id: msg.id });
            break;
        }

        case 'eval': {
            const { id, wsUrl, expression } = msg;
            try {
                const result = await burstEval(wsUrl, expression);
                parentPort.postMessage({ type: 'eval-result', id, result });
            } catch (e) {
                parentPort.postMessage({ type: 'eval-result', id, error: e.message });
            }
            break;
        }

        case 'burst-inject': {
            const { id, wsUrl, targetId, isPaused } = msg;
            // Use msg.script if provided, otherwise use cached script
            const script = msg.script || _cachedScript;
            if (!script) {
                parentPort.postMessage({ type: 'burst-inject-result', id, targetId, error: 'no script cached' });
                break;
            }
            try {
                const result = await burstInject(wsUrl, targetId, script, isPaused);
                parentPort.postMessage({ type: 'burst-inject-result', id, targetId, result });
            } catch (e) {
                parentPort.postMessage({ type: 'burst-inject-result', id, targetId, error: e.message });
            }
            break;
        }

        case 'shutdown': {
            process.exit(0);
            break;
        }
    }
});

// ─── Ephemeral Burst Eval ─────────────────────────────────────────

function burstEval(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const msgId = 1;
        let settled = false;

        const cleanup = () => {
            settled = true;
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { }
        };

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('timeout'));
        }, 5000);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: msgId,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true }
            }));
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.id === msgId) {
                    clearTimeout(timeout);
                    cleanup();
                    resolve(msg);
                }
            } catch (e) { }
        });

        ws.on('error', () => {
            clearTimeout(timeout);
            if (!settled) { cleanup(); reject(new Error('ws error')); }
        });

        ws.on('close', () => {
            clearTimeout(timeout);
            if (!settled) { cleanup(); reject(new Error('ws closed')); }
        });
    });
}

// ─── Multi-step Burst Inject (single message listener) ───────────

function burstInject(wsUrl, targetId, script, isPaused) {
    return new Promise(async (resolve, reject) => {
        let ws;
        try {
            ws = await openSocket(wsUrl);
        } catch (e) {
            reject(e);
            return;
        }

        let id = 0;
        const pending = new Map();

        const messageHandler = (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.id && pending.has(msg.id)) {
                    const handler = pending.get(msg.id);
                    pending.delete(msg.id);
                    clearTimeout(handler.timer);
                    handler.resolve(msg);
                }
            } catch (e) { }
        };
        ws.on('message', messageHandler);

        const send = (method, params = {}) => {
            return new Promise((res, rej) => {
                const myId = ++id;
                const timer = setTimeout(() => {
                    pending.delete(myId);
                    rej(new Error(`timeout: ${method}`));
                }, 5000);
                pending.set(myId, { resolve: res, reject: rej, timer });
                ws.send(JSON.stringify({ id: myId, method, params }));
            });
        };

        try {
            const windowCheck = await send('Runtime.evaluate', {
                expression: 'typeof window !== "undefined" && typeof document !== "undefined"'
            });
            if (windowCheck.result?.result?.value !== true) {
                resolve('no-window');
                return;
            }

            await send('Runtime.evaluate', {
                expression: 'if (typeof window !== "undefined") { if (typeof window.__AA_CLEANUP === "function") window.__AA_CLEANUP(); window.__AA_OBSERVER_ACTIVE = false; }'
            });

            const evalMsg = await send('Runtime.evaluate', { expression: script });
            if (evalMsg.error) { resolve('cdp-error'); return; }
            const exDesc = evalMsg.result?.exceptionDetails;
            if (exDesc) { resolve('script-exception'); return; }
            const result = evalMsg.result?.result?.value || 'undefined';

            if (isPaused && (result === 'observer-installed' || result === 'already-active')) {
                await send('Runtime.evaluate', {
                    expression: 'window.__AA_PAUSED = true; "paused-on-inject"'
                });
            }

            resolve(result);
        } catch (e) {
            reject(e);
        } finally {
            for (const [, handler] of pending) clearTimeout(handler.timer);
            pending.clear();
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { }
        }
    });
}

function openSocket(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { }
            reject(new Error('socket timeout'));
        }, 5000);

        ws.on('open', () => {
            clearTimeout(timeout);
            resolve(ws);
        });

        ws.on('error', () => {
            clearTimeout(timeout);
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { }
            reject(new Error('socket error'));
        });
    });
}
