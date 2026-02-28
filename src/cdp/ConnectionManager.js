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

        // Lifecycle
        this.isRunning = false;
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
    }

    // ─── Public API ───────────────────────────────────────────────────

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.log('[CDP] Connection manager starting');
        this.connect();
    }

    stop() {
        this.isRunning = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this._closeWebSocket();
        this.sessions.clear();
        this.ignoredTargets.clear();
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
                this._onClose();
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
        this.ws = null;
        this.sessions.clear();
        this.ignoredTargets.clear(); // Reset on reconnect — targets may have changed
        this._clearPending();
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;

        if (this.isRunning) {
            this._scheduleReconnect();
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
        const { url, type } = targetInfo;
        if (!url) return false;
        return type === 'page' ||
            url.includes('vscode-webview://') ||
            url.includes('webview') ||
            type === 'iframe';
    }

    async _handleNewTarget(targetInfo) {
        const { targetId, type, url } = targetInfo;
        if (!this._isCandidate(targetInfo)) return;
        if (this.sessions.has(targetId)) return;
        if (this.ignoredTargets.has(targetId)) return;

        const shortId = targetId.substring(0, 6);

        try {
            const attachMsg = await this._send('Target.attachToTarget', { targetId, flatten: true });
            const sessionId = attachMsg.result?.sessionId;
            if (!sessionId) return;

            // Enable Runtime events for this session (to detect context clears/navigation)
            await this._send('Runtime.enable', {}, sessionId).catch(() => { });

            // For page targets, verify DOM access before injecting
            if (type === 'page') {
                const domCheck = await this._send('Runtime.evaluate', {
                    expression: 'typeof document !== "undefined" ? document.title || "has-dom" : "no-dom"'
                }, sessionId);
                const domResult = domCheck.result?.result?.value;
                if (!domResult || domResult === 'no-dom') {
                    await this._send('Target.detachFromTarget', { sessionId }).catch(() => { });
                    this.ignoredTargets.add(targetId);
                    return;
                }
            }

            // Inject MutationObserver payload (one-shot — observer runs autonomously)
            const result = await this._injectObserver(sessionId);

            if (result === 'not-agent-panel') {
                await this._send('Target.detachFromTarget', { sessionId }).catch(() => { });
                this.ignoredTargets.add(targetId);
                return;
            }

            // Keep session alive in pool
            this.sessions.set(targetId, sessionId);
            this.log(`[CDP] ✓ Attached [${shortId}] → ${result} (${(url || '').substring(0, 50)})`);
        } catch (e) {
            // Target may have been destroyed — silent
        }
    }

    _handleTargetDestroyed(targetId) {
        if (this.sessions.has(targetId)) {
            this.sessions.delete(targetId);
            this.log(`[CDP] Target destroyed [${targetId.substring(0, 6)}]`);
        }
        // Clean up ignored cache to prevent memory leak over long sessions
        this.ignoredTargets.delete(targetId);
    }

    _handleSessionDetached(sessionId) {
        if (!sessionId) return;
        for (const [tid, sid] of this.sessions) {
            if (sid === sessionId) {
                this.sessions.delete(tid);
                this.log(`[CDP] Session detached [${tid.substring(0, 6)}]`);
                break;
            }
        }
    }

    // ─── Observer Injection ───────────────────────────────────────────

    async _injectObserver(sessionId) {
        const script = buildDOMObserverScript(this.getCustomTexts());
        const evalMsg = await this._send('Runtime.evaluate', { expression: script }, sessionId);
        return evalMsg.result?.result?.value || 'undefined';
    }

    async _reinjectForSession(sessionId) {
        // Find the targetId for this session
        let targetId = null;
        for (const [tid, sid] of this.sessions) {
            if (sid === sessionId) { targetId = tid; break; }
        }
        if (!targetId) return;

        const shortId = targetId.substring(0, 6);

        try {
            // Small delay to let the new execution context stabilize
            await new Promise(r => setTimeout(r, 500));
            const result = await this._injectObserver(sessionId);
            if (result && result !== 'not-agent-panel') {
                this.log(`[CDP] ✓ Re-injected [${shortId}] → ${result}`);
            }
        } catch (e) {
            // Session may be dead — will be cleaned up by detach/destroy events
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

        // Fallback to legacy port 9222
        if (configPort !== 9222 && await this._pingPort(9222)) {
            this.activeCdpPort = 9222;
            this.log('[CDP] ⚠ Using legacy port 9222');
            return 9222;
        }

        return null;
    }

    // ─── Cleanup Helpers ──────────────────────────────────────────────

    _closeWebSocket() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
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
