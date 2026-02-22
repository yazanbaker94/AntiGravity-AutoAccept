// AntiGravity AutoAccept v1.18.4
// Primary: VS Code Commands API with async lock
// Secondary: Shadow DOM-piercing CDP for permission & action buttons

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
            if (nodeText === text || (text.length >= 3 && nodeText.startsWith(text))) {
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
            btn.click();
            return 'clicked:' + BUTTON_TEXTS[t];
        }
    }
    
    // ═══ PASS 2: No action buttons found — click Expand to reveal them ═══
    var expandTexts = ['expand', 'requires input'];
    for (var e = 0; e < expandTexts.length; e++) {
        var expBtn = findButton(document.body, expandTexts[e]);
        if (expBtn) {
            expBtn.click();
            return 'clicked:' + expandTexts[e];
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
let lastExpandTime = 0; // Cooldown to prevent expand toggle loop
let isCdpBusy = false; // Async lock for CDP polling — prevents overlapping broadcasts

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

// ─── CDP Helpers ──────────────────────────────────────────────────────
function cdpGetPages(port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data).filter(p => p.webSocketDebuggerUrl)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function cdpEvaluate(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 2000);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
                clearTimeout(timeout);
                ws.close();
                const val = msg.result?.result?.value;
                const type = msg.result?.result?.type;
                const sub = msg.result?.result?.subtype;
                const exc = msg.result?.exceptionDetails;
                if (!val) {
                    const errDesc = msg.result?.result?.description || '';
                    const excText = exc?.text || '';
                    const excLine = exc?.lineNumber || '';
                    log(`[CDP-DBG] type=${type} sub=${sub} err=${errDesc.substring(0, 100)} exc=${excText} line=${excLine}`);
                }
                resolve(val || '');
            }
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
    });
}

// Send multiple CDP commands over one WebSocket connection
function cdpSendMulti(wsUrl, commands) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
        const results = {};
        let nextId = 1;
        const pending = [];

        ws.on('open', () => {
            for (const cmd of commands) {
                const id = nextId++;
                cmd._id = id;
                pending.push(id);
                ws.send(JSON.stringify({ id, method: cmd.method, params: cmd.params || {} }));
            }
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id) {
                results[msg.id] = msg.result || msg.error;
                const idx = pending.indexOf(msg.id);
                if (idx !== -1) pending.splice(idx, 1);
                if (pending.length === 0) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(results);
                }
            }
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
    });
}

// Use CDP DOM protocol to pierce closed shadow DOMs and click the banner
async function clickBannerViaDom(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
        let msgId = 1;

        function send(method, params = {}) {
            const id = msgId++;
            ws.send(JSON.stringify({ id, method, params }));
            return id;
        }

        const handlers = {};
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id && handlers[msg.id]) handlers[msg.id](msg);
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });

        ws.on('open', () => {
            // Step 1: Get full DOM tree piercing shadow DOMs
            const docId = send('DOM.getDocument', { depth: -1, pierce: true });
            handlers[docId] = (msg) => {
                if (!msg.result) { clearTimeout(timeout); ws.close(); resolve(null); return; }

                // Step 2: Search for "Expand" text near the banner
                const searchId = send('DOM.performSearch', { query: 'Expand' });
                handlers[searchId] = (msg2) => {
                    const count = msg2.result?.resultCount || 0;
                    if (count === 0) { clearTimeout(timeout); ws.close(); resolve(null); return; }

                    // Step 3: Get search result nodes
                    const getResultsId = send('DOM.getSearchResults', {
                        searchId: msg2.result.searchId,
                        fromIndex: 0,
                        toIndex: Math.min(count, 10)
                    });
                    handlers[getResultsId] = (msg3) => {
                        const nodeIds = msg3.result?.nodeIds || [];
                        if (nodeIds.length === 0) { clearTimeout(timeout); ws.close(); resolve(null); return; }

                        // Step 4: Try each node — get its box model and click at center
                        let tried = 0;
                        function tryNode(idx) {
                            if (idx >= nodeIds.length) {
                                clearTimeout(timeout); ws.close(); resolve(null); return;
                            }
                            const boxId = send('DOM.getBoxModel', { nodeId: nodeIds[idx] });
                            handlers[boxId] = (boxMsg) => {
                                tried++;
                                const quad = boxMsg.result?.model?.content;
                                if (!quad || quad.length < 4) {
                                    tryNode(idx + 1); return; // not visible, try next
                                }
                                // Calculate center of the element
                                const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
                                const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
                                if (x === 0 && y === 0) { tryNode(idx + 1); return; }

                                // Step 5: Real mouse click at center coordinates
                                const downId = send('Input.dispatchMouseEvent', {
                                    type: 'mousePressed', x, y, button: 'left', clickCount: 1
                                });
                                handlers[downId] = () => {
                                    const upId = send('Input.dispatchMouseEvent', {
                                        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
                                    });
                                    handlers[upId] = () => {
                                        clearTimeout(timeout);
                                        ws.close();
                                        resolve(`clicked:expand-mouse[${Math.round(x)},${Math.round(y)}]`);
                                    };
                                };
                            };
                        }
                        tryNode(0);
                    };
                };
            };
        });
    });
}

// Wider port scan: 9000-9014 + common Chromium/Node defaults
const CDP_PORTS = [9222, 9229, ...Array.from({ length: 15 }, (_, i) => 9000 + i)];

async function checkPermissionButtons() {
    if (!isEnabled) return;
    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const customTexts = config.get('customButtonTexts', []);
    const script = buildPermissionScript(customTexts);
    try {
        for (const port of CDP_PORTS) {
            try {
                const pages = await cdpGetPages(port);
                if (pages.length === 0) continue;
                log(`[CDP] Port ${port}: ${pages.length} targets`);
                for (let i = 0; i < pages.length; i++) {
                    try {
                        const result = await cdpEvaluate(pages[i].webSocketDebuggerUrl, script);
                        log(`[CDP] [${i}] => ${result}`);
                        if (result && result.startsWith('clicked:')) {
                            // Expand cooldown (prevents toggle loop)
                            if (result.startsWith('clicked:expand') || result.startsWith('clicked:requires input')) {
                                if (Date.now() - lastExpandTime < 8000) continue;
                                lastExpandTime = Date.now();
                            }
                            log(`[CDP] ✓ ${result}`);
                            return;
                        }
                    } catch (e) {
                        log(`[CDP] [${i}] ERROR: ${e.message}`);
                    }
                }
                return;
            } catch (e) { /* next port */ }
        }
    } catch (e) { /* silent */ }
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

function checkAndFixCDP() {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port: 9222, path: '/json/list', timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                log('[CDP] Debug port active ✓');
                resolve(true);
            });
        });
        req.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                log('[CDP] ⚠ Port 9222 refused — remote debugging not enabled');
                // Fire the notification (non-blocking) — handle clicks via .then()
                vscode.window.showErrorMessage(
                    '⚡ AutoAccept needs Debug Mode to click buttons. Port 9222 is not open.',
                    'Auto-Fix Shortcut (Windows)',
                    'Manual Guide'
                ).then(action => {
                    if (action === 'Auto-Fix Shortcut (Windows)') {
                        applyPermanentWindowsPatch();
                    } else if (action === 'Manual Guide') {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/yazanbaker94/AntiGravity-AutoAccept#setup'));
                    }
                });
            }
            resolve(false);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function applyPermanentWindowsPatch() {
    if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('Auto-patching is Windows-only. Use the Manual Guide.');
        return;
    }

    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    // Write a .ps1 file to avoid inline escaping issues with --remote-debugging-port
    const psFile = path.join(os.tmpdir(), 'antigravity_patch_shortcut.ps1');
    const psContent = `
$flag = "--remote-debugging-port=9222"
$WshShell = New-Object -comObject WScript.Shell
$paths = @(
    "$env:USERPROFILE\\Desktop",
    "$env:PUBLIC\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs"
)
$patched = $false
foreach ($dir in $paths) {
    if (Test-Path $dir) {
        $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            $shortcut = $WshShell.CreateShortcut($file.FullName)
            if ($shortcut.TargetPath -like "*Antigravity*") {
                if ($shortcut.Arguments -notlike "*remote-debugging-port*") {
                    $shortcut.Arguments = ($shortcut.Arguments + " " + $flag).Trim()
                    $shortcut.Save()
                    $patched = $true
                    Write-Output "PATCHED: $($file.FullName)"
                }
            }
        }
    }
}
if ($patched) { Write-Output "SUCCESS" } else { Write-Output "NOT_FOUND" }
`;

    try {
        fs.writeFileSync(psFile, psContent, 'utf8');
    } catch (e) {
        log(`[CDP] Failed to write patcher script: ${e.message}`);
        vscode.window.showWarningMessage('Could not create patcher script. Please add the flag manually.');
        return;
    }

    log('[CDP] Running shortcut patcher...');
    cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, (err, stdout, stderr) => {
        // Clean up temp file
        try { fs.unlinkSync(psFile); } catch (e) { }

        if (err) {
            log(`[CDP] Patcher error: ${err.message}`);
            log(`[CDP] stderr: ${stderr}`);
            vscode.window.showWarningMessage('Shortcut patching failed. Please add the flag manually.');
            return;
        }
        log(`[CDP] Patcher output: ${stdout.trim()}`);
        if (stdout.includes('SUCCESS')) {
            log('[CDP] ✓ Shortcut patched!');
            vscode.window.showInformationMessage(
                '✅ Shortcut updated! Restart Antigravity for the fix to take effect.',
                'Restart Now'
            ).then(action => {
                if (action === 'Restart Now') applyTemporarySessionRestart();
            });
        } else {
            log('[CDP] No matching shortcuts found');
            vscode.window.showWarningMessage(
                'No Antigravity shortcut found on Desktop or Start Menu. Add --remote-debugging-port=9222 to your shortcut manually.'
            );
        }
    });
}

function applyTemporarySessionRestart() {
    vscode.window.showInformationMessage(
        '✅ Closing Antigravity — reopen from your Desktop/Start Menu shortcut to activate Debug Mode.',
        'Close Now'
    ).then(action => {
        if (action === 'Close Now') {
            vscode.commands.executeCommand('workbench.action.quit');
        }
    });
}

// ─── Activation ───────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AntiGravity AutoAccept');
    log('Extension activating (v1.18.4)');

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
