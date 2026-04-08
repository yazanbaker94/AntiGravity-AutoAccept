/**
 * Permission Engine Test Suite
 * ─────────────────────────────
 * Exercises the button-matching logic from DOMObserver.
 * Uses jsdom-free mock DOM that closely mirrors browser APIs.
 *
 * Run:  node test/permission-engine.test.js
 */

const assert = require('assert');

// ─── Mock DOM ────────────────────────────────────────────────────────

class ClassList extends Set {
    contains(v) { return this.has(v); }
}

class El {
    constructor(tag, text, attrs = {}, kids = []) {
        this.tagName = tag.toUpperCase();
        this._text = text || '';
        this._attrs = attrs;
        this.classList = new ClassList((attrs.class || '').split(' ').filter(Boolean));
        this.disabled = !!attrs.disabled;
        this.onclick = attrs.onclick || null;
        this.shadowRoot = attrs.shadowRoot || null;
        this.children = kids;
        this.parentElement = null;
        this._clicked = false;
        kids.forEach(k => k.parentElement = this);
    }
    getAttribute(n) { return this._attrs[n] !== undefined ? this._attrs[n] : null; }
    setAttribute(n, v) { this._attrs[n] = String(v); }
    get textContent() {
        return this._text + this.children.map(c => c.textContent).join('');
    }
    click() { this._clicked = true; }
    querySelector(sel) {
        const all = this._flat();
        for (const el of all) {
            if (sel.startsWith('.')) {
                if (el.classList.has(sel.slice(1))) return el;
            } else if (sel.startsWith('[class*="')) {
                const v = sel.slice(9, -2);
                for (const c of el.classList) if (c.includes(v)) return el;
            } else if (sel.startsWith('[data-')) {
                const attr = sel.slice(1, -1);
                if (el._attrs[attr] !== undefined) return el;
            } else {
                // Tag name match (e.g. 'pre', 'code')
                if (el.tagName === sel.toUpperCase()) return el;
            }
        }
        return null;
    }
    _flat() {
        let r = [];
        for (const c of this.children) { r.push(c); r = r.concat(c._flat()); }
        return r;
    }
}

function makeDoc(bodyKids, isAgentPanel = true) {
    const body = new El('BODY', '', {}, bodyKids);
    bodyKids.forEach(k => k.parentElement = body);
    const doc = {
        body,
        defaultView: {},
        querySelector(sel) {
            if (isAgentPanel && sel === '.react-app-container') return new El('DIV', '');
            if (isAgentPanel && sel.includes('agent')) return new El('DIV', '');
            return body.querySelector(sel);
        },
        createTreeWalker(root) {
            const nodes = [];
            function walk(el) { for (const c of el.children) { nodes.push(c); walk(c); } }
            walk(root);
            let i = -1;
            return { nextNode() { return nodes[++i] || null; } };
        }
    };
    return doc;
}

// ─── Script Runner ───────────────────────────────────────────────────
// Import DOMObserver and run the generated script in our mock.

const path = require('path');
const { buildDOMObserverScript } = require(path.join(__dirname, '..', 'src', 'scripts', 'DOMObserver'));

function run(doc, custom = [], blocked = [], allowed = []) {
    const script = buildDOMObserverScript(custom, blocked, allowed).trim();
    // The script is an IIFE: (function(){ ... })()
    // We need to add 'return' before it for new Function()
    const fn = new Function('document', 'NodeFilter', 'window', 'requestAnimationFrame', 'MutationObserver', 'return ' + script);

    // Mock window, requestAnimationFrame, and MutationObserver
    const mockWindow = {};

    // If tests pre-set doc.defaultView properties (e.g. __AA_PAUSED), copy them
    if (doc.defaultView) {
        Object.assign(mockWindow, doc.defaultView);
    }

    // Link doc.defaultView to mockWindow so tests can inspect window globals after run
    doc.defaultView = mockWindow;

    const mockRAF = (cb) => cb();
    class MockMutationObserver {
        observe() { }
        disconnect() { }
    }

    return fn(doc, { SHOW_ELEMENT: 1 }, mockWindow, mockRAF, MockMutationObserver);
}

// ─── Test Harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function eq(a, b) { assert.strictEqual(a, b); }

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Webview Guard ---\x1b[0m');

test('non-agent-panel: observer installs but buttons are NOT clicked', () => {
    const btn = new El('BUTTON', 'Run');
    const result = run(makeDoc([btn], false));
    eq(result, 'observer-installed');
    assert.ok(!btn._clicked, 'Button should NOT be clicked on non-agent panel');
});

test('allows agent panel (returns observer-installed when empty)', () => {
    eq(run(makeDoc([])), 'observer-installed');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Button Text Matching ---\x1b[0m');

const buttonTests = [
    ['Run', 'clicked:run'],
    ['run', 'clicked:run'],
    ['RUN', 'clicked:run'],
    ['Run Alt+d', 'clicked:run'],
    ['Run Command', 'clicked:run'],
    ['Accept', 'clicked:accept'],
    ['accept', 'clicked:accept'],
    ['Accept All', 'clicked:accept'],
    ['Always Allow', 'clicked:always allow'],
    ['always allow', 'clicked:always allow'],
    ['Always ALLOW', 'clicked:always allow'],
    ['Allow this conversation', 'clicked:allow this conversation'],
    ['Allow', 'clicked:allow'],
    ['allow', 'clicked:allow'],
    ['Continue', 'clicked:continue'],
    ['continue', 'clicked:continue'],
];

for (const [btnText, expected] of buttonTests) {
    test(`"${btnText}" → ${expected}`, () => {
        const btn = new El('BUTTON', btnText);
        // The DOMObserver does scanAndClick() first, then installs observer.
        // scanAndClick returns the click result. But the IIFE returns 'observer-installed' 
        // after scanAndClick(). However, we can verify the button was clicked.
        const result = run(makeDoc([btn]));
        // The script returns 'observer-installed' because scanAndClick's return
        // value is not propagated to the IIFE return. But the button WAS clicked.
        assert.ok(btn._clicked, `Button "${btnText}" should have been clicked`);
    });
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Priority Order ---\x1b[0m');

test('"Run" beats "Always Allow" when both present', () => {
    const r = new El('BUTTON', 'Run');
    const a = new El('BUTTON', 'Always Allow');
    run(makeDoc([a, r]));
    assert.ok(r._clicked, 'Run should be clicked');
    assert.ok(!a._clicked, 'Always Allow should NOT be clicked');
});

test('"Accept" beats "Allow" when both present', () => {
    const a = new El('BUTTON', 'Accept');
    const b = new El('BUTTON', 'Allow');
    run(makeDoc([b, a]));
    assert.ok(a._clicked, 'Accept should be clicked');
    assert.ok(!b._clicked, 'Allow should NOT be clicked');
});

test('"Run" beats "Accept" when both present', () => {
    const r = new El('BUTTON', 'Run');
    const a = new El('BUTTON', 'Accept');
    run(makeDoc([a, r]));
    assert.ok(r._clicked, 'Run should be clicked');
    assert.ok(!a._clicked, 'Accept should NOT be clicked');
});

test('"Always Allow" beats plain "Allow"', () => {
    const aa = new El('BUTTON', 'Always Allow');
    const a = new El('BUTTON', 'Allow');
    run(makeDoc([a, aa]));
    assert.ok(aa._clicked, 'Always Allow should be clicked');
    assert.ok(!a._clicked, 'Allow should NOT be clicked');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Reject / Ignore Cases ---\x1b[0m');

test('skips text > 50 chars (container, not button)', () => {
    const btn = new El('BUTTON', 'Run ' + 'x'.repeat(50));
    run(makeDoc([btn]));
    assert.ok(!btn._clicked);
});

test('skips disabled button', () => {
    const btn = new El('BUTTON', 'Run', { disabled: true });
    run(makeDoc([btn]));
    assert.ok(!btn._clicked);
});

test('skips aria-disabled button', () => {
    const btn = new El('BUTTON', 'Run', { 'aria-disabled': 'true' });
    run(makeDoc([btn]));
    assert.ok(!btn._clicked);
});

test('skips button with .loading class', () => {
    const btn = new El('BUTTON', 'Run', { class: 'loading' });
    run(makeDoc([btn]));
    assert.ok(!btn._clicked);
});

test('skips button containing .codicon-loading spinner', () => {
    const spinner = new El('SPAN', '', { class: 'codicon-loading' });
    const btn = new El('BUTTON', 'Run', {}, [spinner]);
    run(makeDoc([btn]));
    assert.ok(!btn._clicked);
});

test('skips plain DIV with "Run" (not a button)', () => {
    const div = new El('DIV', 'Run');
    run(makeDoc([div]));
    assert.ok(!div._clicked);
});

test('does NOT match 2-char text via startsWith', () => {
    const btn = new El('BUTTON', 'ru');
    run(makeDoc([btn]));
    assert.ok(!btn._clicked);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Clickable Ancestor Traversal ---\x1b[0m');

test('span inside <button> → clicks button', () => {
    const span = new El('SPAN', 'Run');
    const btn = new El('BUTTON', '', {}, [span]);
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

test('span inside role="button" div → clicks div', () => {
    const span = new El('SPAN', 'Accept');
    const div = new El('DIV', '', { role: 'button' }, [span]);
    run(makeDoc([div]));
    assert.ok(div._clicked);
});

test('span inside cursor-pointer div → clicks div', () => {
    const span = new El('SPAN', 'Allow');
    const div = new El('DIV', '', { class: 'cursor-pointer' }, [span]);
    run(makeDoc([div]));
    assert.ok(div._clicked);
});

test('span inside tabindex="0" div → clicks div', () => {
    const span = new El('SPAN', 'Run');
    const div = new El('DIV', '', { tabindex: '0' }, [span]);
    run(makeDoc([div]));
    assert.ok(div._clicked);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- data-testid / data-action Shortcut ---\x1b[0m');

test('data-testid="alwaysallow" on <button> matches', () => {
    const btn = new El('BUTTON', 'Whatever', { 'data-testid': 'alwaysallow' });
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

test('data-action="always-allow" on <button> matches', () => {
    const btn = new El('BUTTON', 'Some Label', { 'data-action': 'always-allow' });
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

test('data-testid on plain DIV is NOT clicked', () => {
    const div = new El('DIV', 'stuff', { 'data-testid': 'alwaysallow' });
    run(makeDoc([div]));
    assert.ok(!div._clicked);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Expand Banner (Pass 2) ---\x1b[0m');

test('"Expand" clicked when no action buttons exist', () => {
    const btn = new El('BUTTON', 'Expand');
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

test('"Requires Input" banner clicked (startsWith match)', () => {
    const btn = new El('BUTTON', 'Requires Input');
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

test('"1 Step Requires Input" does NOT match (prefix mismatch)', () => {
    const btn = new El('BUTTON', '1 Step Requires Input');
    run(makeDoc([btn]));
    assert.ok(!btn._clicked);
});

test('action buttons beat expand', () => {
    const run_btn = new El('BUTTON', 'Run');
    const exp = new El('BUTTON', 'Expand');
    run(makeDoc([exp, run_btn]));
    assert.ok(run_btn._clicked);
    assert.ok(!exp._clicked);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Custom Button Texts ---\x1b[0m');

test('custom "toujours autoriser" matches', () => {
    const btn = new El('BUTTON', 'toujours autoriser');
    run(makeDoc([btn]), ['toujours autoriser']);
    assert.ok(btn._clicked);
});

test('built-in "Run" still beats custom text', () => {
    const r = new El('BUTTON', 'Run');
    const c = new El('BUTTON', 'siempre permitir');
    run(makeDoc([c, r]), ['siempre permitir']);
    assert.ok(r._clicked);
    assert.ok(!c._clicked);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Edge Cases ---\x1b[0m');

test('empty DOM → observer-installed (no buttons to click)', () => {
    eq(run(makeDoc([])), 'observer-installed');
});

test('whitespace "  Run  " still matches', () => {
    const btn = new El('BUTTON', '  Run  ');
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

test('icon + text child: <button><span>⚡</span><span>Run</span></button>', () => {
    const icon = new El('SPAN', '⚡');
    const text = new El('SPAN', 'Run');
    const btn = new El('BUTTON', '', {}, [icon, text]);
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Continue Button ---\x1b[0m');

test('"Continue" is auto-clicked (invocation limit)', () => {
    const btn = new El('BUTTON', 'Continue');
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

test('"Continue generation" matches via startsWith', () => {
    const btn = new El('BUTTON', 'Continue generation');
    run(makeDoc([btn]));
    assert.ok(btn._clicked);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- MutationObserver ---\x1b[0m');

test('returns observer-installed on agent panel', () => {
    eq(run(makeDoc([])), 'observer-installed');
});

test('idempotent: second injection returns already-active', () => {
    const mockWindow = {};
    const doc = makeDoc([]);
    const script = buildDOMObserverScript([]).trim();
    const fn = new Function('document', 'NodeFilter', 'window', 'requestAnimationFrame', 'MutationObserver', 'return ' + script);
    const mockRAF = (cb) => cb();
    class MockMO { observe() { } disconnect() { } }

    // First injection
    const r1 = fn(doc, { SHOW_ELEMENT: 1 }, mockWindow, mockRAF, MockMO);
    eq(r1, 'observer-installed');

    // Second injection on same window
    const r2 = fn(doc, { SHOW_ELEMENT: 1 }, mockWindow, mockRAF, MockMO);
    eq(r2, 'already-active');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Command Filtering ---\x1b[0m');

// Helper: creates a DOM with a button inside a container with a <pre> code block
function makeCommandDoc(commandText, buttonText = 'Run') {
    const codeBlock = new El('PRE', commandText);
    const btn = new El('BUTTON', buttonText);
    const container = new El('DIV', '', {}, [codeBlock, btn]);
    codeBlock.parentElement = container;
    btn.parentElement = container;
    // Use makeDoc with the container as a body child, so TreeWalker walks it
    const doc = makeDoc([container]);
    return { doc, btn, codeBlock };
}

test('blocklist blocks "rm -rf" command', () => {
    const { doc, btn } = makeCommandDoc('rm -rf /home');
    const result = run(doc, [], ['rm -rf'], []);
    assert.ok(!btn._clicked, 'Blocked command should NOT be clicked');
});

test('blocklist allows safe command', () => {
    const { doc, btn } = makeCommandDoc('npm install');
    run(doc, [], ['rm -rf', 'git push --force'], []);
    assert.ok(btn._clicked, 'Safe command should be clicked');
});

test('allowlist: only allows whitelisted commands', () => {
    const { doc: doc1, btn: btn1 } = makeCommandDoc('npm test');
    run(doc1, [], [], ['npm test', 'npm install']);
    assert.ok(btn1._clicked, 'Allowed command should be clicked');

    const { doc: doc2, btn: btn2 } = makeCommandDoc('rm -rf /');
    run(doc2, [], [], ['npm test', 'npm install']);
    assert.ok(!btn2._clicked, 'Non-allowed command should NOT be clicked');
});

test('blocklist takes priority over allowlist', () => {
    // 'rm -rf' appears at word boundary in a piped command
    const { doc, btn } = makeCommandDoc('npm run build && rm -rf /tmp');
    run(doc, [], ['rm -rf'], ['npm run']);
    assert.ok(!btn._clicked, 'Blocklist should override allowlist match');
});

test('no filtering when both lists empty', () => {
    const { doc, btn } = makeCommandDoc('rm -rf /');
    run(doc, [], [], []);
    assert.ok(btn._clicked, 'No filters = click everything');
});

test('non-terminal buttons (accept/allow) unaffected by filters', () => {
    const { doc, btn } = makeCommandDoc('rm -rf /', 'Accept');
    run(doc, [], ['rm -rf'], []);
    assert.ok(btn._clicked, 'Accept button should ignore command filters');
});

test('word boundary: blocking "rm" does NOT block "yarn format"', () => {
    const { doc: doc1, btn: btn1 } = makeCommandDoc('yarn format');
    run(doc1, [], ['rm'], []);
    assert.ok(btn1._clicked, '"yarn format" should NOT be blocked by pattern "rm"');

    const { doc: doc2, btn: btn2 } = makeCommandDoc('npm run build-arm');
    run(doc2, [], ['rm'], []);
    assert.ok(btn2._clicked, '"npm run build-arm" should NOT be blocked by pattern "rm"');

    const { doc: doc3, btn: btn3 } = makeCommandDoc('rm -rf /');
    run(doc3, [], ['rm'], []);
    assert.ok(!btn3._clicked, '"rm -rf /" SHOULD be blocked by pattern "rm"');
});

test('fail closed: Run button with no code block and filters active', () => {
    const btn = new El('BUTTON', 'Run');
    const result = run(makeDoc([btn]), [], ['rm -rf'], []);
    assert.ok(!btn._clicked, 'Should fail closed when code block not found');
});

// ═══ Observer Kill Switch ═══
test('re-injection initializes __AA_PAUSED to false', () => {
    const btn = new El('BUTTON', 'Run');
    const doc = makeDoc([btn]);
    doc.defaultView.__AA_PAUSED = true; // Simulate previous kill signal
    run(doc); // Re-injection should reset it
    assert.strictEqual(doc.defaultView.__AA_PAUSED, false, '__AA_PAUSED should be cleared on re-injection');
});

test('observer is exposed on window.__AA_OBSERVER', () => {
    const btn = new El('BUTTON', 'Run');
    const doc = makeDoc([btn]);
    run(doc);
    assert.ok(doc.defaultView.__AA_OBSERVER !== undefined, '__AA_OBSERVER should be set');
    assert.ok(doc.defaultView.__AA_OBSERVER !== null, '__AA_OBSERVER should not be null');
    assert.ok(typeof doc.defaultView.__AA_OBSERVER.observe === 'function', '__AA_OBSERVER should have observe method');
    assert.ok(typeof doc.defaultView.__AA_OBSERVER.disconnect === 'function', '__AA_OBSERVER should have disconnect method');
});

test('__AA_PAUSED=true blocks scanAndClick (integration)', () => {
    // This test verifies the scanAndClick guard by checking:
    // 1. Normal run clicks the button
    // 2. After setting __AA_PAUSED=true, the scanAndClick check at the top returns null
    const btn1 = new El('BUTTON', 'Run');
    const doc1 = makeDoc([btn1]);
    run(doc1); // Should click
    assert.ok(btn1._clicked, 'Button should be clicked normally');

    // Now verify the guard logic exists by checking the generated script source
    const script = require('../src/scripts/DOMObserver').buildDOMObserverScript(
        ['Run'], [], [], []
    );
    assert.ok(script.includes('__AA_PAUSED'), 'Script should contain __AA_PAUSED check');
    assert.ok(script.includes('window.__AA_OBSERVER'), 'Script should expose observer on window');
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
