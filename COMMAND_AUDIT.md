# Auto-Accept V2.1 — Command Audit

Full audit of all 2,834 registered VS Code commands. Filtered for `accept`, `allow`, `approve`, `confirm`, `grant`, `permit`, `trust` keywords.

> [!IMPORTANT]
> DeepThink confirmed: **No hidden commands exist for tool/MCP approval.** Google intentionally isolates these in the webview UI. Our CDP scraper is the only viable approach — and it's inherently future-proof because all future tools will fire the same `ask_tool_permission` webview payload.

---

## ✅ Commands We Poll (8 total)

| Command | Purpose |
|---|---|
| `antigravity.agent.acceptAgentStep` | Core — accepts file edits, proceed prompts, all agent steps |
| `antigravity.terminalCommand.accept` | Accepts "Run this command?" prompts |
| `antigravity.terminalCommand.run` | Executes terminal commands |
| `antigravity.command.accept` | Accepts inline editor commands |
| `chatEditing.acceptAllFiles` | Batch accepts all pending file changes |
| `chatEditing.acceptFile` | Accepts individual file change |
| `inlineChat.acceptChanges` | Accepts inline chat suggestions (Ctrl+I) |
| `interactive.acceptChanges` | Accepts interactive session changes |

---

## ❌ Commands We Deliberately Exclude

### DANGEROUS — Auto-clicking would cause harm

| Command | Why excluded | Risk |
|---|---|---|
| `notification.acceptPrimaryAction` | **Global** — clicks "Yes" on ANY notification | Would auto-confirm "Delete workspace?", "Restart server?", "Update extension?" — any destructive dialog |
| `workbench.action.chat.editToolApproval` | Opens the tool approval **configuration dialog** | Spams the config UI every 500ms, blocking all user interaction |
| `antigravity.prioritized.agentAcceptAllInFile` | Uses priority fast-lane queue, bypasses main event loop | **Dual write-lock** — fires simultaneously with `acceptAgentStep`, both try to write the same file via TextEdit worker |
| `chat.toolOutput.save` | Opens OS "Save As" dialog for large tool outputs | Spams file-save dialogs every 500ms |
| `git.acceptMerge` | Auto-accepts one side of a git merge conflict | Could silently pick the wrong side, overwriting important code |
| `workbench.files.action.acceptLocalChanges` | Auto-accepts local file version during merge conflicts | Same risk — silently resolves conflicts without human review |
| `merge.acceptAllInput1` / `merge.acceptAllInput2` | Auto-accepts all changes from one merge side | Blindly picks a side in every merge conflict |
| `mergeEditor.acceptAllCombination` | Accepts combined merge result | Could silently accept broken merge output |
| `mergeEditor.acceptMerge` | Accepts the final merge | Same — no human review of merge quality |

### INTERFERENCE — Would break normal VS Code workflows

| Command | Why excluded | Risk |
|---|---|---|
| `acceptSelectedSuggestion` | Accepts autocomplete suggestions | Would auto-accept random completions while you're typing |
| `acceptAlternativeSelectedSuggestion` | Accepts alternative autocomplete | Same — corrupts typing flow |
| `acceptSelectedSuggestionOnEnter` | Enter-key autocomplete acceptance | Would intercept Enter presses |
| `focusAndAcceptSuggestion` | Focus + accept combo | Auto-focuses and accepts random suggestions |
| `acceptRenameInput` | Accepts rename dialog | Would auto-confirm accidental renames |
| `acceptSnippet` | Accepts snippet expansion | Would auto-expand snippets mid-typing |
| `quickInput.accept` | Accepts whatever is in the quick input box | Would auto-confirm command palette selections |
| `scm.acceptInput` | Accepts source control input | Would auto-submit incomplete commit messages |
| `breakpointWidget.action.acceptInput` | Accepts breakpoint condition | Would auto-confirm wrong breakpoint conditions |
| `repl.action.acceptInput` | Accepts REPL input | Would auto-submit incomplete REPL commands |

### SAFE BUT UNNECESSARY

| Command | Why skipped | Add if... |
|---|---|---|
| `git.commitMessageAccept` | Auto-accepts AI-generated commit messages | You want fully automated commits. Risk: commits with bad messages |
| `notebook.inlineChat.acceptChangesAndRun` | Accepts + runs notebook cell changes | You use Jupyter notebooks with Antigravity |
| `workbench.action.terminal.acceptSelectedSuggestion` | Accepts terminal autocomplete | You want terminal autocomplete automated (low risk) |
| `editor.action.accessibleViewAcceptInlineCompletion` | Accessibility version of inline accept | Only relevant for accessibility mode |
| `editor.action.inlineSuggest.acceptNextWord` | Accepts next word of inline suggestion | Could interfere with manual coding |
| `editor.action.inlineSuggest.acceptNextLine` | Accepts next line of inline suggestion | Same interference risk |

---

## How to Add Excluded Commands

If you want to enable a currently excluded command (at your own risk):

1. Open `v2/extension.js`
2. Add the command string to the `ACCEPT_COMMANDS` array
3. Copy to `~/.antigravity/extensions/YazanBaker.auto-accept-v2-2.0.0/extension.js`
4. Reload Window

Example — adding commit message auto-accept:
```javascript
const ACCEPT_COMMANDS = [
    // ... existing commands ...
    'git.commitMessageAccept',  // ⚠️ Auto-accepts AI commit messages
];
```

---

## 🔍 Questions for DeepThink

### 1. Hidden Antigravity-Specific Commands
We found `antigravity.prioritized.agentAcceptAllInFile` which isn't documented anywhere. Are there other internal Antigravity commands for:
- **Tool approval** (the "Always Allow" / "Allow this conversation" prompt) — is there a direct VS Code command for this, or is it purely webview-UI?
- **MCP server approval** — when connecting to a new MCP server, is there a programmatic accept?
- **Workspace trust** — `antigravity.showBrowserAllowlist` exists but only shows a list. Is there a command to programmatically add to it?

### 2. `antigravity.prioritized.*` Namespace
We found these priority commands:
```
antigravity.prioritized.agentAcceptAllInFile
antigravity.prioritized.agentFocusNextFile
antigravity.prioritized.agentFocusPreviousFile  
antigravity.prioritized.agentRejectAllInFile
antigravity.prioritized.explainProblem
```
What does the `prioritized` prefix mean? Are these dispatched through a different queue than `antigravity.agent.acceptAgentStep`? Could calling both cause conflicts?

### 3. Future Command Surface
When Antigravity adds new tools (e.g., database queries, API calls, deployment), will new `antigravity.*.accept` commands be added? Or will tool approvals always live in the webview UI layer?

---

## 🧠 DeepThink Answers (Verified)

### Tool/MCP Approval
No hidden commands exist. Google intentionally isolates approvals in the webview UI to prevent malicious extensions from silently granting agents filesystem/server access. Approvals use dynamic per-session RPC IDs that can't be replayed via command palette.

### `antigravity.prioritized.*` Namespace
These are a **fast-lane queue** bound to UI hotkeys (like `Ctrl+Enter` in an active diff). They bypass the main event loop for instant response. **Conflict risk is HIGH** — firing `acceptAgentStep` and `agentAcceptAllInFile` simultaneously causes dual write-locks on the same file via VS Code's TextEdit worker. **Keep only the standard commands.**

### Future Tools
No new `*.accept` commands will be added. The AI ecosystem is standardizing around a **generic ToolCalling API** — every new tool fires the same `ask_tool_permission` webview payload. Our CDP text-scraper is inherently future-proof.

### `chat.toolOutput.save`
Opens the OS "Save As" file dialog for large tool outputs (5MB+ database dumps, log files). Not permission-related. **Exclude it** — would spam file-save dialogs.
