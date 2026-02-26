# Changelog

## [2.0.1] — 2026-02-25 — Fix: "Allow Now" button not clicking (issue #4)

### Bug Fixes
- **Fixed** Channel 1 (VS Code Commands) being gated behind a successful CDP connection. The extension now restores saved state and starts the commands poller unconditionally on activate — CDP check is purely optional for Channel 2. Users without `--remote-debugging-port` set now get full Command-API coverage immediately.
- **Fixed** "Allow Now" permission dialog button not being matched. Added `'allow now'` as an explicit, first-class button text (tried before the generic `'allow'`).
- **Fixed** Webview guard blocking the "Allow Now" dialog in non-agent-panel webviews. CDP-attached webview targets now bypass the guard entirely — they are already isolated by target selection and don't need a DOM marker check.
- **Fixed** `startsWith` prefix threshold (5 → 3 chars) so `"Run Alt+d"` correctly matches the `'run'` search term. The 3× length cap still prevents false positives.
- **Fixed** Test suite: `El` mock class was missing `setAttribute`, causing 31 of 44 tests to fail. All 49 tests now pass (0 failures).

---

## [1.18.4] — 2026-02-23

### Browser-Level CDP Session Multiplexer
- **Fixed** critical compatibility issue with Electron 30+ / Chromium 120+. The legacy `/json/list` HTTP endpoint no longer exposes webview targets — all CDP evaluations were silently failing with `ReferenceError: document is not defined`.
- **Replaced** the entire CDP layer with a browser-level session multiplexer: connects via `/json/version`, enables `Target.setDiscoverTargets`, attaches to page targets with `Target.attachToTarget({ flatten: true })`, and evaluates scripts through session-tunneled `Runtime.evaluate`.
- **DOM access detection**: Automatically identifies which page targets have real DOM access (vs headless utility processes) before injecting the clicker script.

### Concurrent CDP Optimizations
- **Cooldown Illusion Fix**: Injected `CAN_EXPAND` variable directly into webview script to prevent DOM from clicking Expand while on cooldown.
- **Port Scanner Caching**: Caches active CDP port to eliminate unnecessary failing HTTP requests.
- **Dead Code Removal**: Deleted 120+ lines of deprecated `cdpSendMulti` and `clickBannerViaDom`.

### CDP Script Fix
- **Fixed** `SyntaxError: Unexpected string` in CDP template literal.
- **Per-target cooldowns**: Expand cooldown tracked per chat thread (`lastExpandTimes[targetId]`).
- **Concurrent broadcast**: `Promise.allSettled()` for simultaneous webview evaluation.

---

## [1.18.3] — 2026-02-21

### Webview Guard Architecture (OOPIF migration fix)
- **Webview Guard**: DOM-marker check (`.react-app-container`) prevents execution on main VS Code window
- **startsWith matching**: "Run Alt+d" matches `run`, but "Always run ^" dropdown doesn't
- **Priority reorder**: `run` and `accept` checked before `always allow`
- **Removed dangerous commands**: `chatEditing.acceptAllFiles`, `inlineChat.acceptChanges` etc. removed (caused sidebar interference)
- **Removed problematic texts**: `expand` (infinite click loop), `always run` (clicked dropdown toggle)

### CDP Auto-Fix
- **Detection**: Extension checks CDP port 9222 on activation
- **Auto-Fix Shortcut**: PowerShell patcher finds Antigravity shortcuts and adds `--remote-debugging-port=9222`
- **Manual Guide**: Links to GitHub README setup instructions

### Safety
- Script exits immediately on non-agent-panel targets
- Only Antigravity-specific VS Code commands in polling loop
- Clean logging — only actual button clicks are logged

---

## [2.1.0] — 2025-02-20

### Complete Rewrite (V2)
- **Replaced** 1,435-line CDP DOM scraper with hybrid architecture
- **Primary:** VS Code Commands API with async lock
- **Secondary:** Targeted CDP with Shadow DOM piercing for permission dialogs

### Removed
- All CDP DOM scraping code (1,435 lines)
- Settings panel UI (34KB)
- 18 main_scripts helper files
