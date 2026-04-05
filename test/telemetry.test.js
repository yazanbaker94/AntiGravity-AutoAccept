/**
 * Telemetry & Analytics Test Suite
 * ─────────────────────────────────
 * Tests the pure logic extracted from extension.js and DashboardProvider.js:
 * delta guard, milestone detection, rank computation, time formatting,
 * dollar calculation, and progress bar math.
 *
 * Run:  node test/telemetry.test.js
 */

const assert = require('assert');

// ─── Test Harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function eq(a, b) { assert.strictEqual(a, b); }

// ─── Constants (mirror from extension.js) ────────────────────────────

const SECONDS_SAVED_PER_CLICK = 3;
const MILESTONES = [100, 500, 1000, 5000, 10000, 50000];
const MILESTONE_RANKS = {
    100: 'Initiate',
    500: 'Apprentice',
    1000: 'Automator',
    5000: 'Time Lord',
    10000: 'Grandmaster',
    50000: 'Ascended'
};

// ─── Functions Under Test ────────────────────────────────────────────

function _computeMilestone(clicks) {
    for (let i = MILESTONES.length - 1; i >= 0; i--) {
        if (clicks >= MILESTONES[i]) return MILESTONES[i];
    }
    return 0;
}

function formatTime(mins) {
    if (mins >= 60) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
    }
    return mins + 'm';
}

function isDeltaValid(delta) {
    return typeof delta === 'number' && !isNaN(delta) && delta > 0;
}

function computeNextMilestone(totalClicks) {
    const nextM = MILESTONES.find(m => m > totalClicks);
    return {
        nextMilestone: nextM || null,
        nextRank: nextM ? MILESTONE_RANKS[nextM] : null
    };
}

function computeProgressBar(clicks, currentMilestone, nextMilestone) {
    if (!nextMilestone) {
        return { pct: 100, display: 'block' }; // Max rank
    }
    const currentBase = currentMilestone || 0;
    const range = nextMilestone - currentBase;
    const progress = clicks - currentBase;
    const pct = range > 0 ? Math.min(100, Math.max(0, Math.round((progress / range) * 100))) : 0;
    return { pct, display: 'block' };
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Delta Guard ---\x1b[0m');

test('rejects NaN', () => eq(isDeltaValid(NaN), false));
test('rejects undefined', () => eq(isDeltaValid(undefined), false));
test('rejects null', () => eq(isDeltaValid(null), false));
test('rejects string "5"', () => eq(isDeltaValid("5"), false));
test('rejects empty string', () => eq(isDeltaValid(""), false));
test('rejects negative number', () => eq(isDeltaValid(-1), false));
test('rejects zero', () => eq(isDeltaValid(0), false));
test('Infinity passes guard (valid number > 0)', () => eq(isDeltaValid(Infinity), true));
test('accepts 1', () => eq(isDeltaValid(1), true));
test('accepts 100', () => eq(isDeltaValid(100), true));
test('accepts 0.5 (float delta)', () => eq(isDeltaValid(0.5), true));

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Milestone Detection (computeMilestone) ---\x1b[0m');

test('0 clicks → milestone 0', () => eq(_computeMilestone(0), 0));
test('50 clicks → milestone 0', () => eq(_computeMilestone(50), 0));
test('99 clicks → milestone 0', () => eq(_computeMilestone(99), 0));
test('100 clicks → milestone 100 (Initiate)', () => eq(_computeMilestone(100), 100));
test('205 clicks → milestone 100', () => eq(_computeMilestone(205), 100));
test('499 clicks → milestone 100', () => eq(_computeMilestone(499), 100));
test('500 clicks → milestone 500 (Apprentice)', () => eq(_computeMilestone(500), 500));
test('999 clicks → milestone 500', () => eq(_computeMilestone(999), 500));
test('1000 clicks → milestone 1000 (Automator)', () => eq(_computeMilestone(1000), 1000));
test('5000 clicks → milestone 5000 (Time Lord)', () => eq(_computeMilestone(5000), 5000));
test('10000 clicks → milestone 10000 (Grandmaster)', () => eq(_computeMilestone(10000), 10000));
test('50000 clicks → milestone 50000 (Ascended)', () => eq(_computeMilestone(50000), 50000));
test('100000 clicks → milestone 50000 (max)', () => eq(_computeMilestone(100000), 50000));

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Rank Lookup ---\x1b[0m');

test('milestone 0 → no rank', () => eq(MILESTONE_RANKS[0] || null, null));
test('milestone 100 → Initiate', () => eq(MILESTONE_RANKS[100], 'Initiate'));
test('milestone 500 → Apprentice', () => eq(MILESTONE_RANKS[500], 'Apprentice'));
test('milestone 1000 → Automator', () => eq(MILESTONE_RANKS[1000], 'Automator'));
test('milestone 5000 → Time Lord', () => eq(MILESTONE_RANKS[5000], 'Time Lord'));
test('milestone 10000 → Grandmaster', () => eq(MILESTONE_RANKS[10000], 'Grandmaster'));
test('milestone 50000 → Ascended', () => eq(MILESTONE_RANKS[50000], 'Ascended'));

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Next Milestone ---\x1b[0m');

test('0 clicks → next is 100/Initiate', () => {
    const { nextMilestone, nextRank } = computeNextMilestone(0);
    eq(nextMilestone, 100);
    eq(nextRank, 'Initiate');
});

test('205 clicks → next is 500/Apprentice', () => {
    const { nextMilestone, nextRank } = computeNextMilestone(205);
    eq(nextMilestone, 500);
    eq(nextRank, 'Apprentice');
});

test('999 clicks → next is 1000/Automator', () => {
    const { nextMilestone, nextRank } = computeNextMilestone(999);
    eq(nextMilestone, 1000);
    eq(nextRank, 'Automator');
});

test('50000 clicks → next is null (max rank)', () => {
    const { nextMilestone, nextRank } = computeNextMilestone(50000);
    eq(nextMilestone, null);
    eq(nextRank, null);
});

test('100000 clicks → next is null (beyond max)', () => {
    const { nextMilestone, nextRank } = computeNextMilestone(100000);
    eq(nextMilestone, null);
    eq(nextRank, null);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Time Formatting ---\x1b[0m');

test('0 → "0m"', () => eq(formatTime(0), '0m'));
test('1 → "1m"', () => eq(formatTime(1), '1m'));
test('30 → "30m"', () => eq(formatTime(30), '30m'));
test('59 → "59m"', () => eq(formatTime(59), '59m'));
test('60 → "1h" (zero-minute drop)', () => eq(formatTime(60), '1h'));
test('61 → "1h 1m"', () => eq(formatTime(61), '1h 1m'));
test('90 → "1h 30m"', () => eq(formatTime(90), '1h 30m'));
test('119 → "1h 59m"', () => eq(formatTime(119), '1h 59m'));
test('120 → "2h" (zero-minute drop)', () => eq(formatTime(120), '2h'));
test('500 → "8h 20m" (Grandmaster-scale)', () => eq(formatTime(500), '8h 20m'));
test('2500 → "41h 40m" (Ascended-scale)', () => eq(formatTime(2500), '41h 40m'));

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Dollar Calculation ---\x1b[0m');

test('10m saved → ~$10', () => {
    const mins = 10;
    eq('~$' + mins.toLocaleString('en-US') + ' value', '~$10 value');
});

test('500m saved → ~$500', () => {
    const mins = 500;
    eq('~$' + mins.toLocaleString('en-US') + ' value', '~$500 value');
});

test('2500m saved → ~$2,500', () => {
    const mins = 2500;
    eq('~$' + mins.toLocaleString('en-US') + ' value', '~$2,500 value');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Progress Bar Math ---\x1b[0m');

test('new user (0 clicks, no milestone) → 0%', () => {
    const { pct } = computeProgressBar(0, undefined, 100);
    eq(pct, 0);
});

test('50 clicks, milestone 0, next 100 → 50%', () => {
    const { pct } = computeProgressBar(50, 0, 100);
    eq(pct, 50);
});

test('205 clicks, milestone 100, next 500 → 26%', () => {
    const { pct } = computeProgressBar(205, 100, 500);
    eq(pct, 26);
});

test('100 clicks, milestone 100, next 500 → 0%', () => {
    const { pct } = computeProgressBar(100, 100, 500);
    eq(pct, 0);
});

test('499 clicks, milestone 100, next 500 → 100%', () => {
    const { pct } = computeProgressBar(499, 100, 500);
    eq(pct, 100);
});

test('max rank (50K+, no next) → 100%', () => {
    const { pct } = computeProgressBar(60000, 50000, null);
    eq(pct, 100);
});

test('NaN protection: undefined currentMilestone → uses 0', () => {
    const { pct } = computeProgressBar(50, undefined, 100);
    eq(pct, 50); // 50/100 = 50%
});

test('clamp: progress can never exceed 100%', () => {
    const { pct } = computeProgressBar(600, 100, 500);
    eq(pct, 100);
});

test('clamp: progress can never go below 0%', () => {
    const { pct } = computeProgressBar(50, 100, 500);
    eq(pct, 0);
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Milestone Crossing Detection ---\x1b[0m');

test('crossing 100: prev=99, new=100 triggers Initiate', () => {
    const prev = 99, newTotal = 100;
    let triggered = null;
    for (let i = MILESTONES.length - 1; i >= 0; i--) {
        const m = MILESTONES[i];
        if (prev < m && newTotal >= m) { triggered = m; break; }
    }
    eq(triggered, 100);
    eq(MILESTONE_RANKS[triggered], 'Initiate');
});

test('crossing 500: prev=499, new=500 triggers Apprentice', () => {
    const prev = 499, newTotal = 500;
    let triggered = null;
    for (let i = MILESTONES.length - 1; i >= 0; i--) {
        const m = MILESTONES[i];
        if (prev < m && newTotal >= m) { triggered = m; break; }
    }
    eq(triggered, 500);
});

test('leap: prev=50, new=600 triggers highest crossed (500)', () => {
    const prev = 50, newTotal = 600;
    let triggered = null;
    for (let i = MILESTONES.length - 1; i >= 0; i--) {
        const m = MILESTONES[i];
        if (prev < m && newTotal >= m) { triggered = m; break; }
    }
    eq(triggered, 500);
    eq(MILESTONE_RANKS[triggered], 'Apprentice');
});

test('no crossing: prev=150, new=200 triggers nothing', () => {
    const prev = 150, newTotal = 200;
    let triggered = null;
    for (let i = MILESTONES.length - 1; i >= 0; i--) {
        const m = MILESTONES[i];
        if (prev < m && newTotal >= m) { triggered = m; break; }
    }
    eq(triggered, null);
});

test('crossing Ascended: prev=49999, new=50000', () => {
    const prev = 49999, newTotal = 50000;
    let triggered = null;
    for (let i = MILESTONES.length - 1; i >= 0; i--) {
        const m = MILESTONES[i];
        if (prev < m && newTotal >= m) { triggered = m; break; }
    }
    eq(triggered, 50000);
    eq(MILESTONE_RANKS[triggered], 'Ascended');
});

// ═════════════════════════════════════════════════════════════════════
console.log('\n\x1b[1m--- Notification String Format ---\x1b[0m');

test('notification at 500 clicks', () => {
    const m = 500;
    const rank = MILESTONE_RANKS[m];
    const minsSaved = Math.round((500 * SECONDS_SAVED_PER_CLICK) / 60);
    const dollarsSaved = minsSaved;
    const hh = Math.floor(minsSaved / 60);
    const mm = minsSaved % 60;
    const timeStr = minsSaved >= 60 ? (mm === 0 ? hh + 'h' : hh + 'h ' + mm + 'm') : minsSaved + ' mins';

    const msg = `🏆 ${rank}! You have auto-accepted ${m.toLocaleString()} times, saving ${timeStr} (~$${dollarsSaved}) of manual effort.`;
    assert.ok(msg.includes('Apprentice'), 'should mention rank');
    assert.ok(msg.includes('500'), 'should mention clicks');
    assert.ok(msg.includes('25'), 'should mention dollars');
    assert.ok(msg.includes('~$'), 'should have dollar sign');
});

test('notification time format at 10000 clicks (exact hour)', () => {
    const minsSaved = Math.round((10000 * SECONDS_SAVED_PER_CLICK) / 60); // 500m
    const hh = Math.floor(minsSaved / 60);
    const mm = minsSaved % 60;
    const timeStr = minsSaved >= 60 ? (mm === 0 ? hh + 'h' : hh + 'h ' + mm + 'm') : minsSaved + ' mins';
    eq(timeStr, '8h 20m');
});

// ═════════════════════════════════════════════════════════════════════
// Print summary
console.log(`\n${'═'.repeat(50)}`);
console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[${fail ? '31' : '32'}m${fail} failed\x1b[0m, ${pass + fail} total`);

if (fails.length) {
    console.log('\n  Failures:');
    fails.forEach(f => console.log(`   • ${f}`));
}
console.log('');
process.exit(fail ? 1 : 0);
