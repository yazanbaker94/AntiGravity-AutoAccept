// AntiGravity AutoAccept v3.0.0
// Primary: VS Code Commands API with async lock
// Secondary: Persistent CDP sessions with MutationObserver injection

const vscode = require('vscode');
const cp = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ConnectionManager } = require('./cdp/ConnectionManager');
const { DashboardProvider } = require('./dashboard/DashboardProvider');
const { pingTelemetry } = require('./telemetry');
const { TelegramBridge } = require('./telegram/TelegramBridge');

// ─── Persistent Memory Logger (survives OOM crash) ────────────────
let _memLogTimer = null;
const MEM_LOG_PATH = path.join(require('os').tmpdir(), 'aa-memory.log');

function startMemoryLogger() {
    // APPEND on start (don't truncate — preserves pre-crash data across OOM restarts)
    try { fs.appendFileSync(MEM_LOG_PATH, `\n--- AutoAccept Memory Log (PID ${process.pid}) @ ${new Date().toISOString()} ---\n`); } catch (e) { }
    // Immediate first snapshot (captures state even if OOM hits within 30s)
    _writeMemLine();
    _memLogTimer = setInterval(_writeMemLine, 30000); // Every 30s
}

function _writeMemLine() {
    (async () => {
        try {
            // Cap at 1MB — async stat to avoid blocking event loop
            try {
                const stat = await fs.promises.stat(MEM_LOG_PATH);
                if (stat.size > 1024 * 1024) {
                    await fs.promises.writeFile(MEM_LOG_PATH, `--- AutoAccept Memory Log (PID ${process.pid}) [truncated] ---\n`);
                }
            } catch (e) { }
            const mem = process.memoryUsage();
            const heap = Math.round(mem.heapUsed / 1024 / 1024);
            const rss  = Math.round(mem.rss / 1024 / 1024);
            const ext  = Math.round((mem.external || 0) / 1024 / 1024);
            const ab   = Math.round((mem.arrayBuffers || 0) / 1024 / 1024);
            const sessions = connectionManager ? connectionManager.sessions.size : 0;
            const ignored  = connectionManager ? connectionManager.ignoredTargets.size : 0;
            const pending  = connectionManager ? connectionManager._pendingIpc.size : 0;
            const line = `${new Date().toISOString()} | heap=${heap}MB rss=${rss}MB ext=${ext}MB ab=${ab}MB | sessions=${sessions} ignored=${ignored} pending=${pending}\n`;
            await fs.promises.appendFile(MEM_LOG_PATH, line);
        } catch (e) { }
    })();
}

function stopMemoryLogger() {
    clearInterval(_memLogTimer);
    _memLogTimer = null;
}

// ─── VS Code Commands ─────────────────────────────────────────────────
// Only Antigravity-specific commands — generic VS Code commands like
// chatEditing.acceptAllFiles cause sidebar interference (Outline toggling,
// folder collapsing) when the agent panel lacks focus.
const ALL_ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept',
];

// Terminal commands that Channel 1 fires blindly (no context awareness).
// When blocklist/allowlist is configured, these MUST be removed from Channel 1
// to force the extension to rely on Channel 2's DOM-based command inspection.
const TERMINAL_COMMANDS = [
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept',  // Generic acceptor — also fires terminal commands blindly
];

// Conservative estimate: each manual click = review + find button + click ≈ 3s
const SECONDS_SAVED_PER_CLICK = 3;

// Milestones + gamification ranks (single source of truth — shared with dashboard)
const MILESTONES = [100, 500, 1000, 5000, 10000, 50000];
const MILESTONE_RANKS = {
    100: 'Initiate',
    500: 'Apprentice',
    1000: 'Automator',
    5000: 'Time Lord',
    10000: 'Grandmaster',
    50000: 'Ascended'
};

/**
 * Cached configuration state — refreshed via onDidChangeConfiguration,
 * never read from registry on every poll tick (avoids I/O spam).
 */
let cachedAutoAcceptFileEdits = true;
let cachedBlockedCommands = [];
let cachedAllowedCommands = [];
let cachedHasFilters = false;
let cachedAutoRetryEnabled = true;

function refreshConfig() {
    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const newFileEdits = config.get('autoAcceptFileEdits', true);
    const newBlocked = config.get('blockedCommands', []);
    const newAllowed = config.get('allowedCommands', []);
    const newHasFilters = newBlocked.length > 0 || newAllowed.length > 0;
    const newRetry = config.get('autoRetryEnabled', true);

    // Log only on transitions
    if (newHasFilters !== cachedHasFilters) {
        log(newHasFilters
            ? `[Config] Command filters active — terminal commands deferred to Channel 2`
            : `[Config] Command filters removed — terminal commands restored to Channel 1`);
    }

    cachedAutoAcceptFileEdits = newFileEdits;
    cachedBlockedCommands = newBlocked;
    cachedAllowedCommands = newAllowed;
    cachedHasFilters = newHasFilters;
    cachedAutoRetryEnabled = newRetry;
    log(`[Config] hasFilters=${cachedHasFilters}, blocked=[${newBlocked.join(',')}], fileEdits=${newFileEdits}, retry=${newRetry}`);

    // Hot-reload: push updated config to live CDP sessions
    if (connectionManager) {
        connectionManager.setCommandFilters(newBlocked, newAllowed);
        connectionManager.pushFilterUpdate(newBlocked, newAllowed);

        // Re-inject observers when file edit or retry setting changes (keyword list is baked at inject time)
        const needsReinject = connectionManager.autoAcceptFileEdits !== newFileEdits ||
                              connectionManager.autoRetryEnabled !== newRetry;
        connectionManager.autoAcceptFileEdits = newFileEdits;
        connectionManager.autoRetryEnabled = newRetry;
        if (needsReinject) {
            connectionManager.reinjectAll();
        }
    }
}

/**
 * Builds the command list from cached config (no I/O per tick).
 * When command filters are active, Channel 1 is FULLY disabled.
 * ALL accept commands fire blindly (no command text inspection),
 * so they MUST be deferred to Channel 2's DOM-based inspection.
 */
function getActiveCommands() {
    // Filters active → disable Channel 1 entirely. Channel 2 handles everything.
    if (cachedHasFilters) {
        return [];
    }

    let commands = [...ALL_ACCEPT_COMMANDS];

    if (!cachedAutoAcceptFileEdits) {
        // Fix #45: Remove BOTH the specific and generic acceptors.
        // antigravity.command.accept is Antigravity's generic "accept whatever is pending"
        // and will accept file edits through the backdoor if left in.
        commands = commands.filter(c =>
            c !== 'antigravity.agent.acceptAgentStep' &&
            c !== 'antigravity.command.accept'
        );
    }

    return commands;
}

let isEnabled = false;
let pollIntervalId = null;
let statusBarItem = null;
let outputChannel = null;
let connectionManager = null;
let dashboardProvider = null;
let telegramBridge = null;

// ─── Global Idle Tracker (Swarm focus-steal prevention) ─────────────
let _lastUserActivity = Date.now();
const _resetIdle = () => { _lastUserActivity = Date.now(); };

// ─── Swarm Mode: Ghost Switch ─────────────────────────────────────────
// Phase 1 Pro feature: detects background pending Run commands via the
// onDidOpenTerminal signal, saves the user's current editor, focuses
// Antigravity to hydrate the webview, fires accept, then restores focus.

let _ghostSwitchInProgress = false;
let _ghostSwitchEnabled = false; // Gated behind Pro license
let _swarmReadyAt = 0;

// ─── Swarm Mode: Pro License Activation ───────────────────────────────
const SWARM_WORKER_URL = 'https://aa-swarm.yazanbaker.workers.dev/script';
const SWARM_CACHE_TTL  = 24 * 60 * 60 * 1000; // 24h

/**
 * Fetches the Swarm observer script from the Cloudflare Worker and injects
 * it into the Agent Manager CDP target via SecretStorage-cached delivery.
 */
async function activateSwarmMode(context, forceRefresh = false) {
    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const licenseKey = config.get('proLicenseKey', '').trim();

    if (!licenseKey) {
        log('[Swarm] No Pro key configured — Swarm Mode unavailable');
        _ghostSwitchEnabled = false;
        await context.globalState.update('aa_swarm_active', false);
        if (connectionManager) connectionManager.disableSwarm();
        if (telegramBridge) {
            telegramBridge.unpair().catch(() => {});
            telegramBridge.stop();
            telegramBridge = null;
        }
        return;
    }

    const cachedAt = context.globalState.get('aa_swarm_cached_at', 0);
    const isFresh  = !forceRefresh && (Date.now() - cachedAt) < SWARM_CACHE_TTL;
    let swarmConfig = null;

    if (isFresh) {
        // SecretStorage: encrypted by OS keychain, NOT plaintext SQLite
        swarmConfig = await context.secrets.get('aa_swarm_script');
        if (swarmConfig) {
            // Validate JSON capability gate — bust legacy/stale cache
            try {
                const parsed = JSON.parse(swarmConfig);
                if (!parsed.authorized) throw new Error('not authorized');
                // 🛑 SECURITY: Bust cache if payload OR signature is missing (prevents Downgrade Attack)
                if (!parsed.corePayload || !parsed.coreSignature) throw new Error('stale config: missing corePayload or signature');
                log('[Swarm] Using cached config (within 24h, has signed payload)');
            } catch(e) {
                log(`[Swarm] Cache bust: ${e.message} — forcing fresh fetch`);
                swarmConfig = null;
                try { await context.secrets.delete('aa_swarm_script'); } catch(err) {}
                await context.globalState.update('aa_swarm_cached_at', 0);
            }
            if (swarmConfig) {
                // Ensure active state is set — critical for status bar visibility
                await context.globalState.update('aa_swarm_active', true);
            }
        }
    }

    if (!swarmConfig) {
        try {
            const res = await fetch(SWARM_WORKER_URL, {
                method: 'POST',
                headers: {
                    'X-License-Key': licenseKey,
                    'X-Machine-Id':  vscode.env.machineId,
                },
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                log(`[Swarm] License rejected (${res.status}): ${body.substring(0, 80)}`);

                // 502 = Gumroad API is down — DON'T deactivate the user, fall through to offline cache
                if (res.status === 502) {
                    throw new Error('Gumroad API unreachable (502) — using offline cache');
                }

                // 401/403 = Invalid key or device limit — WIPE secrets to close the "forever offline" exploit
                if (res.status === 401 || res.status === 403) {
                    try { await context.secrets.delete('aa_swarm_script'); } catch(e) {}
                    // 🛑 Tell Cloudflare to drop the Telegram session
                    if (telegramBridge) {
                        await telegramBridge.unpair().catch(()=>{});
                    }
                }
                await context.globalState.update('aa_swarm_active', false);
                await context.globalState.update('aa_swarm_plan', '');
                vscode.window.showWarningMessage(
                    `AntiGravity Swarm Mode: ${res.status === 403 ? 'Device limit reached.' : 'Invalid or refunded key.'} Visit the link to manage your license.`,
                    'Manage License'
                ).then(c => {
                    if (c === 'Manage License')
                        vscode.env.openExternal(vscode.Uri.parse('https://app.gumroad.com/library'));
                });
                _ghostSwitchEnabled = false;
                if (connectionManager) connectionManager.disableSwarm();
                // ⚡ Kill Telegram bridge on invalid key — prevents zombie TG sessions
                if (telegramBridge) { telegramBridge.stop(); telegramBridge = null; }
                return;
            }

            swarmConfig = await res.text();
            const plan = res.headers.get('X-Plan') || '';

            // Validate that it's valid JSON capability gate
            try {
                const parsed = JSON.parse(swarmConfig);
                if (!parsed.authorized) throw new Error('not authorized');
            } catch(e) {
                log(`[Swarm] Invalid capability gate from worker: ${e.message}`);
                _ghostSwitchEnabled = false;
                if (connectionManager) connectionManager.disableSwarm();
                return;
            }

            // Store securely in OS keychain — try/catch for Linux/WSL where keychain may be unavailable
            try {
                await context.secrets.store('aa_swarm_script', swarmConfig);
            } catch (e) {
                log(`[Swarm] Warning: OS Keychain unavailable. Config held in RAM only: ${e.message}`);
                context._pendingSwarmScript = swarmConfig;
            }
            await context.globalState.update('aa_swarm_cached_at', Date.now());
            await context.globalState.update('aa_swarm_plan', plan);
            await context.globalState.update('aa_swarm_active', true);
            log(`[Swarm] Config fetched and cached in SecretStorage (plan: ${plan || 'unknown'})`);
        } catch (e) {
            // Network failure or 502 — try stale cache with 7-day max offline limit
            const stale = await context.secrets.get('aa_swarm_script').catch(() => null);
            const MAX_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

            if (stale && (Date.now() - cachedAt) < MAX_OFFLINE_MS) {
                swarmConfig = stale;
                log(`[Swarm] Network error — using stale cache (${Math.round((Date.now() - cachedAt) / 86400000)}d old): ${e.message}`);
            } else {
                log(`[Swarm] Offline >7 days or no cache. Deactivating: ${e.message}`);
                try { await context.secrets.delete('aa_swarm_script'); } catch(err) {}
                _ghostSwitchEnabled = false;
                await context.globalState.update('aa_swarm_active', false);
                await context.globalState.update('aa_swarm_plan', '');
                if (connectionManager) connectionManager.disableSwarm();
                return;
            }
        }
    }

    if (connectionManager) {
        // Always store the config — even if CDP isn't connected yet.
        // When Agent Manager connects later, it checks _swarmScript and auto-injects.
        connectionManager._swarmScript = swarmConfig;
        const ok = await connectionManager.injectSwarmObserver(swarmConfig);
        if (ok) {
            log('[Swarm] ✓ Swarm Mode active');
            _ghostSwitchEnabled = true;
        } else {
            log('[Swarm] Config stored — will auto-inject when Agent Manager connects');
        }
    } else {
        // Store for injection when connectionManager initialises
        context._pendingSwarmScript = swarmConfig;
        log('[Swarm] Config queued — will inject when CDP connects');
    }

    // ⚡ Telegram Bridge: Start polling if paired (independent of CDP — poll loop works without it)
    if (!telegramBridge && licenseKey) {
        telegramBridge = new TelegramBridge({
            log,
            machineId: vscode.env.machineId,
            licenseKey,
            connectionManager,
        });
        telegramBridge.start();
        log('[Telegram] Bridge initialized');
    }
}

async function ghostSwitchUnblock(conversationId) {
    if (!_ghostSwitchEnabled || !isEnabled) return;
    if (_ghostSwitchInProgress) return;
    _ghostSwitchInProgress = true;

    // Save exactly where the user is currently working
    const previousEditor = vscode.window.activeTextEditor;
    const previousDocument = previousEditor?.document;
    const previousViewColumn = previousEditor?.viewColumn;
    const previousSelection = previousEditor?.selection;

    log(`[SwarmMode] Ghost Switch initiated${conversationId ? ` for ${conversationId.substring(0, 8)}` : ''}`);

    try {
        // Focus the Antigravity panel — triggers React hydration of background chat
        await vscode.commands.executeCommand('workbench.view.extension.antigravity')
            .catch(() => vscode.commands.executeCommand('antigravity.focus'))
            .catch(() => vscode.commands.executeCommand('workbench.action.focusSideBar'));

        // If we have the specific conversationId, navigate directly to it
        if (conversationId) {
            await vscode.commands.executeCommand('antigravity.openConversation', conversationId).catch(() => {});
        }

        // Wait for React to mount the DOM (~350ms is typical for hydration)
        await new Promise(resolve => setTimeout(resolve, 350));

        // Fire accept — Channel 1 now works because the webview is live
        await Promise.allSettled([
            vscode.commands.executeCommand('antigravity.terminalCommand.accept'),
            vscode.commands.executeCommand('antigravity.terminalCommand.run'),
            vscode.commands.executeCommand('antigravity.command.accept'),
        ]);

        log('[SwarmMode] Ghost Switch accept fired ✓');
    } catch (err) {
        log(`[SwarmMode] Ghost Switch error: ${err.message}`);
    } finally {
        // Always restore — even on failure
        await new Promise(resolve => setTimeout(resolve, 100));
        if (previousDocument) {
            try {
                const restored = await vscode.window.showTextDocument(previousDocument, {
                    viewColumn: previousViewColumn,
                    preserveFocus: false,
                    preview: false,
                });
                // Restore exact cursor/selection position
                if (previousSelection) restored.selection = previousSelection;
            } catch(e) { /* editor may have been closed, ignore */ }
        }
        _ghostSwitchInProgress = false;
        log('[SwarmMode] Focus restored to previous editor');
    }
}

function log(msg) {
    if (outputChannel) {
        outputChannel.appendLine(`${new Date().toLocaleTimeString()} ${msg}`);
    }
    // Push to dashboard activity log
    if (dashboardProvider) {
        const type = msg.includes('blocked') || msg.includes('BLOCK') ? 'blocked'
            : msg.includes('clicked') || msg.includes('CLICK') ? 'click' : 'info';
        dashboardProvider.pushActivity(msg, type);
    }
}

function updateStatusBar() {
    if (!statusBarItem) return;
    if (isEnabled) {
        statusBarItem.text = '$(zap) Auto: ON';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.tooltip = 'AntiGravity AutoAccept is ACTIVE — click to disable';
    } else {
        statusBarItem.text = '$(circle-slash) Auto: OFF';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'AntiGravity AutoAccept is OFF — click to enable';
    }
}

// ─── VS Code Command Polling ──────────────────────────────────────────
function startPolling() {
    if (pollIntervalId) return;

    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const interval = config.get('pollInterval', 500);
    log(`Polling started (every ${interval}ms)`);

    let consecutiveErrors = 0;
    let pollRunning = false; // Bug 5 fix: re-entrancy lock
    // Recursive setTimeout pattern — guarantees strict sequential execution.
    async function pollCycle() {
        if (!isEnabled) return;
        // Bug 5 fix: skip if previous cycle is still running (3s timeout race)
        if (pollRunning) {
            if (isEnabled) pollIntervalId = setTimeout(pollCycle, interval);
            return;
        }

        // Fix #48 + #46: CDP Mutex — suppress antigravity.agent.acceptAgentStep (causes
        // focus stealing / sidebar flickering) but keep TERMINAL_COMMANDS active.
        // TERMINAL_COMMANDS includes antigravity.command.accept which is the generic
        // acceptor that handles the Run button in the agent chat UI.
        const isCdpActive = connectionManager && connectionManager.sessions.size > 0;
        if (isCdpActive) {
            if (isEnabled && !cachedHasFilters && !(connectionManager && connectionManager.isPaused)) {
                Promise.allSettled(TERMINAL_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))).catch(() => {});
            }
            pollIntervalId = setTimeout(pollCycle, interval);
            return;
        }

        pollRunning = true;
        try {
            // Re-read active commands each cycle so config changes take effect live.
            const cmds = getActiveCommands();
            let timerId;
            const timeoutPromise = new Promise(resolve => { timerId = setTimeout(resolve, 3000); });
            const commandsPromise = Promise.allSettled(
                cmds.map(cmd => vscode.commands.executeCommand(cmd))
            );
            const results = await Promise.race([commandsPromise, timeoutPromise]);
            clearTimeout(timerId); // P1: prevent orphaned timer leak

            // P0: Promise.allSettled NEVER throws; inspect results to detect failures
            if (Array.isArray(results)) {
                const allFailed = results.length > 0 && results.every(r => r.status === 'rejected');
                if (allFailed) throw new Error('All commands rejected');
            } else {
                throw new Error('Command timeout');
            }
            consecutiveErrors = 0; // Reset only if at least one succeeded
        } catch (e) {
            consecutiveErrors++;
            if (consecutiveErrors <= 3 || consecutiveErrors % 10 === 0) {
                log(`[Poll] Error (${consecutiveErrors}x): ${e.message}`);
            }
        } finally {
            pollRunning = false;
        }
        if (isEnabled) {
            // P2: Smart Sleep — use 5s interval when no active sessions (near-zero IPC when idle)
            const isIdle = connectionManager && connectionManager.sessions.size === 0;
            const baseInterval = isIdle ? 5000 : interval;
            // Exponential backoff with ±20% jitter on persistent failures (caps at 30s).
            const jitter = 0.8 + (Math.random() * 0.4);
            const backoff = consecutiveErrors > 0
                ? Math.min(baseInterval * Math.pow(2, consecutiveErrors - 1), 30000) * jitter
                : baseInterval;
            pollIntervalId = setTimeout(pollCycle, backoff);
        }
    }
    pollIntervalId = setTimeout(pollCycle, interval);

    // Start/unpause persistent CDP connection
    if (connectionManager) {
        if (connectionManager.isRunning) {
            connectionManager.unpause(); // Already connected — just unpause
        } else {
            connectionManager.start(); // First time — establish WS connection
        }
    }
}

function stopPolling() {
    if (pollIntervalId) { clearTimeout(pollIntervalId); pollIntervalId = null; }
    if (connectionManager && connectionManager.isRunning) {
        connectionManager.pause(); // Soft toggle — keep WS alive
    }
    log('Polling stopped');
}

// ─── CDP Auto-Fix: Detect & Repair ───────────────────────────────────

// Graceful Dual-Port: configured port (default 9333), legacy 9222 fallback
// 🛑 SECURITY: parseInt + range check prevents PowerShell injection via malicious workspace settings
function getConfiguredPort() {
    const port = parseInt(vscode.workspace.getConfiguration('autoAcceptV2').get('cdpPort', 9333), 10);
    return (isNaN(port) || port < 1024 || port > 65535) ? 9333 : port;
}

function pingPort(port) {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                // Ghost sockets accept TCP but return no valid HTTP/JSON data.
                // Real CDP returns JSON like {"Browser":"...","webSocketDebuggerUrl":"..."}
                resolve(data.length > 5 && data.includes('{'));
            });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function checkAndFixCDP() {
    const configPort = getConfiguredPort();

    if (await pingPort(configPort)) {
        log(`[CDP] Debug port ${configPort} active ✓`);
        return true;
    }

    // ── Ghost Socket Recovery ──────────────────────────────────────
    // Port may be held by an orphan Electron process. Try to detect and kill it.
    if (process.platform === 'win32') {
        try {
            const netstatResult = await new Promise((resolve) => {
                // ⚡ FIX: Use LISTENING filter to avoid matching ephemeral ports
                cp.exec(`netstat -ano | findstr LISTENING | findstr :${configPort}`, { windowsHide: true, timeout: 3000 }, (err, stdout) => {
                    resolve(stdout?.trim() || '');
                });
            });
            
            if (netstatResult && netstatResult.includes('LISTENING')) {
                // Port is held by something — extract PID
                const match = netstatResult.match(/LISTENING\s+(\d+)/);
                if (match) {
                    const ghostPid = match[1];
                    log(`[CDP] Ghost socket detected on port ${configPort} (PID ${ghostPid}). Attempting recovery...`);
                    
                    // ⚡ FIX: /T kills the entire process TREE (orphaned children holding handles)
                    await new Promise((resolve) => {
                        cp.exec(`taskkill /F /T /PID ${ghostPid}`, { windowsHide: true, timeout: 3000 }, (err) => {
                            if (err) {
                                log(`[CDP] Could not kill ghost PID ${ghostPid}: ${err.message}`);
                            } else {
                                log(`[CDP] Killed ghost process tree ${ghostPid}`);
                            }
                            resolve();
                        });
                    });

                    // Wait for port to release, then retry
                    await new Promise(r => setTimeout(r, 1500));
                    if (await pingPort(configPort)) {
                        log(`[CDP] Port ${configPort} recovered after tree-kill ✓`);
                        return true;
                    }

                    // 🚀 AUTO PORT-HOPPING: Windows kernel has the port hostage — jump to next port
                    let newPort = configPort + 1;
                    if (newPort > 9345) newPort = 9333; // Wrap around safely
                    
                    log(`[CDP] ⚠ Port ${configPort} kernel-locked. Auto-hopping to Port ${newPort}...`);
                    
                    // Update settings globally
                    await vscode.workspace.getConfiguration('autoAcceptV2').update('cdpPort', newPort, vscode.ConfigurationTarget.Global);
                    
                    // Rewrite the Windows Shortcut silently with the new port
                    applyPermanentWindowsPatch(newPort);
                    
                    vscode.window.showWarningMessage(
                        `⚠ Port ${configPort} stuck by Windows. AutoAccept auto-hopped to Port ${newPort} and updated your shortcut. Please restart to apply.`,
                        'Restart Now'
                    ).then(action => {
                        if (action === 'Restart Now') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
                    return false;
                }
            }
        } catch (e) {
            log(`[CDP] Ghost socket check error: ${e.message}`);
        }
    }

    // ── Port Discovery: scan nearby ports for AG ───────────────────
    // AG might be running on a different port (e.g. after conversation fix
    // relaunch, or manual restart without the shortcut).
    for (let scanPort = 9333; scanPort <= 9340; scanPort++) {
        if (scanPort === configPort) continue; // Already checked
        if (await pingPort(scanPort)) {
            log(`[CDP] 🔍 Found AG on port ${scanPort} (configured: ${configPort}). Auto-switching...`);
            await vscode.workspace.getConfiguration('autoAcceptV2').update('cdpPort', scanPort, vscode.ConfigurationTarget.Global);
            applyPermanentWindowsPatch(scanPort);
            vscode.window.showInformationMessage(
                `AutoAccept found AntiGravity on port ${scanPort}. Config updated automatically. ✓`
            );
            return true;
        }
    }

    // Port refused — prompt user
    log(`[CDP] ⚠ Port ${configPort} refused — remote debugging not enabled`);
    vscode.window.showErrorMessage(
        `⚡ AutoAccept needs Debug Mode (Port ${configPort}). Please apply the fix or update your shortcut.`,
        'Auto-Fix Shortcut (Windows)',
        'Manual Guide'
    ).then(action => {
        if (action === 'Auto-Fix Shortcut (Windows)') applyPermanentWindowsPatch(configPort);
        else if (action === 'Manual Guide') vscode.env.openExternal(vscode.Uri.parse('https://github.com/yazanbaker94/AntiGravity-AutoAccept#setup'));
    });
    return false;
}

function applyPermanentWindowsPatch(targetPort) {
    if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('Auto-patching is Windows-only. Use the Manual Guide.');
        return;
    }

    // Fileless patcher: NO temp file needed. Encoded in memory.
    const psContent = `
$flag = "--remote-debugging-port=${targetPort}"
$WshShell = New-Object -comObject WScript.Shell
$paths = @("$env:USERPROFILE\\\\Desktop", "$env:PUBLIC\\\\Desktop", "$env:APPDATA\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs", "$env:ALLUSERSPROFILE\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs", "$env:APPDATA\\\\Microsoft\\\\Internet Explorer\\\\Quick Launch\\\\User Pinned\\\\TaskBar")
$patched = $false
$manualFixNeeded = $false
$patchedLnk = $null

foreach ($dir in $paths) {
    if (Test-Path $dir) {
        $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            try {
                $shortcut = $WshShell.CreateShortcut($file.FullName)
                if ($file.Name -match "Antigravity" -or $shortcut.TargetPath -match "Antigravity") {
                    if ($shortcut.Arguments -match "--remote-debugging-port=") {
                        if ($shortcut.Arguments -notmatch $flag) {
                            $manualFixNeeded = $true
                        } else {
                            if (-not $patchedLnk) { $patchedLnk = $file.FullName }
                        }
                    } else {
                        $shortcut.Arguments = ("$($shortcut.Arguments) " + $flag).Trim()
                        $shortcut.Save()
                        $patched = $true
                        if (-not $patchedLnk) { $patchedLnk = $file.FullName }
                    }
                }
            } catch {
                # Silently ignore COM exceptions from protected system shortcuts
            }
        }
    }
}
if ($manualFixNeeded) { Write-Output "MANUAL_NEEDED" }
elseif ($patched -or $patchedLnk) { Write-Output "SUCCESS|$patchedLnk" }
else { Write-Output "NOT_FOUND" }
`;

    // Encode to UTF-16LE Base64 for safe fileless execution (bypasses Win11 ASR policies)
    const base64Script = Buffer.from(psContent, 'utf16le').toString('base64');

    log(`[CDP] Running fileless shortcut patcher for port ${targetPort}...`);
    cp.exec(`powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${base64Script}`,
        { windowsHide: true },
        (err, stdout) => {

            if (err) {
                log(`[CDP] Patcher error: ${err.message}`);
                vscode.window.showWarningMessage('Shortcut patching failed. Please add the flag manually.');
                return;
            }
            const out = stdout.trim();
            log(`[CDP] Patcher output: ${out}`);
            if (out.includes('MANUAL_NEEDED')) {
                vscode.window.showWarningMessage(
                    `Your shortcut already has a debugging port. Please manually change it to ${targetPort} in the shortcut properties.`
                );
            } else if (out.includes('SUCCESS|')) {
                const lnkPath = out.split('SUCCESS|')[1].trim();
                log(`[CDP] ✓ Shortcut ready: ${lnkPath}`);
                vscode.window.showInformationMessage(
                    `✅ Shortcut ready! Restart Antigravity to activate AutoAccept.`,
                    'Restart Now'
                ).then(action => {
                    if (action === 'Restart Now') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } else {
                log('[CDP] No matching shortcuts found');
                vscode.window.showWarningMessage(
                    `No Antigravity shortcut found. Add --remote-debugging-port=${targetPort} to your shortcut manually.`
                );
            }
        });
}

// ─── Conversation Guard ──────────────────────────────────────────────

/**
 * Spawns a detached worker that waits for AG to exit, rebuilds the
 * conversation index from .pb files on disk, and relaunches AG.
 */
function runConversationFix() {
    const workerPath = path.join(__dirname, 'scripts', 'conversationFix.js');

    const cdpPort = getConfiguredPort();
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    
    // ⚡ CRITICAL FIX: Pass the Main Process PID so the worker knows 
    // exactly when the Chromium Single-Instance Lock is released!
    const mainPid = process.env.VSCODE_PID ? parseInt(process.env.VSCODE_PID, 10) : process.ppid;
    const relaunchInfo = JSON.stringify({ cdpPort, workspaceFolders, mainPid });

    const child = cp.spawn(process.execPath, [workerPath, process.pid.toString(), relaunchInfo], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: 'ignore',
    });
    child.unref();

    log('[ConvGuard] Detached fixer spawned. Quitting AG...');
    // Quit immediately, as the user already confirmed via the modal
    vscode.commands.executeCommand('workbench.action.quit');
}

/**
 * Lazy auto-detection: loads sql.js to read the actual sidebar index count
 * from state.vscdb and compares against .pb files on disk.
 * Shows exact numbers: "100 on disk but only 80 in sidebar — 20 missing"
 */
async function detectMissingConversations(context) {
    try {
        const convDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
        if (!fs.existsSync(convDir)) return;

        const pbFiles = fs.readdirSync(convDir).filter(f => f.endsWith('.pb'));
        const onDisk = pbFiles.length;
        if (onDisk === 0) return;

        // Read actual sidebar index count from state.vscdb
        const isWin = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        const dbPath = isWin
            ? path.join(process.env.APPDATA, 'antigravity', 'User', 'globalStorage', 'state.vscdb')
            : isMac
                ? path.join(os.homedir(), 'Library', 'Application Support', 'antigravity', 'User', 'globalStorage', 'state.vscdb')
                : path.join(os.homedir(), '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

        if (!fs.existsSync(dbPath)) return;

        // Lazy-load sql.js (only here, only once, 15s after startup)
        let indexCount = 0;
        let db;
        try {
            const extRoot = path.resolve(__dirname, '..');
            const wasmPath = path.join(extRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
            const initSqlJs = require(path.join(extRoot, 'node_modules', 'sql.js'));
            const SQL = await initSqlJs({ locateFile: () => wasmPath });
            const dbBuffer = fs.readFileSync(dbPath);
            db = new SQL.Database(dbBuffer);

            const rows = db.exec("SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries'");
            if (rows.length && rows[0].values.length && rows[0].values[0][0]) {
                // Count UUID entries in the protobuf — each entry has a UUID pattern
                const b64Value = rows[0].values[0][0];
                const decoded = Buffer.from(b64Value, 'base64');
                // Quick count: scan for field 1 (UUID strings) in the top-level repeated message
                let pos = 0;
                while (pos < decoded.length) {
                    try {
                        let tag, tagEnd;
                        ({ value: tag, pos: tagEnd } = decodeVarintLight(decoded, pos));
                        if ((tag & 7) !== 2) break;
                        let entryLen;
                        ({ value: entryLen, pos } = decodeVarintLight(decoded, tagEnd));
                        pos += entryLen;
                        indexCount++;
                    } catch (e) { break; }
                }
            }
        } catch (e) {
            log(`[ConvGuard] sql.js detection error: ${e.message}`);
            return; // Can't read DB — skip detection silently
        } finally {
            // Guarantee WASM memory is freed even if db.exec throws
            if (db) { try { db.close(); } catch(e) {} }
        }

        const missing = onDisk - indexCount;
        log(`[ConvGuard] Detection: ${onDisk} on disk, ${indexCount} in sidebar index, ${missing} missing`);

        // Update baseline for future reference
        context.globalState.update('aa_lastConvCount', onDisk);

        // UX GUARD: Don't spam if they already dismissed this exact missing count
        const dismissedCount = context.globalState.get('aa_dismissedMissingCount', -1);

        if (missing > 2 && missing !== dismissedCount) {
            vscode.window.showWarningMessage(
                `Your history has ${onDisk} chats but the sidebar only shows ${indexCount} — ${missing} conversations are missing.`,
                'Fix Now',
                'Dismiss'
            ).then(action => {
                if (action === 'Fix Now') {
                    // Clear dismiss state so it monitors normally after a fix
                    context.globalState.update('aa_dismissedMissingCount', -1);
                    runConversationFix();
                } else if (action === 'Dismiss') {
                    // Silence the popup until the missing count changes again
                    context.globalState.update('aa_dismissedMissingCount', missing);
                }
            });
        }
    } catch (e) {
        log(`[ConvGuard] Detection error: ${e.message}`);
    }
}

/** Lightweight varint decoder for detection (no dependency on worker script) */
function decodeVarintLight(buffer, offset) {
    let result = 0, shift = 0, pos = offset || 0;
    while (pos < buffer.length) {
        const byte = buffer[pos++];
        result += (byte & 0x7F) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result, pos };
}


// ─── Activation ───────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AntiGravity AutoAccept');
    const { version } = require('../package.json');
    log(`Extension activating (v${version})`);
    startMemoryLogger();
    log(`[MEM] Memory log: ${MEM_LOG_PATH}`);

    // Telemetry: anonymous activation ping (fire-and-forget)
    pingTelemetry('activate', context, log);

    // Idle guard for Swarm: track user interactions to prevent focus theft.
    // IMPORTANT: typing in webviews (agent chat input) does NOT fire any of these.
    // We track as many signals as possible and use a generous idle threshold (15s)
    // to avoid navigating while the user is typing in a chat.
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(_resetIdle),  // cursor/typing in editor
        vscode.window.onDidChangeActiveTerminal(_resetIdle),       // terminal focus
        vscode.window.onDidChangeActiveTextEditor(_resetIdle),     // tab switch
        vscode.window.onDidChangeVisibleTextEditors(_resetIdle),   // panel layout change
        vscode.window.onDidChangeWindowState((e) => { if (e.focused) _resetIdle(); })  // window focus
    );

    connectionManager = new ConnectionManager({
        log,
        getPort: getConfiguredPort,
        getCustomTexts: () => vscode.workspace.getConfiguration('autoAcceptV2').get('customButtonTexts', []),
        getLastUserActivity: () => _lastUserActivity
    });
    // CRITICAL: Set swarm pause state BEFORE activateSwarmMode runs (line ~731).
    // Without this, the scan loop starts with swarmPaused=false and navigates
    // before the pause state is restored at line ~853.
    connectionManager.swarmPaused = context.globalState.get('aa_swarm_paused', true);

    // Refresh dashboard when CDP status changes (connect/disconnect)
    connectionManager.onStatusChange = () => {
        if (dashboardProvider) dashboardProvider.refresh();
    };

    // Date initialization uses a session flag to avoid repeated globalState reads.
    // Cannot use prevTotal===0 guard — legacy users upgrading have clicks but no date.
    let isDateInitialized = false;
    connectionManager.onClickTelemetry = (delta) => {
        // Guard: reject non-numeric, NaN, or zero delta to prevent state corruption
        if (typeof delta !== 'number' || isNaN(delta) || delta <= 0) return;
        const prevTotal = context.globalState.get('autoAcceptTotalClicks', 0);
        const newTotal = prevTotal + delta;
        context.globalState.update('autoAcceptTotalClicks', newTotal);
        // Catches both new users AND legacy upgrades on their next click.
        // Zero globalState I/O overhead after the first heartbeat.
        if (!isDateInitialized) {
            if (!context.globalState.get('autoAcceptFirstClickDate')) {
                let startDateMs = Date.now();
                // Synthetic Backdating for Legacy Upgrades:
                // If user has historical clicks but no date, estimate start based on
                // a conservative 250 clicks/week to normalize ROI and honor history.
                if (prevTotal > 0) {
                    const ASSUMED_CLICKS_PER_WEEK = 250;
                    const assumedWeeks = prevTotal / ASSUMED_CLICKS_PER_WEEK;
                    startDateMs -= assumedWeeks * 604800000; // weeks to ms
                }
                context.globalState.update('autoAcceptFirstClickDate', new Date(startDateMs).toISOString());
            }
            isDateInitialized = true;
        }

        // Refresh dashboard counter on every heartbeat (not just milestones)
        if (dashboardProvider) dashboardProvider.refresh();

        // Milestone detection — descending order catches highest milestone on leaps
        for (let i = MILESTONES.length - 1; i >= 0; i--) {
            const m = MILESTONES[i];
            if (prevTotal < m && newTotal >= m) {
                const rank = MILESTONE_RANKS[m] || '';
                const minsSaved = Math.round((newTotal * SECONDS_SAVED_PER_CLICK) / 60);
                const dollarsSaved = minsSaved; // $1/min conservative
                const hh = Math.floor(minsSaved / 60);
                const mm = minsSaved % 60;
                const timeStr = minsSaved >= 60 ? (mm === 0 ? hh + 'h' : hh + 'h ' + mm + 'm') : minsSaved + ' mins';
                log(`[Analytics] 🎉 Milestone: ${newTotal.toLocaleString()} clicks! Rank: ${rank}`);
                // One-time celebration notification with dynamic metrics
                vscode.window.showInformationMessage(
                    `\u{1F3C6} ${rank}! You have auto-accepted ${m.toLocaleString()} times, saving ${timeStr} (~$${dollarsSaved}) of manual effort.`,
                    'Support the Dev \u2615',
                    'Share on X'
                ).then(action => {
                    if (action === 'Support the Dev \u2615') {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/yazanbaker94/AntiGravity-AutoAccept'));
                    } else if (action === 'Share on X') {
                        const tweet = `I just hit ${m.toLocaleString()} auto-clicks with AntiGravity AutoAccept! Rank: ${rank}. Saved ${timeStr} of dev time. Try it: https://github.com/yazanbaker94/AntiGravity-AutoAccept`;
                        vscode.env.openExternal(vscode.Uri.parse(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`));
                    }
                });
                break;
            }
        }
    };


    // Cross-machine sync: persist analytics across VS Code environments
    context.globalState.setKeysForSync([
        'autoAcceptTotalClicks', 'autoAcceptFirstClickDate', 'autoAcceptLastDismissedMilestone',
        'autoAcceptLastToastDate', 'autoAcceptSponsorClicks'
    ]);

    // Initialize cached config state
    refreshConfig();

    // Attempt Swarm Mode activation (Pro license check)
    activateSwarmMode(context);

    // ⚡ Silent Background Payload Refresh (every 12 hours)
    // Ensures users who leave VS Code open for weeks never hit the 14-day payload expiry.
    // Respects the 24h SWARM_CACHE_TTL — only hits the network if cache is stale.
    setInterval(() => {
        if (context.globalState.get('aa_swarm_active', false)) {
            activateSwarmMode(context, false).catch(() => {});
        }
    }, 12 * 60 * 60 * 1000);

    // Hot-reload: watch for config changes and push to live CDP sessions
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('autoAcceptV2')) {
                refreshConfig();
                if (e.affectsConfiguration('autoAcceptV2.proLicenseKey')) {
                    // License key changed — DON'T refresh dashboard yet.
                    // The webview shows "⏳ Activating..." and the Worker
                    // response will push the final state.
                    context.globalState.update('aa_swarm_cached_at', 0);
                    activateSwarmMode(context).then(() => {
                        if (dashboardProvider) dashboardProvider.refresh();
                        if (typeof updateSwarmPauseBar === 'function') updateSwarmPauseBar();
                    });
                } else {
                    if (dashboardProvider) dashboardProvider.refresh();
                }
            }
        })
    );

    // ─── Swarm Mode: Terminal-Open Signal (DEPRECATED — NOT USED) ──────────
    // onDidOpenTerminal was removed: Antigravity uses its own internal terminal
    // renderer inside the webview. VS Code's terminal API events never fire for
    // Antigravity Run commands. The correct approach is Strategy 1 (IPC spoof)
    // or a polling-based conversation-switcher (see swarm_mode_deepthink.md).
    // TODO: Implement proper Swarm Mode trigger after Recon Task 2 is complete.
    // ─────────────────────────────────────────────────────────────────

    // Compute currentMilestone in host (single source of truth — no duplicate array in webview)
    const _computeMilestone = (clicks) => {
        for (let i = MILESTONES.length - 1; i >= 0; i--) {
            if (clicks >= MILESTONES[i]) return MILESTONES[i];
        }
        return 0;
    };

    // Dashboard provider
    dashboardProvider = new DashboardProvider(context, log, () => {
        const totalClicks = context.globalState.get('autoAcceptTotalClicks', 0);
        const currentMilestone = _computeMilestone(totalClicks);
        const nextM = MILESTONES.find(m => m > totalClicks);
        return {
            isEnabled,
            cdpConnected: connectionManager ? !!connectionManager.ws : false,
            sessionCount: connectionManager ? connectionManager.sessions.size : 0,
            totalClicks,
            timeSavedMinutes: Math.round((totalClicks * SECONDS_SAVED_PER_CLICK) / 60),
            firstClickDate: context.globalState.get('autoAcceptFirstClickDate', null),
            lastDismissedMilestone: context.globalState.get('autoAcceptLastDismissedMilestone', 0),
            currentMilestone,
            currentRank: MILESTONE_RANKS[currentMilestone] || null,
            nextMilestone: nextM || null,
            nextRank: nextM ? MILESTONE_RANKS[nextM] : null
        };
    });

    // Wire diagnostic dump: pulls __AA_DIAG from active CDP sessions
    dashboardProvider.getDiagnostics = async () => {
        if (!connectionManager || connectionManager.sessions.size === 0) {
            return { sessions: 0, message: 'No active CDP sessions' };
        }
        const results = {};
        for (const [targetId, info] of connectionManager.sessions) {
            try {
                const check = await connectionManager._workerEval(info.wsUrl,
                    '(() => { const d = window.__AA_DIAG || []; return { diagCount: d.length, diag: d.slice(-20), clickCount: window.__AA_CLICK_COUNT || 0, observerActive: !!window.__AA_OBSERVER_ACTIVE, paused: !!window.__AA_PAUSED, hasFilters: !!window.__AA_HAS_FILTERS, blocked: (window.__AA_BLOCKED || []).length, allowed: (window.__AA_ALLOWED || []).length }; })()'
                );
                const val = check.result?.result?.value;
                results[targetId.substring(0, 6)] = val || { error: 'empty response' };
            } catch (e) {
                results[targetId.substring(0, 6)] = { error: e.message };
            }
        }
        return { sessions: connectionManager.sessions.size, data: results };
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.dashboard', () => {
            dashboardProvider.show();
        })
    );

    // ── Conversation Guard: Fix Missing Conversations ──
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.fixConversations', () => {
            runConversationFix();
        })
    );

    // Lazy auto-detection: 15s after activation (avoids cold-start bloat)
    setTimeout(() => detectMissingConversations(context), 15000);


    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'autoAcceptV2.toggle';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    // Dashboard button in status bar — right next to the toggle
    const dashboardStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    dashboardStatusBar.text = '$(dashboard) Dashboard';
    dashboardStatusBar.command = 'autoAcceptV2.dashboard';
    dashboardStatusBar.tooltip = 'Open AutoAccept Dashboard';
    context.subscriptions.push(dashboardStatusBar);
    dashboardStatusBar.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.toggle', () => {
            isEnabled = !isEnabled;
            log(`Toggled: ${isEnabled ? 'ON' : 'OFF'}`);
            if (isEnabled) { startPolling(); } else { stopPolling(); }
            updateStatusBar();
            if (dashboardProvider) dashboardProvider.refresh();
            context.globalState.update('autoAcceptV2Enabled', isEnabled);
            vscode.window.showInformationMessage(
                `AntiGravity AutoAccept: ${isEnabled ? 'ENABLED ⚡' : 'DISABLED 🔴'}`
            );
        })
    );

    // ── Swarm Mode Commands ──

    // Swarm Pause status bar indicator
    const swarmPauseBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    swarmPauseBar.command = 'autoAcceptV2.toggleSwarmPause';
    context.subscriptions.push(swarmPauseBar);
    // Persist swarm pause state across Reload Window. Default: PAUSED.
    // Swarm navigation is opt-in — user must Ctrl+Shift+S to enable.
    let _swarmPaused = context.globalState.get('aa_swarm_paused', true);
    // Sync persisted pause state to ConnectionManager immediately.
    // CM was created at line ~645 with swarmPaused=false. If the user paused
    // before last reload, the CM wouldn't know without this sync.
    if (connectionManager) connectionManager.swarmPaused = _swarmPaused;
    if (_swarmPaused) log('[Swarm] Restored pause state: PAUSED (persisted)');

    function updateSwarmPauseBar() {
        if (!context.globalState.get('aa_swarm_active', false)) {
            swarmPauseBar.hide();
            return;
        }
        swarmPauseBar.text = _swarmPaused ? '$(debug-pause) Swarm PAUSED' : '$(play) Swarm';
        swarmPauseBar.tooltip = _swarmPaused
            ? 'Swarm Mode is PAUSED (Ctrl+Shift+S to resume)'
            : 'Swarm Mode is running (Ctrl+Shift+S to pause)';
        swarmPauseBar.backgroundColor = _swarmPaused
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
        swarmPauseBar.show();
    }

    // Refresh Swarm — bust cache and re-fetch script from Worker
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.refreshSwarm', async () => {
            log('[Swarm] Manual cache bust requested');
            await context.globalState.update('aa_swarm_cached_at', 0);
            try { await context.secrets.delete('aa_swarm_script'); } catch(e) {}
            await activateSwarmMode(context, true);
            if (dashboardProvider) dashboardProvider.refresh();
            updateSwarmPauseBar();
            vscode.window.showInformationMessage('Swarm Mode: Cache cleared & config refreshed ✓');
        })
    );

    // ⚡ THE SWARM PAUSE TOGGLE
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.toggleSwarmPause', async () => {
            if (!isEnabled) { vscode.window.showWarningMessage('AutoAccept is globally OFF. Enable it first.'); return; }
            if (!context.globalState.get('aa_swarm_active', false)) {
                vscode.window.showInformationMessage('Swarm Mode requires a Pro license.', 'Get Pro').then(c => { if (c === 'Get Pro') vscode.env.openExternal(vscode.Uri.parse('https://yazanbake.gumroad.com/l/auto-accept')); });
                return;
            }
            
            _swarmPaused = !_swarmPaused;
            context.globalState.update('aa_swarm_paused', _swarmPaused);
            
            if (connectionManager) {
                // ⚡ FIX: Removed _localPauseOrigin tracking.
                // The setter natively handles file lock writing and CDP broadcasts.
                connectionManager.swarmPaused = _swarmPaused;
                if (!_swarmPaused) { connectionManager._lastWebviewActivity = 0; _lastUserActivity = 0; }
            }
            updateSwarmPauseBar();
            vscode.window.showInformationMessage(_swarmPaused ? 'Swarm Mode: ⏸ PAUSED' : 'Swarm Mode: ▶ RESUMED');
        })
    );

    setTimeout(() => updateSwarmPauseBar(), 3000);

    if (connectionManager) {
        connectionManager.onSwarmPauseChange = (isPaused) => {
            if (isPaused && !_swarmPaused) {
                // Another window paused → sync this window's UI
                _swarmPaused = true;
                context.globalState.update('aa_swarm_paused', true);
                updateSwarmPauseBar();
                log('[Swarm] Paused by another window (cross-process sync)');
            } else if (!isPaused && _swarmPaused) {
                // Another window resumed → sync this window's UI
                _swarmPaused = false;
                context.globalState.update('aa_swarm_paused', false);
                connectionManager._lastWebviewActivity = 0; _lastUserActivity = 0;
                updateSwarmPauseBar();
                log('[Swarm] Resumed by another window (cross-process sync)');
            }
        };
    }

    // ── Telegram Bot Commands ──
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.telegramPair', async () => {
            if (!context.globalState.get('aa_swarm_active', false)) {
                vscode.window.showWarningMessage('Telegram Remote requires a Pro license.');
                return;
            }
            if (!telegramBridge) {
                vscode.window.showWarningMessage('Telegram bridge not initialized. Ensure Swarm Mode is active.');
                return;
            }
            const result = await telegramBridge.requestPairingToken();
            if (!result) {
                vscode.window.showErrorMessage('Failed to generate pairing token. Check your connection.');
                return;
            }
            if (result.status === 'already_paired') {
                vscode.window.showInformationMessage(`✅ Already connected to Telegram (${result.username || 'user'}).`, 'Disconnect').then(c => {
                    if (c === 'Disconnect') vscode.commands.executeCommand('autoAcceptV2.telegramUnpair');
                });
                return;
            }
            if (result.botUrl) {
                await context.globalState.update('aa_telegram_pairing_url', result.botUrl);
                vscode.env.openExternal(vscode.Uri.parse(result.botUrl));
                vscode.window.showInformationMessage('🤖 Opened Telegram — tap Start to connect!', 'Copy Link').then(c => {
                    if (c === 'Copy Link') vscode.env.clipboard.writeText(result.botUrl);
                });
                if (dashboardProvider) dashboardProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.telegramUnpair', async () => {
            if (telegramBridge) {
                await telegramBridge.unpair();
                vscode.window.showInformationMessage('🔌 Telegram disconnected.');
                await context.globalState.update('aa_telegram_pairing_url', '');
                if (dashboardProvider) dashboardProvider.refresh();
            }
        })
    );

    if (vscode.env.remoteName) {
        if (context.globalState.get('autoAcceptV2Enabled', false)) { isEnabled = true; startPolling(); }
        updateStatusBar(); showWeeklyToast(context); return;
    }

    checkAndFixCDP().then(cdpOk => {
        if (cdpOk) { if (context.globalState.get('autoAcceptV2Enabled', false)) { isEnabled = true; startPolling(); } }
        updateStatusBar(); showWeeklyToast(context);
    });
}

function showWeeklyToast(context) {
    const WEEK_MS = 604800000;
    const lastToast = context.globalState.get('autoAcceptLastToastDate', 0);
    const now = Date.now();
    if (now - lastToast < WEEK_MS) return; 

    const totalClicks = context.globalState.get('autoAcceptTotalClicks', 0);
    if (totalClicks < 10) return; 

    const minsSaved = Math.round((totalClicks * SECONDS_SAVED_PER_CLICK) / 60);
    const timeStr = minsSaved >= 60 ? `${Math.floor(minsSaved / 60)}h ${minsSaved % 60}m` : `${minsSaved} mins`;
    vscode.window.showInformationMessage(`⚡ AutoAccept has saved you ${timeStr} of manual clicking so far!`, 'View Full Stats').then(action => { if (action === 'View Full Stats') vscode.commands.executeCommand('autoAcceptV2.dashboard'); });
    context.globalState.update('autoAcceptLastToastDate', now);
}

function deactivate() {
    stopMemoryLogger(); stopPolling();
    if (telegramBridge) { telegramBridge.stop(); telegramBridge = null; }
    if (connectionManager) connectionManager.stop(); 
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
