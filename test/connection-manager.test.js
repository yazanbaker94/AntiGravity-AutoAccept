/**
 * ConnectionManager Test Suite
 * ─────────────────────────────
 * Exercises CDP target filtering, injection flow, heartbeat,
 * lifecycle, and edge cases using a mock _send() approach.
 *
 * Run:  node test/connection-manager.test.js
 */

const assert = require('assert');
const path = require('path');

// ─── Test Harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

async function testAsync(name, fn) {
    try { await fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function eq(a, b) { assert.strictEqual(a, b); }

// ─── Mock Infrastructure ─────────────────────────────────────────────
const { ConnectionManager } = require(path.join(__dirname, '..', 'src', 'cdp', 'ConnectionManager'));

/**
 * Creates a ConnectionManager with a smart mock _send() that routes
 * responses by method + expression pattern matching.
 * 
 * evaluateHandler: (expression, sessionId) => response
 *   Called for ALL Runtime.evaluate calls. Test provides one handler
 *   that decides response based on expression content.
 */
function createMockCM(opts = {}) {
    const logs = [];
    const cm = new ConnectionManager({
        log: (msg) => logs.push(msg),
        getPort: () => 9333,
        getCustomTexts: () => opts.customTexts || [],
    });
    cm.autoAcceptFileEdits = opts.autoAcceptFileEdits !== undefined ? opts.autoAcceptFileEdits : true;
    cm.blockedCommands = opts.blockedCommands || [];
    cm.allowedCommands = opts.allowedCommands || [];

    // Default handlers per method
    cm._handlers = {
        'Target.attachToTarget': opts.attachResult || (() => ({ result: { sessionId: 'mock-session' } })),
        'Target.detachFromTarget': () => ({ result: {} }),
        'Target.getTargets': opts.getTargetsResult || (() => ({ result: { targetInfos: [] } })),
        'Target.setDiscoverTargets': () => ({ result: {} }),
        'Runtime.enable': () => ({ result: {} }),
        'Runtime.evaluate': null, // Set per-test via evaluateHandler
    };

    cm._evaluateHandler = opts.evaluateHandler || defaultEvaluateHandler;
    cm._sendCalls = [];

    cm._send = async function (method, params = {}, sessionId = null) {
        cm._sendCalls.push({ method, params, sessionId });
        if (method === 'Runtime.evaluate') {
            return cm._evaluateHandler(params.expression, sessionId, params);
        }
        return cm._handlers[method] ? cm._handlers[method](params, sessionId) : { result: {} };
    };

    // Simulate WS as open
    cm.ws = { readyState: 1, removeAllListeners: () => { } };

    return { cm, logs };
}

/** Default evaluate handler: passes DOM check, window check, returns observer-installed */
function defaultEvaluateHandler(expr) {
    // DOM check for page targets
    if (expr.includes('document.title')) {
        return { result: { result: { value: 'has-dom' } } };
    }
    // Window+document pre-check
    if (expr.includes('typeof window') && expr.length < 200) {
        return { result: { result: { value: true } } };
    }
    // DOMObserver injection script (starts with (function...)
    if (expr.includes('__AA_CLICK_COUNT')) {
        return { result: { result: { value: 'observer-installed' } } };
    }
    // Heartbeat health check
    if (expr.includes('__AA_CLICK_COUNT')) {
        return { result: { result: { value: { alive: true, clickCount: 0 } } } };
    }
    // Observer reset
    if (expr.includes('__AA_OBSERVER_ACTIVE = false')) {
        return { result: {} };
    }
    // Pause/unpause
    if (expr.includes('__AA_PAUSED')) {
        return { result: {} };
    }
    return { result: {} };
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Target Filtering (_isCandidate) ---\x1b[0m');

test('rejects target with no URL', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'page', url: '' }), false);
    eq(cm._isCandidate({ type: 'page', url: null }), false);
    eq(cm._isCandidate({ type: 'page', url: undefined }), false);
});

test('rejects service_worker type', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'service_worker', url: 'vscode-webview://abc/sw.js' }), false);
});

test('rejects worker type', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'worker', url: 'vscode-webview://abc/worker.js' }), false);
});

test('rejects shared_worker type', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'shared_worker', url: 'vscode-webview://abc/shared.js' }), false);
});

test('accepts page type with webview URL', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'page', url: 'vscode-webview://1ig6i2k9uec64f3g2sjm7c09ef5kjt1p5' }), true);
});

test('accepts iframe type with URL', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'iframe', url: 'vscode-webview://abc' }), true);
});

test('accepts non-page type if URL contains webview', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'other', url: 'https://something.webview.local' }), true);
});

test('rejects unrelated type without webview URL', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'other', url: 'https://google.com' }), false);
});

test('regression: 90C99E service_worker with vscode-webview URL is rejected', () => {
    const { cm } = createMockCM();
    eq(cm._isCandidate({ type: 'service_worker', url: 'vscode-webview://1ig6i2k9uec64f3g2sjm7c09ef5kjt1p5/sw.js' }), false);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Target Lifecycle ---\x1b[0m');

test('_handleTargetDestroyed cleans session, ignored, and fail counts', () => {
    const { cm } = createMockCM();
    const tid = 'target-abc-123';
    cm.sessions.set(tid, 'session-1');
    cm.ignoredTargets.add(tid);
    cm._sessionFailCounts.set(tid, 2);
    cm._handleTargetDestroyed(tid);
    assert.ok(!cm.sessions.has(tid));
    assert.ok(!cm.ignoredTargets.has(tid));
    assert.ok(!cm._sessionFailCounts.has(tid));
});

test('_handleTargetDestroyed ignores unknown target', () => {
    const { cm } = createMockCM();
    cm._handleTargetDestroyed('unknown-target');
    assert.ok(true);
});

test('_handleSessionDetached removes session by sessionId', () => {
    const { cm } = createMockCM();
    cm.sessions.set('target-1', 'session-abc');
    cm.sessions.set('target-2', 'session-def');
    cm._sessionFailCounts.set('target-1', 1);
    cm._handleSessionDetached('session-abc');
    assert.ok(!cm.sessions.has('target-1'));
    assert.ok(cm.sessions.has('target-2'));
    assert.ok(!cm._sessionFailCounts.has('target-1'));
});

test('_handleSessionDetached ignores null sessionId', () => {
    const { cm } = createMockCM();
    cm._handleSessionDetached(null);
    cm._handleSessionDetached(undefined);
    assert.ok(true);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Injection Flow (_handleNewTarget) ---\x1b[0m');

(async () => {

    await testAsync('successful injection creates session', async () => {
        const { cm } = createMockCM();
        await cm._handleNewTarget({ targetId: 'target-1', type: 'page', url: 'vscode-webview://abc' });
        assert.ok(cm.sessions.has('target-1'), 'should be in sessions');
        eq(cm.sessions.get('target-1'), 'mock-session');
    });

    await testAsync('not-agent-panel permanently ignores target', async () => {
        const { cm } = createMockCM({
            evaluateHandler: (expr) => {
                if (expr.includes('document.title')) return { result: { result: { value: 'has-dom' } } };
                if (expr.includes('typeof window') && expr.length < 200) return { result: { result: { value: true } } };
                return { result: { result: { value: 'not-agent-panel' } } };
            }
        });
        await cm._handleNewTarget({ targetId: 'id-nap', type: 'page', url: 'vscode-webview://xyz' });
        assert.ok(!cm.sessions.has('id-nap'), 'should NOT be in sessions');
        assert.ok(cm.ignoredTargets.has('id-nap'), 'should be permanently ignored');
    });

    await testAsync('undefined result triggers 3-strike rule', async () => {
        let attachCount = 0;
        const { cm } = createMockCM({
            attachResult: () => ({ result: { sessionId: `sess-${++attachCount}` } }),
            evaluateHandler: (expr) => {
                if (expr.includes('document.title')) return { result: { result: { value: 'has-dom' } } };
                if (expr.includes('typeof window')) return { result: { result: { value: true } } };
                return { result: { result: { value: undefined } } };
            }
        });

        await cm._handleNewTarget({ targetId: 'id-strike', type: 'page', url: 'vscode-webview://a' });
        assert.ok(!cm.ignoredTargets.has('id-strike'), 'not ignored after 1 strike');

        await cm._handleNewTarget({ targetId: 'id-strike', type: 'page', url: 'vscode-webview://a' });
        assert.ok(!cm.ignoredTargets.has('id-strike'), 'not ignored after 2 strikes');

        await cm._handleNewTarget({ targetId: 'id-strike', type: 'page', url: 'vscode-webview://a' });
        assert.ok(cm.ignoredTargets.has('id-strike'), 'permanently ignored after 3 strikes');
    });

    await testAsync('windowless target is immediately ignored', async () => {
        const { cm } = createMockCM({
            evaluateHandler: (expr) => {
                if (expr.includes('document.title')) return { result: { result: { value: 'has-dom' } } };
                if (expr.includes('typeof window')) return { result: { result: { value: false } } };
                return { result: { result: { value: 'should-not-reach' } } };
            }
        });
        await cm._handleNewTarget({ targetId: 'id-wl', type: 'page', url: 'vscode-webview://abc' });
        assert.ok(!cm.sessions.has('id-wl'));
        assert.ok(cm.ignoredTargets.has('id-wl'));
    });

    await testAsync('skips already-known session', async () => {
        const { cm } = createMockCM();
        cm.sessions.set('already-known', 'sess-existing');
        let attachCalled = false;
        cm._handlers['Target.attachToTarget'] = () => { attachCalled = true; return { result: { sessionId: 'x' } }; };
        await cm._handleNewTarget({ targetId: 'already-known', type: 'page', url: 'vscode-webview://abc' });
        assert.ok(!attachCalled);
    });

    await testAsync('skips ignored target', async () => {
        const { cm } = createMockCM();
        cm.ignoredTargets.add('ignored-id');
        let attachCalled = false;
        cm._handlers['Target.attachToTarget'] = () => { attachCalled = true; return { result: {} }; };
        await cm._handleNewTarget({ targetId: 'ignored-id', type: 'page', url: 'vscode-webview://abc' });
        assert.ok(!attachCalled);
    });

    await testAsync('no sessionId returned logs error', async () => {
        const { cm, logs } = createMockCM({
            attachResult: () => ({ result: {} })
        });
        await cm._handleNewTarget({ targetId: 'no-sid', type: 'page', url: 'vscode-webview://abc' });
        assert.ok(!cm.sessions.has('no-sid'));
        assert.ok(logs.some(l => l.includes('No sessionId')));
    });

    await testAsync('CDP error in injection is handled gracefully', async () => {
        const { cm, logs } = createMockCM({
            evaluateHandler: (expr) => {
                if (expr.includes('document.title')) return { result: { result: { value: 'has-dom' } } };
                if (expr.includes('typeof window')) return { result: { result: { value: true } } };
                return { error: { code: -32000, message: 'Target closed' } };
            }
        });
        await cm._handleNewTarget({ targetId: 'id-cdperr', type: 'page', url: 'vscode-webview://a' });
        assert.ok(!cm.sessions.has('id-cdperr'));
        assert.ok(logs.some(l => l.includes('CDP error') || l.includes('cdp-error') || l.includes('Injection')));
    });

    await testAsync('script exception in injection is handled', async () => {
        const { cm, logs } = createMockCM({
            evaluateHandler: (expr) => {
                if (expr.includes('document.title')) return { result: { result: { value: 'has-dom' } } };
                if (expr.includes('typeof window')) return { result: { result: { value: true } } };
                return { result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError' } } } };
            }
        });
        await cm._handleNewTarget({ targetId: 'id-exc', type: 'page', url: 'vscode-webview://a' });
        assert.ok(!cm.sessions.has('id-exc'));
        assert.ok(logs.some(l => l.includes('Injection exception') || l.includes('script-exception') || l.includes('Injection')));
    });

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m--- Pause / Unpause ---\x1b[0m');

    await testAsync('pause sets isPaused and sends signal', async () => {
        const { cm } = createMockCM();
        cm.sessions.set('t1', 's1');
        cm.isRunning = true;
        await cm.pause();
        assert.ok(cm.isPaused);
    });

    await testAsync('unpause clears isPaused', async () => {
        const { cm } = createMockCM();
        cm.sessions.set('t1', 's1');
        cm.isRunning = true;
        cm.isPaused = true;
        await cm.unpause();
        assert.ok(!cm.isPaused);
    });

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m--- Heartbeat ---\x1b[0m');

    await testAsync('heartbeat discovers new targets', async () => {
        const { cm } = createMockCM({
            getTargetsResult: () => ({
                result: { targetInfos: [{ targetId: 'new-1', type: 'page', url: 'vscode-webview://abc' }] }
            })
        });
        await cm._heartbeat();
        assert.ok(cm.sessions.has('new-1'), 'should discover and attach');
    });

    await testAsync('heartbeat skips ignored targets', async () => {
        const { cm } = createMockCM({
            getTargetsResult: () => ({
                result: { targetInfos: [{ targetId: 'ignored-hb', type: 'page', url: 'vscode-webview://abc' }] }
            })
        });
        cm.ignoredTargets.add('ignored-hb');
        let attachCalled = false;
        cm._handlers['Target.attachToTarget'] = () => { attachCalled = true; return { result: {} }; };
        await cm._heartbeat();
        assert.ok(!attachCalled);
    });

    await testAsync('heartbeat harvests click telemetry', async () => {
        const { cm } = createMockCM({
            getTargetsResult: () => ({
                result: { targetInfos: [{ targetId: 't-clicks', type: 'page', url: 'vscode-webview://abc' }] }
            }),
            evaluateHandler: (expr) => {
                if (expr.includes('__AA_CLICK_COUNT')) {
                    return { result: { result: { value: { alive: true, clickCount: 7 } } } };
                }
                return defaultEvaluateHandler(expr);
            }
        });
        cm.sessions.set('t-clicks', 's-clicks');
        let harvestedClicks = 0;
        cm.onClickTelemetry = (delta) => { harvestedClicks += delta; };
        await cm._heartbeat();
        eq(harvestedClicks, 7);
    });

    await testAsync('heartbeat re-injects dead observers', async () => {
        let injectCount = 0;
        const { cm, logs } = createMockCM({
            getTargetsResult: () => ({
                result: { targetInfos: [{ targetId: 't-dead', type: 'page', url: 'vscode-webview://abc' }] }
            }),
            evaluateHandler: (expr) => {
                if (expr.includes('__AA_CLICK_COUNT') && expr.length < 500) {
                    return { result: { result: { value: { alive: false, clickCount: 0 } } } };
                }
                if (expr.includes('__AA_OBSERVER_ACTIVE = false')) return { result: {} };
                if (expr.length > 1000) {
                    injectCount++;
                    return { result: { result: { value: 'observer-installed' } } };
                }
                return defaultEvaluateHandler(expr);
            }
        });
        cm.sessions.set('t-dead', 's-dead');
        await cm._heartbeat();
        assert.ok(injectCount > 0, 'should re-inject');
        assert.ok(logs.some(l => l.includes('observer dead')));
    });

    await testAsync('heartbeat filters out service_worker targets', async () => {
        const { cm } = createMockCM({
            getTargetsResult: () => ({
                result: {
                    targetInfos: [
                        { targetId: 'sw-1', type: 'service_worker', url: 'vscode-webview://abc/sw.js' },
                        { targetId: 'page-1', type: 'page', url: 'vscode-webview://abc' }
                    ]
                }
            })
        });
        await cm._heartbeat();
        assert.ok(!cm.sessions.has('sw-1'), 'service worker filtered');
        assert.ok(cm.sessions.has('page-1'), 'page target attached');
    });

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m--- Connection Lifecycle ---\x1b[0m');

    test('_onClose clears sessions and resets state', () => {
        const { cm } = createMockCM();
        cm.sessions.set('t1', 's1');
        cm.sessions.set('t2', 's2');
        cm._sessionFailCounts.set('t1', 2);
        cm.ignoredTargets.add('ignored-1');
        cm.isRunning = true;
        cm.ws = { readyState: 3, removeAllListeners: () => { } };
        cm._onClose();
        eq(cm.sessions.size, 0);
        eq(cm._sessionFailCounts.size, 0);
        eq(cm.ignoredTargets.size, 0);
        eq(cm.ws, null);
    });

    test('stop clears all state and cancels timers', () => {
        const { cm } = createMockCM();
        cm.sessions.set('t1', 's1');
        cm.isRunning = true;
        cm.heartbeatTimer = setTimeout(() => { }, 99999);
        cm.reconnectTimer = setTimeout(() => { }, 99999);
        cm.stop();
        assert.ok(!cm.isRunning);
        eq(cm.heartbeatTimer, null);
        eq(cm.reconnectTimer, null);
    });

    // ═════════════════════════════════════════════════════════════════════
    console.log('\n\x1b[1m--- _onMessage routing ---\x1b[0m');

    test('_onMessage resolves pending promise', () => {
        const { cm } = createMockCM();
        let resolved = null;
        cm.pending.set(42, {
            resolve: (v) => { resolved = v; },
            reject: () => { },
            timer: setTimeout(() => { }, 5000)
        });
        cm._onMessage(JSON.stringify({ id: 42, result: { success: true } }));
        assert.ok(resolved !== null);
        eq(resolved.result.success, true);
        assert.ok(!cm.pending.has(42));
    });

    test('_onMessage handles targetDestroyed event', () => {
        const { cm } = createMockCM();
        cm.sessions.set('target-xyz', 'sess-xyz');
        cm._onMessage(JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: 'target-xyz' } }));
        assert.ok(!cm.sessions.has('target-xyz'));
    });

    test('_onMessage handles detachedFromTarget event', () => {
        const { cm } = createMockCM();
        cm.sessions.set('target-abc', 'sess-abc');
        cm._onMessage(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'sess-abc' } }));
        assert.ok(!cm.sessions.has('target-abc'));
    });

    // ═════════════════════════════════════════════════════════════════════
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[${fail ? '31' : '32'}m${fail} failed\x1b[0m, ${pass + fail} total`);
    if (fails.length) {
        console.log('\n  Failures:');
        fails.forEach(f => console.log(`   • ${f}`));
    }
    console.log('');
    process.exit(fail ? 1 : 0);

})(); // End async IIFE
