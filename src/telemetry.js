// AntiGravity AutoAccept — Anonymous Telemetry
// Fire-and-forget pings gated behind vscode.env.isTelemetryEnabled.
// No PII, no user IDs. Only event name + extension version.
// Daily-throttled to stay within Cloudflare KV free tier (1,000 writes/day).

const vscode = require('vscode');

const WORKER_URL = 'https://telemetry.sakinahtime.com';
const DAY_MS = 86400000;

/**
 * Send an anonymous telemetry ping (max once per event per day).
 * @param {'activate' | 'dashboard_open'} event
 * @param {vscode.ExtensionContext} [context] - For daily throttle persistence
 * @param {Function} [log] - Optional logger
 */
function pingTelemetry(event, context, log) {
    if (!vscode.env.isTelemetryEnabled) {
        if (log) log(`[Telemetry] Skipped '${event}' — telemetry disabled by user`);
        return;
    }

    // Daily throttle: only ping once per event per 24h
    if (context) {
        const key = `telemetryLast_${event}`;
        const last = context.globalState.get(key, 0);
        if (Date.now() - last < DAY_MS) {
            if (log) log(`[Telemetry] Skipped '${event}' — already pinged today`);
            return;
        }
        context.globalState.update(key, Date.now());
    }

    const version = require('../package.json').version;
    const url = `${WORKER_URL}/ping?e=${event}&v=${version}`;

    // Fire-and-forget — never blocks, never throws
    try {
        fetch(url).catch(() => { });
        if (log) log(`[Telemetry] Pinged '${event}' (v${version})`);
    } catch (_) { }
}

module.exports = { pingTelemetry };
