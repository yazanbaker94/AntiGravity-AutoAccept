const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { buildDOMObserverScript } = require('../scripts/DOMObserver');

// 🛑 SECURITY: Hash username into temp filenames to prevent cross-user DoS on shared machines
// 🛑 STABILITY: os.userInfo() can throw ENOENT in Docker/WSL — must be wrapped
let _sysUser = 'shared';
try { _sysUser = os.userInfo().username || 'shared'; } catch(e) {}
const _userHash = crypto.createHash('md5').update(_sysUser).digest('hex').substring(0, 8);
const SWARM_LOCK_FILE = path.join(os.tmpdir(), `aa-swarm-pause-${_userHash}.json`);

// 🛑 STABILITY: Atomic file write via temp+rename to prevent JSON corruption in cross-process races
function atomicWriteSync(filePath, data) {
    const tmp = filePath + '.' + Math.random().toString(36).substring(2) + '.tmp';
    try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, filePath); // OS-level atomic swap
    } catch(e) {
        try { fs.writeFileSync(filePath, data); } catch(e2) {} // fallback
        try { fs.unlinkSync(tmp); } catch(e3) {} // cleanup orphan
    }
}

class ConnectionManager {
    constructor({ log, getPort, getCustomTexts, getLastUserActivity }) {
        this.log = log;
        this.getPort = getPort;
        this.getCustomTexts = getCustomTexts;
        this.getLastUserActivity = getLastUserActivity || (() => 0);

        try {
            if (typeof SharedArrayBuffer !== 'undefined') {
                this._pauseBuffer = new SharedArrayBuffer(2);
                this._pauseFlags = new Uint8Array(this._pauseBuffer);
            }
        } catch (e) {}

        this._isPaused = false;
        this._swarmPaused = false; 

        this.sessions = new Map();
        this.sessionUrls = new Map();
        this.ignoredTargets = new Set();
        this._ignoredTargetTTLs = new Map(); 
        this._sessionCursors = new Map();    
        this.activeCdpPort = null;

        this.blockedCommands = [];
        this.allowedCommands = [];
        this.autoAcceptFileEdits = true;
        this.autoRetryEnabled = true;

        this.isRunning = false;
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.onStatusChange = null;
        this.onClickTelemetry = null;
        this.onSwarmPauseChange = null; 
        this._sessionFailCounts = new Map();
        this._heartbeatRunning = false;
        this._injectionFailCounts = new Map();

        this._worker = null;
        this._pendingIpc = new Map();
        this._ipcId = 0;
        this._idleKillTimer = null;

        this._cachedScript = null;
        this._cachedScriptKey = null;

        this._sidebarTargetId = null;
        this._sidebarWsUrl = null;
        this._swarmScript = null; 
        this._connected = false;
    }

    _updateFileLock() {
        try {
            // ⚡ FIX: Removed `|| this._isPaused` to prevent Global AutoAccept from hijacking Swarm state
            if (this._swarmPaused) {
                atomicWriteSync(SWARM_LOCK_FILE, JSON.stringify({ paused: true, ts: Date.now() }));
            } else {
                if (fs.existsSync(SWARM_LOCK_FILE)) fs.unlinkSync(SWARM_LOCK_FILE);
            }
        } catch(e) {}
    }

    get isPaused() { return this._isPaused; }
    set isPaused(val) {
        this._isPaused = !!val;
        if (this._pauseFlags) this._pauseFlags[0] = this._isPaused ? 1 : 0;
        if (this._worker) this._worker.postMessage({ type: 'sync-pause', isPaused: this._isPaused, swarmPaused: this._swarmPaused });
    }

    get swarmPaused() { return this._swarmPaused; }
    set swarmPaused(val) {
        if (this._swarmPaused === !!val) return; // Prevent redundant IPC/file writes
        
        this._swarmPaused = !!val;
        if (this._pauseFlags) this._pauseFlags[1] = this._swarmPaused ? 1 : 0;
        if (this._worker) this._worker.postMessage({ type: 'sync-pause', isPaused: this._isPaused, swarmPaused: this._swarmPaused });
        
        this._updateFileLock(); // ⚡ Instantly triggers across OS processes

        // ⚡ FIX: Removed clearTimeout(). Let the loop naturally transition to 2500ms sleeping heartbeat.
        
        // ⚡ FULL BROADCAST: Send pause/unpause to ALL sessions (not just sidebar/swarm).
        // Manager/swarm targets get full swarm cleanup. Regular chat windows get __AA_SWARM_PAUSED
        // so DOMObserver stops clicking Run/Accept/Retry.
        const swarmPauseExpr = this._swarmPaused
            ? 'window.__AA_SWARM_PAUSED=true;window.__AA_SWARM_OBS=false;if(window.__AA_SWARM_TIMER)clearInterval(window.__AA_SWARM_TIMER);if(window.__AA_SWEEP_TIMER)clearInterval(window.__AA_SWEEP_TIMER);"manager-paused"'
            : 'window.__AA_SWARM_PAUSED=false;"manager-resumed"';
        const chatPauseExpr = this._swarmPaused
            ? 'window.__AA_SWARM_PAUSED=true;"chat-paused"'
            : 'window.__AA_SWARM_PAUSED=false;"chat-resumed"';
        const swarmTargets = new Set();
        if (this._sidebarWsUrl) swarmTargets.add(this._sidebarWsUrl);
        if (this._swarmSessions) for (const u of this._swarmSessions) swarmTargets.add(u);
        // Broadcast to swarm/manager targets (full cleanup)
        for (const url of swarmTargets) {
            this._workerEval(url, swarmPauseExpr, 2000).catch(() => {});
        }
        // Broadcast to ALL regular chat sessions (just the flag)
        for (const [, info] of this.sessions) {
            if (!swarmTargets.has(info.wsUrl)) {
                this._workerEval(info.wsUrl, chatPauseExpr, 2000).catch(() => {});
            }
        }
        this.log(`[Swarm] ${this._swarmPaused ? 'PAUSED' : 'RESUMED'} broadcast to ${swarmTargets.size} swarm + ${this.sessions.size} total sessions`);
    }

    get ws() { return this._connected ? { readyState: 1 } : null; }

    _getScript() {
        const key = JSON.stringify({ custom: this.getCustomTexts(), blocked: this.blockedCommands, allowed: this.allowedCommands, fileEdits: this.autoAcceptFileEdits, retry: this.autoRetryEnabled });
        if (this._cachedScriptKey === key && this._cachedScript) return this._cachedScript;
        this._cachedScript = buildDOMObserverScript(this.getCustomTexts(), this.blockedCommands, this.allowedCommands, this.autoAcceptFileEdits, this.autoRetryEnabled);
        this._cachedScriptKey = key;
        if (this._worker) this._worker.postMessage({ type: 'cache-script', id: 0, script: this._cachedScript });
        return this._cachedScript;
    }

    _invalidateScriptCache() { this._cachedScriptKey = null; }

    _ensureWorker() {
        if (this._worker) return this._worker;
        const workerPath = path.join(__dirname, 'cdp-worker.js');
        this._worker = new Worker(workerPath);

        this._worker.on('message', (msg) => {
            if (msg.type === 'memory-report') { this.log(`[CDP] Worker memory: heap=${msg.heapUsed}MB rss=${msg.rss}MB`); return; }
            if (msg.id === 0 && msg.result && msg.result.status === 'diag') {
                this.log(`[Swarm] ${msg.result.message}`);
                return;
            }
            if (msg.id && this._pendingIpc.has(msg.id)) {
                const handler = this._pendingIpc.get(msg.id);
                this._pendingIpc.delete(msg.id);
                clearTimeout(handler.timer);
                if (msg.error) handler.reject(new Error(msg.error));
                else handler.resolve(msg.result || msg);
            }
        });

        this._worker.on('exit', (code) => {
            this.log(`[CDP] Worker exited (code ${code})`); this._worker = null;
            for (const [id, handler] of this._pendingIpc) { clearTimeout(handler.timer); handler.reject(new Error('worker exited')); }
            this._pendingIpc.clear();
        });

        this._worker.on('error', (e) => { this.log(`[CDP] Worker error: ${e.message}`); });

        if (this._cachedScript) this._worker.postMessage({ type: 'cache-script', id: 0, script: this._cachedScript });
        if (this._pauseBuffer) this._worker.postMessage({ type: 'init-pause-buffer', buffer: this._pauseBuffer });
        this._worker.postMessage({ type: 'sync-pause', isPaused: this._isPaused, swarmPaused: this._swarmPaused });
        // ⚡ LEVEL 2 DRM: Re-send core payload on worker respawn
        if (this._corePayload) this._worker.postMessage({ type: 'compile-core', id: 0, payload: this._corePayload, signature: this._coreSignature || null });

        this.log('[CDP] Worker thread spawned');
        return this._worker;
    }

    _workerEval(wsUrl, expression, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (this._pendingIpc.size > 20) { reject(new Error('ipc backpressure: too many pending calls')); return; }
            const worker = this._ensureWorker();
            const id = ++this._ipcId;
            const timer = setTimeout(() => { this._pendingIpc.delete(id); reject(new Error('ipc timeout')); }, timeoutMs);
            this._pendingIpc.set(id, { resolve, reject, timer });
            worker.postMessage({ type: 'eval', id, wsUrl, expression });
        });
    }

    _workerRawCdp(wsUrl, method, params = {}, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            if (this._pendingIpc.size > 20) { reject(new Error('ipc backpressure')); return; }
            const worker = this._ensureWorker();
            const id = ++this._ipcId;
            const timer = setTimeout(() => { this._pendingIpc.delete(id); reject(new Error('ipc timeout')); }, timeoutMs);
            this._pendingIpc.set(id, { resolve, reject, timer });
            worker.postMessage({ type: 'cdp-raw', id, wsUrl, method, params });
        });
    }

    _workerBurstInject(wsUrl, targetId, isPaused) {
        return new Promise((resolve, reject) => {
            if (this._pendingIpc.size > 20) { reject(new Error('ipc backpressure: too many pending calls')); return; }
            const worker = this._ensureWorker();
            const id = ++this._ipcId;
            const timer = setTimeout(() => { this._pendingIpc.delete(id); reject(new Error('ipc timeout')); }, 15000);
            this._pendingIpc.set(id, { resolve, reject, timer });
            worker.postMessage({ type: 'burst-inject', id, wsUrl, targetId, isPaused });
        });
    }

    _killWorker() {
        const workerRef = this._worker; this._worker = null;
        if (workerRef) {
            try { workerRef.postMessage({ type: 'shutdown' }); } catch (e) { }
            setTimeout(() => { try { workerRef.terminate(); } catch (e) { } }, 1000);
        }
    }

    _resetIdleTimer() {
        if (this._idleKillTimer) { clearTimeout(this._idleKillTimer); this._idleKillTimer = null; }
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

    setCommandFilters(blocked, allowed) {
        this.blockedCommands = blocked || []; this.allowedCommands = allowed || [];
        this._invalidateScriptCache();
    }

    async pushFilterUpdate(blocked, allowed) {
        if (this.sessions.size === 0) return;
        const hasFilters = (blocked.length > 0 || allowed.length > 0);
        const expr = `window.__AA_BLOCKED = ${JSON.stringify(blocked)}; window.__AA_ALLOWED = ${JSON.stringify(allowed)}; window.__AA_HAS_FILTERS = ${hasFilters}; 'filters-updated';`;
        for (const [targetId, info] of this.sessions) {
            try { await this._workerEval(info.wsUrl, expr); this.log(`[CDP] Pushed filter update to ${targetId.substring(0, 6)}`); } catch (e) { }
        }
    }

    async reinjectAll() {
        if (this.sessions.size === 0) return;
        this._getScript();
        for (const [targetId, info] of this.sessions) {
            try {
                const result = await this._workerBurstInject(info.wsUrl, targetId, this.isPaused) || 'unknown';
                this.log(`[CDP] Re-injected [${targetId.substring(0, 6)}] → ${result}`);
            } catch (e) { this.log(`[CDP] Reinject failed for ${targetId.substring(0, 6)}: ${e.message}`); }
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true; this.isPaused = false;
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
        this.isPaused = false; this.reinjectAll();
        this.log('[CDP] All sessions unpaused + re-injected');
        if (this.onStatusChange) this.onStatusChange();
    }

    stop() {
        this.isRunning = false; this.isPaused = false; this.disableSwarm();
        clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
        clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null;
        clearTimeout(this._idleKillTimer); this._idleKillTimer = null;
        for (const [targetId, info] of this.sessions) {
            this._workerEval(info.wsUrl, `window.__AA_PAUSED = true; if (window.__AA_OBSERVER) { window.__AA_OBSERVER.disconnect(); window.__AA_OBSERVER = null; } 'killed';`).catch(() => {});
        }
        this.sessions.clear(); this.sessionUrls.clear(); this.ignoredTargets.clear();
        this._ignoredTargetTTLs.clear(); this._sessionCursors.clear(); this._sessionFailCounts.clear();
        this._injectionFailCounts.clear(); this._connected = false;
        this._killWorker();
        // ⚡ FIX: Do NOT delete lock file on stop — closing a paused window must not unleash Swarm on other windows
        this.log('[CDP] Connection manager stopped');
    }

    // ⚡ DIRECT WINDOW INJECTION: Find a CDP session whose title contains the conversation name
    // Returns { targetId, wsUrl, title } or null
    findWindowByTitle(convTitle) {
        if (!convTitle || this.sessions.size === 0) return null;
        const needle = convTitle.toLowerCase().trim();
        for (const [targetId, info] of this.sessions) {
            const sessionTitle = (info.title || '').toLowerCase();
            // Match if the session title STARTS with the conversation title
            // e.g. convTitle="Building That Boy" matches "Building That Boy In Gaza"
            if (sessionTitle.includes(needle) || needle.includes(sessionTitle.substring(0, 20))) {
                // Skip the Manager/Launchpad — those are the sidebar, not individual windows
                if (sessionTitle === 'manager' || sessionTitle === 'launchpad') continue;
                // Skip vscode-file:// pages (editor webviews, not chat windows)
                if ((info.url || '').startsWith('vscode-file://')) continue;
                return { targetId, wsUrl: info.wsUrl, title: info.title };
            }
        }
        return null;
    }

    disableSwarm() {
        this.log('[Swarm] Disabling Swarm Engine');
        this._swarmLoopRunning = false;
        this.swarmPaused = false;
        if (this._swarmLogInterval) { clearTimeout(this._swarmLogInterval); this._swarmLogInterval = null; }
        if (this._swarmSessions) this._swarmSessions.clear();
        this._swarmConfig = null; this._swarmScript = null; this._recentClicks = [];
        if (this._activeScans) this._activeScans.clear();
        
        const killScript = 'window.__AA_SWARM_OBS=false;window.__AA_SWARM_PAUSED=false;window.__AA_SWARM_DEAD=true;' +
            'if(window.__AA_SWARM_TIMER)clearInterval(window.__AA_SWARM_TIMER);' +
            'if(window.__AA_SWEEP_TIMER)clearInterval(window.__AA_SWEEP_TIMER);"disabled"';
            
        for (const [targetId, info] of this.sessions) {
            this._workerEval(info.wsUrl, killScript, 2000).catch(() => {});
        }
    }

    getSessionCount() { return this.sessions.size; }
    getActivePort() { return this.activeCdpPort; }

    async connect() {
        if (!this.isRunning || this.isConnecting) return;
        this.isConnecting = true;
        try {
            const port = await this._findActivePort();
            if (!port) { this._scheduleReconnect(); return; }
            const targets = await this._getTargetList(port);
            if (!targets || targets.length === 0) { this.log('[CDP] No targets found'); this._scheduleReconnect(); return; }

            this._connected = true;
            if (this.onStatusChange) this.onStatusChange();

            const candidates = targets.filter(t => this._isCandidate(t));
            this.log(`[CDP] Found ${targets.length} targets, ${candidates.length} candidates`);

            this._getScript();
            for (let i = 0; i < candidates.length; i += 5) {
                await Promise.allSettled(candidates.slice(i, i + 5).map(t => this._handleNewTarget(t)));
            }

            this.log(`[CDP] ${this.sessions.size} sessions active after initial scan`);
            this._scheduleHeartbeat(); this._resetIdleTimer();

            for (const delay of [5000, 15000, 30000]) {
                setTimeout(async () => {
                    if (!this.isRunning || !this.activeCdpPort) return;
                    try {
                        const targets = await this._getTargetList(this.activeCdpPort);
                        if (!targets) return;
                        const newCandidates = targets.filter(t => this._isCandidate(t) && !this.sessions.has(t.id) && !this.ignoredTargets.has(t.id));
                        if (newCandidates.length > 0) {
                            this.log(`[CDP] Re-scan (${delay/1000}s) found ${newCandidates.length} new: ${newCandidates.map(c => c.title || c.id.substring(0,6)).join(', ')}`);
                            for (const t of newCandidates) await this._handleNewTarget(t);
                        }
                    } catch(e) {}
                }, delay);
            }
        } catch (e) {
            this.log(`[CDP] Connection error: ${e.message}`);
            this._scheduleReconnect();
        } finally { this.isConnecting = false; }
    }

    _isCandidate(targetInfo) {
        const type = targetInfo.type; const url = targetInfo.url || '';
        if (!url) return false;
        if (type === 'service_worker' || type === 'worker' || type === 'shared_worker') return false;
        if (url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank') return false;
        return type === 'page' || type === 'iframe' || url.includes('vscode-webview') || url.includes('webview');
    }

    async _handleNewTarget(targetInfo) {
        const { id: targetId, webSocketDebuggerUrl, type, url, title } = targetInfo;
        if (!targetId || !webSocketDebuggerUrl) return;
        const shortId = targetId.substring(0, 6);
        if (this.sessions.has(targetId) || this.ignoredTargets.has(targetId)) return;

        if (url) {
            const titleLower = (title || '').toLowerCase();
            const isSwarmTarget = titleLower === 'manager' || titleLower === 'launchpad' || url.includes('jetski-agent');
            if (!isSwarmTarget) {
                for (const [existingTid, info] of this.sessions) {
                    if (info.url && info.url === url) {
                        this.log(`[CDP] DIAG: Skipping ${shortId} (${(title || 'untitled').substring(0,20)}) — duplicate URL of ${existingTid.substring(0,6)}`);
                        this.ignoredTargets.add(targetId); this._ignoredTargetTTLs.set(targetId, Date.now() + 5 * 60 * 1000); 
                        return;
                    }
                }
            }
        }

        try {
            this._getScript();
            const result = await this._workerBurstInject(webSocketDebuggerUrl, targetId, this.isPaused) || 'unknown';

            if (result !== 'observer-installed' && result !== 'already-active') {
                if (result === 'no-window') {
                    this.ignoredTargets.add(targetId); this._ignoredTargetTTLs.set(targetId, Date.now() + 5 * 60 * 1000); 
                } else {
                    const count = (this._injectionFailCounts.get(targetId) || 0) + 1;
                    this._injectionFailCounts.set(targetId, count);
                    if (count >= 3) { this.ignoredTargets.add(targetId); this._ignoredTargetTTLs.set(targetId, Date.now() + 5 * 60 * 1000); }
                }
                return;
            }

            this.sessions.set(targetId, { url: url || '', wsUrl: webSocketDebuggerUrl, title: title || '' });
            this.sessionUrls.set(targetId, url || '');

            let initialCount = 0;
            try {
                const initCheck = await this._workerEval(webSocketDebuggerUrl, '(() => window.__AA_CLICK_COUNT || 0)()', 1500);
                initialCount = initCheck.result?.result?.value || 0;
            } catch (e) {}
            this._sessionCursors.set(targetId, initialCount);

            this.log(`[CDP] ✓ Injected [${shortId}] → ${result} cursor=${initialCount} (${(url || '').substring(0, 50)})`);

            if (this.isPaused && (result === 'observer-installed' || result === 'already-active')) {
                try { await this._workerEval(webSocketDebuggerUrl, 'window.__AA_PAUSED=true;"init-paused"', 2000); } catch(e) {}
            }

            const titleLower = (title || '').toLowerCase();
            const isJetski = (url || '').includes('jetski-agent');
            const isAgentTitle = titleLower === 'manager' || titleLower === 'launchpad';
            
            if (isJetski || isAgentTitle) {
                const isManager = titleLower === 'manager';
                if (!this._sidebarTargetId || (isManager && !this._sidebarTitleIsManager)) {
                    this._sidebarTargetId = targetId; this._sidebarWsUrl = webSocketDebuggerUrl; this._sidebarTitleIsManager = isManager;
                }

                if (isManager) {
                    if (!this._swarmSessions) this._swarmSessions = new Set();
                    this._swarmSessions.add(webSocketDebuggerUrl);
                    this.log(`[Swarm] Manager wsUrl added to scan targets: ${shortId}`);
                }

                const killLegacy = 'window.__AA_SWARM_OBS=false;window.__AA_SWARM_DEAD=true;' +
                    'if(window.__AA_SWARM_TIMER)clearInterval(window.__AA_SWARM_TIMER);' +
                    'if(window.__AA_SWEEP_TIMER)clearInterval(window.__AA_SWEEP_TIMER);"legacy-killed"';
                try { await this._workerEval(webSocketDebuggerUrl, killLegacy, 2000); } catch(e) {}

                if (this.isPaused || this.swarmPaused) {
                    this.log(`[Swarm] New target during pause — pausing sweep in ${shortId}`);
                    try {
                        let evalStr = 'window.__AA_SWARM_PAUSED=true;';
                        // ⚡ STRICT SEPARATION FIX: ONLY apply window.__AA_PAUSED if GLOBAL pause is enabled.
                        // Setting __AA_PAUSED kills the entire DOMObserver (Run/Accept stop working).
                        if (this.isPaused) evalStr += 'window.__AA_PAUSED=true;'; 
                        await this._workerEval(webSocketDebuggerUrl, evalStr + '"paused"', 2000);
                    } catch(e) {}
                } else {
                    // ⚡ CRITICAL: Explicitly CLEAR swarm pause so DOMObserver doesn't block 'allow' clicks
                    try { await this._workerEval(webSocketDebuggerUrl, 'window.__AA_SWARM_PAUSED=false;"swarm-active"', 2000); } catch(e) {}
                }

                setTimeout(() => { if (this._swarmScript) { this.injectSwarmObserver(this._swarmScript, targetId); } }, 1500);

                // ⚡ MANAGER MEMORY OPTIMIZER + HEAP PROBE
                // Fire for Manager OR Launchpad — same webview, different title
                if (isManager || isAgentTitle) {
                    setTimeout(async () => {
                        try {
                            const probe = await this._workerEval(webSocketDebuggerUrl, `(() => {
                                const r = {};
                                if (performance.memory) {
                                    r.heapMB = Math.round(performance.memory.usedJSHeapSize/1048576);
                                    r.heapTotalMB = Math.round(performance.memory.totalJSHeapSize/1048576);
                                    r.heapLimitMB = Math.round(performance.memory.jsHeapSizeLimit/1048576);
                                }
                                r.dom = document.querySelectorAll('*').length;
                                r.imgs = document.images.length;
                                r.iframes = document.querySelectorAll('iframe').length;
                                r.canvas = document.querySelectorAll('canvas').length;
                                r.styles = document.styleSheets.length;
                                r.scripts = document.querySelectorAll('script').length;
                                r.convos = document.querySelectorAll('[data-testid*="convo-pill"]').length;
                                const globals = {};
                                for (const k of Object.keys(window)) {
                                    try { const v=window[k]; if(v&&typeof v==='object'&&!(v instanceof HTMLElement)) {
                                        const s=JSON.stringify(v); if(s&&s.length>5000) globals[k]=Math.round(s.length/1024)+'KB';
                                    }} catch(e){}
                                }
                                r.largeGlobals = globals;
                                let lsKB=0; try { for(let i=0;i<localStorage.length;i++) { const k=localStorage.key(i); lsKB+=(k.length+(localStorage.getItem(k)||'').length)*2/1024; }} catch(e){}
                                r.localStorageKB = Math.round(lsKB);
                                r.lsKeys = []; try { for(let i=0;i<Math.min(localStorage.length,10);i++) r.lsKeys.push(localStorage.key(i)); } catch(e){}
                                r.perfResources = performance.getEntriesByType('resource').length;
                                return JSON.stringify(r);
                            })()`, 10000);
                            const val = probe?.result?.result?.value || probe?.result?.value || 'null';
                            this.log('[CDP] 🔍 HEAP: ' + val);
                        } catch (e) { this.log('[CDP] Heap probe failed: ' + e.message); }
                        this._injectMemoryOptimizer(webSocketDebuggerUrl).catch(() => {});
                    }, 5000);
                }
            }
        } catch (e) { this.log(`[CDP] [${shortId}] Inject error: ${e.message}`); }
    }

    _scheduleReconnect() {
        if (this.reconnectTimer || !this.isRunning) return;
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this.isRunning) this.connect(); }, 3000);
    }

    _scheduleHeartbeat() {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = setTimeout(async () => {
            await this._heartbeat();
            if (this.isRunning && (this.sessions.size > 0 || this._connected)) { this._scheduleHeartbeat(); }
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

            const candidates = targets.filter(t => this._isCandidate(t) && !this.sessions.has(t.id) && !this.ignoredTargets.has(t.id));
            if (candidates.length > 0) {
                this.log(`[CDP] Heartbeat found ${candidates.length} new targets: ${candidates.map(c => c.title || c.id.substring(0,6)).join(', ')}`);
                for (let i = 0; i < candidates.length; i += 5) {
                    await Promise.allSettled(candidates.slice(i, i + 5).map(t => this._handleNewTarget(t)));
                }
            }

            const activeIds = new Set(targets.map(t => t.id));
            const toPrune = [];
            for (const [targetId] of this.sessions) { if (!activeIds.has(targetId)) toPrune.push(targetId); }

            if (toPrune.length > 0) {
                const harvestExpr = '(() => { return window.__AA_CLICK_COUNT || 0; })()';
                for (let i = 0; i < toPrune.length; i += 5) {
                    await Promise.allSettled(toPrune.slice(i, i + 5).map(async (targetId) => {
                        const info = this.sessions.get(targetId);
                        if (info) {
                            try {
                                const r = await this._workerEval(info.wsUrl, harvestExpr, 1500);
                                const currentCount = r.result?.result?.value || 0;
                                const lastCount = this._sessionCursors.get(targetId) || 0;
                                const delta = (currentCount < lastCount) ? currentCount : (currentCount - lastCount);
                                if (this.onClickTelemetry && delta > 0) { this.onClickTelemetry(delta); }
                            } catch (e) { }
                        }
                        this.sessions.delete(targetId); this.sessionUrls.delete(targetId); this._sessionFailCounts.delete(targetId); this._sessionCursors.delete(targetId);
                        // ⚡ FIX: Prune dead Manager URLs from swarm scan targets
                        if (info && this._swarmSessions) this._swarmSessions.delete(info.wsUrl);
                        if (this._sidebarTargetId === targetId) {
                            this._sidebarTargetId = null; this._sidebarWsUrl = null; this._sidebarTitleIsManager = false;
                            if (this._swarmLogInterval) { clearInterval(this._swarmLogInterval); this._swarmLogInterval = null; }
                        }
                    }));
                }
            }

            const now = Date.now();
            for (const tid of this.ignoredTargets) {
                if (!activeIds.has(tid)) { this.ignoredTargets.delete(tid); this._ignoredTargetTTLs.delete(tid); }
                else if (this._ignoredTargetTTLs.has(tid) && now > this._ignoredTargetTTLs.get(tid)) {
                    this.ignoredTargets.delete(tid); this._ignoredTargetTTLs.delete(tid);
                }
            }

            for (const [tid] of this._injectionFailCounts) { if (!activeIds.has(tid)) this._injectionFailCounts.delete(tid); }

            if (this.sessions.size === 0) { this._resetIdleTimer(); this._heartbeatRunning = false; return; }

            const entries = [...this.sessions.entries()];
            const results = [];
            for (let i = 0; i < entries.length; i += 10) {
                const chunk = entries.slice(i, i + 10);
                const chunkResults = await Promise.allSettled(
                    chunk.map(async ([targetId, info]) => {
                        const check = await this._workerEval(info.wsUrl,
                            '(() => { const c = window.__AA_CLICK_COUNT || 0; const d = window.__AA_DIAG || []; window.__AA_DIAG = []; const cl = window.__AA_CLICK_LOG || []; window.__AA_CLICK_LOG = []; return { alive: !!window.__AA_PAUSED || (!!window.__AA_OBSERVER_ACTIVE && (Date.now() - (window.__AA_LAST_SCAN || 0)) < 120000), clickCount: c, diag: d, clickLog: cl, paused: !!window.__AA_PAUSED, swarmPaused: !!window.__AA_SWARM_PAUSED, lastInput: window.__AA_LAST_USER_INPUT || 0 }; })()'
                        );
                        const health = check.result?.result?.value || { alive: false, clickCount: 0, diag: null, clickLog: [], paused: false, swarmPaused: false, lastInput: 0 };
                        return { targetId, alive: health.alive, clickCount: health.clickCount, diag: health.diag, clickLog: health.clickLog || [], paused: health.paused, swarmPaused: health.swarmPaused, lastInput: health.lastInput };
                    })
                );
                results.push(...chunkResults);
            }

            const dead = [];
            for (let i = 0; i < results.length; i++) {
                const { status, value } = results[i];
                const targetId = entries[i][0]; const info = entries[i][1]; 

                if (status === 'fulfilled') {
                    const lastCount = this._sessionCursors.get(targetId) || 0;
                    const delta = (value.clickCount < lastCount) ? value.clickCount : (value.clickCount - lastCount);
                    if (this.onClickTelemetry && delta > 0) this.onClickTelemetry(delta);
                    this._sessionCursors.set(targetId, value.clickCount);

                    if (value.clickLog && value.clickLog.length > 0) {
                        for (const cl of value.clickLog) {
                            this.log(`[AutoAccept] CLICK in ${targetId.substring(0,6)}: text="${cl.text}" tag=${cl.tag} path=${cl.path}`);
                        }
                    }

                    if (value.lastInput && value.lastInput > (this._lastWebviewActivity || 0)) {
                        this._lastWebviewActivity = value.lastInput;
                    }

                    if (!value.alive) {
                        try {
                            this._getScript();
                            const result = await this._workerBurstInject(info.wsUrl, targetId, this.isPaused) || 'unknown';
                            if (result === 'observer-installed' || result === 'already-active') {
                                this._sessionFailCounts.delete(targetId);
                                if (this.isPaused) {
                                    try { await this._workerEval(info.wsUrl, 'window.__AA_PAUSED=true;"re-paused"', 2000); } catch(e) {}
                                }
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
                        this._sessionFailCounts.delete(targetId);
                    }
                } else {
                    const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                    this._sessionFailCounts.set(targetId, fc);
                    if (fc >= 3) { dead.push(targetId); }
                }
            }

            for (const tid of dead) {
                const info = this.sessions.get(tid);
                // ⚡ FIX: Prune dead Manager URLs from swarm scan targets
                if (info && this._swarmSessions) this._swarmSessions.delete(info.wsUrl);
                this.sessions.delete(tid); this.sessionUrls.delete(tid); this._sessionFailCounts.delete(tid); this._sessionCursors.delete(tid);
            }
            this._resetIdleTimer();
        } catch (e) { } finally { this._heartbeatRunning = false; }
    }

    _pingPort(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800, agent: false }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
            req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    _getTargetList(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json', timeout: 2000, agent: false }, (res) => {
                let data = ''; res.on('data', chunk => data += chunk);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
            });
            req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    async _findActivePort() {
        if (this.activeCdpPort && await this._pingPort(this.activeCdpPort)) return this.activeCdpPort;
        const configPort = this.getPort();
        if (await this._pingPort(configPort)) { this.activeCdpPort = configPort; return configPort; }
        return null;
    }

    async injectSwarmObserver(configString, targetId) {
        const tid = targetId || this._sidebarTargetId;
        const wsUrl = tid ? (this.sessions.get(tid)?.wsUrl || this._sidebarWsUrl) : this._sidebarWsUrl;

        if (!wsUrl || !configString) return false;

        let swarmConfig;
        try { swarmConfig = JSON.parse(configString); } catch (e) { swarmConfig = { authorized: true, icons: [], classes: [] }; }
        if (!swarmConfig || !swarmConfig.authorized) return false;

        this._swarmScript = configString;
        this._swarmConfig = swarmConfig;

        // ⚡ LEVEL 2 DRM: Compile core scanner in worker RAM from server payload
        if (swarmConfig.corePayload && swarmConfig.corePayload !== this._corePayload) {
            this._corePayload = swarmConfig.corePayload;
            this._coreSignature = swarmConfig.coreSignature || null;
            const worker = this._ensureWorker();
            worker.postMessage({ type: 'compile-core', id: ++this._ipcId, payload: this._corePayload, signature: this._coreSignature });
            this.log('[Swarm] Core payload sent to worker for in-RAM compilation');
        }

        try {
            await this._workerEval(wsUrl,
                'window.__AA_SWARM_OBS=false;' +
                'if(window.__AA_SWARM_TIMER){clearInterval(window.__AA_SWARM_TIMER);window.__AA_SWARM_TIMER=null}' +
                'if(window.__AA_SWEEP_TIMER){clearInterval(window.__AA_SWEEP_TIMER);window.__AA_SWEEP_TIMER=null}' +
                'window.__AA_SWARM_PAUSED=false;"legacy-js-killed"', 2000);
        } catch(e) {}

        if (!this._swarmSessions) this._swarmSessions = new Set();
        if (this._swarmSessions.has(wsUrl) && this._swarmLoopRunning) return true;

        this._swarmSessions.add(wsUrl);
        
        // ⚡ FIX: Do NOT clear the timeout if the loop is already running.
        // Let the active loop naturally pick up the new URL on its next sweep.
        if (!this._swarmLoopRunning) {
            this._runNativeSwarmLoop();
        }
        return true;
    }

    async _runNativeSwarmLoop() {
        if (this._swarmLoopRunning) return;
        this._swarmLoopRunning = true;
        this._recentClicks = this._recentClicks || [];
        if (!this._activeScans) this._activeScans = new Set();
        let _pollCycle = 0;

        const loop = async () => {
            if (!this.isRunning || (!this._swarmSessions?.size && !this._sidebarWsUrl)) {
                this._swarmLoopRunning = false; return;
            }

            _pollCycle++;

            // ⚡ CROSS-WINDOW SYNC: The file lock is the absolute source of truth
            try {
                if (fs.existsSync(SWARM_LOCK_FILE)) {
                    const raw = fs.readFileSync(SWARM_LOCK_FILE, 'utf8');
                    const lock = JSON.parse(raw);
                    // TTL Check protects against permanently locked files from crashed windows
                    if (lock.paused && (Date.now() - lock.ts < 12 * 60 * 60 * 1000)) {
                        if (!this.swarmPaused) {
                            this.log('[Swarm] Cross-window pause detected via lock file');
                            this.swarmPaused = true; // ⚡ Invoke setter to halt CDP targets
                            if (this.onSwarmPauseChange) this.onSwarmPauseChange(true);
                        }
                    } else {
                        // File is stale (>12h old), clean it up
                        try { fs.unlinkSync(SWARM_LOCK_FILE); } catch(e) {}
                        if (this.swarmPaused) {
                            this.log('[Swarm] Stale cross-window lock file ignored & removed');
                            this.swarmPaused = false;
                            if (this.onSwarmPauseChange) this.onSwarmPauseChange(false);
                        }
                    }
                } else if (this.swarmPaused) { // ⚡ Removed _localPauseOrigin check
                    this.log('[Swarm] Cross-window resume detected (lock file removed)');
                    this.swarmPaused = false; // ⚡ Invoke setter to awake CDP targets
                    if (this.onSwarmPauseChange) this.onSwarmPauseChange(false);
                }
            } catch(e) {}

            if (this.isPaused || this.swarmPaused) {
                if (_pollCycle % 5 === 0) this.log(`[Swarm] DIAG: Loop check PAUSED | isPaused=${this.isPaused} swarmPaused=${this.swarmPaused} cycle=${_pollCycle}`);
                this._swarmLogInterval = setTimeout(loop, 2500);
                return;
            }

            const idleMs = 20000; // v3.26.5: 8s→20s — prevent notification clicks stealing focus while user types
            const webviewActivity = this._lastWebviewActivity || 0;
            if (Date.now() - webviewActivity < idleMs) {
                if (_pollCycle % 5 === 0) this.log('[Swarm] User active in chat — deferring scan');
                this._swarmLogInterval = setTimeout(loop, 2000);
                return;
            }

            const now = Date.now();
            this._recentClicks = this._recentClicks.filter(c => now - c.time < 15000);

            // ⚡ v3.26.5: Only scan sidebar sessions — individual editor windows get Run/Accept
            // from the DOMObserver. Swarm bell/notification clicks on editor windows steal focus.
            const scanUrls = new Set(this._swarmSessions);
            if (this._sidebarWsUrl) scanUrls.add(this._sidebarWsUrl);
            if (this._sidebarTargetId) {
                const live = this.sessions?.get(this._sidebarTargetId);
                if (live?.wsUrl) scanUrls.add(live.wsUrl);
            }

            const recentClicksData = this._recentClicks;
            const currentIsPaused = this.isPaused;
            const currentSwarmPaused = this.swarmPaused;

            // ⚡ FIX: Strip massive corePayload from IPC loop — it's already compiled in worker RAM.
            // Sending it 4-6x/sec via structured clone was causing UI freezing.
            const lightweightConfig = { ...this._swarmConfig };
            delete lightweightConfig.corePayload;
            delete lightweightConfig.coreSignature;

            await Promise.allSettled(Array.from(scanUrls).map(async url => {
                if (this._activeScans.has(url)) return;
                this._activeScans.add(url);

                try {
                    const res = await new Promise((resolve, reject) => {
                        const worker = this._ensureWorker();
                        const id = ++this._ipcId;
                        const timer = setTimeout(() => { this._pendingIpc.delete(id); reject(new Error('ipc timeout')); }, 30000); 
                        this._pendingIpc.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg?.result ?? msg); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer });
                        this.log(`[Swarm] DIAG: Dispatching scan id=${id} | isPaused=${currentIsPaused} swarmPaused=${currentSwarmPaused} pauseFlags=[${this._pauseFlags ? this._pauseFlags[0]+','+this._pauseFlags[1] : 'null'}]`);
                        const isSidebar = url === this._sidebarWsUrl || (this._sidebarTargetId && url === this.sessions?.get(this._sidebarTargetId)?.wsUrl);
                        worker.postMessage({ type: 'pure-cdp-swarm-scan', id, wsUrl: url, isSidebar, recentClicks: recentClicksData, config: lightweightConfig, isPaused: currentIsPaused, swarmPaused: currentSwarmPaused, sentAt: Date.now() });
                    });

                    this.log(`[Swarm] DIAG: Result=${res?.status || 'null'} ${res?.matchText || res?.message || ''}`);
                    if (res && res.status === 'clicked') {
                        if (this.isPaused || this.swarmPaused) {
                            this.log(`[Swarm] DISCARD: Click AFTER pause (${res.matchText})`);
                        } else {
                            this.log(`[Swarm] CLICK: ${res.matchText} @ ID:${res.fingerprint}${res.isUrgent ? ' [URGENT]' : ''}`);
                            this._recentClicks.push({ id: res.fingerprint, type: res.matchText, isUrgent: res.isUrgent, time: Date.now() });
                        }
                    } else if (res && res.status === 'error') {
                        if (res.message) this.log(`[Swarm] DIAG: ${res.message}`);
                    } else if (res && res.status === 'unauthorized') {
                        // ⚡ EXPIRY HANDLER: Payload has expired or was never compiled
                        this.log(`[Swarm] 🛑 ${res.message || 'Unauthorized'}`);
                        if (res.message && res.message.includes('expired')) {
                            this.log('[Swarm] Payload expired — stopping loop. VS Code restart will refresh.');
                            this.disableSwarm();
                        }
                    } else if (res && res.status === 'aborted') {
                        this.log(`[Swarm] DIAG: Aborted: ${res.message}`);
                    } else if (res && res.status === 'diag') {
                        this.log(`[Swarm] ${res.message}`);
                    }
                } catch(err) { this.log(`[Swarm] DIAG: Error: ${err.message}`); }
                finally { this._activeScans.delete(url); }
            }));

            if (this._swarmLoopRunning && !this.isPaused && !this.swarmPaused) {
                this._swarmLogInterval = setTimeout(loop, 1500);
            } else if (this.isPaused || this.swarmPaused) {
                this.log('[Swarm] DIAG: Loop ended naturally due to pause (in-flight scan completed)');
            } else if (this._swarmLoopRunning) {
                this._swarmLogInterval = setTimeout(loop, 1500);
            }
        };

        loop();
    }

    _workerPureCdpSwarmScan(wsUrl, recentClicks, config, isPaused, swarmPaused) { }
    _closeWebSocket() { }
    _clearPending() { }

    // ⚡ MANAGER MEMORY OPTIMIZER: Reduce sidebar memory footprint
    // Strategy 1: CSS content-visibility:auto (Chromium skips rendering off-screen elements)
    // Strategy 2: Periodic DOM pruner (detaches very old message nodes)
    async _injectMemoryOptimizer(wsUrl) {
        if (!this._memOptUrls) this._memOptUrls = new Set();
        if (this._memOptUrls.has(wsUrl)) return;
        this._memOptUrls.add(wsUrl);

        try {
            const result = await this._workerEval(wsUrl, `
                (() => {
                    const OPT_VERSION = 2; // Bump to force re-inject on extension reload
                    if (window.__AA_MEM_OPT && window.__AA_MEM_OPT._version === OPT_VERSION) return 'already-active-v' + OPT_VERSION;
                    // Clean up old version if present
                    if (window.__AA_MEM_OPT && window.__AA_MEM_OPT.cleanup) {
                        try { window.__AA_MEM_OPT.cleanup(); } catch(e) {}
                        console.log('[AA-MemOpt] Cleaned up old version');
                    }

                    // ── STRATEGY 1: CSS Content-Visibility ──────────────────────
                    // Tells Chromium to skip layout/paint for off-screen messages.
                    // This alone can save 40-60% rendering memory.
                    const style = document.createElement('style');
                    style.id = '__aa-mem-optimizer';
                    style.textContent = \`
                        /* Message containers — skip rendering when off-screen */
                        [data-message-author-role],
                        [data-message-role],
                        .prose,
                        .leading-relaxed {
                            content-visibility: auto;
                            contain-intrinsic-size: auto 200px;
                        }
                        /* Code blocks — heavy renderers */
                        pre, .code-block, [class*="highlight"] {
                            content-visibility: auto;
                            contain-intrinsic-size: auto 150px;
                        }
                        /* Conversation list items in sidebar */
                        div[class*="select-none"][class*="cursor-pointer"][class*="rounded-md"] {
                            content-visibility: auto;
                            contain-intrinsic-size: auto 48px;
                        }
                    \`;
                    document.head.appendChild(style);
                    console.log('[AA-MemOpt] CSS content-visibility injected');

                    // ── STRATEGY 2: DOM Pruner ──────────────────────────────────
                    // Periodically check message count and detach old ones.
                    // Keeps last N messages, replaces old ones with lightweight placeholders.
                    const MAX_VISIBLE_MESSAGES = 40;
                    const PRUNE_INTERVAL = 30000; // 30s

                    function findMessageContainer() {
                        // Try multiple selectors for the scrollable chat area
                        const candidates = [
                            document.querySelector('.antigravity-agent-side-panel'),
                            document.querySelector('div[class*="overflow-y-auto"][class*="h-full"]'),
                            document.querySelector('div[class*="overflow-y"][class*="flex-col"]'),
                            document.querySelector('[role="log"]'),
                            document.querySelector('[role="main"] > div')
                        ].filter(Boolean);

                        for (const el of candidates) {
                            // Find the container with the most message-like children
                            const msgs = el.querySelectorAll('[data-message-author-role], [data-message-role], .prose, .leading-relaxed');
                            if (msgs.length > 3) return { container: el, selector: '[data-message-author-role], [data-message-role], .prose, .leading-relaxed' };
                        }
                        return null;
                    }

                    let pruneCount = 0;
                    let totalPruned = 0;

                    function pruneOldMessages() {
                        const found = findMessageContainer();
                        if (!found) {
                            console.log('[AA-MemOpt] Prune check: no message container found');
                            return;
                        }

                        const { container, selector } = found;
                        const messages = container.querySelectorAll(selector);

                        console.log('[AA-MemOpt] Prune check: ' + messages.length + ' messages found (max=' + MAX_VISIBLE_MESSAGES + ')');

                        if (messages.length <= MAX_VISIBLE_MESSAGES) return;

                        const toPrune = messages.length - MAX_VISIBLE_MESSAGES;
                        let pruned = 0;

                        for (let i = 0; i < toPrune; i++) {
                            const msg = messages[i];
                            if (msg.__aa_pruned) continue;

                            // Don't prune if element is near viewport (user scrolled up)
                            const rect = msg.getBoundingClientRect();
                            if (rect.bottom > -500 && rect.top < window.innerHeight + 500) continue;

                            // Replace heavy content with lightweight placeholder
                            const height = msg.offsetHeight;
                            msg.__aa_pruned = true;
                            msg.__aa_original_html = null; // Don't store — let it GC
                            msg.style.height = height + 'px';
                            msg.style.overflow = 'hidden';
                            msg.innerHTML = ''; // Free DOM nodes
                            pruned++;
                        }

                        if (pruned > 0) {
                            totalPruned += pruned;
                            pruneCount++;
                            console.log('[AA-MemOpt] ✂️ Pruned ' + pruned + ' messages (total=' + totalPruned + ', cycles=' + pruneCount + ')');
                        }
                    }

                    const pruneTimer = setInterval(pruneOldMessages, PRUNE_INTERVAL);

                    // ── STRATEGY 3: Image Lazy Loading ──────────────────────────
                    // Force all images to lazy-load
                    const imgObserver = new MutationObserver((mutations) => {
                        for (const m of mutations) {
                            for (const node of m.addedNodes) {
                                if (node.nodeType !== 1) continue;
                                const imgs = node.querySelectorAll ? node.querySelectorAll('img:not([loading])') : [];
                                for (const img of imgs) {
                                    img.loading = 'lazy';
                                    img.decoding = 'async';
                                }
                            }
                        }
                    });
                    imgObserver.observe(document.body, { childList: true, subtree: true });

                    window.__AA_MEM_OPT = {
                        _version: OPT_VERSION,
                        active: true,
                        pruneCount: () => pruneCount,
                        totalPruned: () => totalPruned,
                        cleanup: () => {
                            clearInterval(pruneTimer);
                            imgObserver.disconnect();
                            const s = document.getElementById('__aa-mem-optimizer');
                            if (s) s.remove();
                            window.__AA_MEM_OPT = null;
                        }
                    };

                    return 'mem-optimizer-installed (msgs=' + (findMessageContainer()?.container?.querySelectorAll('[data-message-author-role], [data-message-role], .prose, .leading-relaxed').length || 0) + ')';
                })()
            `, 5000);

            const resultVal = result?.result?.result?.value || result?.result?.value || 'unknown';
            this.log(`[CDP] ⚡ Manager Memory Optimizer: ${resultVal}`);
        } catch (e) {
            this._memOptUrls.delete(wsUrl);
            this.log(`[CDP] Memory optimizer injection failed: ${e.message}`);
        }
    }
}

module.exports = { ConnectionManager };
