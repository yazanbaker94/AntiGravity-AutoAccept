# AntiGravity AutoAccept

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/yazanbaker)

Automatically accept agent steps, terminal commands, file edits, and permission prompts in [Antigravity](https://antigravity.dev) — Google's AI coding assistant.

## What it does

When the Antigravity agent proposes file edits, terminal commands, or asks for tool permissions, this extension auto-accepts them so you don't have to click every button manually.

**Two strategies, zero interference:**

| Strategy | What it handles | How |
|---|---|---|
| **VS Code Commands** (500ms) | Agent steps, terminal commands | Calls Antigravity's native accept commands |
| **CDP + Webview Guard** (1500ms) | Run, Accept, Always Allow buttons | Isolated script runs only inside the agent panel |

## Setup

### 1. Enable Debug Mode (Required)

The extension needs Chrome DevTools Protocol to click permission buttons. Launch Antigravity with:
```
--remote-debugging-port=9222
```

<details>
<summary><b>🪟 Windows</b></summary>

**Automatic:** On first launch, the extension detects if the port is closed and shows **"Auto-Fix Shortcut"** — click it to automatically patch your `.lnk` shortcut.

**Manual:** Right-click your Antigravity shortcut → Properties → append to Target:
```
--remote-debugging-port=9222
```

</details>

<details>
<summary><b>🍎 macOS</b></summary>

**Option 1 — Automator App (recommended):**
1. Open **Automator** → New Document → **Application**
2. Search for **"Run Shell Script"** in the library
3. Paste: `open -a "Antigravity" --args --remote-debugging-port=9222`
4. Save as "AntiGravity Launcher" to Desktop or Applications

**Option 2 — Terminal alias** (add to `~/.zshrc`):
```bash
alias antigravity='open -a "Antigravity" --args --remote-debugging-port=9222'
```

> **Note:** The app name must match exactly. Check with `ls /Applications/ | grep -i anti`

</details>

<details>
<summary><b>🐧 Linux</b></summary>

**Option 1 — Edit the `.desktop` file:**
```bash
# Find it:
find /usr/share/applications ~/.local/share/applications -name "*ntigravity*" 2>/dev/null

# Edit the Exec line:
Exec=/path/to/antigravity --remote-debugging-port=9222 %F
```

**Option 2 — Shell alias** (add to `~/.bashrc` or `~/.zshrc`):
```bash
alias antigravity='antigravity --remote-debugging-port=9222'
```

**Option 3 — Wrapper script:**
```bash
#!/bin/bash
/opt/Antigravity/antigravity --remote-debugging-port=9222 "$@"
```

</details>

### 2. Install the Extension

**From VSIX (recommended):**
1. Download the latest `.vsix` from [Releases](https://github.com/yazanbaker94/AntiGravity-AutoAccept/releases/)
2. In Antigravity: `Ctrl+Shift+P` → `Extensions: Install from VSIX`
3. Select the downloaded file
4. Reload Window

**Manual:**
1. Copy `extension.js` and `package.json` to:
   ```
   ~/.antigravity/extensions/YazanBaker.antigravity-autoaccept-1.18.4/
   ```
2. Run `npm install` in that directory (installs `ws` dependency)
3. Reload Window

## Usage

- **Toggle:** Click `⚡ Auto: ON` / `✕ Auto: OFF` in the status bar
- **Or:** `Ctrl+Shift+P` → `AntiGravity AutoAccept: Toggle ON/OFF`
- **Logs:** Output panel → `AntiGravity AutoAccept`

## Multi-Agent Workflow

Antigravity's IDE locks the agent chat panel to the sidebar, which means if you open two chat tabs, VS Code will completely unmount the hidden tab's DOM to save memory. 

To run multiple agents simultaneously and have the bot auto-click commands for all of them:

1. Click **File → Duplicate Workspace**
2. This opens a second VS Code window connected to the same project
3. Start a chat in Window 1 and another chat in Window 2
4. The extension's concurrent broadcast architecture will detect both webviews and **auto-click buttons in both windows simultaneously!**

## Settings

| Setting | Default | Description |
|---|---|---|
| `autoAcceptV2.pollInterval` | `500` | Polling interval in ms |
| `autoAcceptV2.customButtonTexts` | `[]` | Extra button texts for i18n or custom prompts |

## How it Works

### Webview Guard
Antigravity's agent panel runs in an isolated Chromium process (OOPIF). The extension evaluates JavaScript on all CDP targets, but a **Webview Guard** checks for `.react-app-container` in the DOM — if it's not present, the script exits immediately. This prevents false positives on the main VS Code window (sidebars, markdown, menus).

### Button Detection
Inside the agent panel, a `TreeWalker` searches for buttons by text content using `startsWith` matching:

| Priority | Text | Matches |
|---|---|---|
| 1 | `run` | "Run Alt+d" button ✅ (not "Always run ^" dropdown) |
| 2 | `accept` | Accept button |
| 3 | `always allow` | Permission prompts |
| 4 | `allow` | Permission prompts |
| 5 | `continue`, `proceed` | Continuation prompts |

### CDP Auto-Fix
On activation, the extension checks if port 9222 is open. If not, it shows a notification with:
- **Auto-Fix Shortcut (Windows)** — patches your `.lnk` shortcut via PowerShell
- **Manual Guide** — links to this README

## Troubleshooting

### Bot stops working after a few hours

**Cause:** Antigravity silently restarts its Electron process (auto-updates, memory pressure, or extension host crash). The new process doesn't have `--remote-debugging-port=9222`.

**Fix:** Close **all** Antigravity windows completely, then reopen from your patched shortcut. A simple Reload Window (`Ctrl+Shift+P` → Reload) won't fix this — you need a full restart.

### Bot is ON but not clicking anything

1. **Toggle OFF → ON** — click the status bar icon twice to restart polling
2. **Check the debug port** — visit `http://127.0.0.1:9222/json/list` in a browser. If it refuses, the debug port is dead (see above)
3. **Check Output logs** — `Ctrl+Shift+U` → dropdown → `AntiGravity AutoAccept`. Look for `[CDP] ✓ Thread` lines. If there are none, CDP can't find the agent panel

### Log shows repeated `clicked:run` but nothing happens

**Cause:** The script is matching a static text element instead of the real Run button. Short terms like `run` require an exact text match to limit false positives. If you still see spam, the 5-second per-element cooldown (`data-aa-t`) should suppress it after the first click.

**Fix:** Update to the latest version — this was fixed in v1.18.4.

### Status bar icon not showing after install

1. Run `Ctrl+Shift+P` → `Reload Window`
2. Check that the VSIX was built **with** dependencies (the `ws` package must be included)

---

## Safety

Commands deliberately **excluded** to prevent harm:
- `notification.acceptPrimaryAction` — would auto-click destructive dialogs
- `chatEditing.acceptAllFiles` — causes sidebar Outline toggling
- All merge/git conflict commands — could silently pick wrong side
- All autocomplete/suggestion commands — would corrupt typing

## Security FAQ

**Why does this need `--remote-debugging-port`?**

Antigravity's agent panel runs in an isolated Chromium process. The VS Code Extension API cannot see or interact with the Run/Accept/Allow buttons inside it — they're React UI elements with no registered commands. Chrome DevTools Protocol (CDP) on port 9222 is the only way to reach them.

**Is it safe?**

- **Localhost only** — the port binds to `127.0.0.1`, not `0.0.0.0`. No external machine can connect.
- **Fully open source** — all ~500 lines are on GitHub. The extension finds buttons by text and clicks them. No data is read, no network requests, no telemetry.
- **Standard dev workflow** — `--remote-debugging-port` is the same flag used by VS Code extension developers and Electron app debugging.
- **Shortcut patcher is scoped** — the auto-fix only modifies `.lnk` files whose target path contains "Antigravity".

## License

MIT