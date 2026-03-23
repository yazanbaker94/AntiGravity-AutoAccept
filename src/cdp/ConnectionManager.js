// AntiGravity AutoAccept — CDP Connection Manager
// Worker thread isolation: all ws WebSocket instances live in a
// worker_thread (cdp-worker.js). The main extension thread has ZERO
// WebSocket instances, making it immune to the "Cannot freeze array
// buffer views with elements" crash (issue #36).
// Memory-optimized: ~2-5MB per worker thread vs ~30-50MB per fork().
//
// Fixed in this revision (Issue #51):
//   RC1  — Harvest __AA_CLICK_COUNT before pruning gone sessions
//   RC2  — ignoredTargets parallel TTL map (5-min self-healing expiry)
//   HB1  — IPC backpressure death spiral: chunk all concurrent evals to ≤10
//   HB2  — Destructive read race: switch to monotonic counter + delta
//   HB3  — Undead session loop: only clear fail count on live or successful re-inject
//   SEC  — Removed dead 'not-agent-panel' branch (DOMObserver never returns it)

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
        this._ignoredTargetTTLs = new Map(); // [RC2] targetId → expiryTimestamp
        this._sessionCursors = new Map();    // [HB2] targetId → last seen __AA_CLICK_COUNT
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
        this._cachedScriptKey = null;

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
            retry: this.autoRetryEnabled
        });
        if (this._cachedScriptKey === key && this._cachedScript) {
            return this._cachedScript;
        }
        this._cachedScript = buildDOMObserverScript(
            this.getCustomTexts(), this.blockedCommands, this.allowedCommands,
            this.autoAcceptFileEdits, this.autoRetryEnabled
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

    // [HB1/RC1] timeoutMs parameter allows callers to set fast-fail for dying targets
    _workerEval(wsUrl, expression, timeoutMs = 10000) {
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
            }, timeoutMs);
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
                const result = await this._workerBurstInject(info.wsUrl, targetId, this.isPaused) || 'unknown';
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
        this._ignoredTargetTTLs.clear(); // [RC2]
        this._sessionCursors.clear();    // [HB2]
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

            // [HB1] Chunk injections to stay under IPC backpressure limit (20)
            for (let i = 0; i < candidates.length; i += 5) {
                await Promise.allSettled(candidates.slice(i, i + 5).map(t => this._handleNewTarget(t)));
            }

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
                    this._ignoredTargetTTLs.set(targetId, Date.now() + 5 * 60 * 1000); // [RC2]
                    return;
                }
            }
        }

        try {
            // Use cached script — no 28KB allocation per target
            this._getScript();
            // [FIX] IPC string unboxing: _workerBurstInject resolves a raw string, not {result:...}
            const result = await this._workerBurstInject(webSocketDebuggerUrl, targetId, this.isPaused) || 'unknown';

            if (result !== 'observer-installed' && result !== 'already-active') {
                this.log(`[CDP] [${shortId}] Injection result: ${result}`);
                // [SEC] Removed dead 'not-agent-panel' branch — DOMObserver never returns it.
                // Only 'no-window' and repeated failures are grounds for ignoring a target.
                if (result === 'no-window') {
                    this.ignoredTargets.add(targetId);
                    this._ignoredTargetTTLs.set(targetId, Date.now() + 5 * 60 * 1000); // [RC2]
                } else {
                    const count = (this._injectionFailCounts.get(targetId) || 0) + 1;
                    this._injectionFailCounts.set(targetId, count);
                    if (count >= 3) {
                        this.ignoredTargets.add(targetId);
                        this._ignoredTargetTTLs.set(targetId, Date.now() + 5 * 60 * 1000); // [RC2]
                    }
                }
                return;
            }

            this.sessions.set(targetId, { url: url || '', wsUrl: webSocketDebuggerUrl });
            this.sessionUrls.set(targetId, url || '');

            // [Q3 FIX] Harvest current __AA_CLICK_COUNT BEFORE setting cursor.
            // DOMObserver preserves the counter across re-injections. If we initialize
            // to 0, the first heartbeat computes delta = 658 - 0 = 658, double-counting
            // all pre-reload clicks. Read the actual value and use it as the baseline.
            let initialCount = 0;
            try {
                const initCheck = await this._workerEval(webSocketDebuggerUrl, '(() => window.__AA_CLICK_COUNT || 0)()', 1500);
                initialCount = initCheck.result?.result?.value || 0;
            } catch (e) { /* best-effort — 0 is safe fallback */ }
            this._sessionCursors.set(targetId, initialCount);

            this.log(`[CDP] ✓ Injected [${shortId}] → ${result} cursor=${initialCount} (${(url || '').substring(0, 50)})`);
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
                // [HB1] Chunk to avoid backpressure
                for (let i = 0; i < candidates.length; i += 5) {
                    await Promise.allSettled(candidates.slice(i, i + 5).map(t => this._handleNewTarget(t)));
                }
            }

            const activeIds = new Set(targets.map(t => t.id));

            // ── RC1: PRE-PRUNE HARVEST ─────────────────────────────────────
            // Identify targets about to be pruned, harvest their click counts
            // BEFORE removing them so no clicks are lost on transient flickers.
            const toPrune = [];
            for (const [targetId] of this.sessions) {
                if (!activeIds.has(targetId)) toPrune.push(targetId);
            }

            if (toPrune.length > 0) {
                // [HB2] Non-destructive read — we harvest the current value without resetting
                const harvestExpr = '(() => { return window.__AA_CLICK_COUNT || 0; })()';
                // [HB1] Chunk prune harvests; [RC1] use 1500ms fast-fail since target is leaving
                for (let i = 0; i < toPrune.length; i += 5) {
                    await Promise.allSettled(toPrune.slice(i, i + 5).map(async (targetId) => {
                        const info = this.sessions.get(targetId);
                        if (info) {
                            try {
                                const r = await this._workerEval(info.wsUrl, harvestExpr, 1500);
                                const currentCount = r.result?.result?.value || 0;
                                const lastCount = this._sessionCursors.get(targetId) || 0;
                                // Monotonic delta: if page reloaded __AA_CLICK_COUNT may be < lastCount
                                const delta = (currentCount < lastCount) ? currentCount : (currentCount - lastCount);
                                if (this.onClickTelemetry && delta > 0) {
                                    this.log(`[CDP] Pre-prune harvest [${targetId.substring(0, 6)}]: +${delta} clicks`);
                                    this.onClickTelemetry(delta);
                                }
                            } catch (e) { /* target already gone — suppress, best-effort */ }
                        }
                        this.sessions.delete(targetId);
                        this.sessionUrls.delete(targetId);
                        this._sessionFailCounts.delete(targetId);
                        this._sessionCursors.delete(targetId); // [HB2]
                        this.log(`[CDP] Target [${targetId.substring(0, 6)}] gone, pruned`);
                    }));
                }
            }

            // ── RC2: IGNORED TARGETS TTL EXPIRY ───────────────────────────
            // Dead target IDs: remove immediately.
            // Live ignored targets: remove after their TTL so transient race
            // conditions (e.g. unhydrated React DOM returning 'no-window' on a
            // valid agent panel) get a self-healing retry window.
            const now = Date.now();
            for (const tid of this.ignoredTargets) {
                if (!activeIds.has(tid)) {
                    // Target no longer exists — clean up
                    this.ignoredTargets.delete(tid);
                    this._ignoredTargetTTLs.delete(tid);
                } else if (this._ignoredTargetTTLs.has(tid) && now > this._ignoredTargetTTLs.get(tid)) {
                    // TTL expired — allow re-discovery on next heartbeat
                    this.ignoredTargets.delete(tid);
                    this._ignoredTargetTTLs.delete(tid);
                    this.log(`[CDP] ignoredTargets: TTL expired for [${tid.substring(0, 6)}], will retry`);
                }
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

            // ── HB1 + HB2: CHUNKED EVAL + MONOTONIC COUNTER ───────────────
            const entries = [...this.sessions.entries()];
            const results = [];

            // Chunk at 10 to keep IPC queue comfortably under the 20-slot limit
            for (let i = 0; i < entries.length; i += 10) {
                const chunk = entries.slice(i, i + 10);
                const chunkResults = await Promise.allSettled(
                    chunk.map(async ([targetId, info]) => {
                        // [HB2] Non-destructive read: removed `window.__AA_CLICK_COUNT = 0`.
                        // If the CDP WebSocket drops the response, the counter is NOT reset,
                        // so clicks are never lost to a network blip.
                        const check = await this._workerEval(info.wsUrl,
                            '(() => { const c = window.__AA_CLICK_COUNT || 0; const d = window.__AA_DIAG || []; window.__AA_DIAG = []; return { alive: !!window.__AA_PAUSED || (!!window.__AA_OBSERVER_ACTIVE && (Date.now() - (window.__AA_LAST_SCAN || 0)) < 120000), clickCount: c, diag: d }; })()'
                        );
                        const health = check.result?.result?.value || { alive: false, clickCount: 0, diag: null };
                        return { targetId, alive: health.alive, clickCount: health.clickCount, diag: health.diag };
                    })
                );
                results.push(...chunkResults);
            }

            const dead = [];
            for (let i = 0; i < results.length; i++) {
                const { status, value } = results[i];
                const targetId = entries[i][0];
                const info = entries[i][1];
                const shortId = targetId.substring(0, 6);

                if (status === 'fulfilled') {
                    // [HB2] Monotonic delta: compute new clicks since last heartbeat
                    const lastCount = this._sessionCursors.get(targetId) || 0;
                    const delta = (value.clickCount < lastCount) ? value.clickCount : (value.clickCount - lastCount);
                    if (this.onClickTelemetry && delta > 0) this.onClickTelemetry(delta);
                    this._sessionCursors.set(targetId, value.clickCount);

                    // [HB3] Removed unconditional this._sessionFailCounts.delete(targetId) here.
                    // Fail count is only cleared below if the target is confirmed alive
                    // or re-injection succeeds — prevents infinite undead session loop.

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
                            // [FIX] IPC string unboxing: _workerBurstInject resolves a raw string
                            const result = await this._workerBurstInject(info.wsUrl, targetId, this.isPaused) || 'unknown';
                            if (result === 'observer-installed' || result === 'already-active') {
                                // [HB3] Only clear fail count on successful resurrection
                                this._sessionFailCounts.delete(targetId);
                                this.log(`[CDP] ✓ Re-injected [${shortId}] → ${result}`);
                            } else {
                                const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                                this._sessionFailCounts.set(targetId, fc);
                                if (fc >= 3) dead.push(targetId);
                            }
                        } catch (e) {
                            const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                            this._sessionFailCounts.set(targetId, fc);
                            if (fc >= 3) dead.push(targetId);
                        }
                    } else {
                        // [HB3] Observer confirmed alive — clear any accumulated strikes
                        this._sessionFailCounts.delete(targetId);
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
                this._sessionCursors.delete(tid); // [HB2]
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
