// AntiGravity AutoAccept — DOM Observer Payload
// Generates a self-contained script injected ONCE per CDP session.
// Uses MutationObserver for zero-polling, event-driven button clicking.
// All cooldown state is localized to DOM data-attributes — no Node.js globals.

/**
 * Generates the MutationObserver-based DOM clicker script.
 * @param {string[]} customTexts - Additional button texts from user config
 * @returns {string} JavaScript source to evaluate via CDP Runtime.evaluate
 */
function buildDOMObserverScript(customTexts) {
    const allTexts = [
        'run', 'accept',  // Primary action buttons first ("Run Alt+d", "Accept")
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
    window.__AA_PAUSED = false;

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
    var COOLDOWN_MS = 5000;
    var EXPAND_COOLDOWN_MS = 8000;
    // Closure-scoped cooldown map — survives React DOM node recreation.
    // Keyed by button identity string (tag + text hash), not DOM node reference.
    var clickCooldowns = {};

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

    function findButton(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var result = findButton(node.shadowRoot, text);
                if (result) return result;
            }
            var testId = (node.getAttribute('data-testid') || node.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                var tag1 = (node.tagName || '').toLowerCase();
                if (tag1 === 'button' || tag1.includes('button') || node.getAttribute('role') === 'button' || tag1.includes('btn')) {
                    return node;
                }
            }
            var nodeText = (node.textContent || '').trim().toLowerCase();
            if (nodeText.length > 50) continue;
            var isMatch = nodeText === text || 
                (text.length >= 5 && nodeText.startsWith(text) && nodeText.length <= text.length * 3) ||
                (nodeText.startsWith(text + ' ') && nodeText.length <= text.length * 5);
            if (isMatch) {
                var clickable = closestClickable(node);
                var tag2 = (clickable.tagName || '').toLowerCase();
                if (tag2 === 'button' || tag2.includes('button') || clickable.getAttribute('role') === 'button' || 
                    tag2.includes('btn') || clickable.classList.contains('cursor-pointer') ||
                    clickable.onclick || clickable.getAttribute('tabindex') === '0' ||
                    text === 'expand' || text === 'requires input') {
                    // Idempotency guard: skip disabled/loading buttons
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                        clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading')) {
                        return null;
                    }
                    // Closure-scoped cooldown — survives React node recreation.
                    // Identity key: DOM path (3 ancestors) + trimmed text for structural uniqueness.
                    // This prevents BUTTON:accept from one code block locking out another.
                    var btnKey = _domPath(clickable) + ':' + (clickable.textContent || '').trim().toLowerCase().substring(0, 30);
                    var cooldown = (text === 'expand' || text === 'requires input') ? EXPAND_COOLDOWN_MS : COOLDOWN_MS;
                    var lastClick = clickCooldowns[btnKey] || 0;
                    if (lastClick && (Date.now() - lastClick < cooldown)) {
                        return null;
                    }
                    return clickable;
                }
            }
        }
        return null;
    }

    // ═══ COOLDOWN PRUNING ═══
    // Prevents unbounded growth of clickCooldowns over long sessions.
    // Called periodically during scanAndClick — lightweight O(n) sweep.
    var lastPrune = Date.now();
    var PRUNE_INTERVAL_MS = 30000; // Prune at most every 30s

    function pruneCooldowns() {
        var now = Date.now();
        if (now - lastPrune < PRUNE_INTERVAL_MS) return;
        lastPrune = now;
        var maxAge = EXPAND_COOLDOWN_MS * 2; // 16s — well past any cooldown
        var keys = Object.keys(clickCooldowns);
        for (var i = 0; i < keys.length; i++) {
            if (now - clickCooldowns[keys[i]] > maxAge) {
                delete clickCooldowns[keys[i]];
            }
        }
    }

    function scanAndClick() {
        pruneCooldowns();
        if (window.__AA_PAUSED) return null;

        // ═══ DEFERRED WEBVIEW GUARD ═══
        // Dynamically checks DOM structure on each scan instead of at injection time.
        // This avoids the race condition where the DOM is unhydrated on targetCreated.
        if (!isAgentPanel()) return null;

        // Pass 1: Action buttons (Run, Accept, Allow, Continue, Retry, etc.)
        for (var t = 0; t < BUTTON_TEXTS.length; t++) {
            var btn = findButton(document.body, BUTTON_TEXTS[t]);
            if (btn) {
                var key = _domPath(btn) + ':' + (btn.textContent || '').trim().toLowerCase().substring(0, 30);
                clickCooldowns[key] = Date.now();
                btn.click();
                return 'clicked:' + BUTTON_TEXTS[t];
            }
        }
        // Pass 2: Expand/Requires Input buttons (only when no action buttons exist)
        for (var e = 0; e < EXPAND_TEXTS.length; e++) {
            var expBtn = findButton(document.body, EXPAND_TEXTS[e]);
            if (expBtn) {
                var key = _domPath(expBtn) + ':' + (expBtn.textContent || '').trim().toLowerCase().substring(0, 30);
                clickCooldowns[key] = Date.now();
                expBtn.click();
                return 'clicked:' + EXPAND_TEXTS[e];
            }
        }
        return null;
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
    window.__AA_OBSERVER = new MutationObserver(function() {
        if (debounceTimer) return;
        debounceTimer = setTimeout(function() {
            debounceTimer = null;
            scanAndClick();
        }, 100);
    });

    window.__AA_OBSERVER.observe(document.body, {
        childList: true,
        subtree: true
    });

    return 'observer-installed';
})()
`;
}

module.exports = { buildDOMObserverScript };
