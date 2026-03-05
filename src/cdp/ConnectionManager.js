// AntiGravity AutoAccept — CDP Connection Manager
// Persistent browser-level WebSocket connection with session pooling.
// Replaces the old poll→attach→evaluate→detach cycle with:
//   connect once → discover targets → inject MutationObserver → keep alive

const http = require('http');
const WebSocket = require('ws');
const { buildDOMObserverScript } = require('../scripts/DOMObserver');

class ConnectionManager {
    /**
     * @param {Object} options
     * @param {Function} options.log - Logging function
     * @param {Function} options.getPort - Returns configured CDP port
     * @param {Function} options.getCustomTexts - Returns custom button texts array
     */
    constructor({ log, getPort, getCustomTexts }) {
        this.log = log;
        this.getPort = getPort;
        this.getCustomTexts = getCustomTexts;

        // Connection state
        this.ws = null;
        this.msgId = 0;
        this.pending = new Map();           // id → { resolve, reject, timer }
        this.sessions = new Map();          // targetId → sessionId
        this.ignoredTargets = new Set();    // targetIds rejected (no-dom, not-agent-panel)
        this.activeCdpPort = null;

        // Command filters (set by extension.js from user config)
        this.blockedCommands = [];
        this.allowedCommands = [];
        this.autoAcceptFileEdits = true;

        // Lifecycle
        this.isRunning = false;
        this.isPaused = false; // Soft toggle: true = stop clicking, keep WS alive
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.onStatusChange = null; // Callback when CDP status changes
        this.onClickTelemetry = null; // Callback with click delta for analytics
        this._sessionFailCounts = new Map(); // Consecutive heartbeat failures per targetId
    }

    /**
     * Updates the command filter lists. Called by extension.js when config changes.
     * @param {string[]} blocked - Patterns to never auto-run
     * @param {string[]} allowed - If non-empty, only auto-run matching patterns
     */
    setCommandFilters(blocked, allowed) {
        this.blockedCommands = blocked || [];
        this.allowedCommands = allowed || [];
    }

    /**
     * Hot-reloads filter config into all live CDP sessions via Runtime.evaluate.
     * Overwrites window.__AA_* globals without re-injecting the full script
     * (which would create duplicate MutationObserver instances).
     */
    async pushFilterUpdate(blocked, allowed) {
        if (!this.ws || this.sessions.size === 0) return;
        const hasFilters = (blocked.length > 0 || allowed.length > 0);
        const expr = `
            window.__AA_BLOCKED = ${JSON.stringify(blocked)};
            window.__AA_ALLOWED = ${JSON.stringify(allowed)};
            window.__AA_HAS_FILTERS = ${hasFilters};
            'filters-updated';
        `;
        for (const [targetId, sessionId] of this.sessions) {
            try {
                await this._send('Runtime.evaluate', { expression: expr }, sessionId);
                this.log(`[CDP] Pushed filter update to session ${targetId.substring(0, 6)}`);
            } catch (e) {
                // Session may have been destroyed — ignore
            }
        }
    }
    /**
     * Re-injects the DOMObserver on all active sessions.
     * Safe: IDEMPOTENCY_GUARD + self-healing in DOMObserver disconnects old observer.
     * Used when button text list changes (e.g., autoAcceptFileEdits toggle).
     */
    reinjectAll() {
        if (!this.ws || this.sessions.size === 0) return;
        // Call __AA_CLEANUP + reset idempotency flag so re-injection proceeds cleanly
        const resetExpr = 'if (typeof window.__AA_CLEANUP === "function") window.__AA_CLEANUP(); window.__AA_OBSERVER_ACTIVE = false; "reset"';
        for (const [targetId, sessionId] of this.sessions) {
            this._send('Runtime.evaluate', { expression: resetExpr }, sessionId)
                .then(() => this._injectObserver(sessionId))
                .then(result => this.log(`[CDP] Re-injected [${targetId.substring(0, 6)}] → ${result}`))
                .catch(e => this.log(`[CDP] Reinject failed for ${targetId.substring(0, 6)}: ${e.message}`));
        }
    }

    /**
     * Kill signal: pauses all injected observers and disconnects them.
     * Must be called BEFORE closing the WebSocket (fire-and-forget).
     * Sets __AA_PAUSED=true for immediate click suppression,
     * then disconnects the MutationObserver to stop DOM watching.
     */
    _disableObservers() {
        if (!this.ws || this.sessions.size === 0) return;
        const killExpr = `
            window.__AA_PAUSED = true;
            if (window.__AA_OBSERVER) {
                window.__AA_OBSERVER.disconnect();
                window.__AA_OBSERVER = null;
            }
            'observers-killed';
        `;
        for (const [targetId, sessionId] of this.sessions) {
            try {
                this._send('Runtime.evaluate', { expression: killExpr }, sessionId);
                this.log(`[CDP] Sent kill signal to session ${targetId.substring(0, 6)}`);
            } catch (e) {
                this.log(`[CDP] Kill signal failed for ${targetId.substring(0, 6)}: ${e.message}`);
            }
        }
    }

    // ─── Public API ───────────────────────────────────────────────────

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isPaused = false;
        this.log('[CDP] Connection manager starting');
        this.connect();
    }

    /**
     * Soft toggle OFF: pause all observers but keep the WS connection alive.
     * Use this for the UI toggle — avoids WS teardown/reconnect race conditions.
     */
    pause() {
        this.isPaused = true;
        const pauseExpr = 'window.__AA_PAUSED = true; "paused"';
        for (const [targetId, sessionId] of this.sessions) {
            this._send('Runtime.evaluate', { expression: pauseExpr }, sessionId)
                .then(() => this.log(`[CDP] Paused session ${targetId.substring(0, 6)}`))
                .catch(e => this.log(`[CDP] Pause failed for ${targetId.substring(0, 6)}: ${e.message}`));
        }
        this.log('[CDP] All sessions paused');
        if (this.onStatusChange) this.onStatusChange();
    }

    /**
     * Soft toggle ON: unpause all observers. No re-injection needed.
     */
    unpause() {
        this.isPaused = false;
        // Nuclear unpause: re-inject all observers to guarantee pristine, known-good state.
        // This ensures that even if the observer was silently disconnected during the pause,
        // the system deterministically re-establishes all bindings.
        this.reinjectAll();
        this.log('[CDP] All sessions unpaused + re-injected');
        if (this.onStatusChange) this.onStatusChange();
    }

    /**
     * Full teardown: only for extension deactivation, NOT for UI toggle.
     * Strips WS listeners to prevent ghost close events.
     */
    stop() {
        this.isRunning = false;
        this.isPaused = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this._disableObservers();
        this._closeWebSocket();
        this.sessions.clear();
        this.ignoredTargets.clear();
        this._sessionFailCounts.clear();
        this._clearPending();
        this.log('[CDP] Connection manager stopped');
    }

    getSessionCount() {
        return this.sessions.size;
    }

    getActivePort() {
        return this.activeCdpPort;
    }

    // ─── Connection Lifecycle ─────────────────────────────────────────

    async connect() {
        if (!this.isRunning || this.isConnecting) return;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        this.isConnecting = true;

        try {
            const port = await this._findActivePort();
            if (!port) {
                this._scheduleReconnect();
                return;
            }

            const wsUrl = await this._getBrowserWsUrl(port);
            if (!wsUrl) {
                this._scheduleReconnect();
                return;
            }

            await this._establishConnection(wsUrl);
        } catch (e) {
            this.log(`[CDP] Connection error: ${e.message}`);
            this._scheduleReconnect();
        } finally {
            this.isConnecting = false;
        }
    }

    _establishConnection(wsUrl) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const timeout = setTimeout(() => {
                try { ws.close(); } catch (e) { }
                reject(new Error('Connection timeout'));
            }, 10000);

            ws.on('open', async () => {
                clearTimeout(timeout);
                this.ws = ws;
                this.log('[CDP] Persistent connection established');
                if (this.onStatusChange) this.onStatusChange();

                try {
                    await this._initializeTargetDiscovery();

                    // Heartbeat: periodic health check + new target discovery
                    this.heartbeatTimer = setInterval(() => this._heartbeat(), 30000);

                    resolve();
                } catch (e) {
                    this.log(`[CDP] Initialization error: ${e.message}`);
                    ws.close();
                    reject(e);
                }
            });

            ws.on('message', (raw) => this._onMessage(raw));

            ws.on('close', () => {
                clearTimeout(timeout);
                // Only run cleanup if THIS ws is still the active connection.
                // Prevents stale close events from wiping a newly-established session.
                if (this.ws === ws) {
                    this._onClose();
                }
            });

            ws.on('error', () => {
                // onClose will fire after this — no action needed here
            });
        });
    }

    // ─── Message Handling ─────────────────────────────────────────────

    _onMessage(raw) {
        try {
            const msg = JSON.parse(raw.toString());

            // Response to a pending request
            if (msg.id && this.pending.has(msg.id)) {
                const handler = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(handler.timer);
                handler.resolve(msg);
                return;
            }

            // CDP Events
            switch (msg.method) {
                case 'Target.targetCreated':
                    this._handleNewTarget(msg.params.targetInfo);
                    break;
                case 'Target.targetDestroyed':
                    this._handleTargetDestroyed(msg.params.targetId);
                    break;
                case 'Target.detachedFromTarget':
                    this._handleSessionDetached(msg.params?.sessionId);
                    break;
                case 'Runtime.executionContextsCleared':
                    // Webview navigated internally — re-inject observer
                    if (msg.sessionId) this._reinjectForSession(msg.sessionId);
                    break;
            }
        } catch (e) {
            // Malformed message — ignore
        }
    }

    _onClose() {
        this.log('[CDP] Connection closed');
        try {
            this.ws = null;
            this.sessions.clear();
            this.ignoredTargets.clear();
            this._sessionFailCounts.clear();
            this._clearPending();
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            if (this.onStatusChange) this.onStatusChange();
        } catch (e) {
            this.log(`[CDP] Teardown error (non-fatal): ${e.message}`);
        } finally {
            // Guarantee reconnection regardless of teardown exceptions
            if (this.isRunning) {
                this._scheduleReconnect();
            }
        }
    }

    // ─── Target Discovery & Session Management ────────────────────────

    async _initializeTargetDiscovery() {
        // Enable real-time target discovery events
        await this._send('Target.setDiscoverTargets', { discover: true });

        // Scan existing targets
        const msg = await this._send('Target.getTargets');
        const targets = msg.result?.targetInfos || [];
        this.log(`[CDP] Found ${targets.length} targets`);

        // Attach to all candidate targets concurrently
        const candidates = targets.filter(t => this._isCandidate(t));
        await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));

        this.log(`[CDP] ${this.sessions.size} sessions active after initial scan`);
    }

    _isCandidate(targetInfo) {
        const { type, url } = targetInfo;
        if (!url) return false;
        // Skip service workers and web workers — they have no DOM or window
        if (type === 'service_worker' || type === 'worker' || type === 'shared_worker') return false;
        return type === 'page' ||
            url.includes('vscode-webview://') ||
            url.includes('webview') ||
            type === 'iframe';
    }

    async _handleNewTarget(targetInfo) {
        const { targetId, type, url } = targetInfo;
        const shortId = targetId.substring(0, 6);

        if (!this._isCandidate(targetInfo)) {
            return;
        }
        if (this.sessions.has(targetId)) {
            return;
        }
        if (this.ignoredTargets.has(targetId)) {
            return;
        }

        try {
            const attachMsg = await this._send('Target.attachToTarget', { targetId, flatten: true });
            const sessionId = attachMsg.result?.sessionId;
            if (!sessionId) {
                this.log(`[CDP] [${shortId}] No sessionId returned. Error: ${JSON.stringify(attachMsg.error || 'none')}`);
                return;
            }

            // Enable Runtime events for this session
            await this._send('Runtime.enable', {}, sessionId)
                .catch(e => this.log(`[CDP] [${shortId}] Runtime.enable failed: ${e.message}`));

            // For page targets, verify DOM access before injecting
            if (type === 'page') {
                const domCheck = await this._send('Runtime.evaluate', {
                    expression: 'typeof document !== "undefined" ? document.title || "has-dom" : "no-dom"'
                }, sessionId);
                const domResult = domCheck.result?.result?.value;
                if (!domResult || domResult === 'no-dom') {
                    this.log(`[CDP] [${shortId}] No DOM access, detaching`);
                    await this._send('Target.detachFromTarget', { sessionId })
                        .catch(e => this.log(`[CDP] [${shortId}] Detach failed: ${e.message}`));
                    this.ignoredTargets.add(targetId);
                    return;
                }
            }

            // Pre-check: skip windowless contexts (service workers, shared workers)
            const windowCheck = await this._send('Runtime.evaluate', {
                expression: 'typeof window !== "undefined" && typeof document !== "undefined"'
            }, sessionId);
            if (windowCheck.result?.result?.value !== true) {
                this.log(`[CDP] [${shortId}] No window/document (likely worker), ignoring`);
                await this._send('Target.detachFromTarget', { sessionId })
                    .catch(e => this.log(`[CDP] [${shortId}] Detach failed: ${e.message}`));
                this.ignoredTargets.add(targetId);
                return;
            }

            // Inject MutationObserver payload
            const result = await this._injectObserver(sessionId);

            // Whitelist: only keep sessions where injection definitively succeeded
            if (result !== 'observer-installed' && result !== 'already-active') {
                this.log(`[CDP] [${shortId}] Injection failed (${result}), detaching`);
                await this._send('Target.detachFromTarget', { sessionId })
                    .catch(e => this.log(`[CDP] [${shortId}] Detach failed: ${e.message}`));
                // Only permanently blacklist if definitively the wrong context.
                // Transient failures get 3 retries before permanent blacklist.
                if (result === 'not-agent-panel') {
                    this.ignoredTargets.add(targetId);
                } else {
                    const count = (this._injectionFailCounts?.get(targetId) || 0) + 1;
                    if (!this._injectionFailCounts) this._injectionFailCounts = new Map();
                    this._injectionFailCounts.set(targetId, count);
                    if (count >= 3) {
                        this.log(`[CDP] [${shortId}] Failed ${count} times, permanently ignoring`);
                        this.ignoredTargets.add(targetId);
                    }
                }
                return;
            }

            // Keep session alive in pool
            this.sessions.set(targetId, sessionId);
            this.log(`[CDP] ✓ Attached [${shortId}] → ${result} (${(url || '').substring(0, 50)})`);

            // If extension is currently paused, immediately pause this new session
            if (this.isPaused) {
                this._send('Runtime.evaluate', {
                    expression: 'window.__AA_PAUSED = true; "paused-on-attach"'
                }, sessionId).catch(e => this.log(`[CDP] [${shortId}] Pause-on-attach failed: ${e.message}`));
            }
        } catch (e) {
            this.log(`[CDP] [${shortId}] Attach error: ${e.message}`);
        }
    }

    _handleTargetDestroyed(targetId) {
        if (this.sessions.has(targetId)) {
            this.sessions.delete(targetId);
            this.log(`[CDP] Target destroyed [${targetId.substring(0, 6)}]`);
        }
        // Clean up all caches to prevent memory leak over long sessions
        this.ignoredTargets.delete(targetId);
        this._sessionFailCounts.delete(targetId);
    }

    _handleSessionDetached(sessionId) {
        if (!sessionId) return;
        for (const [tid, sid] of this.sessions) {
            if (sid === sessionId) {
                this.sessions.delete(tid);
                this._sessionFailCounts.delete(tid);
                this.log(`[CDP] Session detached [${tid.substring(0, 6)}]`);
                break;
            }
        }
    }

    // ─── Observer Injection ───────────────────────────────────────────

    async _injectObserver(sessionId) {
        const script = buildDOMObserverScript(
            this.getCustomTexts(),
            this.blockedCommands,
            this.allowedCommands,
            this.autoAcceptFileEdits
        );
        try {
            // Force-clear stale observer flag from previous sessions.
            // Without this, webviews that retain window globals across extension
            // restarts would return 'already-active' with a dead observer.
            await this._send('Runtime.evaluate', {
                expression: 'if (typeof window !== "undefined") { if (typeof window.__AA_CLEANUP === "function") window.__AA_CLEANUP(); window.__AA_OBSERVER_ACTIVE = false; }'
            }, sessionId).catch(() => { });
            const evalMsg = await this._send('Runtime.evaluate', { expression: script }, sessionId);
            if (evalMsg.error) {
                this.log(`[CDP] Injection CDP error: ${JSON.stringify(evalMsg.error)}`);
                return 'cdp-error';
            }
            const exDesc = evalMsg.result?.exceptionDetails;
            if (exDesc) {
                this.log(`[CDP] Injection exception: ${exDesc.text || ''} ${exDesc.exception?.description || ''}`);
                return 'script-exception';
            }
            return evalMsg.result?.result?.value || 'undefined';
        } catch (e) {
            this.log(`[CDP] Injection threw: ${e.message}`);
            return 'thrown-error';
        }
    }

    async _reinjectForSession(sessionId) {
        // Find the targetId for this session
        let targetId = null;
        for (const [tid, sid] of this.sessions) {
            if (sid === sessionId) { targetId = tid; break; }
        }
        if (!targetId) return;

        const shortId = targetId.substring(0, 6);

        // Bounded retry: poll for a valid execution context instead of a
        // hardcoded sleep. Tries up to 5 times at 100ms intervals (500ms max).
        let contextReady = false;
        for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise(r => setTimeout(r, 100));
            try {
                await this._send('Runtime.evaluate', {
                    expression: '"context-alive"'
                }, sessionId);
                contextReady = true;
                break;
            } catch (e) {
                // Context not ready yet — retry
            }
        }
        if (!contextReady) {
            this.log(`[CDP] [${shortId}] Context never stabilized after 500ms, skipping re-inject`);
            return;
        }

        // Reset the idempotency guard (isolated try/catch so a destroyed
        // context doesn't prevent the re-injection attempt below).
        try {
            await this._send('Runtime.evaluate', {
                expression: 'window.__AA_OBSERVER_ACTIVE = false; "reset"'
            }, sessionId);
        } catch (e) {
            // Context may have been destroyed between the probe and this call.
            // Safe to ignore — a fresh context won't have the flag anyway.
        }

        try {
            const result = await this._injectObserver(sessionId);
            if (result && result !== 'not-agent-panel') {
                this.log(`[CDP] ✓ Re-injected [${shortId}] → ${result}`);
            }
        } catch (e) {
            this.log(`[CDP] Re-inject failed [${shortId}]: ${e.message}`);
        }
    }

    // ─── CDP Protocol Transport ───────────────────────────────────────

    _send(method, params = {}, sessionId = null) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('not connected'));
                return;
            }
            const id = ++this.msgId;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout: ${method}`));
            }, 5000);
            this.pending.set(id, { resolve, reject, timer });
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            this.ws.send(JSON.stringify(payload));
        });
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

    async _heartbeat() {
        try {
            const msg = await this._send('Target.getTargets');
            const targets = msg.result?.targetInfos || [];
            this.log(`[CDP] Heartbeat: ${targets.length} targets, ${this.sessions.size} sessions`);

            // Discover any new targets that appeared since last check
            const candidates = targets.filter(t => this._isCandidate(t) && !this.sessions.has(t.targetId) && !this.ignoredTargets.has(t.targetId));
            if (candidates.length > 0) {
                this.log(`[CDP] ${candidates.length} new targets found, attaching...`);
                await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));
            }

            // Verify existing sessions still have a live observer.
            // Uses Promise.allSettled for concurrent evaluation — avoids
            // sequential 5s-timeout blocking per dead session.
            if (this.sessions.size === 0) return;

            const sessionEntries = [...this.sessions.entries()];
            const healthResults = await Promise.allSettled(
                sessionEntries.map(async ([targetId, sessionId]) => {
                    // Atomic consume-and-reset: IIFE reads click count AND resets to 0
                    // in a single JS turn (thread-safe). Eliminates page-reload data loss.
                    const check = await this._send('Runtime.evaluate', {
                        expression: '(() => { const c = window.__AA_CLICK_COUNT || 0; window.__AA_CLICK_COUNT = 0; return { alive: !!window.__AA_PAUSED || (!!window.__AA_OBSERVER_ACTIVE && (Date.now() - (window.__AA_LAST_SCAN || 0)) < 120000), clickCount: c }; })()',
                        returnByValue: true
                    }, sessionId);
                    const health = check.result?.result?.value || { alive: false, clickCount: 0 };
                    return { targetId, sessionId, alive: health.alive, clickCount: health.clickCount };
                })
            );

            const deadSessions = [];
            for (let i = 0; i < healthResults.length; i++) {
                const { status, value, reason } = healthResults[i];
                const targetId = sessionEntries[i][0];
                const sessionId = sessionEntries[i][1];
                const shortId = targetId.substring(0, 6);

                if (status === 'fulfilled') {
                    // Reset consecutive fail counter on any successful communication
                    this._sessionFailCounts.delete(targetId);

                    // Harvest click telemetry from consume-and-reset
                    if (this.onClickTelemetry && value.clickCount > 0) {
                        this.onClickTelemetry(value.clickCount);
                    }

                    if (!value.alive) {
                        this.log(`[CDP] Session [${shortId}] observer dead, re-injecting...`);
                        // Reset guard (isolated — ignore failures)
                        try {
                            await this._send('Runtime.evaluate', {
                                expression: 'window.__AA_OBSERVER_ACTIVE = false; "reset"'
                            }, sessionId);
                        } catch (e) { /* context may be gone — safe to ignore */ }
                        try {
                            const result = await this._injectObserver(sessionId);
                            // Fast-fail: context changed to non-agent-panel — evict immediately
                            if (result === 'not-agent-panel') {
                                deadSessions.push({ targetId, sessionId });
                                this._sessionFailCounts.delete(targetId);
                                this.ignoredTargets.add(targetId);
                                this.log(`[CDP] Session [${shortId}] is no longer agent panel, evicting`);
                            } else if (result !== 'observer-installed' && result !== 'already-active') {
                                // Soft failure (undefined, script error) — count toward pruning
                                const failCount = (this._sessionFailCounts.get(targetId) || 0) + 1;
                                this._sessionFailCounts.set(targetId, failCount);
                                this.log(`[CDP] Re-inject [${shortId}] → ${result} (fail ${failCount}/3)`);
                                if (failCount >= 3) {
                                    deadSessions.push({ targetId, sessionId });
                                    this._sessionFailCounts.delete(targetId);
                                }
                            } else {
                                this._sessionFailCounts.delete(targetId);
                                this.log(`[CDP] ✓ Heartbeat re-injected [${shortId}] → ${result}`);
                            }
                        } catch (e) {
                            const failCount = (this._sessionFailCounts.get(targetId) || 0) + 1;
                            this._sessionFailCounts.set(targetId, failCount);
                            this.log(`[CDP] Heartbeat re-inject exception [${shortId}]: ${e.message} (fail ${failCount}/3)`);
                            if (failCount >= 3) {
                                deadSessions.push({ targetId, sessionId });
                                this._sessionFailCounts.delete(targetId);
                            }
                        }
                    }
                } else {
                    // Session unreachable — track consecutive failures
                    const failCount = (this._sessionFailCounts.get(targetId) || 0) + 1;
                    this._sessionFailCounts.set(targetId, failCount);
                    if (failCount >= 3) {
                        deadSessions.push({ targetId, sessionId });
                        this._sessionFailCounts.delete(targetId);
                        this.log(`[CDP] Session [${shortId}] unreachable 3x consecutively, pruning`);
                    }
                }
            }

            // Prune dead sessions with clean detach
            for (const { targetId, sessionId } of deadSessions) {
                try {
                    await this._send('Target.detachFromTarget', { sessionId });
                } catch (e) { /* already detached — ignore */ }
                this.sessions.delete(targetId);
            }
        } catch (e) {
            // Connection probably dead — onClose will trigger reconnect
        }
    }

    // ─── Port Discovery ───────────────────────────────────────────────

    _pingPort(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                res.on('data', () => { });
                res.on('end', () => resolve(true));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    _getBrowserWsUrl(port) {
        return new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const info = JSON.parse(data);
                        resolve(info.webSocketDebuggerUrl || null);
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    async _findActivePort() {
        // Try cached port first
        if (this.activeCdpPort && await this._pingPort(this.activeCdpPort)) {
            return this.activeCdpPort;
        }

        const configPort = this.getPort();
        if (await this._pingPort(configPort)) {
            this.activeCdpPort = configPort;
            return configPort;
        }

        return null;
    }

    // ─── Cleanup Helpers ──────────────────────────────────────────────

    _closeWebSocket() {
        if (this.ws) {
            // Strip all listeners before closing to prevent ghost close events
            // from corrupting state after a new connection is established
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (e) {
                this.log(`[CDP] WS close error: ${e.message}`);
            }
            this.ws = null;
        }
    }

    _clearPending() {
        for (const [id, handler] of this.pending) {
            clearTimeout(handler.timer);
        }
        this.pending.clear();
    }
}

module.exports = { ConnectionManager };
