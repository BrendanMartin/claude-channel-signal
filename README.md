# Signal Channel for Claude Code

> **Note:** This has only been tested on Windows. If you're on macOS or Linux, testing and PRs with fixes are very welcome.

Talk to Claude Code from your phone via Signal. Send a Note to Self message, and it arrives in your Claude Code session. Claude can reply back.

## How it works

signal-cli links as a secondary device on your Signal number. When you send a Note to Self, the message syncs to signal-cli, which forwards it to Claude Code as a channel event. Claude's replies come back through Signal.

## Prerequisites

- **Java 25+** — [Adoptium](https://adoptium.net/temurin/releases/?package=jre) / `brew install openjdk` / `apt install openjdk-25-jre-headless`
- **Node.js 21+**
- **Signal** on your phone

## Setup

```bash
git clone <repo-url>
cd signal-channel
npm install
npm run setup
```

The setup script will:
1. Check for Java 25+
2. Download and install signal-cli (if not already installed)
3. Open a QR code in your browser — scan it with Signal to link your device
4. Add the MCP server config to `~/.claude.json`
5. Install slash commands globally

Then start Claude Code with the channel:

```bash
claude --dangerously-load-development-channels server:signal
```

Send a **Note to Self** on Signal. Claude sees it and replies.

## Slash commands

After setup, these are available in any Claude Code session:

| Command | Description |
|---|---|
| `/signal:send <message>` | Send a message to your phone via Signal |
| `/signal:access` | View and manage the sender allowlist |
| `/signal:access pair <code>` | Approve a sender's pairing code |
| `/signal:access policy allowlist` | Lock down to approved senders only |
| `/signal:uninstall` | Remove everything cleanly |

## Configuration

Environment variables (set in the `env` block of your MCP config in `~/.claude.json`):

| Variable | Description | Default |
|---|---|---|
| `SIGNAL_ACCOUNT` | Your phone number (required) | — |
| `SIGNAL_CLI_PATH` | Path to signal-cli binary | `signal-cli` (on PATH) |
| `SIGNAL_DAEMON_PORT` | TCP port for signal-cli daemon | `7583` |
| `SIGNAL_PREFIX` | Only forward messages starting with this prefix | — (all messages) |
| `SIGNAL_ATTACHMENT_ROOT` | If set, `reply`/`send` attachments must be files inside this directory (paths are canonicalized, so symlinks/`..` can't escape it) | — (no restriction) |

### Prefix filtering

If you use Note to Self for other things, set `SIGNAL_PREFIX` so only tagged messages reach Claude:

```json
"env": {
  "SIGNAL_ACCOUNT": "+1234567890",
  "SIGNAL_PREFIX": "cc"
}
```

Then "cc what's the weather" is forwarded (as "what's the weather"), but "buy milk" is ignored. Case-insensitive.

### Using a dedicated number

Instead of Note to Self, you can register signal-cli with a separate phone number as a primary device. This gives Claude its own number that you (and others) can DM directly.

1. Get a number that can receive one SMS (prepaid SIM or eSIM)
2. `signal-cli -a +1NEWNUMBER register`
3. `signal-cli -a +1NEWNUMBER verify <CODE>` (from the SMS)
4. Set `SIGNAL_ACCOUNT=+1NEWNUMBER` in your MCP config

## Uninstall

```bash
cd signal-channel
npm run uninstall
```

Stops the daemon, unregisters the linked device, removes signal-cli, channel state, slash commands, and MCP config. Use `--keep-signal-cli` to keep signal-cli installed.
