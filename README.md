# Auto Accept for Antigravity

Automatically accept agent steps, terminal commands, file edits, and permission prompts in [Antigravity](https://antigravity.dev) — Google's AI coding assistant.

## What it does

When the Antigravity agent proposes file edits, terminal commands, or asks for tool permissions, this extension auto-accepts them so you don't have to click every button manually.

**Two strategies, zero interference:**

| Strategy | What it handles | How |
|---|---|---|
| **VS Code Commands** (500ms) | File edits, terminal commands, inline chat, agent steps | Calls Antigravity's native accept commands |
| **Targeted CDP** (1500ms) | "Always Allow" / "Allow this conversation" permission dialogs | Shadow DOM-piercing button clicker, scoped to agent panel only |

## Features

- **⚡ 8 VS Code commands** polled with async lock (prevents double-accepts)
- **🔒 Shadow DOM piercing** — survives `<vscode-button>`, `<ag-btn>`, Web Components
- **🌍 i18n-safe** — checks `data-testid` attributes before text matching
- **🔌 17-port CDP scan** — finds Antigravity's debug port automatically
- **📊 Status bar toggle** — click `⚡ Auto: ON` to toggle, state persists across reloads
- **🚫 Zero UI interference** — works minimized, unfocused, in background
- **235 lines** of code, ~10KB total

## Installation

### From VSIX (recommended)

1. Download the latest `.vsix` from [Releases](https://github.com/yazanbaker94/AntiGravity-AutoAccept/releases/)
2. In Antigravity: `Ctrl+Shift+P` → `Extensions: Install from VSIX`
3. Select the downloaded file
4. Reload Window

### Manual

1. Copy `extension.js` and `package.json` to:
   ```
   ~/.antigravity/extensions/YazanBaker.auto-accept-v2-2.1.0/
   ```
2. Run `npm install` in that directory (installs `ws` dependency)
3. Reload Window

## Usage

- **Toggle:** Click `⚡ Auto: ON` / `✕ Auto: OFF` in the status bar
- **Or:** `Ctrl+Shift+P` → `Auto Accept V2: Toggle ON/OFF`
- **Logs:** Output panel → `Auto Accept V2`

## Settings

| Setting | Default | Description |
|---|---|---|
| `autoAcceptV2.pollInterval` | `500` | Polling interval in ms |
| `autoAcceptV2.customButtonTexts` | `[]` | Extra button texts for i18n (e.g. `["toujours autoriser"]`) |

## Commands Polled

| Command | Purpose |
|---|---|
| `antigravity.agent.acceptAgentStep` | File edits, proceed prompts |
| `antigravity.terminalCommand.accept` | Terminal command prompts |
| `antigravity.terminalCommand.run` | Execute terminal commands |
| `antigravity.command.accept` | Inline editor commands |
| `chatEditing.acceptAllFiles` | Batch file acceptance |
| `chatEditing.acceptFile` | Individual file acceptance |
| `inlineChat.acceptChanges` | Inline chat suggestions |
| `interactive.acceptChanges` | Interactive session changes |

See [COMMAND_AUDIT.md](COMMAND_AUDIT.md) for the full audit of 2,834 commands — why each was included or excluded.

## Safety

Commands deliberately **excluded** to prevent harm:

- `notification.acceptPrimaryAction` — would auto-click "Yes" on destructive dialogs
- `workbench.action.chat.editToolApproval` — spams config UI
- `antigravity.prioritized.agentAcceptAllInFile` — causes dual write-locks
- All merge/git conflict commands — could silently pick wrong side
- All autocomplete/suggestion commands — would corrupt typing

## Architecture

```
┌──────────────────────────────────────────┐
│  Auto Accept V2.1                        │
│  ~235 lines │ ~10KB │ YazanBaker         │
├──────────────────────────────────────────┤
│                                          │
│  Strategy 1: VS Code Commands (500ms)    │
│  ├─ 8 commands, async-locked             │
│  ├─ Promise.allSettled (no double-fire)  │
│  └─ Handles 95% of accept actions        │
│                                          │
│  Strategy 2: Targeted CDP (1500ms)       │
│  ├─ Shadow DOM piercing TreeWalker       │
│  ├─ data-testid priority (i18n-safe)     │
│  ├─ 3 button texts + custom setting     │
│  ├─ Fuzzy panel selector                 │
│  └─ Handles permission dialogs only      │
│                                          │
└──────────────────────────────────────────┘
```

## License

MIT