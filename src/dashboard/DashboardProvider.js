// AntiGravity AutoAccept — Dashboard Webview Provider
// Creates a VS Code webview panel for managing settings visually.

const vscode = require('vscode');
const path = require('path');

class DashboardProvider {
    static get viewType() { return 'autoAcceptV2.dashboard'; }

    /**
     * @param {vscode.ExtensionContext} context
     * @param {Function} log - Logging function
     * @param {Function} getStatus - Returns { isEnabled, cdpConnected, sessionCount }
     */
    constructor(context, log, getStatus) {
        this._context = context;
        this._log = log;
        this._getStatus = getStatus;
        this._panel = null;
        this._disposables = [];
    }

    /**
     * Show or reveal the dashboard panel
     */
    show() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            this._pushState();
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            DashboardProvider.viewType,
            'AutoAccept Dashboard',
            { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: []
            }
        );

        this._panel.iconPath = vscode.Uri.file(
            path.join(this._context.extensionPath, 'images', 'icon.png')
        );

        this._panel.webview.html = this._getHtml();

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            msg => this._handleMessage(msg),
            null,
            this._disposables
        );

        // Clean up on close — dispose all listeners to prevent memory leak
        this._panel.onDidDispose(() => {
            this._panel = null;
            this._disposables.forEach(d => d.dispose());
            this._disposables = [];
        }, null, this._disposables);

        // State is pushed when webview sends 'ready' — no setTimeout race condition
    }

    /**
     * Push current config + status to the webview
     */
    _pushState() {
        if (!this._panel) return;
        const config = vscode.workspace.getConfiguration('autoAcceptV2');
        const status = this._getStatus();
        this._panel.webview.postMessage({
            type: 'state',
            data: {
                isEnabled: status.isEnabled,
                cdpConnected: status.cdpConnected,
                sessionCount: status.sessionCount,
                autoAcceptFileEdits: config.get('autoAcceptFileEdits', true),
                blockedCommands: config.get('blockedCommands', []),
                allowedCommands: config.get('allowedCommands', []),
                pollInterval: config.get('pollInterval', 500),
                cdpPort: config.get('cdpPort', 9333),
                customButtonTexts: config.get('customButtonTexts', [])
            }
        });
    }

    /**
     * Push a log entry to the activity feed
     */
    pushActivity(message, type = 'info') {
        if (!this._panel) return;
        this._panel.webview.postMessage({
            type: 'activity',
            data: { message, type, timestamp: new Date().toLocaleTimeString() }
        });
    }

    /**
     * Notify dashboard of state changes (e.g., toggle, CDP status)
     */
    refresh() {
        this._pushState();
    }

    /**
     * Handle messages from webview UI
     */
    async _handleMessage(msg) {
        // Hoist config to top — accessible to all cases (avoids ReferenceError)
        const config = vscode.workspace.getConfiguration('autoAcceptV2');
        switch (msg.type) {
            case 'ready':
                // Webview DOM is loaded — safe to push initial state
                this._pushState();
                break;
            case 'toggle':
                vscode.commands.executeCommand('autoAcceptV2.toggle');
                break;
            case 'updateConfig': {
                try {
                    await config.update(msg.key, msg.value, vscode.ConfigurationTarget.Workspace);
                    setTimeout(() => this._pushState(), 50);
                } catch (e) {
                    this.pushActivity(`Failed to update ${msg.key}: ${e.message}`, 'error');
                }
                break;
            }
            case 'addBlocked': {
                const list = [...config.get('blockedCommands', [])];
                if (msg.value && !list.includes(msg.value)) {
                    list.push(msg.value);
                    try {
                        await config.update('blockedCommands', list, vscode.ConfigurationTarget.Workspace);
                        setTimeout(() => this._pushState(), 50);
                    } catch (e) {
                        this.pushActivity(`Failed to block command: ${e.message}`, 'error');
                    }
                }
                break;
            }
            case 'removeBlocked': {
                const list = config.get('blockedCommands', []).filter(c => c !== msg.value);
                try {
                    await config.update('blockedCommands', list, vscode.ConfigurationTarget.Workspace);
                    setTimeout(() => this._pushState(), 50);
                } catch (e) {
                    this.pushActivity(`Failed to remove blocked command: ${e.message}`, 'error');
                }
                break;
            }
            case 'addAllowed': {
                const list = [...config.get('allowedCommands', [])];
                if (msg.value && !list.includes(msg.value)) {
                    list.push(msg.value);
                    try {
                        await config.update('allowedCommands', list, vscode.ConfigurationTarget.Workspace);
                        setTimeout(() => this._pushState(), 50);
                    } catch (e) {
                        this.pushActivity(`Failed to allow command: ${e.message}`, 'error');
                    }
                }
                break;
            }
            case 'removeAllowed': {
                const list = config.get('allowedCommands', []).filter(c => c !== msg.value);
                try {
                    await config.update('allowedCommands', list, vscode.ConfigurationTarget.Workspace);
                    setTimeout(() => this._pushState(), 50);
                } catch (e) {
                    this.pushActivity(`Failed to remove allowed command: ${e.message}`, 'error');
                }
                break;
            }
            case 'refresh':
                this._pushState();
                break;
        }
    }

    _getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoAccept Dashboard</title>
<style>
    :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --accent: var(--vscode-button-background, #0078d4);
        --accent-hover: var(--vscode-button-hoverBackground, #026ec1);
        --danger: #e74c3c;
        --success: #2ecc71;
        --warning: #f39c12;
        --border: var(--vscode-panel-border, #333);
        --card-bg: var(--vscode-sideBar-background, #1e1e2e);
        --input-bg: var(--vscode-input-background, #2d2d3d);
        --input-border: var(--vscode-input-border, #444);
        --badge-bg: rgba(255,255,255,0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
        font-size: 13px;
        color: var(--fg);
        background: var(--bg);
        padding: 16px;
        line-height: 1.5;
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    h1 .icon { font-size: 22px; }
    .status-bar {
        display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap;
    }
    .status-badge {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 12px; border-radius: 20px;
        font-size: 12px; font-weight: 500;
        background: var(--badge-bg); border: 1px solid var(--border);
    }
    .status-dot {
        width: 8px; height: 8px; border-radius: 50%;
        display: inline-block;
    }
    .status-dot.on { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .status-dot.off { background: var(--danger); }
    .status-dot.warn { background: var(--warning); box-shadow: 0 0 6px var(--warning); }

    .card {
        background: var(--card-bg); border: 1px solid var(--border);
        border-radius: 8px; padding: 16px; margin-bottom: 16px;
    }
    .card-title {
        font-size: 14px; font-weight: 600; margin-bottom: 12px;
        display: flex; align-items: center; gap: 6px;
    }
    .toggle-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 0; border-bottom: 1px solid var(--border);
    }
    .toggle-row:last-child { border-bottom: none; }
    .toggle-label { font-size: 13px; }
    .toggle-desc { font-size: 11px; opacity: 0.6; margin-top: 2px; }

    /* Toggle switch */
    .switch { position: relative; width: 40px; height: 22px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
        position: absolute; inset: 0; cursor: pointer;
        background: #555; border-radius: 22px; transition: 0.3s;
    }
    .slider::before {
        content: ''; position: absolute; width: 16px; height: 16px;
        left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.3s;
    }
    .switch input:checked + .slider { background: var(--success); }
    .switch input:checked + .slider::before { transform: translateX(18px); }

    /* List editor */
    .list-editor { margin-top: 8px; }
    .list-input {
        display: flex; gap: 6px; margin-bottom: 8px;
    }
    .list-input input {
        flex: 1; padding: 6px 10px; background: var(--input-bg);
        border: 1px solid var(--input-border); border-radius: 4px;
        color: var(--fg); font-size: 12px; outline: none;
    }
    .list-input input:focus { border-color: var(--accent); }
    .list-input button, .btn {
        padding: 6px 14px; background: var(--accent); color: white;
        border: none; border-radius: 4px; cursor: pointer; font-size: 12px;
        transition: background 0.2s;
    }
    .list-input button:hover, .btn:hover { background: var(--accent-hover); }
    .btn-danger { background: var(--danger); }
    .btn-danger:hover { background: #c0392b; }
    .btn-toggle {
        padding: 8px 20px; font-size: 14px; font-weight: 600;
        border-radius: 6px; width: 100%;
    }
    .btn-toggle.on { background: var(--danger); }
    .btn-toggle.off { background: var(--success); }

    .tag {
        display: inline-flex; align-items: center; gap: 4px;
        background: var(--badge-bg); border: 1px solid var(--border);
        padding: 3px 8px; border-radius: 4px; margin: 3px 4px 3px 0;
        font-size: 12px; font-family: var(--vscode-editor-font-family, monospace);
    }
    .tag .remove {
        cursor: pointer; opacity: 0.6; font-size: 14px; line-height: 1;
    }
    .tag .remove:hover { opacity: 1; color: var(--danger); }
    .empty-note { opacity: 0.5; font-style: italic; font-size: 12px; }

    /* Activity log */
    .activity-log {
        max-height: 200px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px; padding: 8px; background: var(--input-bg);
        border-radius: 4px; border: 1px solid var(--border);
    }
    .activity-entry { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .activity-entry .time { opacity: 0.5; }
    .activity-entry.blocked { color: var(--danger); }
    .activity-entry.click { color: var(--success); }
</style>
</head>
<body>
    <h1><span class="icon">⚡</span> AutoAccept Dashboard</h1>

    <div class="status-bar">
        <span class="status-badge" id="status-enabled">
            <span class="status-dot" id="dot-enabled"></span>
            <span id="label-enabled">Loading...</span>
        </span>
        <span class="status-badge" id="status-cdp">
            <span class="status-dot" id="dot-cdp"></span>
            <span id="label-cdp">CDP: --</span>
        </span>
        <span class="status-badge" id="status-sessions">
            <span>📡</span>
            <span id="label-sessions">0 sessions</span>
        </span>
    </div>

    <button class="btn btn-toggle" id="btn-toggle" onclick="toggle()">Loading...</button>

    <div style="margin-top:16px"></div>

    <div class="card">
        <div class="card-title">⚙️ Settings</div>
        <div class="toggle-row">
            <div>
                <div class="toggle-label">Auto-Accept File Edits</div>
                <div class="toggle-desc">Automatically accept agent file changes</div>
            </div>
            <label class="switch">
                <input type="checkbox" id="chk-file-edits" onchange="updateConfig('autoAcceptFileEdits', this.checked)">
                <span class="slider"></span>
            </label>
        </div>
    </div>

    <div class="card">
        <div class="card-title">🚫 Blocked Commands</div>
        <div class="toggle-desc" style="margin-bottom:8px">Commands matching these patterns will NEVER be auto-run</div>
        <div class="list-editor">
            <div class="list-input">
                <input id="input-blocked" placeholder="e.g. rm -rf, git push --force" onkeydown="if(event.key==='Enter')addBlocked()">
                <button onclick="addBlocked()">+ Add</button>
            </div>
            <div id="list-blocked"></div>
        </div>
    </div>

    <div class="card">
        <div class="card-title">✅ Allowed Commands</div>
        <div class="toggle-desc" style="margin-bottom:8px">If non-empty, ONLY matching commands will be auto-run</div>
        <div class="list-editor">
            <div class="list-input">
                <input id="input-allowed" placeholder="e.g. npm test, npm install" onkeydown="if(event.key==='Enter')addAllowed()">
                <button onclick="addAllowed()">+ Add</button>
            </div>
            <div id="list-allowed"></div>
        </div>
    </div>

    <div class="card">
        <div class="card-title">📋 Activity Log</div>
        <div class="activity-log" id="activity-log">
            <div class="empty-note">Waiting for activity...</div>
        </div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    let state = {};

    function toggle() { vscode.postMessage({ type: 'toggle' }); }

    function updateConfig(key, value) {
        vscode.postMessage({ type: 'updateConfig', key, value });
    }

    function addBlocked() {
        const input = document.getElementById('input-blocked');
        if (input.value.trim()) {
            vscode.postMessage({ type: 'addBlocked', value: input.value.trim() });
            input.value = '';
        }
    }

    function removeBlocked(val) {
        vscode.postMessage({ type: 'removeBlocked', value: val });
    }

    function addAllowed() {
        const input = document.getElementById('input-allowed');
        if (input.value.trim()) {
            vscode.postMessage({ type: 'addAllowed', value: input.value.trim() });
            input.value = '';
        }
    }

    function removeAllowed(val) {
        vscode.postMessage({ type: 'removeAllowed', value: val });
    }

    function renderList(containerId, items, removeHandler) {
        const el = document.getElementById(containerId);
        if (!items.length) {
            el.innerHTML = '<span class="empty-note">No patterns configured</span>';
            return;
        }
        el.innerHTML = items.map(item =>
            '<span class="tag">' +
            '<code>' + escHtml(item) + '</code>' +
            '<span class="remove" onclick="' + removeHandler + '(\\'' + escAttr(item) + '\\')">&times;</span>' +
            '</span>'
        ).join('');
    }

    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function escAttr(s) { return s.replace(/'/g,"\\\\'").replace(/"/g,'&quot;'); }

    function updateUI(data) {
        state = data;
        // Status badges
        const dotOn = document.getElementById('dot-enabled');
        const lblOn = document.getElementById('label-enabled');
        const dotCdp = document.getElementById('dot-cdp');
        const lblCdp = document.getElementById('label-cdp');
        const lblSess = document.getElementById('label-sessions');
        const btnToggle = document.getElementById('btn-toggle');

        dotOn.className = 'status-dot ' + (data.isEnabled ? 'on' : 'off');
        lblOn.textContent = data.isEnabled ? 'ACTIVE' : 'OFF';
        dotCdp.className = 'status-dot ' + (data.cdpConnected ? 'on' : 'off');
        lblCdp.textContent = 'CDP: ' + (data.cdpConnected ? 'Connected' : 'Disconnected');
        lblSess.textContent = data.sessionCount + ' session' + (data.sessionCount !== 1 ? 's' : '');

        btnToggle.className = 'btn btn-toggle ' + (data.isEnabled ? 'on' : 'off');
        btnToggle.textContent = data.isEnabled ? '⏹ Disable AutoAccept' : '⚡ Enable AutoAccept';

        // Settings
        document.getElementById('chk-file-edits').checked = data.autoAcceptFileEdits;

        // Lists
        renderList('list-blocked', data.blockedCommands, 'removeBlocked');
        renderList('list-allowed', data.allowedCommands, 'removeAllowed');
    }

    let activityCount = 0;
    function addActivity(data) {
        const log = document.getElementById('activity-log');
        if (activityCount === 0) log.innerHTML = '';
        activityCount++;
        const cls = data.type === 'blocked' ? 'blocked' : data.type === 'click' ? 'click' : '';
        const entry = document.createElement('div');
        entry.className = 'activity-entry ' + cls;
        entry.innerHTML = '<span class="time">' + data.timestamp + '</span> ' + escHtml(data.message);
        log.insertBefore(entry, log.firstChild);
        // Keep max 100 entries
        while (log.children.length > 100) log.removeChild(log.lastChild);
    }

    // Signal extension host that DOM is ready for state
    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type === 'state') updateUI(msg.data);
        else if (msg.type === 'activity') addActivity(msg.data);
    });
</script>
</body>
</html>`;
    }
}

module.exports = { DashboardProvider };
