# Changelog

## [1.18.4] — 2026-02-22

### Concurrent CDP Optimizations
- **Fixed Cooldown Illusion**: Injected logic directly into the webview script to prevent the DOM from violently clicking the "Expand" banner every 1.5s while the Node.js orchestrator ignored the result on cooldown.
- **Port Scanner Caching**: Caches the active CDP port (`activeCdpPort`) to eliminate 17 unnecessary failing HTTP requests every polling cycle when an agent panel isn't open.
- **Removed Dead Code**: Deleted 120+ lines of deprecated coordinate-clicking code (`cdpSendMulti`, `clickBannerViaDom`) to save memory and reduce extension size.

## [1.18.4] — 2026-02-22

### CDP Script Fix
- **Fixed** critical `SyntaxError: Unexpected string` that silently broke all CDP script evaluations. Root cause: a code comment containing `\necho "test"\n` inside a template literal — the `\n` was interpreted as actual newlines, breaking the script at line 49.
- **Added** `[CDP-DBG]` diagnostic logging: captures exception type, subtype, error description, and line number on evaluation failures.
- **Added** per-cycle target count logging (`Port 9222: N targets`) for better polling visibility.

### Concurrent Broadcast (Multi-Chat Support)
- **Parallel CDP evaluation**: Replaced sequential `for` loop with `Promise.allSettled()` — all webview targets are evaluated simultaneously.
- **Webview filtering**: Only `vscode-webview://` targets are evaluated; service workers and main window are skipped.
- **Per-target cooldowns**: Expand cooldown is now tracked per chat thread (`lastExpandTimes[targetId]`), so one chat's cooldown doesn't lock another.
- **Multi-chat hack**: Use `File → Duplicate Workspace` to run two agent chats in separate windows — bot auto-clicks both simultaneously.

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
