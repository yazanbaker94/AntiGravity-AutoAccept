// AntiGravity AutoAccept — Dashboard Webview Provider
// Creates a VS Code webview panel for managing settings visually.

const vscode = require('vscode');
const path = require('path');
const { pingTelemetry } = require('../telemetry');

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
        this.getDiagnostics = null; // set by extension.js to fetch __AA_DIAG from CDP
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

        // Telemetry: dashboard open ping (fire-and-forget)
        pingTelemetry('dashboard_open', this._context, this._log);

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
                autoRetryEnabled: config.get('autoRetryEnabled', true),
                blockedCommands: config.get('blockedCommands', []),
                allowedCommands: config.get('allowedCommands', []),
                pollInterval: config.get('pollInterval', 500),
                cdpPort: config.get('cdpPort', 9333),
                customButtonTexts: config.get('customButtonTexts', []),
                proLicenseKey: config.get('proLicenseKey', ''),
                swarmPlan: this._context.globalState.get('aa_swarm_plan', ''),
                swarmActive: this._context.globalState.get('aa_swarm_active', false),
                totalClicks: status.totalClicks || 0,
                timeSavedMinutes: status.timeSavedMinutes || 0,
                firstClickDate: status.firstClickDate || null,
                lastDismissedMilestone: status.lastDismissedMilestone || 0,
                currentMilestone: status.currentMilestone || 0,
                currentRank: status.currentRank || null,
                nextMilestone: status.nextMilestone || null,
                nextRank: status.nextRank || null
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
        // Write at the highest active scope: if the user has a workspace override, write there;
        // otherwise write to Global (user settings). Fixes Issue #33 where workspace-level
        // values silently override Global writes, making toggles appear stuck.
        const _target = (key) => {
            const info = config.inspect(key);
            if (info && info.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
            return vscode.ConfigurationTarget.Global;
        };
        switch (msg.type) {
            case 'ready':
                // Webview DOM is loaded — safe to push initial state
                this._pushState();
                break;
            case 'toggle':
                vscode.commands.executeCommand('autoAcceptV2.toggle');
                break;
            case 'updateConfig': {
                const oldValue = config.get(msg.key);
                await config.update(msg.key, msg.value, _target(msg.key));
                
                if (msg.key === 'proLicenseKey') {
                    if (!msg.value) {
                        // User cleared key → Wipe secrets immediately
                        try { await this._context.secrets.delete('aa_swarm_script'); } catch(e) {}
                        await this._context.globalState.update('aa_swarm_active', false);
                        await this._context.globalState.update('aa_swarm_plan', '');
                        await this._context.globalState.update('aa_swarm_cached_at', 0);
                        this._pushState();
                    } else if (oldValue === msg.value) {
                        // Key didn't change — VS Code won't fire change event.
                        this._pushState();
                    } else {
                        // Key changed: clear active state but DON'T push yet — Worker will re-validate
                        await this._context.globalState.update('aa_swarm_active', false);
                        await this._context.globalState.update('aa_swarm_plan', '');
                    }
                } else {
                    this._pushState();
                }
                break;
            }
            case 'addBlocked': {
                const list = [...config.get('blockedCommands', [])];
                if (msg.value && !list.includes(msg.value)) {
                    list.push(msg.value);
                    await config.update('blockedCommands', list, _target('blockedCommands'));
                }
                this._pushState();
                break;
            }
            case 'addBlockedBulk': {
                const list = [...config.get('blockedCommands', [])];
                const items = (msg.values || []).filter(v => v && !list.includes(v));
                if (items.length) {
                    list.push(...items);
                    await config.update('blockedCommands', list, _target('blockedCommands'));
                }
                this._pushState();
                break;
            }
            case 'removeBlocked': {
                const list = config.get('blockedCommands', []).filter(c => c !== msg.value);
                await config.update('blockedCommands', list, _target('blockedCommands'));
                this._pushState();
                break;
            }
            case 'addAllowed': {
                const list = [...config.get('allowedCommands', [])];
                if (msg.value && !list.includes(msg.value)) {
                    list.push(msg.value);
                    await config.update('allowedCommands', list, _target('allowedCommands'));
                }
                this._pushState();
                break;
            }
            case 'removeAllowed': {
                const list = config.get('allowedCommands', []).filter(c => c !== msg.value);
                await config.update('allowedCommands', list, _target('allowedCommands'));
                this._pushState();
                break;
            }
            case 'refresh':
                this._pushState();
                break;
            case 'telegramPair':
                vscode.commands.executeCommand('autoAcceptV2.telegramPair');
                break;
            case 'telegramUnpair':
                vscode.commands.executeCommand('autoAcceptV2.telegramUnpair');
                break;
            case 'dismissMilestone': {
                this._context.globalState.update('autoAcceptLastDismissedMilestone', msg.value);
                this._pushState();
                break;
            }
            case 'openSponsor': {
                // Rolling 7-day timestamp array for weekly CTR telemetry
                const WEEK_MS = 604800000;
                const now = Date.now();
                const raw = this._context.globalState.get('autoAcceptSponsorClicks');
                const prev = Array.isArray(raw) ? raw : []; // Legacy migration: int → array
                const clicks = prev.filter(t => now - t < WEEK_MS);
                clicks.push(now);
                this._context.globalState.update('autoAcceptSponsorClicks', clicks);
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/yazanbaker94/AntiGravity-AutoAccept'));
                break;
            }
            case 'getDiagDump': {
                const status = this._getStatus();
                const ext = vscode.extensions.getExtension('YazanBaker.antigravity-autoaccept');
                const diagData = {
                    timestamp: new Date().toISOString(),
                    version: ext ? ext.packageJSON.version : 'unknown',
                    remoteName: vscode.env.remoteName || null,
                    appHost: vscode.env.appHost,
                    appName: vscode.env.appName,
                    isEnabled: status.isEnabled,
                    cdpConnected: status.cdpConnected,
                    sessionCount: status.sessionCount,
                    telemetryEnabled: vscode.env.isTelemetryEnabled,
                    config: {
                        autoAcceptFileEdits: config.get('autoAcceptFileEdits', true),
                        autoRetryEnabled: config.get('autoRetryEnabled', true),
                        blockedCommands: config.get('blockedCommands', []),
                        allowedCommands: config.get('allowedCommands', []),
                        pollInterval: config.get('pollInterval', 500),
                        cdpPort: config.get('cdpPort', 9333),
                        customButtonTexts: config.get('customButtonTexts', [])
                    },
                    cdpDiag: null
                };
                // Fetch __AA_DIAG from active CDP sessions if available
                if (this.getDiagnostics) {
                    try {
                        const cdpDiag = await this.getDiagnostics();
                        diagData.cdpDiag = cdpDiag;
                    } catch (e) {
                        diagData.cdpDiag = { error: e.message };
                    }
                }
                this._panel.webview.postMessage({ type: 'diagDump', data: JSON.stringify(diagData, null, 2) });
                break;
            }
        }
    }

    _getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
    #sponsor-slot { cursor: pointer; transition: border-color 0.2s ease, background-color 0.2s ease, transform 0.2s ease; }
    body #sponsor-slot:hover, body #sponsor-slot:focus-visible { background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.06)); border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground)); transform: translateY(-1px); outline: none; }
    body #sponsor-slot:active { transform: translateY(0); }

    /* Milestone banner */
    .milestone-banner { display: none; background: linear-gradient(135deg, rgba(255,215,0,0.1), rgba(255,165,0,0.08)); border: 1px solid rgba(255,215,0,0.3); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; text-align: center; }
    .milestone-banner.visible { display: block; }
    .milestone-rank { font-size: 18px; font-weight: 700; color: #FFD700; }
    .milestone-dismiss { background: none; border: 1px solid var(--border); color: var(--fg); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-top: 8px; opacity: 0.7; }
    .milestone-dismiss:hover { opacity: 1; }
    .milestone-share { color: var(--accent); text-decoration: none; font-size: 11px; margin-left: 8px; }
    .milestone-progress { background: rgba(255,255,255,0.08); border-radius: 4px; height: 6px; margin-top: 10px; overflow: hidden; }
    .milestone-progress-fill { background: linear-gradient(90deg, #FFD700, #FFA500); height: 100%; border-radius: 4px; transition: width 0.5s ease; }
    /* Pro card */
    .pro-card { background: linear-gradient(135deg, rgba(243,156,18,0.08), rgba(230,126,34,0.05)); border: 1px solid rgba(243,156,18,0.4); }
    .pro-card .card-title { color: #f39c12; }
    .license-status { font-size: 11px; margin-top: 6px; min-height: 16px; }
    .license-status.ok  { color: var(--success); }
    .license-status.err { color: var(--danger); }
    .license-status.pending { color: var(--warning); }
</style>
</head>
<body>
    <h1><span class="icon">⚡</span> AutoAccept Dashboard</h1>

    <!-- Sponsor Banner (Top placement — maximum visibility) -->
    <div id="sponsor-slot" tabindex="0" role="button" aria-label="Sponsor this project" style="background:var(--vscode-textBlockQuote-background, rgba(255,255,255,0.04));border:1px solid var(--border);border-radius:8px;padding:16px 18px;margin-bottom:16px;text-align:center;font-size:12px;line-height:1.7">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;opacity:0.9">🤝 Keeping AutoAccept Free & Maintained</div>
        <div style="font-size:11px;opacity:0.6;margin-bottom:8px">I spend 10+ hrs/week updating this tool to match IDE DOM changes. To keep it 100% free forever instead of adding a paywall, this space is reserved for a sponsor.</div>
        <span style="opacity:0.7" id="sponsor-text">Reach 24,000+ AI developers who automate their workflows.</span><br>
        <span style="color:var(--vscode-textLink-foreground, var(--accent));font-weight:600">Sponsor this space &#8599;</span>
    </div>

    <!-- Swarm Mode Pro Card -->
    <div class="card pro-card">
        <div class="card-title">&#128081; Swarm Mode <span style="font-size:11px;font-weight:400;opacity:0.7">(Pro)</span></div>
        <div class="toggle-desc" style="margin-bottom:10px">Run multiple background agents hands-free. Automatically navigates every pending Agent Manager chat.</div>
        <div class="list-editor">
            <div class="list-input">
                <input type="password" id="input-license" placeholder="Paste your Gumroad license key..." onkeydown="if(event.key==='Enter')saveLicense()">
                <button class="btn" style="background:transparent;border:none;cursor:pointer;font-size:14px;padding:4px 6px;opacity:0.6" onclick="const i=document.getElementById('input-license');const t=i.type==='password'?'text':'password';i.type=t;this.textContent=t==='password'?'\u{1F441}':'\u{1F648}'" title="Toggle visibility">&#128065;</button>
                <button class="btn" id="btn-activate-license" style="background:var(--warning);color:#000;font-weight:700;white-space:nowrap" onclick="saveLicense()">Activate</button>
            </div>
            <div class="license-status" id="license-status"></div>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                <a href="https://yazanbake.gumroad.com/l/auto-accept" style="color:var(--warning);font-size:11px;font-weight:600" target="_blank" rel="noopener">&#8599; Get Pro (Free Trial)</a>
                <span style="opacity:0.3;font-size:11px">|</span>
                <a href="https://github.com/yazanbaker94/AntiGravity-AutoAccept/blob/main/docs/guide/swarm-mode-guide.md" style="color:var(--vscode-textLink-foreground, var(--accent));font-size:11px;font-weight:600" target="_blank" rel="noopener">&#128214; Swarm Guide</a>
            </div>
            <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)">
                <div style="display:flex;align-items:center;gap:8px">
                    <button class="btn" id="btn-telegram" style="background:linear-gradient(135deg,#0088cc,#00aaee);color:#fff;font-weight:700;font-size:12px;padding:6px 14px;border:none;border-radius:6px;cursor:pointer" onclick="telegramAction()">&#129302; Connect Telegram</button>
                    <span id="telegram-status" style="font-size:11px;opacity:0.7"></span>
                </div>
                <div style="font-size:10px;opacity:0.5;margin-top:4px">Control agents from your phone via Telegram</div>
            </div>
        </div>
    </div>

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

    <!-- Analytics Card (Value-first: immediate dopamine hit) -->
    <div class="card">
        <div class="card-title">📊 Analytics</div>
        <div style="display:flex;gap:12px;text-align:center">
            <div style="flex:1;background:var(--input-bg);border-radius:8px;padding:14px">
                <div style="font-size:26px;font-weight:700;color:var(--accent)" id="stat-clicks">0</div>
                <div style="font-size:10px;opacity:0.5;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px">Total Clicks</div>
            </div>
            <div style="flex:1;background:var(--input-bg);border-radius:8px;padding:14px">
                <div style="font-size:26px;font-weight:700;color:var(--success)" id="stat-time">0m</div>
                <div style="font-size:10px;opacity:0.5;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px">Time Saved</div>
                <div style="font-size:10px;opacity:0.4;margin-top:2px" id="stat-dollars"></div>
            </div>
            <div style="flex:1;background:var(--input-bg);border-radius:8px;padding:14px">
                <div style="font-size:26px;font-weight:700" id="stat-since">--</div>
                <div style="font-size:10px;opacity:0.5;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px">Since</div>
            </div>
        </div>
    </div>

    <!-- Milestone Banner (hidden by default, shown via JS) -->
    <div class="milestone-banner" id="milestone-banner">
        <div style="font-size:24px">&#127942;</div>
        <div class="milestone-rank" id="milestone-rank"></div>
        <div style="font-size:12px;opacity:0.8;margin-top:4px" id="milestone-msg"></div>
        <div class="milestone-progress" id="milestone-progress-wrap" style="display:none">
            <div class="milestone-progress-fill" id="milestone-progress-fill" style="width:0%"></div>
        </div>
        <div style="margin-top:10px">
            <button class="milestone-dismiss" id="milestone-dismiss">Dismiss</button>
            <a class="milestone-share" id="milestone-share" href="#" target="_blank" rel="noopener noreferrer">Share on X &#8599;</a>
        </div>
    </div>



    <!-- Settings & Command Configuration -->
    <div class="card">
        <div class="card-title">&#9881;&#65039; Settings</div>
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
        <div class="toggle-row">
            <div>
                <div class="toggle-label">Auto-Retry on Errors</div>
                <div class="toggle-desc">Auto-click Retry & Continue when agent hits errors</div>
            </div>
            <label class="switch">
                <input type="checkbox" id="chk-auto-retry" onchange="updateConfig('autoRetryEnabled', this.checked)">
                <span class="slider"></span>
            </label>
        </div>
    </div>

    <div class="card">
        <div class="card-title">&#128683; Blocked Commands</div>
        <div class="toggle-desc" style="margin-bottom:8px">Commands matching these patterns will NEVER be auto-run</div>
        <div class="list-editor">
            <div class="list-input">
                <input id="input-blocked" placeholder="e.g. rm -rf, git push --force (comma-separated for bulk)" onkeydown="if(event.key==='Enter')addBlocked()">
                <button onclick="addBlocked()">+ Add</button>
            </div>
            <button class="btn" id="btn-load-presets" style="width:100%;margin-bottom:8px;background:var(--warning);color:#000;font-weight:600" onclick="loadSafetyPresets()">&#128737; Load Recommended Safety Presets</button>
            <div id="list-blocked"></div>
        </div>
    </div>

    <div class="card">
        <div class="card-title">&#9989; Allowed Commands</div>
        <div class="toggle-desc" style="margin-bottom:8px">If non-empty, ONLY matching commands will be auto-run</div>
        <div class="list-editor">
            <div class="list-input">
                <input id="input-allowed" placeholder="e.g. npm test, npm install" onkeydown="if(event.key==='Enter')addAllowed()">
                <button onclick="addAllowed()">+ Add</button>
            </div>
            <div id="list-allowed"></div>
        </div>
    </div>

    <!-- Activity Log (Diagnostics at absolute bottom) -->
    <div class="card">
        <div class="card-title">&#128203; Activity Log</div>
        <div class="activity-log" id="activity-log">
            <div class="empty-note">Waiting for activity...</div>
        </div>
    </div>

    <!-- Diagnostic Dump -->
    <div class="card">
        <div class="card-title">&#128203; Diagnostics</div>
        <div class="toggle-desc" style="margin-bottom:8px">Copy debug info to clipboard for bug reports</div>
        <button id="btn-diag-dump" class="btn" style="width:100%;padding:8px;cursor:pointer;font-size:13px" onclick="copyDiagDump()">&#128203; Copy Diagnostic Dump</button>
        <div id="diag-status" style="margin-top:6px;font-size:11px;color:var(--vscode-descriptionForeground);display:none"></div>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    let state = {};
    let _pendingDiag = false;

    function toggle() { vscode.postMessage({ type: 'toggle' }); }

    function copyDiagDump() {
        if (_pendingDiag) return;
        _pendingDiag = true;
        document.getElementById('btn-diag-dump').textContent = '\u23f3 Collecting...';
        vscode.postMessage({ type: 'getDiagDump' });
    }

    function saveLicense() {
        const input = document.getElementById('input-license');
        const key = input.value.trim();
        const statusEl = document.getElementById('license-status');
        if (!key) { statusEl.className = 'license-status err'; statusEl.textContent = 'Please paste your license key first.'; return; }
        statusEl.className = 'license-status pending';
        statusEl.textContent = '\u23f3 Activating Swarm Mode...';
        document.getElementById('btn-activate-license').disabled = true;
        vscode.postMessage({ type: 'updateConfig', key: 'proLicenseKey', value: key });
        setTimeout(() => { document.getElementById('btn-activate-license').disabled = false; }, 4000);
    }

    function removeLicense() {
        document.getElementById('input-license').value = '';
        const s = document.getElementById('license-status'); s.className = 'license-status'; s.textContent = '';
        vscode.postMessage({ type: 'updateConfig', key: 'proLicenseKey', value: '' });
    }

    function updateConfig(key, value) {
        vscode.postMessage({ type: 'updateConfig', key, value });
    }

    function telegramAction() {
        const btn = document.getElementById('btn-telegram');
        const isConnected = btn.textContent.includes('Disconnect');
        if (isConnected) {
            vscode.postMessage({ type: 'telegramUnpair' });
            btn.textContent = '\\u{1F916} Connect Telegram';
            document.getElementById('telegram-status').textContent = '';
        } else {
            btn.textContent = '\\u23F3 Connecting...';
            btn.disabled = true;
            vscode.postMessage({ type: 'telegramPair' });
            setTimeout(() => { btn.disabled = false; btn.textContent = '\\u{1F916} Connect Telegram'; }, 5000);
        }
    }

    function addBlocked() {
        const input = document.getElementById('input-blocked');
        const raw = input.value.trim();
        if (!raw) return;
        // Support comma-separated bulk paste
        const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) {
            vscode.postMessage({ type: 'addBlockedBulk', values: parts });
        } else {
            vscode.postMessage({ type: 'addBlocked', value: raw });
        }
        input.value = '';
    }

    const SAFETY_PRESETS = [
        "rm -rf /","rm -rf /*","rm -rf ~","rm -rf .*","rm -rf .git",
        "rmdir /s /q c:\\\\","rmdir /s /q d:\\\\","rd /s /q c:\\\\","rd /s /q d:\\\\",
        "del /f /s /q c:\\\\","del /f /s /q d:\\\\",
        "remove-item -recurse -force c:\\\\","remove-item -recurse -force d:\\\\",
        "format c:","format d:","diskpart","clear-disk","format-volume",
        "remove-partition","initialize-disk",
        "dd if=/dev/zero","dd if=/dev/urandom","dd if=/dev/random",
        "mkfs.","wipefs","shred ","vssadmin delete shadows","reg delete hk",
        "chmod -r 777 /","chown -r root /","sudo su","su -",
        "| bash","| sh","| zsh","| pwsh",
        "invoke-expression","iex (","set-executionpolicy bypass",
        "drop database","drop table","truncate table","db.dropdatabase()",
        "docker system prune -a --volumes","docker volume prune","docker volume rm",
        "git push --force","git push -f","git clean -fdx",
        ":(){ :|:& };:","shutdown ","stop-computer"
    ];

    function loadSafetyPresets() {
        vscode.postMessage({ type: 'addBlockedBulk', values: SAFETY_PRESETS });
        const btn = document.getElementById('btn-load-presets');
        btn.textContent = '\u2705 Loaded ' + SAFETY_PRESETS.length + ' presets!';
        btn.style.background = 'var(--success)';
        btn.style.color = '#fff';
        setTimeout(() => {
            btn.textContent = '\uD83D\uDEE1 Load Recommended Safety Presets';
            btn.style.background = 'var(--warning)';
            btn.style.color = '#000';
        }, 3000);
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
        // Bug 15 fix: use data attributes + event delegation instead of
        // fragile inline onclick string escaping
        el.innerHTML = items.map((item, i) =>
            '<span class="tag">' +
            '<code>' + escHtml(item) + '</code>' +
            '<span class="remove" data-idx="' + i + '">&times;</span>' +
            '</span>'
        ).join('');
        el.querySelectorAll('.remove[data-idx]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var idx = parseInt(this.getAttribute('data-idx'), 10);
                if (window[removeHandler]) window[removeHandler](items[idx]);
            });
        });
    }

    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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
        document.getElementById('chk-auto-retry').checked = data.autoRetryEnabled;

        // Pro license status
        const licInput = document.getElementById('input-license');
        const licStatus = document.getElementById('license-status');
        if (licInput && licStatus) {
            if (data.proLicenseKey && !licInput.value) licInput.value = data.proLicenseKey;
            if (data.proLicenseKey && data.swarmActive) {
                const planLabel = data.swarmPlan === 'lifetime' ? '\u2B50 Lifetime Plan'
                                : data.swarmPlan === 'yearly'  ? '\uD83D\uDCC5 Yearly Plan'
                                : data.swarmPlan === 'monthly' ? '\uD83D\uDD01 Monthly Plan'
                                : '';
                licStatus.className = 'license-status ok';
                licStatus.textContent = '\u2713 Active' + (planLabel ? ' \u2014 ' + planLabel : '') + ' \u2014 Swarm Mode activates when Agent Manager connects';
            } else if (data.proLicenseKey && !data.swarmActive) {
                licStatus.className = 'license-status err';
                licStatus.textContent = '\u274C Invalid or expired key \u2014 check your Gumroad license';
            } else {
                licStatus.className = 'license-status'; licStatus.textContent = '';
            }
        }

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
        // DOM culling: cap at 50 elements. insertBefore(_, firstChild) = newest on top,
        // so lastElementChild = oldest. Use Element-specific API to avoid text node mismatch.
        while (log.childElementCount > 50) log.lastElementChild.remove();
    }

    // Signal extension host that DOM is ready for state
    vscode.postMessage({ type: 'ready' });

    // Sponsor card — full card clickable (a11y: keyboard + mouse, double-click throttle)
    (function() {
        const card = document.getElementById('sponsor-slot');
        if (!card) return;
        let locked = false;
        const openSponsor = () => {
            if (locked) return;
            locked = true;
            vscode.postMessage({ type: 'openSponsor' });
            setTimeout(() => { locked = false; }, 1000);
        };
        card.addEventListener('click', openSponsor);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSponsor(); }
        });
    })();

    // Analytics rendering
    function formatTime(mins) {
        if (mins >= 60) {
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
        }
        return mins + 'm';
    }

    function updateAnalytics(data) {
        const clicks = data.totalClicks || 0;
        const mins = data.timeSavedMinutes || 0;

        // Stats cards
        const elClicks = document.getElementById('stat-clicks');
        if (elClicks) elClicks.textContent = clicks.toLocaleString();
        const elTime = document.getElementById('stat-time');
        if (elTime) elTime.textContent = formatTime(mins);
        // Dollar value sub-text
        const elDollars = document.getElementById('stat-dollars');
        if (elDollars && mins > 0) elDollars.textContent = '~$' + mins.toLocaleString() + ' value';
        if (data.firstClickDate) {
            const d = new Date(data.firstClickDate);
            const elSince = document.getElementById('stat-since');
            if (elSince) elSince.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }

        // Milestone banner — focus on progress to NEXT rank (dedup with stats)
        const banner = document.getElementById('milestone-banner');
        if (banner && data.currentMilestone && data.currentRank) {
            const dismissed = data.lastDismissedMilestone || 0;
            if (data.currentMilestone > dismissed) {
                banner.classList.add('visible');
                const rankEl = document.getElementById('milestone-rank');
                if (rankEl) rankEl.textContent = data.currentRank;
                const msgEl = document.getElementById('milestone-msg');
                if (msgEl) {
                    if (data.nextMilestone && data.nextRank) {
                        const remaining = data.nextMilestone - clicks;
                        msgEl.textContent = remaining.toLocaleString() + ' clicks until ' + data.nextRank;
                    } else {
                        msgEl.textContent = 'Maximum rank achieved!';
                    }
                }
                // Progress bar
                const progressWrap = document.getElementById('milestone-progress-wrap');
                const progressFill = document.getElementById('milestone-progress-fill');
                if (progressWrap && progressFill) {
                    if (data.nextMilestone) {
                        progressWrap.style.display = 'block';
                        const currentBase = data.currentMilestone || 0;
                        const range = data.nextMilestone - currentBase;
                        const progress = clicks - currentBase;
                        const pct = range > 0 ? Math.min(100, Math.max(0, Math.round((progress / range) * 100))) : 0;
                        progressFill.style.width = pct + '%';
                    } else {
                        // Max rank achieved — full bar
                        progressWrap.style.display = 'block';
                        progressFill.style.width = '100%';
                    }
                }
                const shareEl = document.getElementById('milestone-share');
                if (shareEl) {
                    const tweet = 'I just hit ' + clicks.toLocaleString() + ' auto-clicks with AntiGravity AutoAccept! Rank: ' + data.currentRank + '. Try it: https://github.com/yazanbaker94/AntiGravity-AutoAccept';
                    shareEl.href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(tweet);
                }
            } else {
                banner.classList.remove('visible');
            }
        }

        // Dynamic sponsor text — rank-based archetype pitch
        const sponsorText = document.getElementById('sponsor-text');
        if (sponsorText) {
            if (data.currentRank) {
                sponsorText.textContent = 'Want your brand here? Reach ' + data.currentRank + '-tier developers who automate their workflows.';
            } else if (mins > 0) {
                sponsorText.textContent = 'Want your brand here? Seen by developers who automate their workflows.';
            }
        }
    }

    // Milestone dismiss handler
    (function() {
        const btn = document.getElementById('milestone-dismiss');
        if (!btn) return;
        btn.addEventListener('click', function() {
            vscode.postMessage({ type: 'dismissMilestone', value: 0 });
            const banner = document.getElementById('milestone-banner');
            if (banner) banner.classList.remove('visible');
        });
    })();

    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type === 'state') { updateUI(msg.data); updateAnalytics(msg.data); }
        else if (msg.type === 'activity') addActivity(msg.data);
        else if (msg.type === 'diagDump') {
            _pendingDiag = false;
            var btn = document.getElementById('btn-diag-dump');
            var statusEl = document.getElementById('diag-status');
            navigator.clipboard.writeText(msg.data).then(function() {
                btn.textContent = '\u2705 Copied to clipboard!';
                statusEl.style.display = 'block';
                statusEl.textContent = 'Paste this into your GitHub issue for faster debugging.';
                setTimeout(function() { btn.textContent = '\uD83D\uDCCB Copy Diagnostic Dump'; }, 3000);
            }).catch(function() {
                btn.textContent = '\u274C Copy failed';
                statusEl.style.display = 'block';
                statusEl.innerHTML = '<pre style="max-height:200px;overflow:auto;font-size:10px;padding:6px;background:var(--vscode-textCodeBlock-background);border-radius:4px">' + escHtml(msg.data) + '</pre>';
                setTimeout(function() { btn.textContent = '\uD83D\uDCCB Copy Diagnostic Dump'; }, 5000);
            });
        }
    });
</script>
</body>
</html>`;
    }
}

module.exports = { DashboardProvider };
