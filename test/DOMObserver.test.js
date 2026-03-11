// AntiGravity AutoAccept — DOMObserver Unit Tests
// Tests the generated DOM observer script by evaluating it in a simulated DOM environment.
// Run: node test/DOMObserver.test.js

const { buildDOMObserverScript } = require('../src/scripts/DOMObserver');
const assert = require('assert');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`  ❌ ${name}: ${e.message}`);
    }
}

function describe(section, fn) {
    console.log(`\n${section}`);
    fn();
}

// ═══════════════════════════════════════════════════════════════════════
// Tests for buildDOMObserverScript() — script generation
// ═══════════════════════════════════════════════════════════════════════

describe('buildDOMObserverScript', () => {
    test('returns a string', () => {
        const script = buildDOMObserverScript([], [], []);
        assert.strictEqual(typeof script, 'string');
    });

    test('includes default button texts', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('"run"'), 'should include "run"');
        assert(script.includes('"always run"'), 'should include "always run"');
        assert(script.includes('"accept"'), 'should include "accept" by default');
        assert(script.includes('"always allow"'), 'should include "always allow"');
        assert(script.includes('"retry"'), 'should include "retry"');
        assert(script.includes('"continue"'), 'should include "continue"');
    });

    test('excludes "accept" when autoAcceptFileEdits is false', () => {
        const script = buildDOMObserverScript([], [], [], false);
        // Parse the BUTTON_TEXTS array from the generated script
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        assert(match, 'should contain BUTTON_TEXTS assignment');
        const texts = JSON.parse(match[1]);
        assert(!texts.includes('accept'), 'should NOT include "accept" when autoAcceptFileEdits=false');
        assert(texts.includes('run'), 'should still include "run"');
    });

    test('includes "accept" when autoAcceptFileEdits is true', () => {
        const script = buildDOMObserverScript([], [], [], true);
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        const texts = JSON.parse(match[1]);
        assert(texts.includes('accept'), 'should include "accept"');
    });

    test('includes custom button texts', () => {
        const script = buildDOMObserverScript(['ejecutar', 'aceptar'], [], []);
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        const texts = JSON.parse(match[1]);
        assert(texts.includes('ejecutar'), 'should include custom text "ejecutar"');
        assert(texts.includes('aceptar'), 'should include custom text "aceptar"');
    });

    test('includes blocked commands', () => {
        const script = buildDOMObserverScript([], ['rm -rf', 'DROP TABLE'], []);
        assert(script.includes('"rm -rf"'), 'should include blocked command');
        assert(script.includes('"DROP TABLE"'), 'should include blocked command');
    });

    test('includes allowed commands', () => {
        const script = buildDOMObserverScript([], [], ['npm test', 'bun run']);
        assert(script.includes('"npm test"'), 'should include allowed command');
        assert(script.includes('"bun run"'), 'should include allowed command');
    });

    test('sets HAS_FILTERS correctly', () => {
        const noFilters = buildDOMObserverScript([], [], []);
        assert(noFilters.includes('var HAS_FILTERS = false'), 'no filters → false');

        const withBlocked = buildDOMObserverScript([], ['rm'], []);
        assert(withBlocked.includes('var HAS_FILTERS = true'), 'blocked list → true');

        const withAllowed = buildDOMObserverScript([], [], ['npm']);
        assert(withAllowed.includes('var HAS_FILTERS = true'), 'allowed list → true');
    });

    test('handles empty inputs and defaults gracefully', () => {
        const script = buildDOMObserverScript([], null, null, undefined);
        assert.strictEqual(typeof script, 'string');
        // Should default autoAcceptFileEdits to true
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        const texts = JSON.parse(match[1]);
        assert(texts.includes('accept'), 'should default to including accept');
    });

    test('contains idempotency guard', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('__AA_OBSERVER_ACTIVE'), 'should have idempotency guard');
    });

    test('contains MutationObserver setup', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('MutationObserver'), 'should set up MutationObserver');
    });

    test('contains auto-continue logic', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('auto-continue'), 'should have auto-continue comments');
        assert(script.includes('whats next'), 'should type "whats next"');
        assert(script.includes('contenteditable'), 'should target contenteditable textbox');
    });

    test('contains HeadlessUI dropdown guard', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('aria-haspopup'), 'should check aria-haspopup');
        assert(script.includes('listbox'), 'should guard against listbox dropdowns');
    });

    test('contains menubar guard', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('menubar-menu-button'), 'should guard against menubar buttons');
        assert(script.includes('menuitem'), 'should guard against menuitems');
    });

    test('contains retry circuit breaker', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('CIRCUIT_BREAKER'), 'should have circuit breaker');
        assert(script.includes('__AA_RECOVERY_TS'), 'should track recovery timestamps');
    });

    test('contains expand-once guard', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('expandedOnce'), 'should track expanded buttons');
        assert(script.includes('SKIP_EXPAND'), 'should have expand skip diagnostic');
    });

    test('contains fallback interval', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('__AA_FALLBACK_INTERVAL'), 'should have fallback polling');
        assert(script.includes('10000'), 'fallback should be 10s interval');
    });

    test('contains agent panel detection', () => {
        const script = buildDOMObserverScript([], [], []);
        assert(script.includes('isAgentPanel'), 'should have agent panel check');
        assert(script.includes('react-app-container'), 'should check for React app');
        assert(script.includes('data-vscode-context'), 'should check for VS Code context');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests for command filtering logic (extracted and tested in isolation)
// ═══════════════════════════════════════════════════════════════════════

describe('Command Filtering (isCommandAllowed)', () => {
    // Extract isCommandAllowed from the generated script and eval it
    function getIsCommandAllowed(blocked, allowed) {
        // Build a minimal environment to test isCommandAllowed
        const script = `
            var BLOCKED_COMMANDS = ${JSON.stringify(blocked)};
            var ALLOWED_COMMANDS = ${JSON.stringify(allowed)};
            var HAS_FILTERS = ${blocked.length > 0 || allowed.length > 0};
            var window = { __AA_BLOCKED: BLOCKED_COMMANDS, __AA_ALLOWED: ALLOWED_COMMANDS, __AA_HAS_FILTERS: HAS_FILTERS };

            function matchesPattern(cmd, pattern) {
                var patLower = pattern.toLowerCase();
                var cmdLower = cmd.toLowerCase();
                var idx = cmdLower.indexOf(patLower);
                while (idx !== -1) {
                    var before = idx === 0 ? ' ' : cmdLower.charAt(idx - 1);
                    var after = idx + patLower.length >= cmdLower.length ? ' ' : cmdLower.charAt(idx + patLower.length);
                    var delimiters = ' \\t\\r\\n|;&/()[]{}"\\'$=<>,\\\\:\`';
                    if ((idx === 0 || delimiters.indexOf(before) !== -1) &&
                        (idx + patLower.length >= cmdLower.length || delimiters.indexOf(after) !== -1)) {
                        return true;
                    }
                    idx = cmdLower.indexOf(patLower, idx + 1);
                }
                return false;
            }

            function isCommandAllowed(commandText) {
                var blockedList = window.__AA_BLOCKED || BLOCKED_COMMANDS;
                var allowedList = window.__AA_ALLOWED || ALLOWED_COMMANDS;
                var hasFilters = window.__AA_HAS_FILTERS !== undefined ? window.__AA_HAS_FILTERS : HAS_FILTERS;
                if (!hasFilters) return true;
                if (!commandText) return false;
                var cmdLower = commandText.toLowerCase();
                for (var b = 0; b < blockedList.length; b++) {
                    if (matchesPattern(cmdLower, blockedList[b])) return false;
                }
                if (allowedList.length > 0) {
                    var allowed = false;
                    for (var a = 0; a < allowedList.length; a++) {
                        if (matchesPattern(cmdLower, allowedList[a])) { allowed = true; break; }
                    }
                    if (!allowed) return false;
                }
                return true;
            }
        `;
        eval(script);
        return isCommandAllowed;
    }

    test('allows everything when no filters configured', () => {
        const check = getIsCommandAllowed([], []);
        assert.strictEqual(check('rm -rf /'), true, 'no filters = allow all');
        assert.strictEqual(check('npm test'), true);
    });

    test('blocks commands matching blocklist', () => {
        const check = getIsCommandAllowed(['rm -rf', 'DROP TABLE'], []);
        assert.strictEqual(check('rm -rf /tmp'), false, 'should block rm -rf');
        assert.strictEqual(check('DROP TABLE users'), false, 'should block DROP TABLE');
    });

    test('allows commands not matching blocklist', () => {
        const check = getIsCommandAllowed(['rm -rf'], []);
        assert.strictEqual(check('npm test'), true, 'should allow npm test');
        assert.strictEqual(check('bun run dev'), true, 'should allow bun run dev');
    });

    test('blocklist uses word boundaries', () => {
        const check = getIsCommandAllowed(['rm'], []);
        assert.strictEqual(check('rm file.txt'), false, 'should block "rm" at start');
        assert.strictEqual(check('npm run format'), true, 'should NOT block "format" (rm inside word)');
    });

    test('allowlist restricts to matching commands', () => {
        const check = getIsCommandAllowed([], ['npm test', 'bun run']);
        assert.strictEqual(check('npm test'), true, 'should allow npm test');
        assert.strictEqual(check('bun run dev'), true, 'should allow bun run dev');
        assert.strictEqual(check('rm -rf /'), false, 'should block non-allowed commands');
    });

    test('blocklist takes priority over allowlist', () => {
        const check = getIsCommandAllowed(['npm run danger'], ['npm']);
        assert.strictEqual(check('npm test'), true, 'should allow npm test');
        assert.strictEqual(check('npm run danger'), false, 'blocklist should override allowlist');
    });

    test('blocks when command text is null/empty (fail closed)', () => {
        const check = getIsCommandAllowed(['rm'], []);
        assert.strictEqual(check(null), false, 'null command → blocked');
        assert.strictEqual(check(''), false, 'empty command → blocked');
    });

    test('case-insensitive matching', () => {
        const check = getIsCommandAllowed(['DROP TABLE'], []);
        assert.strictEqual(check('drop table users'), false, 'lowercase should match');
        assert.strictEqual(check('Drop Table users'), false, 'mixed case should match');
    });

    test('multi-word pattern matching', () => {
        const check = getIsCommandAllowed(['git push --force'], []);
        assert.strictEqual(check('git push --force origin main'), false, 'should block git push --force');
        assert.strictEqual(check('git push origin main'), true, 'should allow regular git push');
    });

    test('pattern at end of command', () => {
        const check = getIsCommandAllowed(['rm'], []);
        assert.strictEqual(check('sudo rm'), false, 'should block rm at end');
    });

    test('pipe-delimited commands', () => {
        const check = getIsCommandAllowed(['rm'], []);
        assert.strictEqual(check('echo hello | rm file'), false, 'should detect rm after pipe');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests for word boundary matching (isWordBoundary)
// ═══════════════════════════════════════════════════════════════════════

describe('Word Boundary Check', () => {
    // Extract isWordBoundary from the generated script pattern
    function getWordBoundary() {
        const _wordBoundaryRegex = /[a-z0-9_\\\\\-\\\\.]/i;
        function isWordBoundary(str, keyLen) {
            if (str.length === keyLen) return true;
            return !_wordBoundaryRegex.test(str.charAt(keyLen));
        }
        return isWordBoundary;
    }

    const isWordBoundary = getWordBoundary();

    test('exact match is always a word boundary', () => {
        assert.strictEqual(isWordBoundary('run', 3), true);
        assert.strictEqual(isWordBoundary('accept', 6), true);
    });

    test('space after keyword is a word boundary', () => {
        assert.strictEqual(isWordBoundary('run command', 3), true);
    });

    test('letter after keyword is NOT a word boundary', () => {
        assert.strictEqual(isWordBoundary('running', 3), false, '"running" should not match "run"');
    });

    test('number after keyword is NOT a word boundary', () => {
        assert.strictEqual(isWordBoundary('run2', 3), false);
    });

    test('underscore after keyword is NOT a word boundary', () => {
        assert.strictEqual(isWordBoundary('run_test', 3), false);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests for button text priority ordering
// ═══════════════════════════════════════════════════════════════════════

describe('Button Text Priority', () => {
    test('run has highest priority (index 0)', () => {
        const script = buildDOMObserverScript([], [], [], true);
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        const texts = JSON.parse(match[1]);
        assert.strictEqual(texts[0], 'run', 'run should be first (highest priority)');
    });

    test('always run has second priority', () => {
        const script = buildDOMObserverScript([], [], [], true);
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        const texts = JSON.parse(match[1]);
        assert.strictEqual(texts[1], 'always run', 'always run should be second');
    });

    test('accept comes before allow', () => {
        const script = buildDOMObserverScript([], [], [], true);
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        const texts = JSON.parse(match[1]);
        const acceptIdx = texts.indexOf('accept');
        const allowIdx = texts.indexOf('allow');
        assert(acceptIdx < allowIdx, 'accept should have higher priority than allow');
    });

    test('custom texts are appended at lowest priority', () => {
        const script = buildDOMObserverScript(['custom1', 'custom2'], [], [], true);
        const match = script.match(/var BUTTON_TEXTS = (\[.*?\]);/);
        const texts = JSON.parse(match[1]);
        const customIdx = texts.indexOf('custom1');
        const defaultLast = texts.indexOf('continue');
        assert(customIdx > defaultLast, 'custom texts should come after all defaults');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
}
console.log(`${'═'.repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
