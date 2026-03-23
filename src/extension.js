// AntiGravity AutoAccept v3.0.0
// Primary: VS Code Commands API with async lock
// Secondary: Persistent CDP sessions with MutationObserver injection

const vscode = require('vscode');
const cp = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ConnectionManager } = require('./cdp/ConnectionManager');
const { DashboardProvider } = require('./dashboard/DashboardProvider');
const { pingTelemetry } = require('./telemetry');

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
    try {
        // Cap at 1MB
        try {
            const stat = fs.statSync(MEM_LOG_PATH);
            if (stat.size > 1024 * 1024) {
                fs.writeFileSync(MEM_LOG_PATH, `--- AutoAccept Memory Log (PID ${process.pid}) [truncated] ---\n`);
            }
        } catch (e) { }
        const mem = process.memoryUsage();
        const heap = Math.round(mem.heapUsed / 1024 / 1024);
        const rss = Math.round(mem.rss / 1024 / 1024);
        const ext = Math.round((mem.external || 0) / 1024 / 1024);
        const ab = Math.round((mem.arrayBuffers || 0) / 1024 / 1024);
        const sessions = connectionManager ? connectionManager.sessions.size : 0;
        const ignored = connectionManager ? connectionManager.ignoredTargets.size : 0;
        const pending = connectionManager ? connectionManager._pendingIpc.size : 0;
        const line = `${new Date().toISOString()} | heap=${heap}MB rss=${rss}MB ext=${ext}MB ab=${ab}MB | sessions=${sessions} ignored=${ignored} pending=${pending}\n`;
        fs.appendFileSync(MEM_LOG_PATH, line);
    } catch (e) { }
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
            if (isEnabled && !cachedHasFilters) {
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
function getConfiguredPort() {
    return vscode.workspace.getConfiguration('autoAcceptV2').get('cdpPort', 9333);
}

function pingPort(port) {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
            res.on('data', () => { }); // Consume data to free memory
            res.on('end', () => resolve(true));
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

// ─── Activation ───────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AntiGravity AutoAccept');
    const { version } = require('../package.json');
    log(`Extension activating (v${version})`);
    startMemoryLogger();
    log(`[MEM] Memory log: ${MEM_LOG_PATH}`);

    // Telemetry: anonymous activation ping (fire-and-forget)
    pingTelemetry('activate', context, log);

    // Initialize persistent CDP connection manager
    connectionManager = new ConnectionManager({
        log,
        getPort: getConfiguredPort,
        getCustomTexts: () => vscode.workspace.getConfiguration('autoAcceptV2').get('customButtonTexts', [])
    });

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

    // Hot-reload: watch for config changes and push to live CDP sessions
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('autoAcceptV2')) {
                refreshConfig();
                if (dashboardProvider) dashboardProvider.refresh();
            }
        })
    );

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

    // SSH Remote detection: CDP is architecturally impossible in remote mode.
    // The extension runs on the headless remote server (Node.js), but the UI
    // renders on the local Electron client. Channel 1 (VS Code commands) works
    // natively over RPC, so we fall back to polling-only mode.
    if (vscode.env.remoteName) {
        log(`[Setup] Remote environment (${vscode.env.remoteName}) detected. CDP disabled.`);
        log('[Setup] Operating in Channel 1 (command polling) mode only.');
        if (context.globalState.get('autoAcceptV2Enabled', false)) {
            isEnabled = true;
            startPolling();
        }
        updateStatusBar();
        log('Extension activated');
        showWeeklyToast(context);
        return;
    }

    // Check CDP on activation — prompt auto-fix if port is closed
    checkAndFixCDP().then(cdpOk => {
        if (cdpOk) {
            // Restore saved state
            if (context.globalState.get('autoAcceptV2Enabled', false)) {
                isEnabled = true;
                startPolling();
            }
        } else {
            log('CDP not available — bot will not start until debug port is enabled');
        }
        updateStatusBar();
        log('Extension activated');

        // Weekly stats toast — drives dashboard opens (sponsor impressions)
        showWeeklyToast(context);
    });
}

/**
 * Show a weekly stats notification to drive dashboard traffic.
 * Fires at most once per 7 days. Clicking "View Full Stats" opens the dashboard.
 */
function showWeeklyToast(context) {
    const WEEK_MS = 604800000;
    const lastToast = context.globalState.get('autoAcceptLastToastDate', 0);
    const now = Date.now();

    if (now - lastToast < WEEK_MS) return; // Already shown this week

    const totalClicks = context.globalState.get('autoAcceptTotalClicks', 0);
    if (totalClicks < 10) return; // Skip for brand-new users with no meaningful data

    const minsSaved = Math.round((totalClicks * SECONDS_SAVED_PER_CLICK) / 60);
    const timeStr = minsSaved >= 60
        ? `${Math.floor(minsSaved / 60)}h ${minsSaved % 60}m`
        : `${minsSaved} mins`;

    vscode.window.showInformationMessage(
        `⚡ AutoAccept has saved you ${timeStr} of manual clicking so far!`,
        'View Full Stats'
    ).then(action => {
        if (action === 'View Full Stats') {
            vscode.commands.executeCommand('autoAcceptV2.dashboard');
        }
    });

    context.globalState.update('autoAcceptLastToastDate', now);
    log(`[Toast] Weekly stats notification shown (${timeStr} saved)`);
}

function deactivate() {
    stopMemoryLogger();
    stopPolling();
    if (connectionManager) connectionManager.stop(); // Full teardown on deactivation
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
