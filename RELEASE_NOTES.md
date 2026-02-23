## v1.18.4 — Expand Banner Fix + Test Suite

### 🔧 Expand Banner Detection Fixed

The "Steps Require Input" banner (e.g. `"1 Step Requires Input | Expand"`) is now correctly detected and clicked. Previously, `startsWith()` matching failed because the banner text begins with a number, not `"requires input"`. Switched to `includes()` matching for expand-pass texts while keeping `startsWith()` for primary buttons (Run, Accept, Allow) to avoid false positives.

### 🧪 44-Test Offline Test Suite

New `test/permission-engine.test.js` — run `node test/permission-engine.test.js` to verify all button matching logic without needing Antigravity IDE:

| Category | Tests |
|----------|-------|
| Webview Guard | 2 |
| Button Text Matching | 14 (Run, Accept, Always Allow, Allow, case variations) |
| Priority Order | 4 (Run > Accept > Always Allow > Allow) |
| Reject/Ignore | 7 (disabled, loading, long text, non-buttons) |
| Clickable Ancestor Traversal | 4 (span→button, role=button, cursor-pointer, tabindex) |
| data-testid / data-action | 3 |
| Expand Banner | 4 (includes match, CAN_EXPAND gate) |
| Custom Texts (i18n) | 2 |
| Edge Cases | 3 (whitespace, nested children, empty DOM) |

### Files Changed

- `extension.js` — `findButton()` now accepts `useIncludes` parameter for expand-pass matching
- `test/permission-engine.test.js` — **[NEW]** full offline test suite
