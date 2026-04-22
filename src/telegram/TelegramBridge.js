/**
 * TelegramBridge — Connects VS Code to the Telegram bot relay via D1 polling.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TELEGRAM_WORKER_URL = 'https://aa-telegram.yazanbaker.workers.dev';
const POLL_INTERVAL = 1500; 
const CONVOS_PUSH_INTERVAL = 15000;  // 15s — responsive + dedup guard means writes only on change

class TelegramBridge {
    constructor({ log, machineId, licenseKey, connectionManager }) {
        this.log = log;
        this.machineId = machineId;
        this.licenseKey = licenseKey;
        this.cm = connectionManager;

        this._pollTimer = null;
        this._convosPushTimer = null;
        this._masterLockTimer = null;
        this._running = false;
        this._lastConvos = null;
        this._lastConvosJson = '';
        this._lastCmdTs = 0; 
        this._pollBusy = false; 
        
        // ⚡ P1 FIX: Strict processed ID tracking prevents D1 replica-lag duplicates
        this._processedCmdIds = new Set(); 
        this._lastSentText = '';
        this._lastSentTs = 0;
        
        this._activeWatcherTimer = null; 
        this._commandQueue = []; 
        this._watcherGenerations = new Map(); // ⚡ Per-window watcher generations (wsUrl → gen)
        this._processingCommand = false;
        this._wasMaster = false;
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._sidebarReady = false;

        // ⚡ FIX: Treat extension startup as active so it doesn't immediately deep sleep
        this._lastActive = Date.now();

        this.log('[Telegram] Bridge started — hybrid long-poll mode');
        this._masterLockLoop();
        this._watchForWindowChanges();
        // ⚡ FIX: All worker-dependent loops wait for HMAC key to be seeded first
        this._seedAuth().then(() => {
            this._fetchRemoteScripts();
            this._pollLoop();
            this._convosPushLoop();
        });
    }

    // ⚡ Seed HMAC auth key for existing users who paired before HMAC was added
    async _seedAuth() {
        try {
            const res = await this._post('/seed-auth', null, {
                'X-License-Key': this.licenseKey,
                'X-Machine-Id': this.machineId
            });
            if (res?.status === 'seeded') {
                this.log('[Telegram] 🔐 HMAC auth key seeded successfully');
            } else if (res?.status === 'not_paired') {
                this.log('[Telegram] ⚠️ Seed-auth: not paired yet');
            }
        } catch (e) {
            this.log(`[Telegram] Seed-auth error: ${e.message}`);
        }
    }

    stop() {
        this._running = false;
        if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
        if (this._convosPushTimer) { clearTimeout(this._convosPushTimer); this._convosPushTimer = null; }
        if (this._masterLockTimer) { clearTimeout(this._masterLockTimer); this._masterLockTimer = null; }
        if (this._activeWatcherTimer) { clearTimeout(this._activeWatcherTimer); this._activeWatcherTimer = null; }
        this.log('[Telegram] Bridge stopped');
    }

    // ⚡ Continuous window watcher: detects sidebar + session changes, triggers immediate sync
    _watchForWindowChanges() {
        if (!this._running) return;

        const currentSidebar = this.cm ? this.cm._sidebarWsUrl : null;
        const sessionCount = this.cm && this.cm.sessions ? this.cm.sessions.size : 0;

        let shouldPush = false;

        if (currentSidebar && !this._sidebarReady) {
            this._sidebarReady = true;
            this.log('[Telegram] Sidebar opened — triggering immediate sync');
            shouldPush = true;
        } else if (!currentSidebar && this._sidebarReady) {
            this._sidebarReady = false;
            this.log('[Telegram] Sidebar closed — triggering immediate sync');
            shouldPush = true;
        } else if (this._lastSessionCount !== undefined && this._lastSessionCount !== sessionCount) {
            this.log(`[Telegram] Active window count changed (${this._lastSessionCount} -> ${sessionCount}) — triggering immediate sync`);
            shouldPush = true;
        }

        this._lastSessionCount = sessionCount;

        if (shouldPush) {
            // Wake up the push loop immediately (debounced 500ms)
            if (this._convosPushTimer) clearTimeout(this._convosPushTimer);
            this._convosPushTimer = setTimeout(() => this._convosPushLoop(), 500);
        }

        // ⚡ FIX #7: Prune stale watcher generations to prevent memory leak
        // sessions is keyed by targetId, watcherGenerations by wsUrl — collect active wsUrls first
        if (this.cm && this._watcherGenerations.size > 0) {
            const activeWsUrls = new Set();
            // Include sidebar wsUrl (not tracked in sessions)
            if (this.cm._sidebarWsUrl) activeWsUrls.add(this.cm._sidebarWsUrl);
            if (this.cm.sessions) {
                for (const [, sess] of this.cm.sessions) {
                    if (sess.wsUrl) activeWsUrls.add(sess.wsUrl);
                }
            }
            for (const wsUrl of this._watcherGenerations.keys()) {
                if (!activeWsUrls.has(wsUrl)) {
                    this._watcherGenerations.delete(wsUrl);
                }
            }
        }

        // Watcher runs endlessly every 2 seconds (costs 0 API requests)
        this._activeWatcherTimer = setTimeout(() => this._watchForWindowChanges(), 2000);
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── Pairing ──────────────────────────────────────────────────────
    async requestPairingToken() {
        try {
            return await this._post('/pair', null, { 'X-License-Key': this.licenseKey, 'X-Machine-Id': this.machineId });
        } catch (e) {
            this.log(`[Telegram] Pairing error: ${e.message}`);
            return null;
        }
    }

    async unpair() {
        try {
            await this._post('/unpair', null, { 'X-Machine-Id': this.machineId });
            this.log('[Telegram] Unpaired');
            return true;
        } catch (e) { return false; }
    }

    // ── Master Election: Only one window polls Cloudflare ──────────
    async _checkMasterLock() {
        const lockFile = path.join(os.tmpdir(), `aa-tg-master-${this.machineId}.json`);
        try {
            if (fs.existsSync(lockFile)) {
                const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
                
                // ⚡ FIX: Detect dead PIDs from previous IDE reloads to instantly bypass 15s wait
                let isDead = false;
                if (lock.pid && lock.pid !== process.pid) {
                    try {
                        process.kill(lock.pid, 0); // 0 signal checks existence without killing
                    } catch (e) {
                        isDead = true; // Old IDE process is dead
                    }
                }

                if (Date.now() - lock.ts < 15000 && lock.pid !== process.pid && !isDead) {
                    if (this._wasMaster) { this.log('[Telegram] Lost Master role.'); this._wasMaster = false; }
                    return false;
                }
            }
            if (!this._wasMaster) {
                this._wasMaster = true;
                this.log('[Telegram] 👑 Claimed Master role. Orchestrating all windows globally.');
            }
            const tmp = lockFile + '.' + Math.random().toString(36).substring(2);
            fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() }));
            fs.renameSync(tmp, lockFile);
            return true;
        } catch (e) { return false; }
    }

    // ⚡ FIX #1: Independent lock maintenance loop (renews every 5s, well within 15s TTL)
    // Prevents split-brain when poll holds for 25s — lock won't expire during long-poll
    async _masterLockLoop() {
        if (!this._running) return;
        await this._checkMasterLock();
        this._masterLockTimer = setTimeout(() => this._masterLockLoop(), 5000);
    }

    // ── Polling Loop (Hybrid Long-Poll + Smart Backoff) ──────────
    async _pollLoop() {
        if (!this._running || this._pollBusy) return;

        // ⚡ FIX #1: Check cached master status (lock is maintained by _masterLockLoop)
        if (!this._wasMaster) {
            this._pollTimer = setTimeout(() => this._pollLoop(), 3000);
            return;
        }

        this._pollBusy = true;

        // ⚡ SMART IDLE DETECTION: Combines Telegram commands, IDE typing, and webview activity
        const ideActivity = this.cm && typeof this.cm.getLastUserActivity === 'function' ? this.cm.getLastUserActivity() : 0;
        const webviewActivity = this.cm ? (this.cm._lastWebviewActivity || 0) : 0;
        const effectiveLastActive = Math.max(this._lastActive || 0, ideActivity, webviewActivity);
        
        const timeSinceLastCmd = Date.now() - effectiveLastActive;
        const isAgentOpen = this.cm && this.cm._sidebarWsUrl;

        // ⚡ ALWAYS use long-polling (25s hold) — same latency, ~15x fewer requests
        let waitParam = 25;
        let restInterval = 5000; // Default: 25s hold + 5s sleep = 30s cycle

        if (timeSinceLastCmd < 60000) {
            // Burst mode: 25s hold + 1s sleep — instant response, ~2 req/min
            restInterval = 1000;
        } else if (!isAgentOpen) {
            // Deep sleep: 25s hold + 155s sleep = 180s cycle (saves ~40% daily requests)
            restInterval = 155000;
        } else if (timeSinceLastCmd < 5 * 60 * 1000) {
            // Active: 25s hold + 5s sleep = 30s cycle
            restInterval = 5000;
        } else {
            // Extended AFK: 25s hold + 155s sleep = 180s cycle
            restInterval = 155000;
        }

        try {
            // ⚡ Pass the ?wait parameter for long-polling
            const query = waitParam > 0 ? `?wait=${waitParam}` : '';
            const data = await this._get(`/poll${query}`, { 'X-Machine-Id': this.machineId }, 35000);

            if (data && data.cmds && Array.isArray(data.cmds)) {
                data.cmds.forEach(cmd => {
                    const uniqueId = cmd.cmdId || cmd.ts;
                    if (!this._processedCmdIds.has(uniqueId)) {
                        this._processedCmdIds.add(uniqueId);
                        if (this._processedCmdIds.size > 100) this._processedCmdIds.delete(this._processedCmdIds.keys().next().value);

                        this._lastCmdTs = Math.max(this._lastCmdTs, cmd.ts);
                        this._lastActive = Date.now();
                        this.log(`[Telegram] Received command: ${cmd.cmd} | delta=${cmd._delta || '?'}ms`);

                        restInterval = 1000; // Wake up instantly after receiving command
                        this._enqueueCommand(cmd);
                    }
                });
            }
        } catch (e) {
            // Silent timeout ignores for long-polling (expected after 25s hold)
            if (e.message !== 'timeout') this.log(`[Telegram] Poll error: ${e.message}`);
            restInterval = Math.max(restInterval, 10000); // Backoff on network drops
        }

        this._pollBusy = false;
        if (this._running) {
            this._pollTimer = setTimeout(() => this._pollLoop(), restInterval);
        }
    }

    async _convosPushLoop() {
        if (!this._running) return;

        if (!this._wasMaster) {
            if (this._running) this._convosPushTimer = setTimeout(() => this._convosPushLoop(), CONVOS_PUSH_INTERVAL);
            return;
        }

        const HEARTBEAT_INTERVAL = 300000; // 5 minutes
        
        // ⚡ FIX: Use same effectiveLastActive as poll loop (IDE + webview + Telegram activity)
        let loopInterval = CONVOS_PUSH_INTERVAL;
        const ideActivity = this.cm && typeof this.cm.getLastUserActivity === 'function' ? this.cm.getLastUserActivity() : 0;
        const webviewActivity = this.cm ? (this.cm._lastWebviewActivity || 0) : 0;
        const effectiveLastActive = Math.max(this._lastActive || 0, ideActivity, webviewActivity);
        const timeSinceLastCmd = Date.now() - effectiveLastActive;
        if (timeSinceLastCmd > 5 * 60 * 1000) {
            loopInterval = 30000; // Scan UI every 30s when AFK (costs 0 limits)
        }

        try {
            const convos = await this._scrapeConversations();
            
            const payloadToPush = convos || [];
            const json = JSON.stringify(payloadToPush);
            const timeSinceLastPush = Date.now() - (this._lastConvosPushTime || 0);
            const changed = json !== this._lastConvosJson;

            // Push if UI changed OR if it's time for a mandatory heartbeat
            if (changed || timeSinceLastPush >= HEARTBEAT_INTERVAL) {
                this._lastConvos = payloadToPush;
                this._lastConvosJson = json;
                this._lastConvosPushTime = Date.now();
                
                await this._post('/convos', payloadToPush, { 'X-Machine-Id': this.machineId });
                
                if (changed) {
                    if (payloadToPush.length > 0) {
                        this.log(`[Telegram] Pushed ${payloadToPush.length} conversations`);
                    } else {
                        this.log(`[Telegram] Sidebar gone / Idle — cleared D1 conversation list`);
                    }
                }
            }
        } catch (e) {}

        if (this._running) this._convosPushTimer = setTimeout(() => this._convosPushLoop(), loopInterval);
    }

    // ── Command Queue: processes one at a time with settle delay ───────
    _enqueueCommand(cmd) {
        // ⚡ PEEK BYPASS: Peek is instant — no navigation, no queue wait needed
        if (cmd.cmd === 'peek') {
            // ⚡ /peek N — extract index from text if present (e.g. "/peek 2")
            if (cmd.text) {
                const m = cmd.text.match(/(\d+)/);
                if (m) cmd.convIndex = parseInt(m[1]) - 1; // 1-indexed to 0-indexed
            }
            this._handlePeek(cmd).catch(e => this.log(`[Telegram] Peek error: ${e.message}`));
            return;
        }
        this._commandQueue.push(cmd);
        this._drainQueue();
    }

    async _drainQueue() {
        if (this._processingCommand || this._commandQueue.length === 0) return;
        this._processingCommand = true;

        while (this._commandQueue.length > 0) {
            let cmd = this._commandQueue.shift();

            // ── ⚡ AUTO-STITCHER: Reassemble Telegram's 4096-char split messages ──
            if (cmd.cmd === 'prompt' && !cmd.photoPath) {
                await this._sleep(1500); // Let concurrent chunks arrive
                while (this._commandQueue.length > 0 &&
                       this._commandQueue[0].cmd === 'prompt' &&
                       this._commandQueue[0].convIndex === cmd.convIndex &&
                       !this._commandQueue[0].photoPath &&
                       Math.abs(this._commandQueue[0].ts - cmd.ts) < 5000) {
                    const next = this._commandQueue.shift();
                    cmd.text += '\n\n' + (next.text || '');
                    this.log(`[Telegram] ✂️ Stitched chunk (total: ${cmd.text.length} chars)`);
                }
            }

            try {
                if (cmd.cmd === 'prompt') await this._handlePrompt(cmd);
                else if (cmd.cmd === 'peek') await this._handlePeek(cmd);
                else if (cmd.cmd === 'pause') {
                    if (this.cm) {
                        this.cm.isPaused = true;
                        this.cm.swarmPaused = true;  // Setter handles file lock + CDP broadcast
                        // Trigger the extension's onSwarmPauseChange callback to update status bar
                        if (typeof this.cm.onSwarmPauseChange === 'function') this.cm.onSwarmPauseChange(true);
                    }
                    this.log('[Telegram] ⏸ AutoAccept + Swarm paused remotely');
                    await this._sendResult('⏸ AutoAccept + Swarm paused.');
                }
                else if (cmd.cmd === 'resume') {
                    if (this.cm) {
                        this.cm.isPaused = false;
                        this.cm.swarmPaused = false;  // Setter handles file lock + CDP broadcast
                        this.cm._lastWebviewActivity = 0;  // Reset idle timers
                        if (typeof this.cm.onSwarmPauseChange === 'function') this.cm.onSwarmPauseChange(false);
                    }
                    this.log('[Telegram] ▶️ AutoAccept + Swarm resumed remotely');
                    await this._sendResult('▶️ AutoAccept + Swarm resumed.');
                }
                else if (cmd.cmd === 'stop') await this._handleStop();
                else this.log(`[Telegram] Unknown command: ${cmd.cmd}`);
            } catch (e) {
                this.log(`[Telegram] Command error: ${e.message}`);
            }

            if (this._commandQueue.length > 0) {
                // ⚡ AGENT-BUSY GUARD: Wait for agent to finish before injecting next prompt
                await this._waitForAgentIdle();
                this.log(`[Telegram] Waiting 2s for sidebar to settle (${this._commandQueue.length} queued)`);
                await this._sleep(2000);
            }
        }
        this._processingCommand = false;
    }

    // Wait for agent to finish generating (stop button gone) before next injection
    async _waitForAgentIdle() {
        if (!this.cm || !this.cm._sidebarWsUrl) return;
        const wsUrl = this.cm._sidebarWsUrl;
        const MAX_WAIT = 90000; // 90s max
        const startTime = Date.now();

        for (let i = 0; i < 60; i++) { // Check every 1.5s, up to 90s
            try {
                const result = await this.cm._workerEval(wsUrl, `
                    (() => {
                        const panel = document.querySelector('.antigravity-agent-side-panel') || document;
                        const stopBtn = panel.querySelector('button[aria-label*="stop"], button[aria-label*="Stop"], [class*="stop"]');
                        const progress = panel.querySelector('[class*="progress_activity"], [class*="animate-spin"]');
                        return !!(stopBtn || progress);
                    })()
                `, 3000);
                const isBusy = result?.result?.result?.value === true;
                if (!isBusy) {
                    if (i > 0) this.log(`[Telegram] Agent idle after ${Math.round((Date.now() - startTime) / 1000)}s`);
                    return;
                }
                if (i === 0) this.log('[Telegram] ⏳ Agent still generating — waiting for completion before next inject...');
            } catch (e) { /* V8 frozen during render, keep waiting */ }

            if (Date.now() - startTime > MAX_WAIT) {
                this.log('[Telegram] Agent busy timeout (90s) — proceeding anyway');
                return;
            }
            await this._sleep(1500);
        }
    }

    // ── Prompt Handler ──────────────────────────────────────────────
    async _handlePrompt({ convIndex, convTitle, text, photoPath }) {
        // ⚡ INSTANT ROUTING: If this is an individual window from cross-port scan, route directly
        const targetConvo = this._lastConvos && this._lastConvos[convIndex];
        if (targetConvo && targetConvo.isIndividual) {
            this.log(`[Telegram] 🎯 Direct multi-port routing to window: ${targetConvo.rawTitle}`);
            try {
                await this._handleDirectWindowPrompt({
                    wsUrl: targetConvo.wsUrl,
                    targetId: targetConvo.targetId,
                    title: targetConvo.rawTitle
                }, { convTitle: targetConvo.rawTitle, text, photoPath });
                return;
            } catch (e) {
                this.log(`[Telegram] Direct window injection failed: ${e.message}`);
                await this._sendResult(`❌ Error routing to window: ${e.message}`);
                return;
            }
        }

        if (!this.cm || !this.cm._sidebarWsUrl) {
            await this._sendResult('❌ Not connected to Agent Manager. Open Antigravity with the agent panel visible.');
            return;
        }

        // ⚡ DIRECT WINDOW PATH: Check if an individual chat window exists for this conversation.
        // If found, inject directly — no sidebar navigation, no Swarm pause, no race conditions!
        const directWindow = this.cm.findWindowByTitle(convTitle);
        if (directWindow) {
            this.log(`[Telegram] 🎯 Direct window found for "${convTitle}" → ${directWindow.targetId.substring(0, 6)} (${directWindow.title})`);
            try {
                await this._handleDirectWindowPrompt(directWindow, { convTitle, text, photoPath });
                return; // Success — skip sidebar path entirely
            } catch (e) {
                this.log(`[Telegram] Direct window injection failed, falling back to sidebar: ${e.message}`);
                // Fall through to sidebar path
            }
        }

        try {
            // _watcherGeneration used only for sidebar path — per-window tracking in _watchForResponse
            const t0 = Date.now();

            // ⚡ CANCEL STALE RESTORE: If a previous prompt's 20s timer is still pending,
            // cancel it now — we're taking over the pause lifecycle
            if (this._tgSwarmRestoreTimer) {
                clearTimeout(this._tgSwarmRestoreTimer);
                this._tgSwarmRestoreTimer = null;
                this.log('[Telegram] 🧹 Cancelled stale swarm restore timer from previous prompt');
            }

            // ⚡ KILL PREVIOUS SIDEBAR WATCHER: If a previous sidebar-path prompt left
            // a watcher polling, kill it now — we're about to navigate away from that chat
            if (this._activeSidebarWatcher) {
                const { wsUrl: prevWsUrl, watcherId: prevWId } = this._activeSidebarWatcher;
                const prevGenId = this._watcherGenerations.get(prevWsUrl) || 0;
                this._watcherGenerations.set(prevWsUrl, prevGenId + 1); // bump gen to kill checkFn loop
                this._cleanupWatcher(prevWsUrl, prevWId);
                this.log(`[Telegram] 🧹 Killed previous sidebar watcher: ${prevWId}`);
                this._activeSidebarWatcher = null;
            }

            // ⚡ NUCLEAR PAUSE: Use swarmPaused (not just isPaused) to broadcast
            // window.__AA_SWARM_OBS=false directly into the sidebar DOM. This kills
            // any in-flight scanner that already passed the worker-level pause check.
            this.log('[Telegram] 🔒 Hard-pausing Swarm for navigate cycle');
            this.cm.isPaused = true;
            this.cm.swarmPaused = true; // ⚡ DOM-level kill broadcast
            this._touchSwarmDefer();
            
            // ⚡ PAUSE DRAIN: Wait for any in-flight Swarm scans to complete
            // swarmPaused broadcast kills DOM-level scanners, but worker scans may
            // still be mid-execution — wait for them to finish harmlessly
            await this._sleep(1500);
            this.cm.isPaused = true; // Re-assert after drain
            this.cm.swarmPaused = true; // Re-assert after drain

            // 1. Navigate
            const navResult = await this._navigateToConversation(convIndex, convTitle);
            this._touchSwarmDefer();
            this.log(`[Telegram] ⏱️ navigate: ${Date.now() - t0}ms`);
            
            if (!navResult) {
                // Restore swarm before throwing
                this.cm.isPaused = false;
                this.cm.swarmPaused = false;
                this.log('[Telegram] 🔓 Swarm restored (nav failed)');
                throw new Error(`Could not navigate to *${convTitle}*. Agent may have been closed or is hidden.`);
            }

            // ⚡ POST-NAV VERIFICATION: Check Swarm didn't steal focus during pause race
            // Re-navigate up to 2 times if needed
            for (let verify = 0; verify < 2; verify++) {
                await this._sleep(500);
                const inputReady = await this._checkInputReady(this.cm._sidebarWsUrl);
                if (inputReady) break;
                
                this.log(`[Telegram] ⚠️ Post-nav check failed (attempt ${verify + 1}/2) — re-navigating`);
                this.cm.isPaused = true; // Re-assert pause
                this._touchSwarmDefer();
                await this._navigateToConversation(convIndex, convTitle);
                this._touchSwarmDefer();
            }

            // 2. ⚡ VISUAL BRIDGE: Paste Telegram photo into chat via CDP
            if (photoPath) {
                this.log(`[Telegram] 🖼️ Downloading image from proxy...`);
                const fetchUrlObj = new URL(`${TELEGRAM_WORKER_URL}/proxy-img?path=${encodeURIComponent(photoPath)}`);
                const signedHeaders = this._signHeaders('GET', '/proxy-img');
                
                const imageBase64 = await new Promise((resolve, reject) => {
                    https.get({
                        hostname: fetchUrlObj.hostname,
                        path: fetchUrlObj.pathname + fetchUrlObj.search,
                        headers: signedHeaders
                    }, res => {
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
                        res.on('error', reject);
                    }).on('error', reject);
                });

                this.log(`[Telegram] 🖼️ Image downloaded (${Math.round(imageBase64.length / 1024)}KB b64). Pasting via CDP...`);
                await this.cm._workerEval(this.cm._sidebarWsUrl, `
                    (async () => {
                        try {
                            // ⚡ Zero-blocking async native browser decoding (no for loop freeze)
                            const res = await fetch('data:image/jpeg;base64,${imageBase64}');
                            const blob = await res.blob();
                            const file = new File([blob], 'upload.jpg', { type: 'image/jpeg' });
                            const dt = new DataTransfer();
                            dt.items.add(file);
                            
                            const input = document.querySelector('[contenteditable="true"][role="textbox"]:not(.xterm-helper-textarea)');
                            if (input) {
                                input.focus();
                                input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
                            }
                            return 'pasted';
                        } catch(e) { return e.message; }
                    })()
                `, 10000);
                
                await this._sleep(1000); // Let React attach the thumbnail
            }

            // 3. Inject text (or just Enter for image-only)
            if (text) {
                const t1 = Date.now();
                const injected = await this._injectPromptBatched(this.cm._sidebarWsUrl, text);
                this.log(`[Telegram] ⏱️ batch-inject: ${Date.now() - t1}ms (total: ${Date.now() - t0}ms)`);
                if (!injected) throw new Error(`Could not inject prompt into *${convTitle}*. Input field not visible.`);
            } else if (photoPath) {
                // Image with no caption — just hit Enter
                const wsUrl = this.cm._sidebarWsUrl;
                await this.cm._workerRawCdp(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                await this.cm._workerRawCdp(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            }

            this.log(`[Telegram] Prompt injected into "${convTitle}": "${(text || '[photo]').substring(0, 60)}"`);
            await this._sendResult(`⚡ Agent *${convTitle}* received your prompt. Working...`);

            // ⚡ DELAYED SWARM RESTORE: Keep Swarm paused for 20s to let agent start responding.
            // This prevents Swarm from stealing the sidebar before the watcher captures the response.
            // ⚡ FIX: Always restore to false/false — never snapshot prev state (which may be paused by a prior prompt)
            this._touchSwarmDefer();
            this.log('[Telegram] 🔒 Swarm held paused for 20s (agent startup window)');
            if (this._tgSwarmRestoreTimer) clearTimeout(this._tgSwarmRestoreTimer);
            this._tgSwarmRestoreTimer = setTimeout(() => {
                if (this.cm) {
                    this.cm.isPaused = false;
                    this.cm.swarmPaused = false;
                    this._touchSwarmDefer();
                    this.log('[Telegram] 🔓 Swarm auto-restored after 20s hold');
                }
            }, 20000);

            this._tgTargetConvTitle = convTitle;
            this._tgTargetConvIndex = convIndex;

            // 4. Watch for agent response (with reclaim navigation)
            // Pass the individual chat wsUrl if we switched targets
            this._watchForResponse(convTitle, null, this._individualChatWsUrl || undefined);

            // ⚡ RESTORE SIDEBAR URL: If we switched to editor target for individual chat,
            // restore the original sidebar URL so Swarm doesn't target the editor workbench
            if (this._originalSidebarWsUrl && this.cm) {
                this.cm._sidebarWsUrl = this._originalSidebarWsUrl;
                this.log('[Telegram] 🔄 Restored original sidebar wsUrl (editor target was temporary)');
                this._originalSidebarWsUrl = null;
                this._individualChatWsUrl = null;
            }

        } catch (e) {
            // Always restore swarm on error — always to false/false
            if (this._tgSwarmRestoreTimer) { clearTimeout(this._tgSwarmRestoreTimer); this._tgSwarmRestoreTimer = null; }
            if (this._originalSidebarWsUrl && this.cm) {
                this.cm._sidebarWsUrl = this._originalSidebarWsUrl;
                this._originalSidebarWsUrl = null;
            }
            if (this.cm) { this.cm.isPaused = false; this.cm.swarmPaused = false; }
            this.log(`[Telegram] 🔓 Swarm restored (error path)`);
            this.log(`[Telegram] Prompt injection error: ${e.message}`);
            await this._sendResult(`❌ Error: ${e.message}`);
        }
    }

    // ⚡ DIRECT WINDOW INJECTION: Inject prompt directly into an individual chat window
    // No sidebar navigation, no Swarm pause, no race conditions!
    async _handleDirectWindowPrompt(window, { convTitle, text, photoPath }) {
        const { wsUrl, targetId, title } = window;
        // Per-window generation tracked in _watchForResponse
        const t0 = Date.now();

        // 1. Focus the chat input — SCOPED to agent panel, select all existing text
        const focusExpr = `(() => {
            const panel = document.querySelector('.antigravity-agent-side-panel');
            const scope = panel || document;
            const input = scope.querySelector('[contenteditable="true"][role="textbox"]:not(.xterm-helper-textarea)');
            
            if (input && input.offsetParent !== null) {
                input.focus();
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(input);
                sel.removeAllRanges();
                sel.addRange(range);
                return 'ready';
            }
            return 'not-found';
        })()`;

        const focusRes = await this.cm._workerEval(wsUrl, focusExpr, 5000);
        const focusVal = focusRes?.result?.result?.value || 'unknown';
        this.log(`[Telegram] 🎯 Direct focus result: ${focusVal}`);

        if (focusVal !== 'ready') {
            throw new Error('No input field found in direct window');
        }

        // 2. Use CDP Input.insertText — triggers React state properly (unlike textContent)
        await this.cm._workerRawCdp(wsUrl, 'Input.insertText', { text: text || '' });

        // 3. Upload photo if present
        if (photoPath) {
            try {
                this.log(`[Telegram] 🖼️ Downloading image from proxy for direct window...`);
                const fetchUrlObj = new URL(`${TELEGRAM_WORKER_URL}/proxy-img?path=${encodeURIComponent(photoPath)}`);
                const signedHeaders = this._signHeaders('GET', '/proxy-img');
                const photoB64 = await new Promise((resolve, reject) => {
                    https.get({
                        hostname: fetchUrlObj.hostname,
                        path: fetchUrlObj.pathname + fetchUrlObj.search,
                        headers: signedHeaders
                    }, res => {
                        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
                        res.on('error', reject);
                    }).on('error', reject);
                });
                const mimeType = photoPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
                await this.cm._workerEval(wsUrl, `(() => {
                    const panel = document.querySelector('.antigravity-agent-side-panel');
                    const scope = panel || document;
                    const input = scope.querySelector('[contenteditable="true"][role="textbox"]');
                    if (input) {
                        const b64 = '${photoB64}';
                        const byteChars = atob(b64);
                        const byteArray = new Uint8Array(byteChars.length);
                        for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
                        const file = new File([byteArray], 'photo.jpg', { type: '${mimeType}' });
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
                        return 'photo-pasted';
                    }
                    return 'no-input-for-photo';
                })()`, 10000);
            } catch (e) {
                this.log(`[Telegram] Photo upload to direct window failed: ${e.message}`);
            }
        }

        // 4. Press Enter to submit — ZERO delay burst like _injectPromptBatched
        await this.cm._workerRawCdp(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await this.cm._workerRawCdp(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

        this.log(`[Telegram] 🎯 Direct window prompt sent to "${title}" (convTitle="${convTitle}") in ${Date.now() - t0}ms`);
        await this._sendResult(`⚡ Agent *${convTitle}* received your prompt (direct window). Working...`);

        // 5. Watch for response — reuse the same watcher but with the direct window's wsUrl
        this._tgTargetConvTitle = convTitle;
        this._watchForResponse(convTitle, null, wsUrl);
    }

    // ── Response Watcher: MutationObserver (State Machine) ──────────
    async _watchForResponse(convTitle, _unusedGen, overrideWsUrl) {
        const wsUrl = overrideWsUrl || this.cm?._sidebarWsUrl;
        if (!wsUrl) return;

        // ⚡ PER-WINDOW GENERATION: Each wsUrl gets its own counter so concurrent
        // watchers on different windows don't kill each other
        const prevGen = this._watcherGenerations.get(wsUrl) || 0;
        const generationId = prevGen + 1;
        this._watcherGenerations.set(wsUrl, generationId);

        const watcherId = `__tgWatch_${Date.now()}`;
        this._currentWatcherId = watcherId;

        // ⚡ RETRY LOOP: V8 may still be frozen from history render — retry watcher injection
        let watcherInjected = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                // First: kill any surviving old watchers on THIS window only
                // (Other windows keep their watchers alive for concurrent prompts)
                await this.cm._workerEval(wsUrl, `
                    (() => {
                        for (const key of Object.keys(window)) {
                            if (key.startsWith('__tgWatch_')) {
                                const w = window[key];
                                if (w && w._observer) { try { w._observer.disconnect(); } catch(e){} }
                                if (w && w._fallback) { try { clearInterval(w._fallback); } catch(e){} }
                                if (w && w._quiet) { try { clearTimeout(w._quiet); } catch(e){} }
                                delete window[key];
                            }
                        }
                    })()
                `, 10000); // 10s — V8 freezes for 10-20s when agent starts

                // ⚡ DEEPTHINK FIX: Node Identity Tracking + Visibility Filtering
                // ⚡ REMOTE CODE: Selectors injected from worker
                const _sels = this._scripts?.selectors;
                const _asstSels = JSON.stringify(_sels?.assistant || [
                    '[data-message-author-role="assistant"]',
                    '[data-message-role="assistant"]',
                    '.rendered-markdown:not([data-message-author-role="user"]):not([data-message-role="user"])',
                    '[class*="markdown-body"]:not([data-message-author-role="user"]):not([data-message-role="user"])',
                    '.prose:not([data-message-author-role="user"]):not([data-message-role="user"])',
                    '.leading-relaxed.select-text'
                ]);
                const _scopeSels = JSON.stringify(_sels?.scopes || [
                    '.antigravity-agent-side-panel',
                    '#conversation',
                    'div[class*="w-full"][class*="flex"][class*="h-full"][class*="overflow-y-auto"]'
                ]);
                const _stopBtnSel = _sels?.stopButton || '[data-tooltip-id="input-send-button-cancel-tooltip"]';
                const _stopPat = _sels?.stopTextPatterns || '^(stop|stop generating|cancel)$';
                const _thinkSel = _sels?.thinkingBlocks || 'details, [class*="thinking"], [class*="thought"], [class*="reasoning"], [class*="collapsed"], [class*="collapsible"], [data-type="thinking"], [data-type="thought"]';
                const _chromeSel = _sels?.uiChrome || 'button, [role="button"], .material-icons, .codicon, svg, [class*="action"], span.hidden, style, link[rel="stylesheet"]';
                const _panelSel = _sels?.panel || '.antigravity-agent-side-panel';

                await this.cm._workerEval(wsUrl, `
                    (() => {
                        const WID = '${watcherId}';
                        window[WID] = { status: 'watching', text: null, ts: Date.now(), rect: null };
                        let lastMutationTime = Date.now();
                        let quietCheckTimer = null;
                        let stopEverSeen = false;
                        let agentStarted = false;

                        // ⚡ BUG A FIX: Visibility filter — VS Code caches hidden DOM from other chats
                        function isVisible(el) { return el && el.offsetParent !== null; }

                        const _STOP_SEL = '${_stopBtnSel}';
                        const _STOP_PAT = new RegExp('${_stopPat}');
                        function hasStopButton() {
                            const tb = document.querySelector(_STOP_SEL);
                            if (isVisible(tb)) return true;
                            const btns = document.querySelectorAll('button, [role="button"]');
                            for (let i = 0; i < btns.length; i++) {
                                if (!isVisible(btns[i])) continue;
                                const t = (btns[i].textContent || '').trim().toLowerCase();
                                const a = (btns[i].getAttribute('aria-label') || '').trim().toLowerCase();
                                if (_STOP_PAT.test(t) || _STOP_PAT.test(a)) return true;
                            }
                            return false;
                        }

                        let _rd = false;

                        const _ASST_SELS = ${_asstSels};
                        const _SCOPE_SELS = ${_scopeSels};
                        function getLastResponseNode() {
                            const scopes = _SCOPE_SELS.map(s => document.querySelector(s)).filter(isVisible);
                            scopes.push(document.body);

                            for (const scope of scopes) {
                                for (const sel of _ASST_SELS) {
                                    const nodes = Array.from(scope.querySelectorAll(sel)).filter(isVisible);
                                    if (nodes.length > 0) {
                                        if (!_rd) {
                                            _rd = true;
                                            window[WID]._matchedSel = sel;
                                            window[WID]._matchedScope = scope.id || scope.className?.substring(0, 40) || scope.tagName;
                                        }
                                        return nodes[nodes.length - 1];
                                    }
                                }
                            }
                            if (!_rd) { _rd = true; window[WID]._noMatch = true; }
                            return null;
                        }

                        function extractText(node) {
                            if (!node) return '';
                            const clone = node.cloneNode(true);
                            // Remove UI chrome
                            const trash = clone.querySelectorAll('${_chromeSel}');
                            for (let i = 0; i < trash.length; i++) trash[i].remove();
                            // ⚡ THINKING FILTER: Strip thinking/reasoning blocks
                            const thinkTrash = clone.querySelectorAll('${_thinkSel}');
                            // ⚡ DEBUG: Log what thinking elements we found and stripped
                            if (thinkTrash.length > 0) {
                                const thinkDbg = [];
                                for (let i = 0; i < thinkTrash.length; i++) {
                                    const el = thinkTrash[i];
                                    thinkDbg.push({ tag: el.tagName, cls: (el.className||'').substring(0,60), textLen: (el.textContent||'').length, preview: (el.textContent||'').substring(0,80) });
                                }
                                window[WID]._thinkStripped = thinkDbg;
                            }
                            for (let i = 0; i < thinkTrash.length; i++) thinkTrash[i].remove();
                            let t = (clone.innerText || clone.textContent || '').trim();
                            // Strip leftover thinking headers
                            const beforeThinkStrip = t.length;
                            t = t.replace(/^(Thinking\\.{3}|Thought for \\d+[ms\\s]+seconds?)\\s*/gi, '');
                            if (t.length !== beforeThinkStrip) window[WID]._thinkHeaderStripped = beforeThinkStrip - t.length;
                            return t.replace(/(alternate_email|content_copy|more_vert|archive|fork_right|edit|delete|refresh)/g, '').trim();
                        }

                        // ⚡ BASELINE: Store EXACT DOM node memory pointer
                        let baselineNode = getLastResponseNode();
                        let baselineText = extractText(baselineNode);
                        // DEBUG: Store baseline info for external diagnostics
                        window[WID]._baselineLen = baselineText.length;
                        window[WID]._baselinePreview = baselineText.substring(0, 60);
                        window[WID]._baselineHasNode = !!baselineNode;
                        let activeResponseNode = null;
                        let _lic = !!(baselineNode && baselineText.length > 20 && !hasStopButton());

                        function complete(reason) {
                            const targetNode = activeResponseNode || getLastResponseNode();
                            const text = extractText(targetNode);
                            const isStop = hasStopButton();
                            // ⚡ DEBUG: FULL STATE DUMP on every complete() call
                            const _dbg = {
                                reason,
                                textLen: (text||'').length,
                                textPreview: (text||'').substring(0, 120),
                                stopBtn: isStop,
                                agentStarted,
                                stopEverSeen,
                                sameNode: targetNode === baselineNode,
                                elapsed: Math.round((Date.now() - _injAt) / 1000),
                                quietMs: Date.now() - lastMutationTime,
                                thinkStripped: window[WID]?._thinkStripped || null,
                                thinkHeaderStripped: window[WID]?._thinkHeaderStripped || 0
                            };
                            console.log('[AA-Watcher] complete() called:', JSON.stringify(_dbg));

                            // ⚡ ANTI-PREMATURE GUARD: If stop button is STILL visible, agent is still generating.
                            // Don't complete unless this is an absolute timeout.
                            if (isStop && reason !== 'timeout') {
                                console.log('[AA-Watcher] BLOCKED: stop button still visible, reason=' + reason + ' — waiting for agent to finish');
                                window[WID]._blockedComplete = _dbg;
                                return;
                            }

                            if (agentStarted || (targetNode && targetNode !== baselineNode) || (text && text.length > 5 && text !== baselineText)) {
                                let rect = null;
                                if (targetNode) {
                                    try {
                                        targetNode.style.maxHeight = 'none';
                                        targetNode.style.overflow = 'visible';
                                        targetNode.querySelectorAll('pre').forEach(p => { p.style.maxHeight = 'none'; p.style.overflow = 'visible'; });
                                        
                                        // ⚡ FIX: Scroll the last child into view for better framing
                                        const lastChild = targetNode.lastElementChild || targetNode;
                                        lastChild.scrollIntoView({ block: 'end' });
                                        
                                        const r = targetNode.getBoundingClientRect();
                                        // Scope to agent panel bounds (excludes toolbar/status bar)
                                        const panel = document.querySelector('.antigravity-agent-side-panel') || document.body;
                                        const panelRect = panel.getBoundingClientRect();
                                        const panelBot = Math.min(window.innerHeight, panelRect.bottom);
                                        
                                        const visTop = Math.max(0, Math.max(r.top, panelRect.top));
                                        const visBot = Math.min(panelBot, r.bottom);
                                        const visH = visBot - visTop;
                                        if (r.width > 10 && visH > 10) {
                                            rect = { x: Math.max(0, Math.round(r.x) - 15), y: Math.max(0, Math.round(visTop) - 15),
                                                     width: Math.round(r.width) + 30, height: Math.round(visH) + 30 };
                                        }
                                    } catch (e) {}
                                }
                                window[WID] = { status: 'done', text: text || '(Empty response)', ts: Date.now(), reason, rect, _baselineLen: baselineText.length, _baselinePreview: baselineText.substring(0, 40), _capturedPreview: (text||'').substring(0, 40), _sameNode: (targetNode === baselineNode), _nodeChanged: !!(activeResponseNode && activeResponseNode !== baselineNode), _debugState: _dbg };
                                observer.disconnect();
                                clearInterval(fallbackInterval);
                                clearTimeout(quietCheckTimer);
                            }
                        }

                        const _injAt = Date.now();
                        let debounceTimer = null;

                        const observer = new MutationObserver((mutations) => {
                            lastMutationTime = Date.now();
                            // ⚡ SYNCHRONOUS STOP CHECK: Catch fast-disappearing stop buttons
                            if (!agentStarted && !stopEverSeen) {
                                for (let i = 0; i < mutations.length; i++) {
                                    if (mutations[i].addedNodes.length > 0 && hasStopButton()) {
                                        agentStarted = true;
                                        stopEverSeen = true;
                                        break;
                                    }
                                }
                            }
                            if (debounceTimer) return;
                            debounceTimer = setTimeout(() => {
                                debounceTimer = null;
                                const isStreaming = hasStopButton();
                                const currentNode = getLastResponseNode();

                                if (!agentStarted) {
                                    if (isStreaming) {
                                        agentStarted = true;
                                    } else if (currentNode && baselineNode && currentNode !== baselineNode) {
                                        // ⚡ NODE IDENTITY CHANGE: New DOM bubble — instant trigger
                                        agentStarted = true;
                                        activeResponseNode = currentNode;
                                    } else if (Date.now() - _injAt > 3000) {
                                        if (extractText(currentNode) !== baselineText) {
                                            agentStarted = true;
                                            activeResponseNode = currentNode;
                                        }
                                    }
                                }

                                if (currentNode && currentNode !== baselineNode) activeResponseNode = currentNode;

                                if (isStreaming && !stopEverSeen) {
                                    stopEverSeen = true;
                                    agentStarted = true;
                                } else if (!isStreaming && stopEverSeen) {
                                    // Stop button disappeared — agent done streaming
                                    console.log('[AA-Watcher] Stop button removed. Scheduling 3s quiet check. elapsed=' + Math.round((Date.now()-_injAt)/1000) + 's');
                                    if (!quietCheckTimer) {
                                        quietCheckTimer = setTimeout(() => complete('stop_removed'), 3000);
                                    }
                                    return;
                                }

                                // ⚡ FIX: Only SET quiet timer, never reset it once running
                                // Background mutations (cursor blinks, UI updates) were resetting the 8s timer forever
                                if (agentStarted && !quietCheckTimer && !isStreaming) {
                                    quietCheckTimer = setTimeout(() => {
                                        if (!hasStopButton()) complete('dom_quiet');
                                    }, 3000);
                                }
                            }, 250);
                        });

                        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

                        const _watcherStart = Date.now();
                        const fallbackInterval = setInterval(() => {
                            const quiet = Date.now() - lastMutationTime;
                            const _fe = Math.round((Date.now() - _watcherStart) / 1000);
                            const _isStop = hasStopButton();
                            // ⚡ DEBUG: Log fallback state every 4s
                            if (_fe % 4 === 0) console.log('[AA-Watcher] fallback tick: elapsed=' + _fe + 's quiet=' + quiet + 'ms stopBtn=' + _isStop + ' started=' + agentStarted + ' stopEverSeen=' + stopEverSeen);

                            if (agentStarted && quiet > 4000 && !_isStop) complete('fallback_quiet');
                            if (agentStarted && !_isStop && quiet > 3000) complete('fallback_safety');

                            if (!agentStarted) {
                                try {
                                    const cn = getLastResponseNode();
                                    if (cn && baselineNode && cn !== baselineNode) {
                                        agentStarted = true;
                                        activeResponseNode = cn;
                                        console.log('[AA-Watcher] NEW NODE detected (fallback) — tag=' + cn.tagName + ' cls=' + (cn.className||'').substring(0,60));
                                        complete('fallback_new_node');
                                    } else {
                                        const ct = extractText(cn);
                                        if (ct && ct.length >= 1 && ct !== baselineText) {
                                            agentStarted = true;
                                            activeResponseNode = cn;
                                            console.log('[AA-Watcher] TEXT CHANGED (fallback) — len=' + ct.length + ' preview=' + ct.substring(0,80));
                                            complete('fallback_return_capture');
                                        }
                                    }
                                } catch(e) {}
                            }

                            const elapsed = Date.now() - _watcherStart;
                            if (_lic && !agentStarted && !stopEverSeen && elapsed > 6000) {
                                baselineNode = null;
                                baselineText = '';
                                _lic = false;
                            }

                            // ⚡ FORCE CAPTURE (SAFETY VALVE): Only fires when watcher is stuck
                            // v3.26.4: Stop-button aware — if agent is still generating, wait up to 120s
                            const _forceThreshold = hasStopButton() ? 120000 : 15000;
                            if (elapsed > _forceThreshold && window[WID]?.status === 'watching') {
                                try {
                                    const fn = activeResponseNode || getLastResponseNode();
                                    const ft = extractText(fn);
                                    const _isStopNow = hasStopButton();
                                    window[WID]._forceDebug = { elapsed: Math.round(elapsed/1000), sameNode: fn === baselineNode, started: agentStarted, stopBtn: _isStopNow, threshold: _forceThreshold/1000 };
                                    console.log('[AA-Watcher] FORCE CAPTURE check: elapsed=' + Math.round(elapsed/1000) + 's threshold=' + (_forceThreshold/1000) + 's stopBtn=' + _isStopNow + ' textLen=' + (ft||'').length);
                                    if (ft && ft.length >= 1) {
                                        // Route through complete() so anti-premature guard applies
                                        agentStarted = true;
                                        complete('force_capture_' + Math.round(_forceThreshold/1000) + 's');
                                    }
                                } catch(e) {}
                            }

                            // ⚡ RETRY-AWARE ERROR DETECTION
                            const errorBanner = document.querySelector('[class*="error"], [class*="terminated"]');
                            if (errorBanner && isVisible(errorBanner)) {
                                const errText = (errorBanner.textContent || '').trim();
                                if (errText.includes('terminated') || errText.includes('error')) {
                                    // Check if a retry button exists — AutoAccept will click it
                                    const retryBtn = document.querySelector('button');
                                    const hasRetry = retryBtn && Array.from(document.querySelectorAll('button')).some(b => 
                                        isVisible(b) && /retry|try again|regenerate/i.test(b.textContent || b.getAttribute('aria-label') || '')
                                    );
                                    if (hasRetry && !window[WID]._retryCount) {
                                        // Retry available — reset baseline and continue watching
                                        window[WID]._retryCount = (window[WID]._retryCount || 0) + 1;
                                        window[WID]._retryAt = Date.now();
                                        baselineNode = getLastResponseNode();
                                        baselineText = extractText(baselineNode);
                                        activeResponseNode = null;
                                        agentStarted = false;
                                        stopEverSeen = false;
                                        quietCheckTimer = null;
                                        window[WID]._retryDebug = 'retry_detected_resetting';
                                    } else if (hasRetry && window[WID]._retryCount && (Date.now() - window[WID]._retryAt) < 30000) {
                                        // Still within retry window — keep watching
                                        window[WID]._retryDebug = 'retry_in_progress_' + window[WID]._retryCount;
                                    } else {
                                        // No retry or retry timed out — complete with error
                                        window[WID] = { status: 'done', text: '❌ ' + errText.substring(0, 500), ts: Date.now(), reason: 'error_detected', _retryCount: window[WID]._retryCount || 0 };
                                        observer.disconnect();
                                        clearInterval(fallbackInterval);
                                        clearTimeout(quietCheckTimer);
                                    }
                                }
                            }
                        }, 2000);

                        window[WID]._observer = observer;
                        window[WID]._fallback = fallbackInterval;
                        window[WID]._quiet = quietCheckTimer;

                        setTimeout(() => {
                            observer.disconnect();
                            clearInterval(fallbackInterval);
                            clearTimeout(quietCheckTimer);
                            if (window[WID]?.status === 'watching') {
                                window[WID] = { status: 'timeout', text: extractText(activeResponseNode || getLastResponseNode()), ts: Date.now() };
                            }
                        }, 300000);
                    })()
                `, 25000);

                watcherInjected = true;
                break; // Success — exit retry loop
            } catch (e) {
                this.log(`[Telegram] Watcher inject attempt ${attempt}/5 failed: ${e.message}`);
                if (attempt < 5) {
                    await this._sleep(5000); // Wait 5s for V8 to recover before retry
                }
            }
        }

        if (!watcherInjected) {
            this.log(`[Telegram] Failed to inject watcher after 5 attempts — response will not be relayed`);
            return;
        }

        this.log(`[Telegram] Response watcher injected for "${convTitle}" (gen=${generationId}, watcher=${watcherId})`);

        // ⚡ SIDEBAR WATCHER TRACKING: Track this watcher so the next sidebar-path prompt
        // can kill it before navigating away. Only track sidebar watchers (not direct-window ones)
        // since direct-window watchers observe their own isolated DOM and don't get clobbered.
        if (!overrideWsUrl || overrideWsUrl === this.cm?._sidebarWsUrl) {
            this._activeSidebarWatcher = { wsUrl, watcherId, gen: generationId, convTitle };
        }

        // Lightweight status poll — just reads window[watcherId]
        const CHECK_MS = 3000;
        const MAX_WAIT = 300000;
        const startTime = Date.now();

        const checkFn = async () => {
            if ((this._watcherGenerations.get(wsUrl) || 0) !== generationId) {
                this.log(`[Telegram] Watcher gen=${generationId} killed for ${convTitle} (current=${this._watcherGenerations.get(wsUrl)})`);
                this._cleanupWatcher(wsUrl, watcherId);
                if (this._activeSidebarWatcher?.watcherId === watcherId) this._activeSidebarWatcher = null;
                return;
            }
            if (!this._running || Date.now() - startTime > MAX_WAIT) {
                this.log(`[Telegram] Response watch timed out for "${convTitle}"`);
                this._cleanupWatcher(wsUrl, watcherId);
                if (this._activeSidebarWatcher?.watcherId === watcherId) this._activeSidebarWatcher = null;
                return;
            }

            try {
                const result = await this.cm._workerEval(wsUrl, `JSON.stringify(window['${watcherId}'] || { status: 'unknown' })`, 3000);
                const state = JSON.parse(result?.result?.result?.value || '{}');
                const elapsed = Math.round((Date.now() - startTime) / 1000);

                // 💡 TELEGRAM TYPING INDICATOR — "🤖 AutoAccept is typing..." while LLM streams
                if (state.status === 'watching' && elapsed > 0 && elapsed % 5 === 0) {
                    this._post('/action', { action: 'typing' }, { 'X-Machine-Id': this.machineId }).catch(() => {});
                }
                
                // DEBUG v3.26.3: Enhanced — log every state check for first 30s + thinking debug
                if (elapsed <= 30 && elapsed % 2 === 0) {
                    const retryInfo = state._retryCount ? ` retry=${state._retryCount} retryDbg=${state._retryDebug||'-'}` : '';
                    const thinkInfo = state._thinkStripped ? ` thinkStripped=${JSON.stringify(state._thinkStripped)}` : '';
                    const blockedInfo = state._blockedComplete ? ` BLOCKED=${JSON.stringify(state._blockedComplete)}` : '';
                    this.log(`[Telegram] WATCHER[${elapsed}s] status=${state.status} textLen=${(state.text||'').length} reason=${state.reason||'-'} rect=${!!state.rect} sel=${state._matchedSel||'-'} noMatch=${!!state._noMatch} baselineLen=${state._baselineLen||'-'}${retryInfo}${thinkInfo}${blockedInfo}`);
                }

                // Debug: log watcher diagnostics once
                if (elapsed === 4 && (state._matchedSel || state._noMatch || state._titleDebug)) {
                    this.log(`[Telegram] 🏷️ TITLE DEBUG: ${state._titleDebug || 'none'}`);
                    if (state._matchedSel) this.log(`[Telegram] 📋 Response matched: sel=${state._matchedSel} scope=${state._matchedScope}`);
                    if (state._noMatch) this.log(`[Telegram] ⚠️ No response selectors matched! scopes=${state._scopeCount}`);
                }
                if (state._forceDebug && elapsed >= 16 && elapsed <= 19) {
                    this.log(`[Telegram] 🔧 Force debug: ${JSON.stringify(state._forceDebug)}`);
                }

                // ⚡ RECLAIM: If watcher is still watching after 25s, Swarm may have navigated away.
                // Navigate back to the target conversation to check for the response.
                if (state.status === 'watching' && elapsed > 25 && elapsed % 15 < 4) {
                    this.log(`[Telegram] 🔄 Reclaim attempt for "${this._tgTargetConvTitle}" at ${elapsed}s`);
                    try {
                        // Briefly re-pause Swarm for the reclaim
                        const wasPaused = this.cm.isPaused;
                        const wasSwarmPaused = this.cm.swarmPaused;
                        this.cm.isPaused = true;
                        this.cm.swarmPaused = true;
                        this._touchSwarmDefer();
                        await this._sleep(500);

                        // Navigate back to the target conversation
                        await this._navigateToConversation(this._tgTargetConvIndex, this._tgTargetConvTitle);
                        this._touchSwarmDefer();
                        this.log('[Telegram] 🔄 Reclaim navigation complete — checking response');

                        // Give the DOM a moment to render
                        await this._sleep(2000);

                        // Restore Swarm after reclaim
                        this.cm.isPaused = wasPaused;
                        this.cm.swarmPaused = wasSwarmPaused;
                        this._touchSwarmDefer();
                    } catch (e) {
                        this.log(`[Telegram] Reclaim failed: ${e.message}`);
                    }
                }
                
                // ⚡ DEBUG: Log title guard candidates on first check
                if (state._titleDebug && !this._titleDebugLogged) {
                    this._titleDebugLogged = true;
                    this.log(`[Telegram] 🏷️ TITLE DEBUG: ${state._titleDebug}`);
                }

                if (state.status === 'done' && state.text && state.text.length >= 1) {
                    // ⚡ No truncation — the worker's tgSend() auto-splits at 4096 chars
                    const responseText = state.text;
                    this.log(`[Telegram] ✅ RELAY triggered! elapsed=${elapsed}s textLen=${state.text.length} reason=${state.reason} sameNode=${state._sameNode} nodeChanged=${state._nodeChanged} baselineLen=${state._baselineLen} basePreview="${(state._baselinePreview||"").substring(0,30)}" captPreview="${(state._capturedPreview||"").substring(0,30)}"`);
                    if (state._debugState) this.log(`[Telegram] 🔬 DEBUG STATE: ${JSON.stringify(state._debugState)}`);
                    await this._sendResult(`💬 *${convTitle}*:\n\n${responseText}`);
                    this.log(`[Telegram] Relayed agent response (${state.text.length} chars)`);
                    
                    // ⚡ VISUAL BRIDGE: Use pre-computed rect from watcher if available
                    if (state.rect) {
                        await this._captureAndSendScreenshotPrecomputed(wsUrl, convTitle, state.rect);
                    } else {
                        await this._captureAndSendScreenshot(wsUrl, convTitle);
                    }
                    
                    this._cleanupWatcher(wsUrl, watcherId);
                    if (this._activeSidebarWatcher?.watcherId === watcherId) this._activeSidebarWatcher = null;
                    return;
                }

                if (state.status === 'timeout') {
                    // On timeout, still try to relay whatever text was captured
                    if (state.text && state.text.length >= 1) {
                        this.log(`[Telegram] Watcher timed out but has text — relaying`);
                        await this._sendResult(`💬 *${convTitle}*:\n\n${state.text}`);
                    } else {
                        this.log(`[Telegram] In-browser watcher timed out for "${convTitle}"`);
                    }
                    this._cleanupWatcher(wsUrl, watcherId);
                    if (this._activeSidebarWatcher?.watcherId === watcherId) this._activeSidebarWatcher = null;
                    return;
                }

                this.log(`[Telegram] 🔍 check ${elapsed}s | status=${state.status}`);
            } catch (e) {
                this.log(`[Telegram] ⚠️ check error: ${e.message}`);
            }

            setTimeout(checkFn, CHECK_MS);
        };
        setTimeout(checkFn, 4000);
    }

    // Clean up watcher variable from sidebar DOM
    _cleanupWatcher(wsUrl, watcherId) {
        try { this.cm._workerEval(wsUrl, `delete window['${watcherId}']`, 2000); } catch (e) {}
    }

    // ── ⚡ /PEEK: Full-screen IDE screenshot on demand ──────────────────
    async _handlePeek(cmd) {
        if (!this.cm) {
            await this._sendResult('❌ Not connected — cannot peek.');
            return;
        }

        // ⚡ /peek N — target a specific window by index from /list
        let wsUrl = null;
        const peekIndex = cmd && cmd.convIndex !== undefined ? cmd.convIndex : null;
        
        if (peekIndex !== null && this._lastConvos && this._lastConvos[peekIndex]) {
            const target = this._lastConvos[peekIndex];
            this.log(`[Telegram] 👁️ PEEK DEBUG: index=${peekIndex} title="${target.title}" isIndividual=${!!target.isIndividual} hasWsUrl=${!!target.wsUrl} workspace="${target.workspace || '-'}"`);
            
            if (target.wsUrl) {
                wsUrl = target.wsUrl;
                this.log(`[Telegram] 👁️ PEEK DEBUG: Using target's own wsUrl`);
            } else if (!target.isIndividual) {
                // Manager sidebar conversation — use the sidebar wsUrl
                wsUrl = this.cm._sidebarWsUrl;
                this.log(`[Telegram] 👁️ PEEK DEBUG: Manager convo — using sidebar wsUrl=${!!wsUrl}`);
            }
        } else {
            this.log(`[Telegram] 👁️ PEEK DEBUG: No index or index out of range (peekIndex=${peekIndex}, lastConvos=${this._lastConvos?.length || 0})`);
        }
        
        // Fallback chain: sidebar → session scan (only if no specific target)
        if (!wsUrl && peekIndex === null) {
            // Generic /peek with no index — find any window
            if (this._lastConvos) {
                const individual = this._lastConvos.find(c => c.isIndividual);
                if (individual) {
                    wsUrl = individual.wsUrl;
                    this.log(`[Telegram] 👁️ PEEK DEBUG: Fallback to first individual: "${individual.title}"`);
                }
            }
            if (!wsUrl) {
                wsUrl = this.cm._sidebarWsUrl;
                this.log(`[Telegram] 👁️ PEEK DEBUG: Fallback to sidebar wsUrl`);
            }
        } else if (!wsUrl) {
            // Specific index requested but no wsUrl resolved — try sidebar as last resort
            wsUrl = this.cm._sidebarWsUrl;
            this.log(`[Telegram] 👁️ PEEK DEBUG: Index ${peekIndex} has no wsUrl — last resort sidebar wsUrl=${!!wsUrl}`);
        }
        
        if (!wsUrl) {
            const sessions = this.cm.sessions;
            if (sessions) {
                for (const [, info] of sessions) {
                    if (info.url && info.url.startsWith('vscode-file://') && info.title !== 'Launchpad') {
                        wsUrl = info.wsUrl;
                        this.log(`[Telegram] 👁️ PEEK DEBUG: Session scan fallback: "${info.title}"`);
                        break;
                    }
                }
            }
        }
        
        if (!wsUrl) {
            await this._sendResult('❌ Not connected — cannot peek.');
            return;
        }
        
        this.log(`[Telegram] 👁️ PEEK DEBUG: Final wsUrl target = ${wsUrl.substring(0, 60)}...`);

        try {
            this.log('[Telegram] 👁️ Peek: capturing full-screen screenshot...');
            const screenshot = await this.cm._workerRawCdp(wsUrl, 'Page.captureScreenshot', {
                format: 'jpeg',
                quality: 50  // Lower quality for speed — it's just a peek
            }, 10000);

            const b64Data = screenshot?.data || screenshot?.result?.data;
            if (b64Data) {
                this.log(`[Telegram] 👁️ Peek captured (${Math.round(b64Data.length / 1024)}KB). Sending...`);
                await this._postLarge('/upload-photo', {
                    base64: b64Data,
                    caption: '👁️ Live IDE Peek'
                }, { 'X-Machine-Id': this.machineId });
                this.log('[Telegram] 👁️ Peek sent!');
            } else {
                await this._sendResult('❌ Peek failed — no screenshot data.');
            }
        } catch (e) {
            this.log(`[Telegram] Peek failed: ${e.message}`);
            await this._sendResult(`❌ Peek failed: ${e.message}`);
        }
    }

    // ── 🛑 /STOP: Emergency Kill — Cancel generation on ALL windows ──────
    async _handleStop() {
        if (!this.cm) {
            await this._sendResult('❌ Not connected — cannot stop.');
            return;
        }

        const evalScript = `
            (() => {
                // Target Antigravity's stop/cancel buttons
                const selectors = [
                    'button[aria-label*="stop" i]',
                    'button[aria-label*="cancel" i]',
                    '[data-tooltip-id="input-send-button-cancel-tooltip"]',
                    'button[title*="Stop" i]',
                    'button[title*="Cancel" i]'
                ];
                for (const sel of selectors) {
                    const btn = document.querySelector(sel);
                    if (btn && btn.offsetParent !== null) {
                        btn.click();
                        return 'clicked: ' + sel;
                    }
                }
                return 'no-stop-button-found';
            })()
        `;

        const promises = [];
        let targets = 0;

        // Broadcast to sidebar
        if (this.cm._sidebarWsUrl) {
            targets++;
            promises.push(this.cm._workerEval(this.cm._sidebarWsUrl, evalScript, 3000).catch(() => 'error'));
        }

        // Broadcast to all individual windows
        if (this.cm.sessions) {
            for (const [, info] of this.cm.sessions) {
                if (info.wsUrl && info.wsUrl !== this.cm._sidebarWsUrl && info.url && info.url.startsWith('vscode-file://')) {
                    targets++;
                    promises.push(this.cm._workerEval(info.wsUrl, evalScript, 3000).catch(() => 'error'));
                }
            }
        }

        const results = await Promise.all(promises);
        this.log(`[Telegram] 🛑 STOP broadcasted to ${targets} targets: ${JSON.stringify(results)}`);
        await this._sendResult(`🛑 Stop sent to ${targets} agent window(s).`);
    }

    // ── ⚡ VISUAL BRIDGE: PRE-COMPUTED RECT SCREENSHOT (DEPRECATED) ──
    async _captureAndSendScreenshotPrecomputed(wsUrl, convTitle, rect) {
        // Precomputed rects suffer from negative-Y scroll bugs.
        // Route everything through the Perfect Wrapper engine.
        return this._captureAndSendScreenshot(wsUrl, convTitle);
    }

    // ── ⚡ VISUAL BRIDGE: Perfect Isolated Screenshot (Auto-Slicing) ─────
    async _captureAndSendScreenshot(wsUrl, convTitle) {
        try {
            // 1. Isolate the response using remote script (or fallback)
            const screenshotScript = this._scripts?.screenshot;
            if (!screenshotScript) {
                this.log('[Telegram] Screenshot: remote scripts not loaded yet');
                return;
            }
            const isolateRes = await this.cm._workerEval(wsUrl, screenshotScript, 5000);

            const rectVal = isolateRes?.result?.result?.value;
            if (!rectVal || rectVal === 'null') {
                this.log('[Telegram] Screenshot: no response element found');
                return;
            }
            
            const rect = JSON.parse(rectVal);
            this.log(`[Telegram] 📸 Isolated response for capture: ${rect.width}x${rect.height}`);

            // Let DOM paint the clone
            await this._sleep(400);

            // ⚡ AUTO-SLICING FOR TELEGRAM LIMITS (Width + Height < 10000px)
            // At scale: 2, a 2500px CSS height becomes a 5000px image height (100% safe).
            const MAX_CHUNK_HEIGHT = 2500; 
            const totalChunks = Math.ceil(rect.height / MAX_CHUNK_HEIGHT);
            const chunksToSend = Math.min(totalChunks, 4); // Hard cap at 4 images to avoid spam

            try {
                for (let i = 0; i < chunksToSend; i++) {
                    let chunkY = i * MAX_CHUNK_HEIGHT;
                    let chunkHeight = MAX_CHUNK_HEIGHT;
                    const isLast = (i === chunksToSend - 1);
                    
                    if (isLast) {
                        if (totalChunks > 4) {
                            // ⚡ THE "BEST PLACE FOR RESULTS" GUARANTEE
                            // If message is massive, force the final image to anchor to the absolute bottom.
                            chunkY = Math.max(0, rect.height - MAX_CHUNK_HEIGHT);
                            chunkHeight = rect.height - chunkY;
                        } else {
                            chunkHeight = rect.height - chunkY;
                        }
                    }

                    // Add padding buffer to bottom chunk
                    if (isLast) chunkHeight += 10;

                    // Take the screenshot chunk
                    const screenshot = await this.cm._workerRawCdp(wsUrl, 'Page.captureScreenshot', {
                        format: 'jpeg',
                        quality: 85,
                        clip: { x: rect.x, y: rect.y + chunkY, width: rect.width, height: chunkHeight, scale: 2 },
                        captureBeyondViewport: true 
                    }, 15000);

                    const b64Data = screenshot?.data || screenshot?.result?.data;
                    if (b64Data) {
                        const b64Len = Math.round(b64Data.length / 1024);
                        this.log(`[Telegram] 📸 Chunk ${i + 1}/${chunksToSend} captured (${b64Len}KB)`);
                        
                        let caption = `📸 ${convTitle}`;
                        if (chunksToSend > 1) {
                            caption += ` (${i + 1}/${chunksToSend})`;
                            if (isLast && totalChunks > 4) caption += `\n*(Middle skipped - too long)*`;
                        }

                        const uploadRes = await this._postLarge('/upload-photo', {
                            base64: b64Data,
                            caption: caption
                        }, { 'X-Machine-Id': this.machineId });
                        
                        if (uploadRes?.status === 'tg_error') {
                            this.log(`[Telegram] ⚠️ Telegram rejected chunk ${i+1}: ${uploadRes.error} (HTTP ${uploadRes.httpStatus})`);
                        }
                    } else {
                        this.log(`[Telegram] Screenshot chunk ${i+1} failed: CDP returned no data.`);
                    }
                    
                    if (!isLast) await this._sleep(800); // Preserve upload order in Telegram chat
                }
            } finally {
                // Always delete the wrapper even if a chunk fails
                await this.cm._workerEval(wsUrl, this._scripts?.screenshotCleanup || `const w = document.getElementById('aa-perfect-shot'); if(w) w.remove();`, 2000).catch(()=>{});
            }
        } catch (e) {
            this.log(`[Telegram] Screenshot failed: ${e.message}`);
            try { await this.cm._workerEval(wsUrl, this._scripts?.screenshotCleanup || `const w = document.getElementById('aa-perfect-shot'); if(w) w.remove();`, 2000); } catch(err){}
        }
    }

    // ── ⚡ CREATIVE FIX: The UI Stabilizer Guard ──────────────────────
    async _waitForUIReady(wsUrl, expectedTitle) {
        // Wait up to 6 seconds for the UI to completely stabilize
        for (let i = 0; i < 12; i++) {
            try {
                const result = await this.cm._workerEval(wsUrl, `
                    (() => {
                        const panel = document.querySelector('.antigravity-agent-side-panel') || document;
                        const input = panel.querySelector('[contenteditable="true"][role="textbox"]:not(.xterm-helper-textarea)');
                        const isInputReady = !!(input && input.offsetParent !== null && !input.hasAttribute('disabled'));
                        
                        // Detect Antigravity's loading states (spinners, progress bars, skeletons)
                        const spinners = panel.querySelectorAll('[class*="animate-spin"], [class*="progress_activity"], [class*="skeleton"]');
                        const isLoading = spinners.length > 0;
                        
                        let activeTitle = '';
                        const titleSelectors = ['h1', 'h2', '[class*="truncate"][class*="font-medium"]', '.antigravity-agent-side-panel h1'];
                        for (const sel of titleSelectors) {
                            const el = panel.querySelector(sel);
                            if (el) {
                                const t = (el.textContent || '').trim().toLowerCase();
                                if (t.length > 3) { activeTitle = t; break; }
                            }
                        }
                        
                        const expected = '${(expectedTitle || '').toLowerCase().replace(/'/g, "\\'")}';
                        const titleMatches = !expected || activeTitle === expected;

                        return JSON.stringify({ isInputReady, isLoading, titleMatches });
                    })()
                `, 3000);
                
                const state = JSON.parse(result?.result?.result?.value || '{}');
                
                // Only proceed if input exists, all loading spinners GONE, and title matches
                if (state.isInputReady && !state.isLoading && state.titleMatches) {
                    return true;
                }
            } catch (e) { }
            
            await this._sleep(500);
        }
        return false;
    }

    // Keep simple version for non-title checks
    async _checkInputReady(wsUrl) {
        try {
            const result = await this.cm._workerEval(wsUrl, `
                (() => {
                    const panel = document.querySelector('.antigravity-agent-side-panel');
                    const scope = panel || document;
                    const input = scope.querySelector('[contenteditable="true"][role="textbox"]:not(.xterm-helper-textarea)');
                    return !!(input && input.offsetParent !== null);
                })()
            `, 3000);
            return result?.result?.result?.value === true;
        } catch (e) { return false; }
    }

    // ── CDP: Get agent state (for title verification) ─────────────────
    async _getAgentState(wsUrl) {
        try {
            const result = await this.cm._workerEval(wsUrl, `
                (() => {
                    const panel = document.querySelector('.antigravity-agent-side-panel');
                    
                    // Broad search: grab ALL possible title elements
                    const candidates = [];
                    const allH1 = document.querySelectorAll('h1');
                    const allH2 = document.querySelectorAll('h2');
                    allH1.forEach(el => { const t = (el.textContent || '').trim(); if (t.length > 3 && t.length < 100) candidates.push('h1:' + t); });
                    allH2.forEach(el => { const t = (el.textContent || '').trim(); if (t.length > 3 && t.length < 100) candidates.push('h2:' + t); });
                    
                    // Also check the document title
                    candidates.push('docTitle:' + document.title);
                    
                    // Check for input
                    const input = (panel || document).querySelector('[contenteditable="true"][role="textbox"]:not(.xterm-helper-textarea)');
                    const hasInput = !!(input && input.offsetParent !== null);
                    
                    // Try to find active title from multiple strategies
                    let activeTitle = '';
                    // Strategy 1: Panel heading
                    if (panel) {
                        const h = panel.querySelector('h1, h2');
                        if (h) activeTitle = (h.textContent || '').trim();
                    }
                    // Strategy 2: Document title often contains conversation name
                    if (!activeTitle) {
                        const dt = document.title || '';
                        // Antigravity format: "ConvName - Workspace - Antigravity"
                        if (dt.includes(' - ')) {
                            activeTitle = dt.split(' - ')[0].trim();
                        }
                    }
                    
                    return JSON.stringify({ activeTitle, hasInput, candidates: candidates.slice(0, 10) });
                })()
            `, 5000);
            const parsed = JSON.parse(result?.result?.result?.value || '{}');
            if (parsed.candidates) {
                this.log(`[Telegram] DOM title candidates: ${parsed.candidates.join(' | ')}`);
            }
            return { activeTitle: parsed.activeTitle || '', hasInput: !!parsed.hasInput };
        } catch (e) { return { activeTitle: '', hasInput: false }; }
    }

    // ── CDP: Conversation Scraping ───────────────────────────────────
    // ── Global Discovery: Scan all ports for individual windows ──────
    async _scanIndividualWindows() {
        const windows = [];
        const basePort = (this.cm && this.cm.activeCdpPort) || 9333;
        const promises = [];

        for (let port = basePort - 2; port <= basePort + 20; port++) {
            promises.push(new Promise((resolve) => {
                const req = http.get({ hostname: '127.0.0.1', port, path: '/json', timeout: 800 }, (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', async () => {
                        try {
                            const targets = JSON.parse(data);
                            const editors = targets.filter(t => t.type === 'page' && t.url && t.url.startsWith('vscode-file://') && t.webSocketDebuggerUrl);

                            for (const t of editors) {
                                try {
                                    const windowScanScript = this._scripts?.windowScan;
                                    if (!windowScanScript) continue;
                                    const evalRes = await this.cm._workerEval(t.webSocketDebuggerUrl, windowScanScript, 2000);

                                    const state = JSON.parse(evalRes?.result?.result?.value || 'null');
                                    if (state && state.title) {
                                        windows.push({
                                            title: state.title,
                                            wsUrl: t.webSocketDebuggerUrl,
                                            targetId: t.id,
                                            isRunning: state.running,
                                            port
                                        });
                                    }
                                } catch (e) {}
                            }
                        } catch(e) {}
                        resolve();
                    });
                });
                req.on('error', () => resolve());
                req.on('timeout', () => { req.destroy(); resolve(); });
            }));
        }

        await Promise.all(promises);
        return windows;
    }

    async _scrapeConversations() {
        let allConvos = [];
        const seenTitles = new Set();

        // 1. Scrape the Manager Sidebar (existing logic)
        if (this.cm && this.cm._sidebarWsUrl) {
            try {
                const scraperScript = this._scripts?.scraper;
                if (!scraperScript) { /* fallback: skip if remote scripts not loaded */ }
                const result = scraperScript 
                    ? await this.cm._workerEval(this.cm._sidebarWsUrl, scraperScript, 5000)
                    : null;
                const managerConvos = result?.result?.result?.value;
                if (Array.isArray(managerConvos)) {
                    managerConvos.forEach(c => {
                        allConvos.push({ ...c, type: 'manager' });
                        seenTitles.add(c.title);
                    });
                }
            } catch(e) {}
        }

        // 2. Discover all Individual Windows across all ports
        try {
            const individualWindows = await this._scanIndividualWindows();
            // ⚡ Sort by port to ensure deterministic ordering (Promise.all returns in completion order)
            individualWindows.sort((a, b) => a.port - b.port || a.title.localeCompare(b.title));
            for (const win of individualWindows) {
                if (!seenTitles.has(win.title)) {
                    allConvos.push({
                        title: '🪟 ' + win.title.substring(0, 58),
                        workspace: 'Individual Windows',
                        status: win.isRunning ? 'running' : 'idle',
                        wsUrl: win.wsUrl,
                        targetId: win.targetId,
                        isIndividual: true,
                        rawTitle: win.title
                    });
                }
            }
        } catch(e) {
            this.log(`[Telegram] Individual window scan error: ${e.message}`);
        }

        // Normalize indices
        allConvos.forEach((c, i) => c.index = i);
        return allConvos.length > 0 ? allConvos : null;
    }

    // ── ⚡ P0 & P2 FIX: Cross-Workspace Navigate + Fast Path ────────
    async _navigateToConversation(index, convTitle) {
        if (!this.cm || !this.cm._sidebarWsUrl) return false;
        const wsUrl = this.cm._sidebarWsUrl;

        // P2 Fast-Path: Zero Freeze if already on the correct conversation
        if (convTitle) {
            const state = await this._getAgentState(wsUrl);
            this.log(`[Telegram] Fast-path check: activeTitle="${state.activeTitle}" vs expected="${convTitle}"`);
            if (state.activeTitle && state.activeTitle.toLowerCase() === convTitle.toLowerCase()) {
                this.log(`[Telegram] Fast-path: already on conversation "${convTitle}"`);
                const ready = await this._checkInputReady(wsUrl);
                if (ready) return true;
            }
        }

        // ⚡ INDIVIDUAL CHAT DETECTION: Individual chats are rendered inside the EDITOR
        // workbench target, NOT the Launchpad sidebar. When sidebar has no cards/pills,
        // scan all CDP sessions to find the one containing a chat textbox.
        try {
            const chatCheck = await this.cm._workerEval(wsUrl, `(() => {
                const cards = document.querySelectorAll('[data-workspace-card="true"]').length;
                const pills = document.querySelectorAll('[data-testid*="convo-pill"]').length;
                const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
                return JSON.stringify({ cards, pills, hasInput: !!input });
            })()`, 5000);
            const chatState = JSON.parse(chatCheck?.result?.result?.value || '{}');
            this.log(`[Telegram] Chat state (sidebar): cards=${chatState.cards} pills=${chatState.pills} hasInput=${chatState.hasInput}`);
            
            if (chatState.cards === 0 && chatState.pills === 0 && chatState.hasInput) {
                this.log('[Telegram] 🎯 Individual chat in sidebar — skipping navigation');
                return true;
            }
            
            // Sidebar has nothing — check ALL other sessions for the chat
            if (chatState.cards === 0 && chatState.pills === 0 && !chatState.hasInput) {
                this.log('[Telegram] Sidebar empty — scanning all sessions for individual chat...');
                for (const [targetId, info] of this.cm.sessions) {
                    if (info.wsUrl === wsUrl) continue; // Skip the sidebar itself
                    try {
                        const probe = await this.cm._workerEval(info.wsUrl, `(() => {
                            const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
                            const agentPanel = document.querySelector('[class*="agent"], [class*="chat"], [class*="conversation"]');
                            return JSON.stringify({ hasInput: !!input, hasAgent: !!agentPanel, dom: document.querySelectorAll('*').length });
                        })()`, 3000);
                        const probeState = JSON.parse(probe?.result?.result?.value || '{}');
                        this.log(`[Telegram] Probe ${targetId.substring(0,6)}: inputs=${probeState.hasInput} agent=${probeState.hasAgent} dom=${probeState.dom}`);
                        
                        if (probeState.hasInput && probeState.dom > 500) {
                            // Found the editor target with the individual chat!
                            this.log(`[Telegram] 🎯 Individual chat found in editor target ${targetId.substring(0,6)} — switching wsUrl`);
                            this._originalSidebarWsUrl = this.cm._sidebarWsUrl; // Save for restore
                            this.cm._sidebarWsUrl = info.wsUrl;
                            this._individualChatWsUrl = info.wsUrl;
                            return true;
                        }
                    } catch (e) {
                        this.log(`[Telegram] Probe ${targetId.substring(0,6)} failed: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            this.log(`[Telegram] Chat detection error: ${e.message}`);
        }

        // ⚡ LAUNCHPAD ESCAPE: If sidebar is on Launchpad (no workspace cards), go back to Manager
        let launchpadEscaped = false;
        try {
            const hasCards = await this.cm._workerEval(wsUrl, `document.querySelectorAll('[data-workspace-card="true"]').length > 0`, 3000);
            if (hasCards?.result?.result?.value !== true) {
                this.log('[Telegram] 🚀 Launchpad detected (no workspace cards) — escaping via history.back()');
                await this.cm._workerEval(wsUrl, `window.history.back()`, 2000);
                await this._sleep(2000); // Wait for Manager view to render
                launchpadEscaped = true;

                // Verify cards appeared
                const check = await this.cm._workerEval(wsUrl, `document.querySelectorAll('[data-workspace-card="true"]').length`, 3000);
                const cardCount = check?.result?.result?.value || 0;
                this.log(`[Telegram] Launchpad escape result: ${cardCount} workspace cards found`);
                if (cardCount === 0) {
                    // history.back() didn't work — try clicking the logo/home
                    this.log('[Telegram] history.back() failed — trying alternate escape');
                    await this.cm._workerEval(wsUrl, `
                        (() => {
                            // Try clicking any navigation element that might return to Manager
                            const backBtns = document.querySelectorAll('button[aria-label*="back"], button[aria-label*="Back"], [class*="back"]');
                            if (backBtns.length > 0) { backBtns[0].click(); return 'clicked_back'; }
                            // Try the logo/home icon
                            const logo = document.querySelector('[class*="logo"], [class*="home"]');
                            if (logo) { logo.click(); return 'clicked_logo'; }
                            return 'no_escape';
                        })()
                    `, 3000);
                    await this._sleep(2000);
                }
            }
        } catch (e) {
            this.log(`[Telegram] Launchpad escape error: ${e.message}`);
        }

        const MAX_ATTEMPTS = launchpadEscaped ? 7 : 5; // More retries if we escaped Launchpad
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                // Step 1: Check if target is in a collapsed workspace — expand if needed
                const expandResult = await this.cm._workerEval(wsUrl, `
                    (() => {
                        const workspaceCards = document.querySelectorAll('[data-workspace-card="true"]');
                        let count = 0;
                        for (const card of workspaceCards) {
                            const grid = card.nextElementSibling;
                            if (!grid) continue;
                            const items = grid.querySelectorAll('div[class*="select-none"][class*="cursor-pointer"][class*="rounded-md"]');
                            for (const item of items) {
                                if (count === ${index}) {
                                    const isCollapsed = grid.offsetHeight === 0 || window.getComputedStyle(grid).display === 'none';
                                    if (isCollapsed) {
                                        card.scrollIntoView({block: 'center'});
                                        card.click();
                                        return 'expanded';
                                    }
                                    return 'visible';
                                }
                                count++;
                            }
                        }
                        return 'not_found';
                    })()
                `, 15000); // 15s — V8 may be frozen rendering history

                const expandStatus = expandResult?.result?.result?.value;
                this.log(`[Telegram] Expand check: status=${expandStatus} (attempt ${attempt}/${MAX_ATTEMPTS})`);
                if (expandStatus === 'not_found') {
                    // ⚡ CONVO-PILL FALLBACK: Launchpad uses convo-pill elements, not workspace cards
                    const pillResult = await this.cm._workerEval(wsUrl, `(() => {
                        const pills = document.querySelectorAll('[data-testid*="convo-pill"]');
                        if (pills.length === 0) return 'no_pills';
                        const idx = ${index};
                        if (idx >= pills.length) return 'index_oob:' + pills.length;
                        pills[idx].scrollIntoView({block: 'center'});
                        pills[idx].click();
                        return 'pill_clicked:' + pills.length;
                    })()`, 5000);
                    const pillVal = pillResult?.result?.result?.value || 'unknown';
                    this.log(`[Telegram] Convo-pill fallback: ${pillVal}`);
                    
                    if (pillVal && pillVal.startsWith('pill_clicked')) {
                        this.log('[Telegram] 🎯 Clicked convo-pill — waiting for chat render...');
                        await this._sleep(2500);
                        const ready = await this._checkInputReady(wsUrl);
                        if (ready) { this.log('[Telegram] Input ready after pill click'); return true; }
                        this.log('[Telegram] Input not ready after pill click — inject will poll');
                        return true;
                    }
                    
                    this.log(`[Telegram] Navigate attempt ${attempt}/${MAX_ATTEMPTS}: conversation at index ${index} not found`);
                    if (attempt < MAX_ATTEMPTS) { await this._sleep(1500); continue; }
                    return false;
                }

                // If we expanded a collapsed workspace, wait for React CSS animation
                if (expandStatus === 'expanded') {
                    this.log(`[Telegram] Expanded collapsed workspace card, waiting 600ms...`);
                    await this._sleep(600);
                }

                // Step 2: Click the conversation item
                const clickResult = await this.cm._workerEval(wsUrl, `
                    (() => {
                        const workspaceCards = document.querySelectorAll('[data-workspace-card="true"]');
                        let count = 0;
                        for (const card of workspaceCards) {
                            const grid = card.nextElementSibling;
                            if (!grid) continue;
                            const items = grid.querySelectorAll('div[class*="select-none"][class*="cursor-pointer"][class*="rounded-md"]');
                            for (const item of items) {
                                if (count === ${index}) {
                                    item.scrollIntoView({block: 'center'});
                                    item.click();
                                    return true;
                                }
                                count++;
                            }
                        }
                        return false;
                    })()
                `, 15000); // 15s — V8 may be frozen rendering history

                const clicked = clickResult?.result?.result?.value === true;
                if (!clicked) {
                    this.log(`[Telegram] Navigate attempt ${attempt}/${MAX_ATTEMPTS}: click failed after expand`);
                    if (attempt < MAX_ATTEMPTS) { await this._sleep(1500); continue; }
                    return false;
                }

                // ⚡ SHORT WAIT: Minimal delay — inject's own polling handles the rest
                // Shorter = less time for IDE auto-navigation to steal focus
                this.log(`[Telegram] Clicked conversation. Waiting 2s for initial render...`);
                await this._sleep(2000);
                
                // Quick check — if ready, great. If not, inject will poll.
                const ready = await this._checkInputReady(wsUrl);
                if (ready) {
                    this.log(`[Telegram] Input ready after 2s wait`);
                    return true;
                }
                
                // Not ready yet — return true anyway, inject's polling will wait
                this.log(`[Telegram] Input not ready yet — inject will poll for it`);
                return true;
            } catch (e) {
                this.log(`[Telegram] Navigate attempt ${attempt}/${MAX_ATTEMPTS} error: ${e.message}`);
                if (attempt < MAX_ATTEMPTS) { await this._sleep(1500); continue; }
                return false;
            }
        }
        return false;
    }

    // ── CDP: Inject Prompt (Batched via main-thread WS) ──────────────
    async _injectPromptBatched(wsUrl, text) {
        const WebSocket = require('ws');
        return new Promise((resolve) => {
            const ws = new WebSocket(wsUrl);
            let msgId = 0;
            const pending = new Map();
            let resolved = false;

            const cleanup = () => {
                for (const [, h] of pending) clearTimeout(h.timer);
                pending.clear();
                try { ws.terminate(); } catch (e) { }
            };

            const finish = (val) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                resolve(val);
            };

            const send = (method, params = {}) => new Promise((res, rej) => {
                const id = ++msgId;
                const timer = setTimeout(() => { pending.delete(id); rej(new Error('cdp-timeout')); }, 25000);
                pending.set(id, { resolve: res, reject: rej, timer });
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ id, method, params }));
                } else {
                    pending.delete(id);
                    clearTimeout(timer);
                    rej(new Error('ws-not-open'));
                }
            });

            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.id && pending.has(msg.id)) {
                        const h = pending.get(msg.id);
                        pending.delete(msg.id);
                        clearTimeout(h.timer);
                        if (msg.error) h.reject(new Error(msg.error.message));
                        else h.resolve(msg.result);
                    }
                } catch (e) { }
            });

            ws.on('open', async () => {
                try {
                    // ⚡ RAPID INJECT: Focus → Insert → Enter with ZERO delays
                    // Must complete in <50ms to prevent IDE auto-navigation from stealing focus
                    const focusRes = await send('Runtime.evaluate', {
                        awaitPromise: true,
                        returnByValue: true,
                        expression: `
                            new Promise((resolve) => {
                                let attempts = 0;
                                const check = () => {
                                    const panel = document.querySelector('.antigravity-agent-side-panel');
                                    const scope = panel || document;
                                    const input = scope.querySelector('[contenteditable="true"][role="textbox"]:not(.xterm-helper-textarea)');
                                    
                                    if (input && input.offsetParent !== null) {
                                        input.focus();
                                        const sel = window.getSelection();
                                        const range = document.createRange();
                                        range.selectNodeContents(input);
                                        sel.removeAllRanges();
                                        sel.addRange(range);
                                        return resolve('ready');
                                    }
                                    if (++attempts > 130) return resolve('timeout');
                                    setTimeout(check, 150);
                                };
                                check();
                            })
                        `
                    });

                    if (focusRes?.result?.value !== 'ready') return finish(false);

                    // ⚡ ZERO-DELAY BURST: Insert + Enter back-to-back, no awaits between
                    // The faster this executes, the less chance IDE has to steal focus
                    await send('Input.insertText', { text });
                    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

                    this.log('[Telegram] Batch injection complete');
                    finish(true);
                } catch (e) { finish(false); }
            });

            ws.on('error', () => finish(false));
            setTimeout(() => finish(false), 30000);
        });
    }

    // ── ⚡ HMAC REQUEST SIGNING (method+path bound — FIX #4) ──────────
    _signHeaders(method = 'GET', pathname = '/') {
        const timestamp = Date.now().toString();
        const data = `${method}:${pathname}:${timestamp}:${this.machineId}`;
        const hmac = crypto.createHmac('sha256', this.licenseKey).update(data).digest('hex');
        return { 'X-Machine-Id': this.machineId, 'X-Timestamp': timestamp, 'X-Signature': hmac };
    }

    // ── ⚡ REMOTE CODE PROTECTION: Fetch sensitive scripts from worker ──
    async _fetchRemoteScripts() {
        try {
            const scripts = await this._get('/tg-scripts');
            if (scripts && scripts.selectors) {
                this._scripts = scripts;
                this.log(`[Telegram] 🔒 Remote scripts loaded (${Object.keys(scripts).length} keys)`);
            } else {
                this.log(`[Telegram] ⚠️ Failed to load remote scripts — screenshot/scraper may not work`);
            }
        } catch (e) {
            this.log(`[Telegram] ⚠️ Remote scripts fetch error: ${e.message}`);
        }
        // Refresh every hour
        if (this._running) setTimeout(() => this._fetchRemoteScripts(), 3600000);
    }

    // ── Notifications ────────────────────────────────────────────────
    async sendNotification(text) {
        try { await this._post('/notify', { text }, { 'X-Machine-Id': this.machineId }); } catch (e) { }
    }

    // ── Swarm Defer (brief, during navigate+inject only) ─────────────
    _touchSwarmDefer() {
        if (this.cm) this.cm._lastWebviewActivity = Date.now();
    }

    // ⚡ P1 FIX: Deduplicate identical strings sent within 10 seconds
    async _sendResult(text) {
        const now = Date.now();
        if (this._lastSentText === text && (now - (this._lastSentTs || 0) < 10000)) {
            this.log(`[Telegram] Dropped duplicate result to prevent spam`);
            return;
        }
        this._lastSentText = text;
        this._lastSentTs = now;

        try {
            await this._post('/result', { type: 'result', text }, { 'X-Machine-Id': this.machineId });
        } catch (e) {
            this.log(`[Telegram] Send result error: ${e.message}`);
        }
    }

    // ── HTTP Helpers (HMAC-signed with method+path) ────────────
    _get(path, headers = {}, timeoutMs = 35000) {
        const pathname = path.split('?')[0]; // Strip query params for HMAC (worker uses url.pathname)
        const signed = { ...this._signHeaders('GET', pathname), ...headers };
        return new Promise((resolve, reject) => {
            const url = new URL(TELEGRAM_WORKER_URL + path);
            const opts = { hostname: url.hostname, path: url.pathname + url.search, method: 'GET', headers: signed, timeout: timeoutMs };
            const req = https.get(opts, (res) => {
                let data = ''; res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
            });
            req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    _post(path, body, headers = {}) {
        const pathname = path.split('?')[0]; // Strip query params for HMAC
        const signed = { ...this._signHeaders('POST', pathname), ...headers };
        return new Promise((resolve, reject) => {
            const url = new URL(TELEGRAM_WORKER_URL + path);
            const payload = body ? JSON.stringify(body) : '';
            const opts = {
                hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...signed },
                timeout: 5000,
            };
            const req = https.request(opts, (res) => {
                let data = ''; res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
            });
            req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            if (payload) req.write(payload);
            req.end();
        });
    }

    // Large POST with 30s timeout for screenshot uploads (base64 can be >1MB)
    _postLarge(path, body, headers = {}) {
        const pathname = path.split('?')[0]; // Strip query params for HMAC
        const signed = { ...this._signHeaders('POST', pathname), ...headers };
        return new Promise((resolve, reject) => {
            const url = new URL(TELEGRAM_WORKER_URL + path);
            const payload = body ? JSON.stringify(body) : '';
            const opts = {
                hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...signed },
                timeout: 30000,
            };
            const req = https.request(opts, (res) => {
                let data = ''; res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
            });
            req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            if (payload) req.write(payload);
            req.end();
        });
    }
}

module.exports = { TelegramBridge };
