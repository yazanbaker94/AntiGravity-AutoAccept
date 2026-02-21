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

The extension needs Chrome DevTools Protocol to click buttons. On first launch, if the debug port is not open, the extension will show an error with **"Auto-Fix Shortcut (Windows)"** — click it to automatically patch your shortcut.

**Manual method:** Right-click your Antigravity shortcut → Properties → add to Target:
```
--remote-debugging-port=9222
```

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