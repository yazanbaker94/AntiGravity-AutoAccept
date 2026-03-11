// Deep probe of the workbench target — check what buttons exist and what selectors work
const WebSocket = require('ws');

const TARGET_WS = 'ws://127.0.0.1:9333/devtools/page/39655818F543E84E574CF48BEED3537A';

const w = new WebSocket(TARGET_WS);
let id = 0;

function evaluate(expr) {
    return new Promise((resolve, reject) => {
        const myId = ++id;
        w.send(JSON.stringify({
            id: myId, method: 'Runtime.evaluate',
            params: { expression: expr, returnByValue: true }
        }));
        const handler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id === myId) {
                w.removeListener('message', handler);
                resolve(msg.result?.result?.value || msg.result?.exceptionDetails?.text || 'undefined');
            }
        };
        w.on('message', handler);
    });
}

w.on('open', async () => {
    console.log('Connected to workbench page\n');

    // Check if observer is already injected
    const obsActive = await evaluate('window.__AA_OBSERVER_ACTIVE');
    console.log('Observer active:', obsActive);

    const obsPaused = await evaluate('window.__AA_PAUSED');
    console.log('Paused:', obsPaused);

    const lastScan = await evaluate('window.__AA_LAST_SCAN ? new Date(window.__AA_LAST_SCAN).toISOString() : "never"');
    console.log('Last scan:', lastScan);

    const clickCount = await evaluate('window.__AA_CLICK_COUNT || 0');
    console.log('Click count:', clickCount);

    const diag = await evaluate('JSON.stringify(window.__AA_DIAG || [])');
    console.log('Diagnostics:', diag);

    // Check all buttons
    const buttons = await evaluate(`
        (function() {
            var btns = document.querySelectorAll('button');
            var result = [];
            for (var i = 0; i < btns.length && i < 60; i++) {
                var b = btns[i];
                var text = (b.textContent || '').trim();
                if (text.length > 0 && text.length <= 50) {
                    result.push({
                        text: text.substring(0, 40),
                        disabled: !!b.disabled,
                        tag: b.tagName,
                        tooltipId: b.getAttribute('data-tooltip-id') || '',
                        ariaLabel: (b.getAttribute('aria-label') || '').substring(0, 40)
                    });
                }
            }
            return JSON.stringify(result);
        })()
    `);
    console.log('\nAll buttons with text:');
    try {
        const parsed = JSON.parse(buttons);
        parsed.forEach((b, i) => {
            console.log(`  [${i}] "${b.text}" disabled=${b.disabled} tooltip="${b.tooltipId}" aria="${b.ariaLabel}"`);
        });
    } catch (e) { console.log(buttons); }

    // Check for contenteditable
    const editables = await evaluate(`
        (function() {
            var eds = document.querySelectorAll('div[contenteditable="true"][role="textbox"]');
            var result = [];
            for (var i = 0; i < eds.length; i++) {
                var e = eds[i];
                result.push({
                    content: (e.textContent || '').substring(0, 40),
                    parent: (e.parentElement?.tagName || '?') + '.' + (e.parentElement?.className || '').substring(0, 30)
                });
            }
            return JSON.stringify(result);
        })()
    `);
    console.log('\nContenteditable textboxes:');
    try {
        const parsed = JSON.parse(editables);
        parsed.forEach((e, i) => {
            console.log(`  [${i}] content="${e.content}" parent="${e.parent}"`);
        });
    } catch (e) { console.log(editables); }

    // Check agent panel markers
    const agentCheck = await evaluate(`
        (function() {
            var agents = document.querySelectorAll('[class*="agent"]');
            var result = [];
            for (var i = 0; i < agents.length && i < 10; i++) {
                result.push({
                    tag: agents[i].tagName,
                    cls: (agents[i].className || '').substring(0, 60),
                    childCount: agents[i].children.length
                });
            }
            return JSON.stringify(result);
        })()
    `);
    console.log('\nAgent-class elements:');
    try {
        const parsed = JSON.parse(agentCheck);
        parsed.forEach((a, i) => {
            console.log(`  [${i}] <${a.tag}> class="${a.cls}" children=${a.childCount}`);
        });
    } catch (e) { console.log(agentCheck); }

    w.close();
});

w.on('error', e => { console.error('WS Error:', e.message); });
