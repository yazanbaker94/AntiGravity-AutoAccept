# Changelog

## [2.1.0] — 2025-02-20

### Complete Rewrite (V2)
- **Replaced** 1,435-line CDP DOM scraper with 235-line hybrid architecture
- **Primary:** VS Code Commands API with async lock (8 commands, 500ms polling)
- **Secondary:** Targeted CDP with Shadow DOM piercing for permission dialogs only

### Production Hardening (DeepThink Audit)
- Added async lock (`isAccepting` guard + `Promise.allSettled`) to prevent race conditions
- Shadow DOM piercing `TreeWalker` — survives `<vscode-button>`, `<ag-btn>`, Web Components
- `data-testid` / `data-action` attribute matching before text matching (i18n-safe)
- Fuzzy panel selector (`iframe[id*="antigravity"]`) — survives ID wrapping
- Wider CDP port scan (17 ports: 9000-9014 + 9222, 9229)
- `customButtonTexts` setting for i18n escape hatch

### Safety
- Excluded `notification.acceptPrimaryAction` (auto-clicks destructive dialogs)
- Excluded `workbench.action.chat.editToolApproval` (spams config UI)
- Excluded `antigravity.prioritized.agentAcceptAllInFile` (dual write-lock risk)
- Excluded `chat.toolOutput.save` (spams file-save dialogs)
- Full audit of 2,834 commands documented in COMMAND_AUDIT.md

### Removed
- All CDP DOM scraping code (1,435 lines)
- Settings panel UI (34KB)
- 18 main_scripts helper files
- Command dump debug code
