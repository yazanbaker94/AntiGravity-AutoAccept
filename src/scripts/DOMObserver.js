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

    // ═══ WEBVIEW GUARD ═══
    // Only execute inside the Antigravity agent panel webview.
    // The panel has .react-app-container; the main VS Code window doesn't.
    if (!document.querySelector('.react-app-container') && 
        !document.querySelector('[class*="agent"]') &&
        !document.querySelector('[data-vscode-context]')) {
        return 'not-agent-panel';
    }

    window.__AA_OBSERVER_ACTIVE = true;

    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};
    var EXPAND_TEXTS = ${JSON.stringify(expandTexts)};
    var COOLDOWN_MS = 5000;
    var EXPAND_COOLDOWN_MS = 8000;

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
                    // Per-element cooldown via DOM attribute (fully localized — no Node.js state)
                    var lastClick = parseInt(clickable.getAttribute('data-aa-t') || '0', 10);
                    var cooldown = (text === 'expand' || text === 'requires input') ? EXPAND_COOLDOWN_MS : COOLDOWN_MS;
                    if (lastClick && (Date.now() - lastClick < cooldown)) {
                        return null;
                    }
                    return clickable;
                }
            }
        }
        return null;
    }

    function scanAndClick() {
        // Pass 1: Action buttons (Run, Accept, Allow, Continue, Retry, etc.)
        for (var t = 0; t < BUTTON_TEXTS.length; t++) {
            var btn = findButton(document.body, BUTTON_TEXTS[t]);
            if (btn) {
                btn.setAttribute('data-aa-t', '' + Date.now());
                btn.click();
                return 'clicked:' + BUTTON_TEXTS[t];
            }
        }
        // Pass 2: Expand/Requires Input buttons (only when no action buttons exist)
        for (var e = 0; e < EXPAND_TEXTS.length; e++) {
            var expBtn = findButton(document.body, EXPAND_TEXTS[e]);
            if (expBtn) {
                expBtn.setAttribute('data-aa-t', '' + Date.now());
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
    // Zero-polling, event-driven: reacts instantly when React mounts new elements.
    var rafPending = false;
    var observer = new MutationObserver(function() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(function() {
            rafPending = false;
            scanAndClick();
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    return 'observer-installed';
})()
`;
}

module.exports = { buildDOMObserverScript };
