/**
 * ConnectionManager Test Suite (Architecture V2)
 * ────────────────────────────────────────────────
 * Exercises HTTP fallback polling, target filtering,
 * and Worker lifecycle in the new zero-dependency architecture.
 *
 * Run:  node test/connection-manager.test.js
 */

const assert = require('assert');
const path = require('path');

// ─── Test Harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];
const asyncTests = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack || e.message}`); }
}

function testAsync(name, fn) {
    asyncTests.push(async () => {
        try { await fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
        catch (e) { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack || e.message}`); }
    });
}

function eq(a, b) { assert.strictEqual(a, b); }

// ─── Mock Infrastructure ─────────────────────────────────────────────
const { ConnectionManager } = require(path.join(__dirname, '..', 'src', 'cdp', 'ConnectionManager'));

function createMockCM(opts = {}) {
    const logs = [];
    const cm = new ConnectionManager({
        log: (msg) => logs.push(msg),
        getPort: () => 9333,
        getCustomTexts: () => opts.customTexts || [],
    });

    // Mock out worker internals
    cm._ensureWorker = () => ({
        postMessage: () => {},
        terminate: () => {}
    });
    
    // Stub evaluations so we don't need real IPC
    cm._workerEval = async (wsUrl, expr) => opts.evalResult || 'observer-installed';
    cm._workerBurstInject = async (wsUrl, targetId, isPaused) => opts.burstResult !== undefined ? opts.burstResult : 'observer-installed';

    return { cm, logs };
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Target Filtering (_isCandidate) ---\x1b[0m');

test('rejects target with no URL', () => {
    const { cm } = createMockCM();
    assert.ok(!cm._isCandidate({ type: 'page' }));
});

test('rejects service_worker type', () => {
    const { cm } = createMockCM();
    assert.ok(!cm._isCandidate({ type: 'service_worker', url: 'https://vscode-webview-test.com' }));
});

test('rejects worker type', () => {
    const { cm } = createMockCM();
    assert.ok(!cm._isCandidate({ type: 'worker', url: 'https://vscode-webview-test.com' }));
});

test('rejects shared_worker type', () => {
    const { cm } = createMockCM();
    assert.ok(!cm._isCandidate({ type: 'shared_worker', url: 'https://vscode-webview-test.com' }));
});

test('accepts page type with webview URL', () => {
    const { cm } = createMockCM();
    assert.ok(cm._isCandidate({ type: 'page', url: 'vscode-webview://blah' }));
});

test('accepts iframe type with URL', () => {
    const { cm } = createMockCM();
    assert.ok(cm._isCandidate({ type: 'iframe', url: 'vscode-webview://iframe-content' }));
});

test('rejects non-page type if URL contains webview', () => {
    const { cm } = createMockCM();
    // V1 matched anything containing the URL limit, V2 strictly rejects worker types first
    assert.ok(!cm._isCandidate({ type: 'service_worker', url: 'vscode-webview://' }));
});

test('regression: 90C99E service_worker with vscode-webview URL is rejected', () => {
    const { cm } = createMockCM();
    assert.ok(!cm._isCandidate({ type: 'service_worker', url: 'vscode-webview://13lksjdfk/worker.js' }));
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Target Lifecycle (V2 HTTP Polling) ---\x1b[0m');

testAsync('_heartbeat adds new sessions', async () => {
    const { cm } = createMockCM();
    cm.activeCdpPort = 9333;
    cm._getTargetList = async () => [
        { id: 't1', type: 'page', url: 'vscode-webview://1', webSocketDebuggerUrl: 'ws://t1' }
    ];
    await cm._heartbeat();
    assert.ok(cm.sessions.has('t1'), 'Session T1 should exist');
    assert.strictEqual(cm.sessionUrls.get('t1'), 'vscode-webview://1');
});

testAsync('_heartbeat skips ignored targets', async () => {
    const { cm } = createMockCM();
    cm.activeCdpPort = 9333;
    cm.ignoredTargets.add('t2');
    cm._getTargetList = async () => [
        { id: 't2', type: 'page', url: 'vscode-webview://2', webSocketDebuggerUrl: 'ws://t2' }
    ];
    await cm._heartbeat();
    assert.ok(!cm.sessions.has('t2'), 'Session T2 should be skipped due to ignore set');
});

testAsync('_heartbeat drops stale sessions', async () => {
    const { cm } = createMockCM();
    cm.activeCdpPort = 9333;
    cm.sessions.set('t-stale', { url: 'vscode-webview://old', wsUrl: 'ws://stale' });
    cm.sessionUrls.set('t-stale', 'vscode-webview://old');
    
    // Mock getTargetList returns an empty list, so t-stale should be dropped
    cm._getTargetList = async () => [];
    await cm._heartbeat();
    
    assert.ok(!cm.sessions.has('t-stale'), 'Stale session should be removed');
    assert.ok(!cm.sessionUrls.has('t-stale'), 'Stale URL should be removed');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Injection Error Handling ---\x1b[0m');

testAsync('unsuccessful injection sets failures and eventually ignores', async () => {
    // Return null from burst inject to simulate failure
    const { cm } = createMockCM({ burstResult: null }); 
    cm.activeCdpPort = 9333;
    cm._getTargetList = async () => [
        { id: 'bad-t1', type: 'page', url: 'vscode-webview://bad', webSocketDebuggerUrl: 'ws://bad' }
    ];
    
    // Strike 1
    await cm._heartbeat();
    assert.ok(!cm.sessions.has('bad-t1'));
    assert.strictEqual(cm._injectionFailCounts.get('bad-t1'), 1);
    
    // Strike 2
    await cm._heartbeat();
    assert.strictEqual(cm._injectionFailCounts.get('bad-t1'), 2);
    
    // Strike 3 -> Ban
    await cm._heartbeat();
    assert.ok(cm.ignoredTargets.has('bad-t1'), 'Target should be permanently banned after 3 strikes');
});


// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Lifecycle Methods ---\x1b[0m');

test('pause sets isPaused', () => {
    const { cm } = createMockCM();
    cm.pause();
    assert.ok(cm.isPaused);
});

test('unpause clears isPaused', () => {
    const { cm } = createMockCM();
    cm.isPaused = true;
    cm.unpause();
    assert.ok(!cm.isPaused);
});

test('stop clears all state and cancels timers', () => {
    const { cm } = createMockCM();
    cm.sessions.set('x', {});
    cm.ignoredTargets.add('y');
    
    // Simulate heartbeart timer being active
    cm.heartbeatTimer = setTimeout(() => {}, 10000);
    cm.isRunning = true;
    
    cm.stop();
    assert.strictEqual(cm.sessions.size, 0);
    assert.strictEqual(cm.ignoredTargets.size, 0);
    assert.strictEqual(cm.heartbeatTimer, null);
    assert.ok(!cm.isRunning);
});

// ═════════════════════════════════════════════════════════════════════
// Trigger Async Tests Run

(async () => {
    for (const tn of asyncTests) {
        await tn();
    }
    
    console.log(`\n${'═'.repeat(50)}`);
    const color = fail ? '31' : '32';
    console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[${color}m${fail} failed\x1b[0m, ${pass + fail} total`);

    if (fails.length) {
        console.log('\n  Failures:');
        fails.forEach(f => console.log(`   • ${f}`));
    }
    console.log('');
    process.exit(fail ? 1 : 0);
})();
