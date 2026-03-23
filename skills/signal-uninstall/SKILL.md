---
name: signal:uninstall
description: Remove Signal channel - stops daemon, unlinks device, removes signal-cli, config, and skills
user_invocable: true
---

# /signal:uninstall

Remove the Signal channel completely.

Arguments passed: `$ARGUMENTS`

Run from the signal-channel repo directory:

```bash
npm run uninstall
```

If `$ARGUMENTS` contains `--keep-signal-cli`:
```bash
npm run uninstall -- --keep-signal-cli
```

The script handles everything: stops the daemon, unregisters the device,
removes signal-cli, channel state, MCP config, and global skills.

Tell the user to also remove "Claude Code" from Signal on their phone:
Settings > Linked Devices > Claude Code > Remove.
