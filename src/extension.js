// AntiGravity AutoAccept v3.0.0
// Primary: VS Code Commands API with async lock
// Secondary: Persistent CDP sessions with MutationObserver injection

const vscode = require('vscode');
const cp = require('child_process');
const http = require('http');
const { ConnectionManager } = require('./cdp/ConnectionManager');
const { DashboardProvider } = require('./dashboard/DashboardProvider');

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
    'antigravity.command.accept',
];

/**
 * Cached configuration state — refreshed via onDidChangeConfiguration,
 * never read from registry on every poll tick (avoids I/O spam).
 */
let cachedAutoAcceptFileEdits = true;
let cachedBlockedCommands = [];
let cachedAllowedCommands = [];
let cachedHasFilters = false;

function refreshConfig() {
    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const newFileEdits = config.get('autoAcceptFileEdits', true);
    const newBlocked = config.get('blockedCommands', []);
    const newAllowed = config.get('allowedCommands', []);
    const newHasFilters = newBlocked.length > 0 || newAllowed.length > 0;

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

    // Hot-reload: push updated config to live CDP sessions
    if (connectionManager) {
        connectionManager.setCommandFilters(newBlocked, newAllowed);
        connectionManager.pushFilterUpdate(newBlocked, newAllowed);

        // Re-inject observers when file edit setting changes (button list is baked at inject time)
        if (connectionManager.autoAcceptFileEdits !== newFileEdits) {
            connectionManager.autoAcceptFileEdits = newFileEdits;
            connectionManager.reinjectAll();
        }
    }
}

/**
 * Builds the command list from cached config (no I/O per tick).
 */
function getActiveCommands() {
    let commands = [...ALL_ACCEPT_COMMANDS];

    if (!cachedAutoAcceptFileEdits) {
        commands = commands.filter(c => c !== 'antigravity.agent.acceptAgentStep');
    }

    if (cachedHasFilters) {
        commands = commands.filter(c => !TERMINAL_COMMANDS.includes(c));
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
    const activeCommands = getActiveCommands();
    log(`Polling started (every ${interval}ms, ${activeCommands.length} commands)`);

    // Recursive setTimeout pattern — guarantees strict sequential execution.
    async function pollCycle() {
        if (!isEnabled) return;
        // Re-read active commands each cycle so config changes take effect live
        const cmds = getActiveCommands();
        try {
            const timeoutPromise = new Promise(resolve => setTimeout(resolve, 3000));
            const commandsPromise = Promise.allSettled(
                cmds.map(cmd => vscode.commands.executeCommand(cmd))
            );
            await Promise.race([commandsPromise, timeoutPromise]);
        } catch (e) { /* silent */ }
        if (isEnabled) {
            pollIntervalId = setTimeout(pollCycle, interval);
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
                    if (action === 'Restart Now' && lnkPath) {
                        // Safe path encoding: Base64-encode the path to handle Unicode, spaces,
                        // and special characters without brittle string escaping.
                        const pathB64 = Buffer.from(lnkPath, 'utf16le').toString('base64');

                        // Sleeper payload: decodes the Base64 path at runtime, waits 2s for 
                        // single-instance lock release, then launches the shortcut.
                        const sleeperScript = `$p=[System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${pathB64}'));Start-Sleep -Seconds 2;Start-Process -FilePath $p`;
                        const b64Sleeper = Buffer.from(sleeperScript, 'utf16le').toString('base64');

                        // WMI Escape Hatch: spawns sleeper under WmiPrvSE.exe, outside IDE's Job Object
                        const wmiScript = `$si=([wmiclass]"Win32_ProcessStartup").CreateInstance();$si.ShowWindow=0;$cmd="powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64Sleeper}";([wmiclass]"Win32_Process").Create($cmd,$null,$si)`;
                        const b64Wmi = Buffer.from(wmiScript, 'utf16le').toString('base64');

                        log('[CDP] Triggering WMI escape hatch for restart...');
                        cp.exec(`powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64Wmi}`,
                            { windowsHide: true },
                            (err) => {
                                if (err) log(`[CDP] WMI trigger warning: ${err.message}`);
                                vscode.commands.executeCommand('workbench.action.quit');
                            }
                        );
                    } else if (action === 'Restart Now') {
                        vscode.commands.executeCommand('workbench.action.quit');
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
    log('Extension activating (v3.0.0)');

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

    // Dashboard provider
    dashboardProvider = new DashboardProvider(context, log, () => ({
        isEnabled,
        cdpConnected: connectionManager ? !!connectionManager.ws : false,
        sessionCount: connectionManager ? connectionManager.sessions.size : 0
    }));

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
    });
}

function deactivate() {
    stopPolling();
    if (connectionManager) connectionManager.stop(); // Full teardown on deactivation
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
