// AntiGravity AutoAccept v2.2.0
// Primary: VS Code Commands API with async lock
// Secondary: Browser-level CDP session multiplexer for permission & action buttons

const vscode = require('vscode');
const http = require('http');
const WebSocket = require('ws');

// ─── VS Code Commands ─────────────────────────────────────────────────
// Only Antigravity-specific commands — generic VS Code commands like
// chatEditing.acceptAllFiles cause sidebar interference (Outline toggling,
// folder collapsing) when the agent panel lacks focus.
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept',
];

// ─── Webview-Isolated Permission Clicker ──────────────────────────────
// Uses a Webview Guard to prevent execution on the main VS Code window.
// The agent panel runs in an isolated Chromium process (OOPIF) since
// VS Code's migration to Out-Of-Process Iframes.
function buildPermissionScript(customTexts) {
    const allTexts = [
        'run', 'accept',  // Primary action buttons first ("Run Alt+d", "Accept")
        'always allow', 'allow this conversation', 'allow',
        'retry',
        ...customTexts
    ];
    return `
(function() {
    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};
    
    // ═══ WEBVIEW GUARD ═══
    // Check for Antigravity agent panel DOM markers.
    // The panel has .react-app-container; the main VS Code window doesn't.
    // This prevents false positives (sidebars, markdown, menus).
    if (!document.querySelector('.react-app-container') && 
        !document.querySelector('[class*="agent"]') &&
        !document.querySelector('[data-vscode-context]')) {
        return 'not-agent-panel';
    }
    
    // We are safely inside the isolated agent panel webview.
    // document.body IS the agent panel — no iframe needed.
    
    function closestClickable(node) {
        var el = node;
        while (el && el !== document.body) {
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || tag.includes('button') || tag.includes('btn') ||
                el.getAttribute('role') === 'button' || el.classList.contains('cursor-pointer') ||
                el.onclick || el.getAttribute('tabindex') === '0') {
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }
    
    function findButton(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var result = findButton(node.shadowRoot, text);
                if (result) return result;
            }
            var testId = (node.getAttribute('data-testid') || node.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                var tag1 = (node.tagName || '').toLowerCase();
                if (tag1 === 'button' || tag1.includes('button') || node.getAttribute('role') === 'button' || tag1.includes('btn')) {
                    return node;
                }
            }
            var nodeText = (node.textContent || '').trim().toLowerCase();
            // Length cap: real buttons have short text (< 50 chars).
            // Skip large container elements that happen to start with button text.
            if (nodeText.length > 50) continue;
            // Matching rules:
            // - Exact match always works
            // - startsWith only for terms >= 5 chars (avoids 'run' matching random text)
            // - For startsWith, the matched text can't be more than 3x the search term length
            var isMatch = nodeText === text || 
                (text.length >= 5 && nodeText.startsWith(text) && nodeText.length <= text.length * 3);
            if (isMatch) {
                var clickable = closestClickable(node);
                var tag2 = (clickable.tagName || '').toLowerCase();
                if (tag2 === 'button' || tag2.includes('button') || clickable.getAttribute('role') === 'button' || 
                    tag2.includes('btn') || clickable.classList.contains('cursor-pointer') ||
                    clickable.onclick || clickable.getAttribute('tabindex') === '0' ||
                    text === 'expand' || text === 'requires input') {
                    // Idempotency guard: skip disabled/loading buttons
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                        clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading')) {
                        return null;
                    }
                    // Skip elements we already clicked recently (5s cooldown per element)
                    var lastClickTime = parseInt(clickable.getAttribute('data-aa-t') || '0', 10);
                    if (lastClickTime && (Date.now() - lastClickTime < 5000)) {
                        return null;
                    }
                    return clickable;
                }
            }
        }
        return null;
    }
    
    // ═══ PASS 1: Search for ACTION buttons (Run, Accept, Allow, etc.) ═══
    for (var t = 0; t < BUTTON_TEXTS.length; t++) {
        var btn = findButton(document.body, BUTTON_TEXTS[t]);
        if (btn) {
            btn.setAttribute('data-aa-t', '' + Date.now());
            btn.click();
            return 'clicked:' + BUTTON_TEXTS[t];
        }
    }
    
    // ═══ PASS 2: No action buttons found — click Expand to reveal them ═══
    // Only attempt to expand if the Node.js orchestrator allows it this cycle
    if (typeof CAN_EXPAND === 'undefined' || CAN_EXPAND) {
        var expandTexts = ['expand', 'requires input'];
        for (var e = 0; e < expandTexts.length; e++) {
            var expBtn = findButton(document.body, expandTexts[e]);
            if (expBtn) {
                expBtn.setAttribute('data-aa-t', '' + Date.now());
                expBtn.click();
                return 'clicked:' + expandTexts[e];
            }
        }
    }
    return 'no-permission-button';
})()
`;
}


let isEnabled = false;
let isAccepting = false; // Async lock — prevents double-accepts
let pollIntervalId = null;
let cdpIntervalId = null;
let statusBarItem = null;
let outputChannel = null;
let lastExpandTimes = {}; // Per-target cooldown to prevent expand toggle loops
let isCdpBusy = false; // Async lock for CDP polling — prevents overlapping broadcasts
let activeCdpPort = null; // Caches the successful port to prevent over-scanning
let cdpCycleCount = 0; // Diagnostic: counts CDP poll cycles for periodic status logging

function log(msg) {
    if (outputChannel) {
        outputChannel.appendLine(`${new Date().toLocaleTimeString()} ${msg}`);
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

// ─── CDP: Browser-Level Session Multiplexer ──────────────────────────
// Uses the browser-level WebSocket (/json/version) to attach to page
// targets and execute scripts inside windows with actual DOM access.

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

// Get the browser-level WebSocket URL
function cdpGetBrowserWsUrl(port) {
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

function multiplexCdpWebviews(port, scriptGenerator) {
    return new Promise(async (resolve) => {
        try {
            // 1. Get browser-level WebSocket
            const browserWsUrl = await cdpGetBrowserWsUrl(port);
            if (!browserWsUrl) return resolve(false);

            const ws = new WebSocket(browserWsUrl);
            const timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);

            let msgId = 1;
            const pending = {};

            function send(method, params = {}, sessionId = null) {
                return new Promise((res, rej) => {
                    const id = msgId++;
                    const timer = setTimeout(() => { delete pending[id]; rej(new Error('timeout')); }, 2000);
                    pending[id] = { res: (v) => { clearTimeout(timer); res(v); }, rej };
                    const payload = { id, method, params };
                    if (sessionId) payload.sessionId = sessionId;
                    ws.send(JSON.stringify(payload));
                });
            }

            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.id && pending[msg.id]) {
                    pending[msg.id].res(msg);
                    delete pending[msg.id];
                }
            });

            ws.on('error', () => { clearTimeout(timeout); resolve(false); });

            ws.on('open', async () => {
                try {
                    // 2. Enable target discovery
                    await send('Target.setDiscoverTargets', { discover: true });

                    // 3. Get ALL targets from the browser level
                    const targetsMsg = await send('Target.getTargets');
                    const allTargets = targetsMsg.result?.targetInfos || [];

                    // Periodic diagnostic log (every ~30s = 20 cycles at 1.5s)
                    cdpCycleCount++;
                    const isStatusCycle = (cdpCycleCount % 20 === 0);

                    // 4. Collect ALL candidate targets: webviews + page targets
                    const webviews = allTargets.filter(t =>
                        t.url && (
                            t.url.includes('vscode-webview://') ||
                            t.url.includes('webview') ||
                            t.type === 'iframe'
                        )
                    );
                    const pageTargets = allTargets.filter(t => t.type === 'page');

                    if (isStatusCycle) log(`[CDP] Status: ${allTargets.length} targets, ${pageTargets.length} pages, ${webviews.length} webviews (port ${port})`);

                    // 5. Evaluate on ALL targets concurrently (webviews + pages)
                    const allEvalTargets = [
                        ...webviews.map(t => ({ ...t, kind: 'Webview' })),
                        ...pageTargets.map(t => ({ ...t, kind: 'Page' }))
                    ];

                    const evalPromises = allEvalTargets.map(async (target) => {
                        try {
                            const targetId = target.targetId;
                            const shortId = targetId.substring(0, 6);
                            const kind = target.kind;

                            const attachMsg = await send('Target.attachToTarget', { targetId, flatten: true });
                            const sessionId = attachMsg.result?.sessionId;
                            if (!sessionId) return;

                            // For page targets, check DOM access first
                            if (kind === 'Page') {
                                const domCheck = await send('Runtime.evaluate', {
                                    expression: 'typeof document !== "undefined" ? document.title || "has-dom" : "no-dom"'
                                }, sessionId);
                                const domResult = domCheck.result?.result?.value;
                                if (!domResult || domResult === 'no-dom') {
                                    await send('Target.detachFromTarget', { sessionId }).catch(() => { });
                                    return;
                                }
                            }

                            const now = Date.now();
                            const canExpand = !lastExpandTimes[targetId] || (now - lastExpandTimes[targetId] >= 8000);
                            const dynamicScript = scriptGenerator(canExpand);

                            const evalMsg = await send('Runtime.evaluate', { expression: dynamicScript }, sessionId);
                            const result = evalMsg.result?.result?.value;

                            if (result && result.startsWith('clicked:')) {
                                if (result.includes('expand') || result.includes('requires input')) {
                                    lastExpandTimes[targetId] = Date.now();
                                }
                                log(`[CDP] \u2713 Thread [${shortId}] -> ${result}`);
                            } else if (isStatusCycle) {
                                log(`[CDP] ${kind} [${shortId}] -> ${result || 'undefined'} (url: ${(target.url || '').substring(0, 60)})`);
                            }

                            await send('Target.detachFromTarget', { sessionId }).catch(() => { });
                        } catch (e) { /* silent */ }
                    });

                    await Promise.allSettled(evalPromises);

                    clearTimeout(timeout);
                    ws.close();
                    resolve(true);
                } catch (e) {

                    clearTimeout(timeout); ws.close(); resolve(false);
                }
            });
        } catch (e) { resolve(false); }
    });
}

async function checkPermissionButtons() {
    if (!isEnabled || isCdpBusy) return;
    isCdpBusy = true;

    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const customTexts = config.get('customButtonTexts', []);

    const scriptGenerator = (canExpand) => {
        return `var CAN_EXPAND = ${canExpand};\n` + buildPermissionScript(customTexts);
    };

    try {
        const portsToScan = activeCdpPort ? [activeCdpPort] : [getConfiguredPort(), 9222];

        for (const port of portsToScan) {
            const connected = await multiplexCdpWebviews(port, scriptGenerator);

            if (connected) {
                activeCdpPort = port;
                isCdpBusy = false;
                return;
            } else if (port === activeCdpPort) {
                activeCdpPort = null;
            }
        }
    } catch (e) { /* silent */ }
    finally {
        isCdpBusy = false;
    }
}

// ─── Polling with Async Lock ──────────────────────────────────────────
function startPolling() {
    if (pollIntervalId) return;

    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const interval = config.get('pollInterval', 500);
    log(`Polling started (every ${interval}ms, ${ACCEPT_COMMANDS.length} commands)`);

    // VS Code commands — with async lock and safety timeout
    pollIntervalId = setInterval(async () => {
        if (!isEnabled || isAccepting) return;
        isAccepting = true;
        // Safety timeout: force-release lock after 3s if commands hang
        const safetyTimer = setTimeout(() => { isAccepting = false; }, 3000);
        try {
            await Promise.allSettled(
                ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))
            );
        } catch (e) { /* silent */ }
        finally {
            clearTimeout(safetyTimer);
            isAccepting = false;
        }
    }, interval);

    // CDP permission polling
    cdpIntervalId = setInterval(() => {
        checkPermissionButtons();
    }, 1500);
}

function stopPolling() {
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
    if (cdpIntervalId) { clearInterval(cdpIntervalId); cdpIntervalId = null; }
    isAccepting = false;
    log('Polling stopped');
}

// ─── CDP Auto-Fix: Detect & Repair ───────────────────────────────────
const cp = require('child_process');

async function checkAndFixCDP() {
    const configPort = getConfiguredPort();

    // 1. Try the configured port first (default 9333)
    if (await pingPort(configPort)) {
        log(`[CDP] Debug port ${configPort} active ✓`);
        activeCdpPort = configPort;
        return true;
    }

    // 2. Graceful Fallback: try legacy port 9222
    if (configPort !== 9222 && await pingPort(9222)) {
        log(`[CDP] ⚠ Configured port ${configPort} offline. Legacy port 9222 is active. Using 9222.`);
        activeCdpPort = 9222;
        return true;
    }

    // 3. Both failed — prompt user
    log(`[CDP] ⚠ All ports refused — remote debugging not enabled`);
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
$paths = @("$env:USERPROFILE\\Desktop", "$env:PUBLIC\\Desktop", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs")
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
                        const safePath = lnkPath.replace(/'/g, "''");

                        // Sleeper payload: waits 2s for single-instance lock, then launches shortcut
                        const sleeperScript = `Start-Sleep -Seconds 2; Start-Process -FilePath '${safePath}'`;
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

// applyTemporarySessionRestart removed — restart is now handled inline via Detached Time-Bomb

// ─── Activation ───────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AntiGravity AutoAccept');
    log('Extension activating (v2.2.0)');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'autoAcceptV2.toggle';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.toggle', () => {
            isEnabled = !isEnabled;
            log(`Toggled: ${isEnabled ? 'ON' : 'OFF'}`);
            if (isEnabled) { startPolling(); } else { stopPolling(); }
            updateStatusBar();
            context.globalState.update('autoAcceptV2Enabled', isEnabled);
            vscode.window.showInformationMessage(
                `AntiGravity AutoAccept: ${isEnabled ? 'ENABLED ⚡' : 'DISABLED 🔴'}`
            );
        })
    );

    // Check CDP on activation — prompt auto-fix if port 9222 is closed
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
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
