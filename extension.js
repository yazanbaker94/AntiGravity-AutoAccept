// Auto Accept Agent V2.1 — Production Hardened
// Primary: VS Code Commands API with async lock
// Secondary: Shadow DOM-piercing CDP for "Always Allow" in webview

const vscode = require('vscode');
const http = require('http');
const WebSocket = require('ws');

// ─── VS Code Commands ─────────────────────────────────────────────────
// Verified from Antigravity package.json + runtime dump (2,914 commands)
// NOTE: notification.acceptPrimaryAction deliberately EXCLUDED —
//       it would auto-click destructive notifications (delete, restart, etc.)
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept',
    'chatEditing.acceptAllFiles',
    'chatEditing.acceptFile',
    'inlineChat.acceptChanges',
    'interactive.acceptChanges',
];

// ─── Shadow DOM-Piercing Permission Clicker ───────────────────────────
// Searches through Shadow DOMs and nested iframes for "Always Allow"
// Future-proof against <vscode-button>, <ag-btn>, etc.
// Build the CDP script dynamically to inject custom button texts
function buildPermissionScript(customTexts) {
    const allTexts = ['always allow', 'allow this conversation', 'allow', 'accept', ...customTexts];
    return `
(function() {
    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};
    
    // Recursive Shadow DOM piercer
    function findButton(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var result = findButton(node.shadowRoot, text);
                if (result) return result;
            }
            // Priority 1: data-testid / data-action attributes (i18n-safe)
            var testId = (node.getAttribute('data-testid') || node.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                var tag1 = (node.tagName || '').toLowerCase();
                if (tag1 === 'button' || tag1.includes('button') || node.getAttribute('role') === 'button' || tag1.includes('btn')) {
                    return node;
                }
            }
            // Priority 2: text content match
            var nodeText = (node.textContent || '').trim().toLowerCase();
            if (nodeText === text) {
                var tag2 = (node.tagName || '').toLowerCase();
                if (tag2 === 'button' || tag2.includes('button') || node.getAttribute('role') === 'button' || tag2.includes('btn')) {
                    return node;
                }
            }
        }
        return null;
    }

    // Fuzzy panel selector — survives ID wrapping/hashing
    var panel = document.querySelector('iframe[id*="antigravity"][id*="agentPanel"]')
             || document.querySelector('iframe[name*="antigravity"]')
             || document.querySelector('#antigravity\\\\.agentPanel');
    if (!panel) return 'no-panel';
    
    var doc;
    try { doc = panel.contentDocument; } catch(e) { return 'cross-origin'; }
    if (!doc) return 'no-doc';
    
    // Collect all accessible documents (panel + nested iframes)
    var docs = [doc];
    try {
        var iframes = doc.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
    } catch(e) {}
    
    // Search each document for permission buttons (priority order)
    for (var t = 0; t < BUTTON_TEXTS.length; t++) {
        for (var d = 0; d < docs.length; d++) {
            var btn = findButton(docs[d], BUTTON_TEXTS[t]);
            if (btn) {
                btn.click();
                return 'clicked:' + BUTTON_TEXTS[t];
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
        statusBarItem.tooltip = 'Auto Accept V2.1 is ACTIVE — click to disable';
    } else {
        statusBarItem.text = '$(circle-slash) Auto: OFF';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'Auto Accept V2.1 is OFF — click to enable';
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
                resolve(msg.result?.result?.value || '');
            }
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
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
                const result = await cdpEvaluate(pages[0].webSocketDebuggerUrl, script);
                if (result && result.startsWith('clicked:')) {
                    log(`[V2-CDP] ✓ Permission: ${result}`);
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
    log(`[V2] Polling started (every ${interval}ms, ${ACCEPT_COMMANDS.length} commands)`);

    // VS Code commands — with async lock to prevent double-accepts
    pollIntervalId = setInterval(async () => {
        if (!isEnabled || isAccepting) return;
        isAccepting = true;
        try {
            await Promise.allSettled(
                ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))
            );
        } finally {
            isAccepting = false;
        }
    }, interval);

    // CDP permission polling (slower cadence)
    cdpIntervalId = setInterval(() => {
        checkPermissionButtons();
    }, 1500);
}

function stopPolling() {
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
    if (cdpIntervalId) { clearInterval(cdpIntervalId); cdpIntervalId = null; }
    isAccepting = false;
    log('[V2] Polling stopped');
}

// ─── Activation ───────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Auto Accept V2');
    log('[V2] Extension activating (v2.1 — production hardened)');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'autoAcceptV2.toggle';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.toggle', () => {
            isEnabled = !isEnabled;
            log(`[V2] Toggled: ${isEnabled ? 'ON' : 'OFF'}`);
            if (isEnabled) { startPolling(); } else { stopPolling(); }
            updateStatusBar();
            context.globalState.update('autoAcceptV2Enabled', isEnabled);
            vscode.window.showInformationMessage(
                `Auto Accept V2: ${isEnabled ? 'ENABLED ⚡' : 'DISABLED 🔴'}`
            );
        })
    );

    // Restore saved state
    if (context.globalState.get('autoAcceptV2Enabled', false)) {
        isEnabled = true;
        startPolling();
    }

    updateStatusBar();
    log('[V2] Extension activated');
}

function deactivate() {
    stopPolling();
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
