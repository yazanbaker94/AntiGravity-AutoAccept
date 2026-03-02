// AntiGravity AutoAccept — DOM Observer Payload
// Generates a self-contained script injected ONCE per CDP session.
// Uses MutationObserver for zero-polling, event-driven button clicking.
// All cooldown state is localized to DOM data-attributes — no Node.js globals.

/**
 * Generates the MutationObserver-based DOM clicker script.
 * @param {string[]} customTexts - Additional button texts from user config
 * @param {string[]} blockedCommands - Command patterns to never auto-run
 * @param {string[]} allowedCommands - If non-empty, only auto-run matching patterns
 * @param {boolean} [autoAcceptFileEdits=true] - Whether to auto-accept file edit buttons
 * @returns {string} JavaScript source to evaluate via CDP Runtime.evaluate
 */
function buildDOMObserverScript(customTexts, blockedCommands, allowedCommands, autoAcceptFileEdits) {
    blockedCommands = blockedCommands || [];
    allowedCommands = allowedCommands || [];
    if (autoAcceptFileEdits === undefined) autoAcceptFileEdits = true;

    const allTexts = [
        'run',  // Primary action button
        ...(autoAcceptFileEdits ? ['accept'] : []),  // Only include 'accept' when file edits are enabled
        'always allow', 'allow this conversation', 'allow',
        'retry', 'continue',
        ...customTexts
    ];
    const expandTexts = ['expand', 'requires input'];

    return `
(function() {
    // ═══ IDEMPOTENCY GUARD ═══
    // Prevents double-injection if the script is evaluated again on the same context.
    if (window.__AA_OBSERVER_ACTIVE) return 'already-active';
    window.__AA_OBSERVER_ACTIVE = true;

    // ═══ WEBVIEW GUARD (deferred) ═══
    // Moved inside scanAndClick() to avoid race condition:
    // On Target.targetCreated / executionContextsCleared, the DOM may be
    // unhydrated (empty). Checking synchronously here would falsely reject
    // valid agent panels. Instead, we install the observer unconditionally
    // and check the DOM structure dynamically on each scan.
    function isAgentPanel() {
        return !!(document.querySelector('.react-app-container') ||
            document.querySelector('[class*="agent"]') ||
            document.querySelector('[data-vscode-context]'));
    }

    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};
    var EXPAND_TEXTS = ${JSON.stringify(expandTexts)};
    var BLOCKED_COMMANDS = ${JSON.stringify(blockedCommands)};
    var ALLOWED_COMMANDS = ${JSON.stringify(allowedCommands)};
    var HAS_FILTERS = BLOCKED_COMMANDS.length > 0 || ALLOWED_COMMANDS.length > 0;

    // Self-healing injection: if a previous observer exists (e.g. Extension Host
    // crashed and re-injected without calling stop()), disconnect it first.
    // This guarantees at most ONE active AutoAccept observer per page.
    if (window.__AA_OBSERVER) {
        window.__AA_OBSERVER.disconnect();
        window.__AA_OBSERVER = null;
    }

    // Expose filter state as window globals for hot-reload via Runtime.evaluate.
    // pushFilterUpdate() in ConnectionManager overwrites these without re-injecting
    // the full script (which would create duplicate MutationObservers).
    window.__AA_BLOCKED = BLOCKED_COMMANDS;
    window.__AA_ALLOWED = ALLOWED_COMMANDS;
    window.__AA_HAS_FILTERS = HAS_FILTERS;
    window.__AA_PAUSED = false; // Kill switch: set to true to stop all clicking

    var COOLDOWN_MS = 5000;
    var EXPAND_COOLDOWN_MS = 30000; // 30s global cooldown for expand buttons
    var clickCooldowns = {};
    var lastExpandClickTime = 0;    // Global expand timestamp — survives React re-renders
    var expandClickedTexts = {};    // Tracks expand buttons by text signature — permanent dedup

    // Lightweight DOM path: walks up to 3 ancestors to create a structurally unique key.
    // Differentiates multiple "Accept" buttons in different DOM subtrees.
    function _domPath(el) {
        // Iterates 4 levels starting from el itself (not just ancestors).
        // Includes sibling index (nth-child equivalent) at every level,
        // ensuring unique paths even for direct sibling buttons.
        var parts = [];
        var curr = el;
        for (var i = 0; i < 4 && curr && curr !== document.body; i++) {
            var idx = 0;
            var child = curr.parentElement ? curr.parentElement.firstElementChild : null;
            while (child) {
                if (child === curr) break;
                idx++;
                child = child.nextElementSibling;
            }
            parts.unshift((curr.tagName || '') + '[' + idx + ']');
            curr = curr.parentElement;
        }
        return parts.join('/');
    }

    function closestClickable(node) {
        var el = node;
        while (el && el !== document.body) {
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || tag.includes('button') || tag.includes('btn') ||
                el.getAttribute('role') === 'button' || el.classList.contains('cursor-pointer') ||
                el.onclick || el.getAttribute('tabindex') === '0') {
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }

    // ═══ WORD BOUNDARY CHECK (module scope — avoids per-iteration allocation) ═══
    // Prevents filename false-positives: "accept-test.js" should NOT match "accept".
    var _wordBoundaryRegex = /[a-z0-9_\\-\\.]/i;
    function isWordBoundary(str, keyLen) {
        if (str.length === keyLen) return true;
        return !_wordBoundaryRegex.test(str.charAt(keyLen));
    }

    // ═══ SINGLE-PASS BUTTON SCANNER ═══
    // Walks the DOM tree exactly ONCE and checks every node against ALL keywords.
    // Returns { node: clickableElement, matchedText: keyword, priority: index } or null.
    // Tracks the BEST match by keyword priority (lowest index = highest priority).
    // O(D) complexity instead of O(N×D) — fixes Issue #19 performance freezes.
    function findButton(root, texts) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var wNode;
        var best = null; // { node, matchedText, priority }
        while ((wNode = walker.nextNode())) {
            if (wNode.shadowRoot) {
                var result = findButton(wNode.shadowRoot, texts);
                if (result && (best === null || result.priority < best.priority)) {
                    best = result;
                    if (best.priority === 0) return best; // Can't do better
                }
            }
            // data-testid / data-action shortcut for allow buttons
            var testId = (wNode.getAttribute('data-testid') || wNode.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                var tag1 = (wNode.tagName || '').toLowerCase();
                if (tag1 === 'button' || tag1.includes('button') || wNode.getAttribute('role') === 'button' || tag1.includes('btn')) {
                    // Find priority of 'allow' in texts array
                    var allowIdx = texts.indexOf('allow');
                    if (allowIdx === -1) allowIdx = texts.length;
                    if (best === null || allowIdx < best.priority) {
                        best = { node: wNode, matchedText: 'allow', priority: allowIdx };
                        if (best.priority === 0) return best;
                    }
                    continue;
                }
            }
            var nodeText = (wNode.textContent || '').trim().toLowerCase();
            if (nodeText.length > 50) continue;

            // Check this node against ALL keywords in a single iteration
            for (var t = 0; t < texts.length; t++) {
                // Skip keywords lower priority than current best
                if (best !== null && t >= best.priority) break;
                var text = texts[t];
                var isMatch = nodeText === text ||
                    (text.length >= 5 && nodeText.startsWith(text) && isWordBoundary(nodeText, text.length) && nodeText.length <= text.length * 3) ||
                    (nodeText.startsWith(text + ' ') && nodeText.length <= text.length * 5);
                if (!isMatch) continue;

                var clickable = closestClickable(wNode);
                var tag2 = (clickable.tagName || '').toLowerCase();
                if (tag2 === 'button' || tag2.includes('button') || clickable.getAttribute('role') === 'button' ||
                    tag2.includes('btn') || clickable.classList.contains('cursor-pointer') ||
                    clickable.onclick || clickable.getAttribute('tabindex') === '0') {
                    // Idempotency guard: skip disabled/loading buttons
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                        clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading')) {
                        continue;
                    }
                    // Expand dedup: TWO layers of protection.
                    // Layer 1: global timestamp cooldown (30s) for ALL expand clicks.
                    // Layer 2: text-signature dedup — same text is NEVER clicked twice.
                    // Both survive React re-renders (JS variables, not DOM attributes).
                    var isExpandType = (text === 'expand' || text === 'requires input');
                    if (isExpandType) {
                        // Layer 1: global timestamp
                        if (lastExpandClickTime && (Date.now() - lastExpandClickTime < EXPAND_COOLDOWN_MS)) {
                            continue;
                        }
                        // Layer 2: text signature dedup
                        var expandSig = (clickable.textContent || '').trim().toLowerCase().substring(0, 60);
                        if (expandClickedTexts[expandSig]) {
                            continue;
                        }
                    }
                    var btnKey = _domPath(clickable) + ':' + (clickable.textContent || '').trim().toLowerCase().substring(0, 30);
                    var cooldown = isExpandType ? EXPAND_COOLDOWN_MS : COOLDOWN_MS;
                    var lastClick = clickCooldowns[btnKey] || 0;
                    if (lastClick && (Date.now() - lastClick < cooldown)) {
                        continue;
                    }
                    best = { node: clickable, matchedText: text, priority: t };
                    if (t === 0) return best; // Priority 0 — can't do better
                    break; // Found match for this node, move to next node
                }
            }
        }
        return best;
    }

    // ═══ COOLDOWN PRUNING ═══
    var lastPrune = Date.now();
    var PRUNE_INTERVAL_MS = 30000;

    function pruneCooldowns() {
        var now = Date.now();
        if (now - lastPrune < PRUNE_INTERVAL_MS) return;
        lastPrune = now;
        var maxAge = EXPAND_COOLDOWN_MS * 2;
        var keys = Object.keys(clickCooldowns);
        for (var i = 0; i < keys.length; i++) {
            if (now - clickCooldowns[keys[i]] > maxAge) {
                delete clickCooldowns[keys[i]];
            }
        }
    }

    // ═══ COMMAND FILTERING ═══
    var TERMINAL_BUTTON_TEXTS = ['run'];

    /**
     * Walks up the DOM from a button to find the nearest command preview.
     */
    function extractCommandText(btn) {
        try {
            var el = btn;
            for (var i = 0; i < 8 && el && el !== document.body; i++) {
                el = el.parentElement;
                if (!el) break;
                var code = el.querySelector('pre') || el.querySelector('code');
                if (code) {
                    var text = (code.textContent || '').trim();
                    if (text.length > 0) return text;
                }
            }
        } catch (e) { /* fail closed — return null */ }
        return null;
    }

    /**
     * Checks if a command should be auto-clicked based on blocklist/allowlist.
     * Evaluation order (per DeepThink directive):
     *   1. If command matches ANY blocklist pattern → BLOCK
     *   2. If allowlist is configured AND command matches NO allowlist pattern → BLOCK
     *   3. Otherwise → ALLOW
     * When command text cannot be extracted and filters are active → fail closed (BLOCK)
     * @returns {boolean} true if safe to click
     */
    function isCommandAllowed(commandText) {
        // Read from window globals (hot-reloadable via pushFilterUpdate)
        var blockedList = window.__AA_BLOCKED || BLOCKED_COMMANDS;
        var allowedList = window.__AA_ALLOWED || ALLOWED_COMMANDS;
        var hasFilters = window.__AA_HAS_FILTERS !== undefined ? window.__AA_HAS_FILTERS : HAS_FILTERS;
        if (!hasFilters) return true;
        if (!commandText) return false; // Fail closed: can't inspect → don't click

        var cmdLower = commandText.toLowerCase();

        // Word-boundary match: checks if pattern appears as a standalone token
        // sequence in the command. Uses shell metacharacters as boundaries to prevent
        // 'rm' from matching 'format' or 'npm run build-arm'.
        function matchesPattern(cmd, pattern) {
            var patLower = pattern.toLowerCase();
            var cmdLower = cmd.toLowerCase();
            // Multi-word patterns (e.g. 'rm -rf', 'git push --force'):
            // check if the exact multi-word sequence appears with boundaries
            var idx = cmdLower.indexOf(patLower);
            while (idx !== -1) {
                var before = idx === 0 ? ' ' : cmdLower.charAt(idx - 1);
                var after = idx + patLower.length >= cmdLower.length ? ' ' : cmdLower.charAt(idx + patLower.length);
                // Full shell metacharacter set: whitespace, pipes, semicolons,
                // ampersands, slashes, subshells, quotes, backticks, variables,
                // redirections, commas, backslashes, colons
                var delimiters = ${JSON.stringify(' \t\r\n|;&/()[]{}\"\'`$=<>,\\:')};
        if ((idx === 0 || delimiters.indexOf(before) !== -1) &&
                    (idx + patLower.length >= cmdLower.length || delimiters.indexOf(after) !== -1)) {
                    return true;
                }
        idx = cmdLower.indexOf(patLower, idx + 1);
            }
        return false;
        }

        // 1. Blocklist: any pattern match at word boundary → block
        for (var b = 0; b < blockedList.length; b++) {
            if (matchesPattern(cmdLower, blockedList[b])) {
                return false;
            }
        }

        // 2. Allowlist: if configured and no match → block
        if (allowedList.length > 0) {
            var allowed = false;
        for (var a = 0; a < allowedList.length; a++) {
                if (matchesPattern(cmdLower, allowedList[a])) {
            allowed = true;
        break;
                }
            }
        if (!allowed) return false;
        }

        return true;
    }

        function scanAndClick() {
            if (window.__AA_PAUSED) return null;
            pruneCooldowns();

            if (!isAgentPanel()) return null;

            // Single-pass: combine all keywords and walk the DOM exactly once
            var allTexts = BUTTON_TEXTS.concat(EXPAND_TEXTS);
            var match = findButton(document.body, allTexts);
            if (!match) return null;

            var btn = match.node;
            var matchedText = match.matchedText;

            // Command filtering: only applies to terminal-related buttons
            var currentHasFilters = window.__AA_HAS_FILTERS !== undefined ? window.__AA_HAS_FILTERS : HAS_FILTERS;
            if (currentHasFilters && TERMINAL_BUTTON_TEXTS.indexOf(matchedText) !== -1) {
                var cmdText = extractCommandText(btn);
                if (!isCommandAllowed(cmdText)) {
                    return null; // Blocked by filter
                }
            }

            // Record cooldown and click
            var key = _domPath(btn) + ':' + (btn.textContent || '').trim().toLowerCase().substring(0, 30);
            clickCooldowns[key] = Date.now();
            // Global expand cooldown + text-signature dedup
            if (matchedText === 'expand' || matchedText === 'requires input') {
                lastExpandClickTime = Date.now();
                var sig = (btn.textContent || '').trim().toLowerCase().substring(0, 60);
                expandClickedTexts[sig] = true;
            }
            btn.click();
            return 'clicked:' + matchedText;
        }

        // ═══ INITIAL SCAN ═══
        // Click any buttons already present in the DOM right now.
        scanAndClick();

        // ═══ MUTATION OBSERVER ═══
        // Zero-polling, event-driven: reacts when React mounts new elements.
        // Leading-edge throttle (200ms): fires scanAndClick() on the FIRST mutation,
        // then at most once per 200ms during continuous activity. This is optimal
        // because Antigravity buttons appear at the START of mutation bursts
        // (React mounts button → then streams LLM text). A trailing debounce
        // would delay clicks until streaming stops, which is the wrong behavior.
        var debounceTimer = null;
        var observer = new MutationObserver(function() {
        if (debounceTimer) return;
        debounceTimer = setTimeout(function() {
            debounceTimer = null;
        scanAndClick();
        }, 100);
    });

        observer.observe(document.body, {
            childList: true,
        subtree: true
    });

        // Expose observer on window for external disconnect (kill switch)
        window.__AA_OBSERVER = observer;

        return 'observer-installed';
})()
        `;
}

module.exports = { buildDOMObserverScript };
