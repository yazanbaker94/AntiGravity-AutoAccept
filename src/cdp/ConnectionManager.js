// AntiGravity AutoAccept — CDP Connection Manager
// Worker thread isolation: all ws WebSocket instances live in a
// worker_thread (cdp-worker.js). The main extension thread has ZERO
// WebSocket instances, making it immune to the "Cannot freeze array
// buffer views with elements" crash (issue #36).
// Memory-optimized: ~2-5MB per worker thread vs ~30-50MB per fork().

const http = require('http');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildDOMObserverScript } = require('../scripts/DOMObserver');

class ConnectionManager {
    constructor({ log, getPort, getCustomTexts }) {
        this.log = log;
        this.getPort = getPort;
        this.getCustomTexts = getCustomTexts;

        // Tracked targets (metadata only — no sockets in this thread)
        this.sessions = new Map();          // targetId → { url, wsUrl }
        this.sessionUrls = new Map();       // targetId → url (compat)
        this.ignoredTargets = new Set();
        this.activeCdpPort = null;

        // Command filters
        this.blockedCommands = [];
        this.allowedCommands = [];
        this.autoAcceptFileEdits = true;
        this.autoRetryEnabled = true;

        // Lifecycle
        this.isRunning = false;
        this.isPaused = false;
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.onStatusChange = null;
        this.onClickTelemetry = null;
        this._sessionFailCounts = new Map();
        this._heartbeatRunning = false;
        this._injectionFailCounts = new Map();

        // Worker thread (owns all WebSocket instances)
        this._worker = null;
        this._pendingIpc = new Map();
        this._ipcId = 0;
        this._idleKillTimer = null;

        // Script caching (eliminates 28KB IPC churn per heartbeat)
        this._cachedScript = null;
        this._cachedScriptKey = null; // hash of inputs to detect changes

        // Compat shim
        this._connected = false;
    }

    get ws() {
        return this._connected ? { readyState: 1 } : null;
    }

    // ─── Script Cache ─────────────────────────────────────────────────

    _getScript() {
        const key = JSON.stringify({
            custom: this.getCustomTexts(),
            blocked: this.blockedCommands,
            allowed: this.allowedCommands,
            fileEdits: this.autoAcceptFileEdits,
            autoRetry: this.autoRetryEnabled
        });
        if (this._cachedScriptKey === key && this._cachedScript) {
            return this._cachedScript;
        }
        this._cachedScript = buildDOMObserverScript(
            this.getCustomTexts(), this.blockedCommands, this.allowedCommands, this.autoAcceptFileEdits, this.autoRetryEnabled
        );
        this._cachedScriptKey = key;
        // Push to worker if alive
        if (this._worker) {
            this._worker.postMessage({ type: 'cache-script', id: 0, script: this._cachedScript });
        }
        this.log('[CDP] Script cached (config changed)');
        return this._cachedScript;
    }

    _invalidateScriptCache() {
        this._cachedScriptKey = null;
    }

    // ─── Worker Thread Management ─────────────────────────────────────

    _ensureWorker() {
        if (this._worker) return this._worker;

        const workerPath = path.join(__dirname, 'cdp-worker.js');
        this._worker = new Worker(workerPath);

        this._worker.on('message', (msg) => {
            // Worker memory report (P1 monitoring)
            if (msg.type === 'memory-report') {
                this.log(`[CDP] Worker memory: heap=${msg.heapUsed}MB rss=${msg.rss}MB`);
                return;
            }
            if (msg.id && this._pendingIpc.has(msg.id)) {
                const handler = this._pendingIpc.get(msg.id);
                this._pendingIpc.delete(msg.id);
                clearTimeout(handler.timer);
                if (msg.error) {
                    handler.reject(new Error(msg.error));
                } else {
                    handler.resolve(msg.result || msg);
                }
            }
        });

        this._worker.on('exit', (code) => {
            this.log(`[CDP] Worker exited (code ${code})`);
            this._worker = null;
            for (const [id, handler] of this._pendingIpc) {
                clearTimeout(handler.timer);
                handler.reject(new Error('worker exited'));
            }
            this._pendingIpc.clear();
        });

        this._worker.on('error', (e) => {
            this.log(`[CDP] Worker error: ${e.message}`);
        });

        // Send cached script to worker immediately
        if (this._cachedScript) {
            this._worker.postMessage({ type: 'cache-script', id: 0, script: this._cachedScript });
        }

        this.log('[CDP] Worker thread spawned');
        return this._worker;
    }

    _workerEval(wsUrl, expression) {
        return new Promise((resolve, reject) => {
            if (this._pendingIpc.size > 20) {
                reject(new Error('ipc backpressure: too many pending calls'));
                return;
            }
            const worker = this._ensureWorker();
            const id = ++this._ipcId;
            const timer = setTimeout(() => {
                this._pendingIpc.delete(id);
                reject(new Error('ipc timeout'));
            }, 10000);
            this._pendingIpc.set(id, { resolve, reject, timer });
            worker.postMessage({ type: 'eval', id, wsUrl, expression });
        });
    }

    _workerBurstInject(wsUrl, targetId, isPaused) {
        return new Promise((resolve, reject) => {
            if (this._pendingIpc.size > 20) {
                reject(new Error('ipc backpressure: too many pending calls'));
                return;
            }
            const worker = this._ensureWorker();
            const id = ++this._ipcId;
            const timer = setTimeout(() => {
                this._pendingIpc.delete(id);
                reject(new Error('ipc timeout'));
            }, 15000);
            this._pendingIpc.set(id, { resolve, reject, timer });
            // Worker uses cached script — no need to send 28KB every time
            worker.postMessage({ type: 'burst-inject', id, wsUrl, targetId, isPaused });
        });
    }

    _killWorker() {
        const workerRef = this._worker;
        this._worker = null;
        if (workerRef) {
            try { workerRef.postMessage({ type: 'shutdown' }); } catch (e) { }
            setTimeout(() => {
                try { workerRef.terminate(); } catch (e) { }
            }, 1000);
        }
    }

    // P2: setTimeout debounce idle kill (not setInterval)
    _resetIdleTimer() {
        if (this._idleKillTimer) {
            clearTimeout(this._idleKillTimer);
            this._idleKillTimer = null;
        }
        // Only start countdown when completely idle
        if (this.sessions.size === 0 && this._pendingIpc.size === 0 && this._worker) {
            this._idleKillTimer = setTimeout(() => {
                if (this._worker && this.sessions.size === 0 && this._pendingIpc.size === 0) {
                    this.log('[CDP] No sessions for 60s, killing idle worker');
                    this._killWorker();
                }
                this._idleKillTimer = null;
            }, 60000);
        }
    }

    // ─── Public API ───────────────────────────────────────────────────

    setCommandFilters(blocked, allowed) {
        this.blockedCommands = blocked || [];
        this.allowedCommands = allowed || [];
        this._invalidateScriptCache();
    }

    async pushFilterUpdate(blocked, allowed) {
        if (this.sessions.size === 0) return;
        const hasFilters = (blocked.length > 0 || allowed.length > 0);
        const expr = `
            window.__AA_BLOCKED = ${JSON.stringify(blocked)};
            window.__AA_ALLOWED = ${JSON.stringify(allowed)};
            window.__AA_HAS_FILTERS = ${hasFilters};
            'filters-updated';
        `;
        for (const [targetId, info] of this.sessions) {
            try {
                await this._workerEval(info.wsUrl, expr);
                this.log(`[CDP] Pushed filter update to ${targetId.substring(0, 6)}`);
            } catch (e) { }
        }
    }

    async reinjectAll() {
        if (this.sessions.size === 0) return;
        const script = this._getScript();
        for (const [targetId, info] of this.sessions) {
            try {
                const msg = await this._workerBurstInject(info.wsUrl, targetId, this.isPaused);
                const result = msg.result || 'unknown';
                this.log(`[CDP] Re-injected [${targetId.substring(0, 6)}] → ${result}`);
            } catch (e) {
                this.log(`[CDP] Reinject failed for ${targetId.substring(0, 6)}: ${e.message}`);
            }
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isPaused = false;
        this.log('[CDP] Connection manager starting (worker thread isolation)');
        this.connect();
    }

    pause() {
        this.isPaused = true;
        for (const [targetId, info] of this.sessions) {
            this._workerEval(info.wsUrl, 'window.__AA_PAUSED = true; "paused"')
                .then(() => this.log(`[CDP] Paused session ${targetId.substring(0, 6)}`))
                .catch(e => this.log(`[CDP] Pause failed for ${targetId.substring(0, 6)}: ${e.message}`));
        }
        this.log('[CDP] All sessions paused');
        if (this.onStatusChange) this.onStatusChange();
    }

    unpause() {
        this.isPaused = false;
        this.reinjectAll();
        this.log('[CDP] All sessions unpaused + re-injected');
        if (this.onStatusChange) this.onStatusChange();
    }

    stop() {
        this.isRunning = false;
        this.isPaused = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
        clearTimeout(this._idleKillTimer);
        this._idleKillTimer = null;
        for (const [targetId, info] of this.sessions) {
            this._workerEval(info.wsUrl, `
                window.__AA_PAUSED = true;
                if (window.__AA_OBSERVER) { window.__AA_OBSERVER.disconnect(); window.__AA_OBSERVER = null; }
                'killed';
            `).catch(() => {});
        }
        this.sessions.clear();
        this.sessionUrls.clear();
        this.ignoredTargets.clear();
        this._sessionFailCounts.clear();
        this._injectionFailCounts.clear();
        this._connected = false;
        this._killWorker();
        this.log('[CDP] Connection manager stopped');
    }

    getSessionCount() { return this.sessions.size; }
    getActivePort() { return this.activeCdpPort; }

    // ─── Connection Lifecycle ─────────────────────────────────────────

    async connect() {
        if (!this.isRunning || this.isConnecting) return;
        this.isConnecting = true;

        try {
            const port = await this._findActivePort();
            if (!port) { this._scheduleReconnect(); return; }

            const targets = await this._getTargetList(port);
            if (!targets || targets.length === 0) {
                this.log('[CDP] No targets found');
                this._scheduleReconnect();
                return;
            }

            this._connected = true;
            if (this.onStatusChange) this.onStatusChange();

            const candidates = targets.filter(t => this._isCandidate(t));
            this.log(`[CDP] Found ${targets.length} targets, ${candidates.length} candidates`);

            // Pre-cache script before injecting
            this._getScript();

            await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));

            this.log(`[CDP] ${this.sessions.size} sessions active after initial scan`);
            this._scheduleHeartbeat();
            this._resetIdleTimer();
        } catch (e) {
            this.log(`[CDP] Connection error: ${e.message}`);
            this._scheduleReconnect();
        } finally {
            this.isConnecting = false;
        }
    }

    // ─── Target Discovery ─────────────────────────────────────────────

    _isCandidate(targetInfo) {
        const type = targetInfo.type;
        const url = targetInfo.url || '';
        if (!url) return false;
        if (type === 'service_worker' || type === 'worker' || type === 'shared_worker') return false;
        if (url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank') return false;
        return type === 'page' || type === 'iframe' ||
            url.includes('vscode-webview') || url.includes('webview');
    }

    async _handleNewTarget(targetInfo) {
        const { id: targetId, webSocketDebuggerUrl, type, url } = targetInfo;
        if (!targetId || !webSocketDebuggerUrl) return;
        const shortId = targetId.substring(0, 6);
        if (this.sessions.has(targetId) || this.ignoredTargets.has(targetId)) return;

        // URL dedup
        if (url) {
            for (const [existingTid, info] of this.sessions) {
                if (info.url && info.url === url) {
                    this.ignoredTargets.add(targetId);
                    return;
                }
            }
        }

        try {
            // Use cached script — no 28KB allocation per target
            this._getScript();
            const msg = await this._workerBurstInject(webSocketDebuggerUrl, targetId, this.isPaused);
            const result = msg.result || 'unknown';

            if (result !== 'observer-installed' && result !== 'already-active') {
                this.log(`[CDP] [${shortId}] Injection result: ${result}`);
                if (result === 'not-agent-panel' || result === 'no-window') {
                    this.ignoredTargets.add(targetId);
                } else {
                    const count = (this._injectionFailCounts.get(targetId) || 0) + 1;
                    this._injectionFailCounts.set(targetId, count);
                    if (count >= 3) this.ignoredTargets.add(targetId);
                }
                return;
            }

            this.sessions.set(targetId, { url: url || '', wsUrl: webSocketDebuggerUrl });
            this.sessionUrls.set(targetId, url || '');
            this.log(`[CDP] ✓ Injected [${shortId}] → ${result} (${(url || '').substring(0, 50)})`);
        } catch (e) {
            this.log(`[CDP] [${shortId}] Inject error: ${e.message}`);
        }
    }

    // ─── Health & Reconnection ────────────────────────────────────────

    _scheduleReconnect() {
        if (this.reconnectTimer || !this.isRunning) return;
        this.log('[CDP] Reconnecting in 3s...');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isRunning) this.connect();
        }, 3000);
    }

    _scheduleHeartbeat() {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = setTimeout(async () => {
            await this._heartbeat();
            if (this.isRunning && (this.sessions.size > 0 || this._connected)) {
                this._scheduleHeartbeat();
            }
        }, 10000);
    }

    async _heartbeat() {
        if (this._heartbeatRunning) return;
        this._heartbeatRunning = true;
        try {
            const port = this.activeCdpPort;
            if (!port) { this._heartbeatRunning = false; return; }

            const targets = await this._getTargetList(port);
            if (!targets) { this._heartbeatRunning = false; return; }

            this.log(`[CDP] Heartbeat: ${targets.length} targets, ${this.sessions.size} sessions`);

            // Discover new targets
            const candidates = targets.filter(t =>
                this._isCandidate(t) && !this.sessions.has(t.id) && !this.ignoredTargets.has(t.id)
            );
            if (candidates.length > 0) {
                this.log(`[CDP] ${candidates.length} new targets found, injecting...`);
                await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));
            }

            // Prune gone targets
            const activeIds = new Set(targets.map(t => t.id));
            for (const [targetId] of this.sessions) {
                if (!activeIds.has(targetId)) {
                    this.sessions.delete(targetId);
                    this.sessionUrls.delete(targetId);
                    this._sessionFailCounts.delete(targetId);
                    this.log(`[CDP] Target [${targetId.substring(0, 6)}] gone, pruned`);
                }
            }

            // Prune ignoredTargets of dead target IDs
            for (const tid of this.ignoredTargets) {
                if (!activeIds.has(tid)) this.ignoredTargets.delete(tid);
            }

            // Prune _injectionFailCounts of dead target IDs
            for (const [tid] of this._injectionFailCounts) {
                if (!activeIds.has(tid)) this._injectionFailCounts.delete(tid);
            }

            // Health check existing sessions
            if (this.sessions.size === 0) {
                this._resetIdleTimer();
                this._heartbeatRunning = false;
                return;
            }

            const entries = [...this.sessions.entries()];
            const results = await Promise.allSettled(
                entries.map(async ([targetId, info]) => {
                    const check = await this._workerEval(info.wsUrl,
                        '(() => { const c = window.__AA_CLICK_COUNT || 0; window.__AA_CLICK_COUNT = 0; const d = window.__AA_DIAG || []; window.__AA_DIAG = []; return { alive: !!window.__AA_PAUSED || (!!window.__AA_OBSERVER_ACTIVE && (Date.now() - (window.__AA_LAST_SCAN || 0)) < 120000), clickCount: c, diag: d }; })()'
                    );
                    const health = check.result?.result?.value || { alive: false, clickCount: 0, diag: null };
                    return { targetId, alive: health.alive, clickCount: health.clickCount, diag: health.diag };
                })
            );

            const dead = [];
            for (let i = 0; i < results.length; i++) {
                const { status, value } = results[i];
                const targetId = entries[i][0];
                const info = entries[i][1];
                const shortId = targetId.substring(0, 6);

                if (status === 'fulfilled') {
                    this._sessionFailCounts.delete(targetId);
                    if (this.onClickTelemetry && value.clickCount > 0) this.onClickTelemetry(value.clickCount);

                    if (value.diag && Array.isArray(value.diag) && value.diag.length > 0) {
                        for (const d of value.diag) {
                            if (d.action === 'BLOCKED') this.log(`[DIAG] [${shortId}] BLOCKED | matched=${d.matched} | cmd=${d.cmd || 'N/A'}`);
                            else if (d.action === 'CIRCUIT_BREAKER') this.log(`[DIAG] [${shortId}] ⚠️ CIRCUIT BREAKER | matched=${d.matched} | retries=${d.count}`);
                            else if (d.action === 'CLICKED') this.log(`[DIAG] [${shortId}] CLICKED | matched=${d.matched} | cmd=${d.cmd || 'N/A'} | near=${(d.near || '').substring(0, 60)}`);
                            else this.log(`[DIAG] [${shortId}] ${d.action} | ${JSON.stringify(d).substring(0, 100)}`);
                        }
                    }

                    if (!value.alive) {
                        this.log(`[CDP] Session [${shortId}] observer dead, re-injecting...`);
                        try {
                            this._getScript(); // Ensure cache is fresh
                            const msg = await this._workerBurstInject(info.wsUrl, targetId, this.isPaused);
                            const result = msg.result || 'unknown';
                            if (result === 'not-agent-panel') {
                                dead.push(targetId); this.ignoredTargets.add(targetId);
                            } else if (result !== 'observer-installed' && result !== 'already-active') {
                                const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                                this._sessionFailCounts.set(targetId, fc);
                                if (fc >= 3) dead.push(targetId);
                            } else {
                                this._sessionFailCounts.delete(targetId);
                                this.log(`[CDP] ✓ Re-injected [${shortId}] → ${result}`);
                            }
                        } catch (e) {
                            const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                            this._sessionFailCounts.set(targetId, fc);
                            if (fc >= 3) dead.push(targetId);
                        }
                    }
                } else {
                    const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                    this._sessionFailCounts.set(targetId, fc);
                    if (fc >= 3) { dead.push(targetId); this.log(`[CDP] Session [${shortId}] unreachable 3x, pruning`); }
                }
            }

            for (const tid of dead) {
                this.sessions.delete(tid);
                this.sessionUrls.delete(tid);
                this._sessionFailCounts.delete(tid);
            }

            this._resetIdleTimer();
        } catch (e) { } finally { this._heartbeatRunning = false; }
    }

    // ─── Port & Target Discovery (HTTP only — no WebSocket) ───────────

    _pingPort(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800, agent: false }, (res) => {
                res.on('data', () => {});
                res.on('end', () => resolve(true));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    _getTargetList(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json', timeout: 2000, agent: false }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    async _findActivePort() {
        if (this.activeCdpPort && await this._pingPort(this.activeCdpPort)) return this.activeCdpPort;
        const configPort = this.getPort();
        if (await this._pingPort(configPort)) { this.activeCdpPort = configPort; return configPort; }
        return null;
    }

    // ─── Compat Shims ─────────────────────────────────────────────────
    _closeWebSocket() { }
    _clearPending() { }
}

module.exports = { ConnectionManager };
