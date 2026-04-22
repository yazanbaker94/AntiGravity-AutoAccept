# 🐝 Swarm Mode Pro — Complete Guide

> Run unlimited background agents completely hands-free — and control them from your phone.

---

## What is Swarm Mode?

**The problem:** Antigravity's Agent Manager uses a **single shared webview**. Only the currently visible conversation's DOM is rendered — background conversations are fully unmounted. This means AutoAccept (and even Antigravity's own VS Code APIs) can only reach the **active conversation**. If you have 5 agents running, you need to manually click through each one.

**The solution:** Swarm Mode uses Chrome DevTools Protocol (CDP) to **automatically navigate between all your pending Agent Manager conversations**, clicking Accept/Run/Allow buttons across every agent — not just the one you're looking at.

**The result:** Start multiple agents, minimize the window, and walk away. Swarm handles everything.

### How it works

1. Swarm detects all active Agent Manager panels via CDP
2. It cycles through each conversation, checking for pending buttons
3. When it finds Accept, Run, Allow, or Continue — it clicks them
4. It moves to the next conversation and repeats
5. Pause state is preserved across re-injections — your workflow stays intact

---

## Plans & Pricing

AutoAccept Pro includes **Swarm Mode** and **Telegram Remote Control** in a single subscription with a free trial.

### 🛒 Get Started

👉 [**Start Free Trial**](https://yazanbake.gumroad.com/l/auto-accept)

Choose Monthly or Yearly at checkout. After purchase, Gumroad will email you a **license key**. Keep it safe — you'll paste it into the dashboard to activate.

---

## How to Activate

### Step 1: Open the AutoAccept Dashboard

Click the **📊 Dashboard** button in your status bar at the bottom of Antigravity:

![Status bar showing Dashboard and Swarm buttons](swarm%20in%20status%20bar.png)

Or use: `Ctrl+Shift+P` → `AntiGravity AutoAccept: Open Dashboard`

### Step 2: Find the Swarm Mode Card

At the top of the dashboard, you'll see the **👑 Swarm Mode (Pro)** card with the golden border:

![Swarm Mode activation card in the dashboard](Swarm%20mode%20activation.png)

### Step 3: Paste Your License Key

1. Copy your license key from the Gumroad purchase confirmation email
2. Paste it into the **"Paste your Gumroad license key..."** field
3. Click the **Activate** button

### Step 4: Verify Activation

Once validated, you'll see:

- ✅ **"✓ Active"** (with your plan type) below the license field
- The status bar will show **▶ Swarm** indicating Swarm Mode is ready

> **Note:** Swarm Mode activates automatically when the Agent Manager connects. You don't need to toggle anything extra — just start your agents!

---

## How to Use Swarm Mode

### Starting Multiple Agents

1. **Make sure AutoAccept is ON** (⚡ Auto: ON in the status bar)
2. Open the **Agent Manager** panel in Antigravity
3. Start multiple conversations — give each agent a different task
4. Swarm automatically detects all active agent panels and handles Accept/Run/Allow across all of them

![Agent Manager with multiple conversations](agent%20manager%20window.png)

### Pause & Resume

- Click **▶ Swarm** in the status bar to **pause** Swarm (it will show ⏸ Swarm)
- Click again to **resume**
- Swarm remembers pause state even when agents reconnect

### Status Bar Indicators

| Icon | Meaning |
|------|---------|
| `⚡ Auto: ON` | AutoAccept is active |
| `▶ Swarm` | Swarm Mode is running |
| `⏸ Swarm` | Swarm Mode is paused |
| `📊 Dashboard` | Opens the full dashboard |

---

## 📱 Telegram Remote Control

Control your agents from your phone via Telegram. Send prompts, receive AI responses, peek at screenshots — all without touching your computer.

### Setup

1. **Activate Swarm Mode first** (see above)
2. In the Dashboard, click **🤖 Connect Telegram**
3. Your browser opens a link to the **AutoAccept Bot** on Telegram
4. Tap **Start** — your Telegram is now paired to your IDE

> **Tip:** Use the **☰ Menu** button next to your Telegram chat input for quick access to all commands.

### Available Commands

| Command | Description |
|---------|-------------|
| `/list` | Show all active agent conversations with inline buttons |
| `/peek` | Take a full screenshot of your IDE |
| `/peek N` | Screenshot a specific agent window (e.g. `/peek 2`) |
| `/pause` | Pause AutoAccept + Swarm Mode |
| `/resume` | Resume AutoAccept + Swarm Mode |
| `/stop` | Emergency stop — halt all active agents |
| `/status` | Show connection info, heartbeat, and active agent count |
| `/disconnect` | Unpair your Telegram from the IDE |

### Sending Prompts

1. **Select an agent** — Use `/list` and tap a button, or type `/1`, `/2`, etc.
2. **Type your message** — Any plain text is sent as a prompt to the selected agent
3. **Send photos** — Attach an image with an optional caption to paste it into the agent's chat
4. **Get responses** — The bot relays the AI's response text + a screenshot back to you

#### Quick Select Syntax

| Syntax | What it does |
|--------|-------------|
| `/1` | Select agent #1 (sticky — all future messages go here) |
| `/3 fix the login bug` | Send "fix the login bug" directly to agent #3 |
| `any text` | Sends to your currently selected (sticky) agent |

### How It Works

```
📱 Telegram → ☁️ Cloudflare Worker → 💻 IDE Extension → 🤖 Agent
                                          ↓
📱 Telegram ← ☁️ Cloudflare Worker ← 💻 Response Watcher
```

1. Your message hits a Cloudflare Worker secured with **HMAC-SHA256 signatures**
2. The IDE polls the worker and picks up queued commands
3. The prompt is injected into the selected agent's chat via CDP
4. A MutationObserver watches for the AI response
5. When complete, the response text + screenshot are relayed back to Telegram

> **Security:** All communication between the IDE and the Cloudflare Worker is signed with method-bound HMAC-SHA256. Your prompts and responses are never stored permanently — they're processed and deleted atomically.

---

## Frequently Asked Questions

### Does Swarm work with SSH Remote?
No — SSH Remote environments disable the Chrome DevTools Protocol. In Remote sessions, AutoAccept falls back to **Channel 1 only** (VS Code command polling), which works for the active conversation but cannot navigate between agents.

### Can I use my key on multiple machines?
Yes — up to **3 machines** per license key. If you activate a 4th device, the oldest one is automatically deactivated (LRU queue). This prevents key sharing while allowing legitimate users to rotate laptops.

### What happens when my subscription expires?
Swarm Mode and Telegram Remote Control deactivate gracefully. AutoAccept's **free features** (Channel 1 polling + Channel 2 DOM observer for the active conversation) continue working normally. You only lose multi-agent navigation and Telegram control.

### Do I still need `--remote-debugging-port=9333`?
**Yes.** Swarm Mode builds on top of CDP, which requires the debug port. Without it, neither Swarm nor the regular DOM observer (Channel 2) can function.

### The dashboard says "Invalid or expired key"
1. Double-check you copied the full key from Gumroad (no leading/trailing spaces)
2. Verify your subscription is active on [Gumroad](https://gumroad.com/library)
3. If it still fails, clear the key field, paste it again, and click Activate
4. Contact **autoaccept@sakinahtime.com** if the issue persists

### How does Swarm differ from "Duplicate Workspace"?
The **Duplicate Workspace** workaround (documented in the README) opens separate Antigravity windows — each with its own webview where AutoAccept runs independently. This works but is heavy on resources (each window is a full Electron process).

Swarm Mode operates **within a single window**, navigating between Agent Manager conversations via CDP. Much lighter, fully automated, zero manual setup per agent.

### Can I use Telegram without Swarm Mode?
Both features are included in the Pro subscription. Telegram requires Swarm Mode to be activated since it uses the same CDP infrastructure to inject prompts and detect responses.

### Is my data safe with Telegram?
Yes. Messages are queued in Cloudflare D1 and **atomically deleted** when the IDE picks them up. No permanent storage. All API calls are HMAC-signed. The Telegram bot cannot access your files or code — it only relays text prompts and responses.

---

## Support

Having issues? Here's how to get help:

1. **Check the Output log:** `Ctrl+Shift+U` → dropdown → `AntiGravity AutoAccept`
2. **Copy Diagnostics:** Open Dashboard → click **📋 Copy Diagnostic Dump** at the bottom
3. **File an issue:** [GitHub Issues](https://github.com/yazanbaker94/AntiGravity-AutoAccept/issues)
4. **Email:** autoaccept@sakinahtime.com
