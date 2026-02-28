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

function run(doc, custom = []) {
    const script = buildDOMObserverScript(custom).trim();
    // The script is an IIFE: (function(){ ... })()
    // We need to add 'return' before it for new Function()
    const fn = new Function('document', 'NodeFilter', 'window', 'requestAnimationFrame', 'MutationObserver', 'return ' + script);

    // Mock window, requestAnimationFrame, and MutationObserver
    const mockWindow = {};
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
console.log(`\n${'═'.repeat(50)}`);
console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[${fail ? '31' : '32'}m${fail} failed\x1b[0m, ${pass + fail} total`);
if (fails.length) {
    console.log('\n  Failures:');
    fails.forEach(f => console.log(`   • ${f}`));
}
console.log('');
process.exit(fail ? 1 : 0);
