// AntiGravity AutoAccept — DOM Observer Payload (v3.5.9)

function buildDOMObserverScript(customTexts, blockedCommands, allowedCommands, autoAcceptFileEdits, autoRetryEnabled) {
    blockedCommands = blockedCommands || [];
    allowedCommands = allowedCommands || [];
    if (autoAcceptFileEdits === undefined) autoAcceptFileEdits = true;
    if (autoRetryEnabled === undefined) autoRetryEnabled = true;

    const allTexts = [
        'run',  
        ...(autoAcceptFileEdits ? ['accept'] : []),  
        'always allow', 'allow this conversation', 'allow',
        ...(autoRetryEnabled ? ['retry', 'continue'] : []),  
        ...customTexts
    ];
    const expandTexts = ['requires input', 'expand'];

    return `
(function() {
    if (window.__AA_OBSERVER_ACTIVE) return 'already-active';
    window.__AA_OBSERVER_ACTIVE = true;

    function isAgentPanel() {
        // Legacy DOM markers (.react-app-container, [class*="agent"], [data-vscode-context])
        // no longer exist in VS Code OSS 1.107.0+ (AG 1.23.2+).
        // ConnectionManager already gates injection to valid targets before calling burst-inject,
        // so this in-script guard is redundant. Always return true. (Issue #61)
        return true;
    }

    // ⚡ STRUCTURAL SIDEBAR GUARD: Short ambiguous words like "run" can appear as chat titles
    // in the sidebar list. We MUST NOT click those. But we also must NOT block legitimate
    // "Run" buttons inside the chat content area.
    // Strategy: If the matched text is short (≤8 chars), verify the clickable element is NOT
    // inside a sidebar list/tree container. Long unique phrases like "always allow" are safe.
    var AMBIGUOUS_TEXTS = { 'run': true, 'accept': true, 'allow': true, 'retry': true, 'continue': true };
    var SIDEBAR_SELECTORS = '[role="tree"], [role="treeitem"], [role="listbox"], [role="option"], .monaco-list, .conversation-list, .chat-list, .sidebar-list, [data-testid*="convo"], [data-testid*="trajectory"], [class*="conversation-list"], [class*="trajectory"], [class*="history"], [class*="past-chat"], [class*="chat-history"]';
    // ⚡ LIST CONTAINER SELECTORS: Scrollable containers that hold conversation history items.
    // These are parents of clickable list items — NOT action buttons.
    var LIST_CONTAINER_SELECTORS = SIDEBAR_SELECTORS + ', [class*="overflow-y"][class*="cursor-pointer"], nav, [role="navigation"], [role="menu"], [role="menubar"]';

    function isSidebarElement(el) {
        if (!el || !el.closest) return false;
        if (el.closest(SIDEBAR_SELECTORS)) return true;
        // ⚡ CONVERSATION LIST HEURISTIC: If the element is a cursor-pointer+select-none div
        // inside a scrollable container with many similar siblings, it's a list item, not a button.
        return isConversationListItem(el);
    }

    // ⚡ SECONDARY GUARD: Detects conversation list items by structural heuristics.
    // Conversation history entries are typically select-none+cursor-pointer divs inside
    // a scrollable container with 3+ similar siblings. Action buttons are standalone.
    function isConversationListItem(el) {
        if (!el || !el.parentElement) return false;
        var classes = el.className || '';
        // Fast path: check for Antigravity's known conversation item class pattern
        if (typeof classes === 'string' && classes.indexOf('select-none') !== -1 && classes.indexOf('cursor-pointer') !== -1 && classes.indexOf('rounded') !== -1) {
            return true;
        }
        // ⚡ PAST CHATS PANEL GUARD: Walk up 6 levels (deeper than before) to catch
        // history overlay panels. Threshold stays at 3+ to avoid blocking Run buttons
        // inside the chat message list (which is also scrollable with 2+ children).
        var parent = el.parentElement;
        for (var up = 0; up < 6 && parent && parent !== document.body; up++) {
            var pClass = parent.className || '';
            var isScrollable = false;
            if (typeof pClass === 'string' && (pClass.indexOf('overflow-y') !== -1 || pClass.indexOf('overflow-auto') !== -1 || pClass.indexOf('overflow-scroll') !== -1 || pClass.indexOf('scroll') !== -1)) {
                isScrollable = true;
            }
            if (!isScrollable) {
                try { var cs = window.getComputedStyle(parent); isScrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll'); } catch(e) {}
            }
            if (isScrollable && parent.children.length >= 3) {
                // Scrollable container with 3+ children — this is a list, not a button group
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    }

    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};
    var EXPAND_TEXTS = ${JSON.stringify(expandTexts)};
    var BLOCKED_COMMANDS = ${JSON.stringify(blockedCommands)};
    var ALLOWED_COMMANDS = ${JSON.stringify(allowedCommands)};
    var HAS_FILTERS = BLOCKED_COMMANDS.length > 0 || ALLOWED_COMMANDS.length > 0;

    if (typeof window.__AA_CLEANUP === 'function') window.__AA_CLEANUP();
    window.__AA_CLEANUP = function() {
        if (window.__AA_OBSERVER) { window.__AA_OBSERVER.disconnect(); window.__AA_OBSERVER = null; }
        if (window.__AA_FALLBACK_INTERVAL) { clearInterval(window.__AA_FALLBACK_INTERVAL); window.__AA_FALLBACK_INTERVAL = null; }
    };

    window.__AA_LAST_SCAN = Date.now();
    window.__AA_CLICK_COUNT = window.__AA_CLICK_COUNT || 0;

    window.__AA_BLOCKED = BLOCKED_COMMANDS;
    window.__AA_ALLOWED = ALLOWED_COMMANDS;
    window.__AA_HAS_FILTERS = HAS_FILTERS;
    window.__AA_PAUSED = false; 

    if (!window.__AA_ACTIVITY_TRACKED) {
        window.__AA_ACTIVITY_TRACKED = true;
        window.__AA_LAST_USER_INPUT = Date.now();
        var _trackActivity = function() { window.__AA_LAST_USER_INPUT = Date.now(); };
        document.addEventListener('keydown', _trackActivity, true);
        document.addEventListener('mousedown', _trackActivity, true);
        document.addEventListener('touchstart', _trackActivity, true);
    }

    var DEBUG = true;
    function _log() {
        if (!DEBUG) return; var args = ['[AA]'];
        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        console.log.apply(console, args);
    }

    var COOLDOWN_MS = 5000;
    var EXPAND_COOLDOWN_MS = 10000; 
    var clickCooldowns = {};

    function _domPath(el) {
        var parts = []; var curr = el;
        for (var i = 0; i < 4 && curr && curr !== document.body; i++) {
            var idx = 0; var child = curr.parentElement ? curr.parentElement.firstElementChild : null;
            while (child) { if (child === curr) break; idx++; child = child.nextElementSibling; }
            parts.unshift((curr.tagName || '') + '[' + idx + ']'); curr = curr.parentElement;
        }
        return parts.join('/');
    }

    function closestClickable(node) {
        var el = node;
        while (el && el !== document.body) {
            // ⚡ GUARD: Abort upward walk if we enter a sidebar/list container.
            // This prevents promoting conversation list items to click targets.
            if (el !== node && el.matches && (function() { try { return el.matches(LIST_CONTAINER_SELECTORS); } catch(e) { return false; } })()) {
                return null; // Hit a list container — this node is NOT an action button
            }
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || tag === 'a' || tag.includes('button') || tag.includes('btn') ||
                el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' ||
                el.classList.contains('cursor-pointer') ||
                el.onclick || el.getAttribute('tabindex') === '0') {
                // ⚡ FINAL CHECK: Reject if it's a conversation list item.
                // EXCEPTION: Real semantic <button> and <a> elements are ALWAYS valid click
                // targets — conversation history items are divs/spans, never button tags.
                var isSemanticTag = (tag === 'button' || tag === 'a');
                if (!isSemanticTag && isConversationListItem(el)) return null;
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }

    var _wordBoundaryRegex = /[a-z0-9_\\\\-\\\\.]/i;
    function isWordBoundary(str, keyLen) {
        if (str.length === keyLen) return true;
        return !_wordBoundaryRegex.test(str.charAt(keyLen));
    }

    function findButton(root, texts) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var wNode; var best = null; 
        while ((wNode = walker.nextNode())) {
            if (wNode.shadowRoot) {
                var result = findButton(wNode.shadowRoot, texts);
                if (result && (best === null || result.priority < best.priority)) {
                    best = result; if (best.priority === 0) return best; 
                }
            }
            var testId = (wNode.getAttribute('data-testid') || wNode.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                var tag1 = (wNode.tagName || '').toLowerCase();
                if (tag1 === 'button' || tag1.includes('button') || wNode.getAttribute('role') === 'button' || tag1.includes('btn')) {
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
            if (nodeText.length > 50) {
                if (!window.__AA_SKIP_COUNT) window.__AA_SKIP_COUNT = 0;
                if (window.__AA_SKIP_COUNT < 3) {
                    for (var lt = 0; lt < texts.length; lt++) {
                        if (nodeText.indexOf(texts[lt]) !== -1) { window.__AA_SKIP_COUNT++; break; }
                    }
                }
                continue;
            }

            for (var t = 0; t < texts.length; t++) {
                if (best !== null && t >= best.priority) break;
                var text = texts[t];
                var isExpandKeyword = (text === 'expand' || text === 'requires input');
                var isMatch = false;

                if (isExpandKeyword) {
                    if (text === 'expand') {
                        isMatch = nodeText.replace(/[^a-z]/g, '') === 'expand';
                        if (isMatch) {
                            var hasContext = false; var p = wNode;
                            for (var up = 0; up < 6 && p && p !== document.body; up++) {
                                p = p.parentElement;
                                if (p && (p.textContent || '').toLowerCase().indexOf('requires input') !== -1) { hasContext = true; break; }
                            }
                            isMatch = hasContext;
                        }
                    } else if (text === 'requires input') {
                        isMatch = nodeText.indexOf('requires input') !== -1 && nodeText.length <= 80;
                    }
                } else {
                    isMatch = nodeText === text ||
                        (text.length >= 3 && nodeText.startsWith(text) && isWordBoundary(nodeText, text.length) && nodeText.length <= text.length * 3) ||
                        (nodeText.startsWith(text + ' ') && nodeText.length <= text.length * 5) ||
                        (text.length >= 3 && nodeText.startsWith(text) && nodeText.length <= text.length * 5 &&
                            /^(alt|ctrl|shift|cmd|meta|\u2318|\u2325|\u21E7|\u2303)/.test(nodeText.substring(text.length)));
                }
                if (!isMatch) continue;

                var clickable = closestClickable(wNode);
                if (!clickable) continue; // ⚡ closestClickable returned null — inside a list container
                var tag2 = (clickable.tagName || '').toLowerCase();
                var isExpandType = (text === 'expand' && nodeText === 'expand') || text === 'requires input';

                // ⚡ STRUCTURAL SIDEBAR GUARD for ambiguous short words
                // "run", "accept", "allow" etc. can appear as chat titles in the sidebar.
                // We only block if: (a) text is an ambiguous keyword AND (b) the element is inside
                // a sidebar container AND (c) it is NOT a real semantic <button>/<a>.
                // Conversation history items are always divs — never actual button tags.
                var isSemanticTag2 = (tag2 === 'button' || tag2 === 'a');
                if (!isSemanticTag2 && AMBIGUOUS_TEXTS[text] && isSidebarElement(clickable)) {
                    continue; // Skip — this is a sidebar chat title, not an action button
                }

                // ⚡ PROPER BUTTON TAG GUARD for ambiguous keywords (Issue #62)
                // After clicking a real <button>, the MutationObserver fires and can match
                // an adjacent sibling <div> that also contains "run"/"accept" text (e.g. labels,
                // VS Code menu items, activity bar entries, status indicators).
                // These divs match because of cursor-pointer but are NOT action buttons.
                // Fix: For ambiguous keywords, ONLY click semantic button elements.
                if (AMBIGUOUS_TEXTS[text]) {
                    var isSemanticButton = tag2 === 'button' || tag2 === 'a' ||
                        (clickable.getAttribute('role') === 'button') ||
                        (clickable.getAttribute('role') === 'link');
                    if (!isSemanticButton) {
                        continue; // Skip — not a real button, just a div with cursor-pointer
                    }
                }

                if (tag2 === 'button' || tag2 === 'a' || tag2.includes('button') || tag2.includes('btn') ||
                    clickable.getAttribute('role') === 'button' || clickable.getAttribute('role') === 'link' ||
                    clickable.classList.contains('cursor-pointer') ||
                    clickable.onclick || clickable.getAttribute('tabindex') === '0') {
                    
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                        clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading') ||
                        clickable.getAttribute('data-aa-blocked')) { continue; }

                    if (isExpandKeyword) {
                        var isAlreadyExpanded =
                            clickable.getAttribute('aria-expanded') === 'true' ||
                            clickable.getAttribute('data-state') === 'open' ||
                            clickable.getAttribute('data-state') === 'expanded';
                        if (isAlreadyExpanded) continue;
                    }

                    var btnKey = isExpandType
                        ? _domPath(clickable) + ':expand:' + (clickable.textContent || '').trim().toLowerCase().substring(0, 30)
                        : _domPath(clickable) + ':' + (clickable.textContent || '').trim().toLowerCase().substring(0, 30);
                    var cooldown = isExpandType ? EXPAND_COOLDOWN_MS : COOLDOWN_MS;
                    var lastClick = clickCooldowns[btnKey] || 0;
                    if (lastClick && (Date.now() - lastClick < cooldown)) continue;
                    
                    best = { node: clickable, matchedText: text, priority: t };
                    if (t === 0) return best; 
                    break; 
                }
            }
        }
        return best;
    }

    var lastPrune = Date.now();
    var PRUNE_INTERVAL_MS = 30000;
    function pruneCooldowns() {
        var now = Date.now(); if (now - lastPrune < PRUNE_INTERVAL_MS) return; lastPrune = now;
        var maxAge = EXPAND_COOLDOWN_MS * 2; var keys = Object.keys(clickCooldowns);
        for (var i = 0; i < keys.length; i++) { if (now - clickCooldowns[keys[i]] > maxAge) { delete clickCooldowns[keys[i]]; } }
    }

    function extractCommandText(btn) {
        try {
            var el = btn;
            for (var i = 0; i < 8 && el && el !== document.body; i++) {
                el = el.parentElement; if (!el) break;
                var codes = el.querySelectorAll('pre, code');
                if (codes.length > 0) {
                    var allText = '';
                    for (var j = 0; j < codes.length; j++) { allText += ' ' + (codes[j].textContent || '').trim(); }
                    return allText.trim();
                }
            }
        } catch (e) { } return null;
    }

    function isCommandAllowed(commandText) {
        var blockedList = window.__AA_BLOCKED || BLOCKED_COMMANDS;
        var allowedList = window.__AA_ALLOWED || ALLOWED_COMMANDS;
        var hasFilters = window.__AA_HAS_FILTERS !== undefined ? window.__AA_HAS_FILTERS : HAS_FILTERS;
        if (!hasFilters) return true;
        if (!commandText) return false; 

        var cmdLower = commandText.toLowerCase();

        function matchesPattern(cmd, pattern) {
            var patLower = pattern.toLowerCase(); var cmdLower = cmd.toLowerCase(); var idx = cmdLower.indexOf(patLower);
            while (idx !== -1) {
                var before = idx === 0 ? ' ' : cmdLower.charAt(idx - 1);
                var after = idx + patLower.length >= cmdLower.length ? ' ' : cmdLower.charAt(idx + patLower.length);
                var delimiters = ${JSON.stringify(' \t\r\n|;&/()[]{}\"\'`$=<>,\\:')};
                if ((idx === 0 || delimiters.indexOf(before) !== -1) && (idx + patLower.length >= cmdLower.length || delimiters.indexOf(after) !== -1)) { return true; }
                idx = cmdLower.indexOf(patLower, idx + 1);
            }
            return false;
        }

        for (var b = 0; b < blockedList.length; b++) { if (matchesPattern(cmdLower, blockedList[b])) { return false; } }
        if (allowedList.length > 0) {
            var allowed = false;
            for (var a = 0; a < allowedList.length; a++) { if (matchesPattern(cmdLower, allowedList[a])) { allowed = true; break; } }
            if (!allowed) return false;
        }
        return true;
    }

    function scanAndClick() {
        window.__AA_LAST_SCAN = Date.now(); 
        window.__AA_SKIP_COUNT = 0; 
        if (window.__AA_PAUSED || window.__AA_SWARM_PAUSED) return null;
        pruneCooldowns();

        if (!isAgentPanel()) return null;

        if (!window.__AA_EXPAND_DIAG_TS || Date.now() - window.__AA_EXPAND_DIAG_TS > 10000) { window.__AA_EXPAND_DIAG_TS = Date.now(); }

        var allTexts = BUTTON_TEXTS.concat(EXPAND_TEXTS);
        var currentHasFilters = window.__AA_HAS_FILTERS !== undefined ? window.__AA_HAS_FILTERS : HAS_FILTERS;

        var MAX_SCANS = 5;
        for (var scan = 0; scan < MAX_SCANS; scan++) {
            var match = findButton(document.body, allTexts);
            if (!match) return null;

            var btn = match.node; var matchedText = match.matchedText;
            var isExpandBtn = (matchedText === 'expand' || matchedText === 'requires input');

            // ⚡ SWARM PAUSE GUARD: "allow" clicks in Manager webview cause ghost navigation.
            // When swarm is paused, skip these but keep Run/Accept/Expand working.
            if (window.__AA_SWARM_PAUSED && (matchedText === 'allow' || matchedText === 'always allow')) {
                continue;
            }

            if (currentHasFilters && !isExpandBtn) {
                var cmdText = extractCommandText(btn);
                if (cmdText !== null) {
                    if (!isCommandAllowed(cmdText)) {
                        btn.setAttribute('data-aa-blocked', 'true');
                        btn.style.cssText += ';background:#4a1c1c !important;opacity:0.6;cursor:not-allowed;';
                        btn.textContent = '\uD83D\uDEAB Blocked by Filter';
                        var blockKey = _domPath(btn) + ':' + (btn.textContent || '').trim().toLowerCase().substring(0, 30);
                        clickCooldowns[blockKey] = Date.now() + (15000 - COOLDOWN_MS);
                        continue; 
                    }
                }
            }

            var isRecovery = matchedText === 'retry' || matchedText === 'continue';
            if (isRecovery) {
                window.__AA_RECOVERY_TS = window.__AA_RECOVERY_TS || []; var now = Date.now();
                window.__AA_RECOVERY_TS = window.__AA_RECOVERY_TS.filter(function(ts) { return now - ts < 60000; });
                if (window.__AA_RECOVERY_TS.length >= 3) { return 'blocked:circuit_breaker'; }
                window.__AA_RECOVERY_TS.push(now);
            } else { window.__AA_RECOVERY_TS = []; }

            var key = isExpandBtn 
                ? _domPath(btn) + ':expand:' + (btn.textContent || '').trim().toLowerCase().substring(0, 30)
                : _domPath(btn) + ':' + (btn.textContent || '').trim().toLowerCase().substring(0, 30);
            clickCooldowns[key] = Date.now();
            
            // ⚡ CLICK AUDIT: Store what we clicked for heartbeat to report
            if (!window.__AA_CLICK_LOG) window.__AA_CLICK_LOG = [];
            window.__AA_CLICK_LOG.push({ text: matchedText, tag: (btn.tagName || '').toLowerCase(), path: _domPath(btn), time: Date.now() });
            if (window.__AA_CLICK_LOG.length > 10) window.__AA_CLICK_LOG.shift();
            
            _log('clicking:', matchedText, 'tag:', (btn.tagName || ''), 'path:', _domPath(btn));
            btn.click();
            window.__AA_CLICK_COUNT = (window.__AA_CLICK_COUNT || 0) + 1;
            return 'clicked:' + matchedText;
        }
        return null; 
    }

    try { scanAndClick(); } catch(e) { _log('initial scan error:', e.message); }

    var __AA_SCAN_QUEUED = false;
    var observer = new MutationObserver(function() {
        if (__AA_SCAN_QUEUED || window.__AA_PAUSED || window.__AA_SWARM_PAUSED) return;
        __AA_SCAN_QUEUED = true;
        setTimeout(function() {
            try { scanAndClick(); } catch(e) { _log('scan error:', e.message); } finally { __AA_SCAN_QUEUED = false; }
        }, 50);
    });

    observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'data-state']
    });

    if (window.__AA_FALLBACK_INTERVAL) { clearInterval(window.__AA_FALLBACK_INTERVAL); }
    window.__AA_FALLBACK_INTERVAL = setInterval(function() {
        if (window.__AA_PAUSED || window.__AA_SWARM_PAUSED) return; window.__AA_LAST_SCAN = Date.now();
        setTimeout(function() { try { scanAndClick(); } catch(e) { } }, 0);
    }, 10000);

    window.__AA_OBSERVER = observer;
    return 'observer-installed';
})()
`;
}

module.exports = { buildDOMObserverScript };
