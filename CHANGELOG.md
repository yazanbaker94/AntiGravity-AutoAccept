# Changelog

## [3.0.0] — 2026-02-28

### Architecture: Event-Driven CDP (Zero-Polling)
- **Replaced** attach→evaluate→detach polling cycle with **persistent CDP sessions** (`Map<targetId, sessionId>`)
- **Replaced** periodic script injection with one-shot **MutationObserver** payload — reacts instantly when buttons appear in DOM
- **Connection Manager**: browser-level WebSocket stays open, uses `Target.targetCreated`/`Target.targetDestroyed` events for lifecycle
- **Self-healing**: automatic reconnection on WebSocket close, re-injection on execution context clear (webview navigation)
- **Heartbeat**: periodic health check + new target discovery every 30s

### Modularization
- **Split** monolithic 589-line `extension.js` into three modules:
  - `src/extension.js` — VS Code lifecycle, command polling, auto-fix patcher
  - `src/cdp/ConnectionManager.js` — persistent WebSocket, session pool, target management
  - `src/scripts/DOMObserver.js` — MutationObserver payload generator

### Localized Cooldowns
- **Moved** all cooldown state into the injected DOM script via `data-aa-t` attributes
- **Eliminated** Node.js global `lastExpandTimes` map — cooldowns are fully per-element

### Continue Button Support (from v2.3.0)
- **Added** automatic clicking of the "Continue" button (agent invocation limit)

---

## [2.3.0] — 2026-02-28

### Continue Button Support
- **Added** automatic clicking of the "Continue" button that appears when the agent reaches its invocation limit for a single response.
- This enables fully unattended sessions — the agent now auto-resumes after hitting tool-call limits.

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
