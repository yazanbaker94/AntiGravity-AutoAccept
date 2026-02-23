/**
 * Permission Engine Test Suite
 * ─────────────────────────────
 * Exercises the button-matching logic from buildPermissionScript().
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
// Extract buildPermissionScript from extension.js and run it in our mock.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function findBrace(s, i) {
    let d = 0;
    for (; i < s.length; i++) {
        if (s[i] === '{') d++;
        if (s[i] === '}') { d--; if (d === 0) return i; }
    }
    return -1;
}

const fnStart = src.indexOf('function buildPermissionScript(customTexts)');
const fnEnd = findBrace(src, src.indexOf('{', fnStart));
const buildPermissionScript = new Function('return ' + src.slice(fnStart, fnEnd + 1))();

function run(doc, custom = [], canExpand = true) {
    const script = buildPermissionScript(custom).trim();
    // The script is an IIFE: (function(){ ... return 'xxx'; })()
    // Wrapping in new Function() creates another scope, so we need 'return' before the IIFE
    const fn = new Function('document', 'NodeFilter', 'CAN_EXPAND', 'return ' + script);
    return fn(doc, { SHOW_ELEMENT: 1 }, canExpand);
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

test('blocks non-agent-panel windows', () => {
    eq(run(makeDoc([], false)), 'not-agent-panel');
});

test('allows agent panel (returns no-permission-button when empty)', () => {
    eq(run(makeDoc([])), 'no-permission-button');
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
];

for (const [btnText, expected] of buttonTests) {
    test(`"${btnText}" → ${expected}`, () => {
        const btn = new El('BUTTON', btnText);
        eq(run(makeDoc([btn])), expected);
    });
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Priority Order ---\x1b[0m');

test('"Run" beats "Always Allow" when both present', () => {
    const r = new El('BUTTON', 'Run');
    const a = new El('BUTTON', 'Always Allow');
    eq(run(makeDoc([a, r])), 'clicked:run');
});

test('"Accept" beats "Allow" when both present', () => {
    const a = new El('BUTTON', 'Accept');
    const b = new El('BUTTON', 'Allow');
    eq(run(makeDoc([b, a])), 'clicked:accept');
});

test('"Run" beats "Accept" when both present', () => {
    const r = new El('BUTTON', 'Run');
    const a = new El('BUTTON', 'Accept');
    eq(run(makeDoc([a, r])), 'clicked:run');
});

test('"Always Allow" beats plain "Allow"', () => {
    const aa = new El('BUTTON', 'Always Allow');
    const a = new El('BUTTON', 'Allow');
    eq(run(makeDoc([a, aa])), 'clicked:always allow');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Reject / Ignore Cases ---\x1b[0m');

test('skips text > 50 chars (container, not button)', () => {
    const btn = new El('BUTTON', 'Run ' + 'x'.repeat(50));
    eq(run(makeDoc([btn])), 'no-permission-button');
});

test('skips disabled button', () => {
    const btn = new El('BUTTON', 'Run', { disabled: true });
    eq(run(makeDoc([btn])), 'no-permission-button');
});

test('skips aria-disabled button', () => {
    const btn = new El('BUTTON', 'Run', { 'aria-disabled': 'true' });
    eq(run(makeDoc([btn])), 'no-permission-button');
});

test('skips button with .loading class', () => {
    const btn = new El('BUTTON', 'Run', { class: 'loading' });
    eq(run(makeDoc([btn])), 'no-permission-button');
});

test('skips button containing .codicon-loading spinner', () => {
    const spinner = new El('SPAN', '', { class: 'codicon-loading' });
    const btn = new El('BUTTON', 'Run', {}, [spinner]);
    eq(run(makeDoc([btn])), 'no-permission-button');
});

test('skips plain DIV with "Run" (not a button)', () => {
    const div = new El('DIV', 'Run');
    eq(run(makeDoc([div])), 'no-permission-button');
});

test('does NOT match 2-char text via startsWith', () => {
    const btn = new El('BUTTON', 'ru');
    eq(run(makeDoc([btn])), 'no-permission-button');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Clickable Ancestor Traversal ---\x1b[0m');

test('span inside <button> → clicks button', () => {
    const span = new El('SPAN', 'Run');
    const btn = new El('BUTTON', '', {}, [span]);
    eq(run(makeDoc([btn])), 'clicked:run');
});

test('span inside role="button" div → clicks div', () => {
    const span = new El('SPAN', 'Accept');
    const div = new El('DIV', '', { role: 'button' }, [span]);
    eq(run(makeDoc([div])), 'clicked:accept');
});

test('span inside cursor-pointer div → clicks div', () => {
    const span = new El('SPAN', 'Allow');
    const div = new El('DIV', '', { class: 'cursor-pointer' }, [span]);
    eq(run(makeDoc([div])), 'clicked:allow');
});

test('span inside tabindex="0" div → clicks div', () => {
    const span = new El('SPAN', 'Run');
    const div = new El('DIV', '', { tabindex: '0' }, [span]);
    eq(run(makeDoc([div])), 'clicked:run');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- data-testid / data-action Shortcut ---\x1b[0m');

test('data-testid="alwaysallow" on <button> matches', () => {
    const btn = new El('BUTTON', 'Whatever', { 'data-testid': 'alwaysallow' });
    const result = run(makeDoc([btn]));
    // Should be clicked via the data-testid shortcut path
    assert.ok(result.startsWith('clicked:'));
});

test('data-action="always-allow" on <button> matches', () => {
    const btn = new El('BUTTON', 'Some Label', { 'data-action': 'always-allow' });
    const result = run(makeDoc([btn]));
    assert.ok(result.startsWith('clicked:'));
});

test('data-testid on plain DIV is NOT clicked', () => {
    const div = new El('DIV', 'stuff', { 'data-testid': 'alwaysallow' });
    eq(run(makeDoc([div])), 'no-permission-button');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Expand Banner (Pass 2) ---\x1b[0m');

test('"Expand" clicked when no action buttons exist', () => {
    const btn = new El('BUTTON', 'Expand');
    eq(run(makeDoc([btn])), 'clicked:expand');
});

test('"Requires Input" banner clicked (startsWith match)', () => {
    const btn = new El('BUTTON', 'Requires Input');
    eq(run(makeDoc([btn])), 'clicked:requires input');
});

test('"1 Step Requires Input" clicked (includes match)', () => {
    const btn = new El('BUTTON', '1 Step Requires Input');
    eq(run(makeDoc([btn])), 'clicked:requires input');
});

test('expand skipped when CAN_EXPAND=false', () => {
    const btn = new El('BUTTON', 'Expand');
    eq(run(makeDoc([btn]), [], false), 'no-permission-button');
});

test('action buttons beat expand', () => {
    const run_btn = new El('BUTTON', 'Run');
    const exp = new El('BUTTON', 'Expand');
    eq(run(makeDoc([exp, run_btn])), 'clicked:run');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Custom Button Texts ---\x1b[0m');

test('custom "toujours autoriser" matches', () => {
    const btn = new El('BUTTON', 'toujours autoriser');
    eq(run(makeDoc([btn]), ['toujours autoriser']), 'clicked:toujours autoriser');
});

test('built-in "Run" still beats custom text', () => {
    const r = new El('BUTTON', 'Run');
    const c = new El('BUTTON', 'siempre permitir');
    eq(run(makeDoc([c, r]), ['siempre permitir']), 'clicked:run');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Edge Cases ---\x1b[0m');

test('empty DOM → no-permission-button', () => {
    eq(run(makeDoc([])), 'no-permission-button');
});

test('whitespace "  Run  " still matches', () => {
    const btn = new El('BUTTON', '  Run  ');
    eq(run(makeDoc([btn])), 'clicked:run');
});

test('icon + text child: <button><span>⚡</span><span>Run</span></button>', () => {
    const icon = new El('SPAN', '⚡');
    const text = new El('SPAN', 'Run');
    const btn = new El('BUTTON', '', {}, [icon, text]);
    // The walker hits the SPAN "Run" → closestClickable walks up to BUTTON
    eq(run(makeDoc([btn])), 'clicked:run');
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
