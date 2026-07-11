import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const STATE_DIR =
  process.env.SIGNAL_STATE_DIR ?? join(homedir(), ".claude", "channels", "signal");
export const ACCESS_FILE = join(STATE_DIR, "access.json");
export const ENV_FILE = join(STATE_DIR, ".env");

// Load ~/.claude/channels/signal/.env into process.env. Real env wins.
try {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

export interface Config {
  signalAccount: string;
  signalCliPath: string;
  daemonPort: number;
  stateDir: string;
  prefix: string;
  attachmentRoot: string;
}

export function loadConfig(): Config {
  return {
    signalAccount: process.env.SIGNAL_ACCOUNT ?? "",
    signalCliPath: process.env.SIGNAL_CLI_PATH ?? "signal-cli",
    daemonPort: parseInt(process.env.SIGNAL_DAEMON_PORT ?? "7583", 10),
    stateDir: STATE_DIR,
    prefix: process.env.SIGNAL_PREFIX ?? "",
    // If set, attachments may only come from inside this directory
    // (paths are canonicalized first, so symlinks/.. can't escape it).
    // Empty = no restriction.
    attachmentRoot: process.env.SIGNAL_ATTACHMENT_ROOT ?? "",
  };
}
