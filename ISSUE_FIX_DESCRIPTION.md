## Fix: "Allow Now" button not clicking (#4)

### Problem

Multiple users reported that the "Allow Now" button was not being auto-clicked, while the developer could not reproduce. Root cause: **three independent bugs** that only manifested when the user's environment differed from the developer's.

### Root Causes

| # | Bug | Impact |
|---|---|---|
| 1 | `activate()` gated Channel 1 (VS Code Commands) behind a successful CDP connection | **Users without `--remote-debugging-port` got zero auto-clicking** — not even Run/Accept |
| 2 | `'allow now'` was not in the explicit button text list | Relied on generic `'allow'` fallback which could match wrong elements first |
| 3 | Webview guard blocked permission dialogs in non-agent-panel webviews | CDP correctly attached to the webview, but the script returned `'not-agent-panel'` and did nothing |

### Additional Fixes

| # | Bug | Impact |
|---|---|---|
| 4 | `startsWith` prefix threshold was 5 chars — too high for `'run'` (3 chars) | `"Run Alt+d"` button never matched via prefix. Lowered to 3 chars; 3× length cap still prevents false positives |
| 5 | Test suite `El` mock was missing `setAttribute` | 31 of 44 tests were silently failing since v2.0.0 |

### Changes

- **`extension.js`**: Channel 1 starts unconditionally; `'allow now'` added to button texts; `IS_WEBVIEW_TARGET` flag bypasses webview guard for CDP-confirmed targets; `startsWith` threshold 5→3
- **`test/permission-engine.test.js`**: `setAttribute` added to mock; new tests for "Allow Now", priority order, and webview guard bypass
- **`package.json`**: Version bump 2.0.0 → 2.0.1
- **`CHANGELOG.md`**: v2.0.1 entry

### Test Results

```
Before:  13 passed, 31 failed, 44 total
After:   49 passed,  0 failed, 49 total
```

### Verified

- ✅ Channel 1 auto-clicks "Run" button without CDP configured
- ✅ Channel 2 (CDP) auto-clicks "Allow Now" / "Always Allow" dialogs
- ✅ Webview guard still blocks main VS Code window (no sidebar interference)

Closes #3
