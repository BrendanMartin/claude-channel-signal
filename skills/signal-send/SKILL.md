---
name: signal:send
description: Send a message to your phone via Signal. Use when the user wants to send something to their phone.
user_invocable: true
---

# /signal:send

Send a message to the user's phone via Signal.

Arguments passed: `$ARGUMENTS`

Use the `send` MCP tool (from the signal server) with `text` set to `$ARGUMENTS`.
If `$ARGUMENTS` is empty, ask the user what they want to send.
