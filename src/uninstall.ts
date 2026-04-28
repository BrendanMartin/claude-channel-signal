#!/usr/bin/env npx tsx
/**
 * Signal channel uninstall script.
 *
 * 1. Kills signal-cli daemon
 * 2. Unregisters linked device
 * 3. Removes signal-cli
 * 4. Removes channel state
 * 5. Removes MCP config from ~/.claude.json
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";

const IS_WIN = platform() === "win32";
const STATE_DIR = join(homedir(), ".claude", "channels", "signal");
const SIGNAL_CLI_DIR = join(homedir(), ".local", "share", "signal-cli");
const ENV_FILE = join(STATE_DIR, ".env");
const PID_FILE = join(STATE_DIR, "daemon.pid");
const CLAUDE_CONFIG = join(homedir(), ".claude.json");

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question(question, (answer) => { rl.close(); res(answer.trim()); });
  });
}

function log(msg: string) { console.error(msg); }
function ok(msg: string) { log(`  ✓ ${msg}`); }

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}

// --- Step 1: Kill daemon ---

function killDaemon(): void {
  log("\n[1/6] Stop signal-cli daemon");

  // Try PID file first
  try {
    const pid = readFileSync(PID_FILE, "utf8").trim();
    if (IS_WIN) {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } else {
      process.kill(parseInt(pid), "SIGTERM");
    }
    ok(`Killed daemon (PID ${pid})`);
    return;
  } catch {}

  // Fallback: find signal-cli process
  if (IS_WIN) {
    try {
      execSync('wmic process where "commandline like \'%signal-cli%\'" call terminate', { stdio: "ignore" });
      ok("Killed signal-cli process");
      return;
    } catch {}
  } else {
    try {
      execSync("pkill -f signal-cli", { stdio: "ignore" });
      ok("Killed signal-cli process");
      return;
    } catch {}
  }

  ok("No daemon running");
}

// --- Step 2: Unregister device ---

async function unregisterDevice(): Promise<void> {
  log("\n[2/6] Unregister linked device");

  const env = readEnv();
  const signalCli = env.SIGNAL_CLI_PATH || findSignalCli();
  const account = env.SIGNAL_ACCOUNT;

  if (!signalCli || !account) {
    ok("Skipped (no account configured)");
    return;
  }

  // Clean SQLite locks from force-kill
  try {
    const dataDir = join(SIGNAL_CLI_DIR, "data");
    if (existsSync(dataDir)) {
      for (const entry of readdirSync(dataDir)) {
        const d = join(dataDir, entry);
        if (entry.endsWith(".d") && existsSync(d)) {
          try { rmSync(join(d, "account.db-shm"), { force: true }); } catch {}
          try { rmSync(join(d, "account.db-wal"), { force: true }); } catch {}
        }
      }
    }
  } catch {}

  try {
    execSync(`"${signalCli}" -a ${account} unregister`, {
      stdio: "ignore",
      timeout: 30000,
    });
    ok(`Unregistered ${account}`);
  } catch {
    log("  ⚠ Unregister failed or timed out. Remove 'Claude Code' from Signal on your phone manually:");
    log("    Settings > Linked Devices > Claude Code > Remove");
  }
}

function findSignalCli(): string | null {
  const bin = IS_WIN
    ? join(SIGNAL_CLI_DIR, "bin", "signal-cli.bat")
    : join(SIGNAL_CLI_DIR, "bin", "signal-cli");
  return existsSync(bin) ? bin : null;
}

// --- Step 3: Remove signal-cli ---

function removeSignalCli(): void {
  log("\n[3/6] Remove signal-cli");
  if (existsSync(SIGNAL_CLI_DIR)) {
    rmSync(SIGNAL_CLI_DIR, { recursive: true, force: true });
    ok(`Deleted ${SIGNAL_CLI_DIR}`);
  } else {
    ok("Already removed");
  }
}

// --- Step 4: Remove channel state ---

function removeState(): void {
  log("\n[4/6] Remove channel state");
  if (existsSync(STATE_DIR)) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    ok(`Deleted ${STATE_DIR}`);
  } else {
    ok("Already removed");
  }
}

// --- Step 5: Remove global skills ---

function removeSkills(): void {
  log("\n[5/6] Remove global skills");
  const skillsDir = join(homedir(), ".claude", "skills");
  const skills = ["signal-access", "signal-send", "signal-uninstall"];
  for (const skill of skills) {
    const dir = join(skillsDir, skill);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  ok("Removed signal skills");
}

// --- Step 6: Remove MCP config ---

function removeMcpConfig(): void {
  log("\n[6/6] Remove MCP config");
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG, "utf8"));
    if (config.mcpServers?.signal) {
      delete config.mcpServers.signal;
      writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2));
      ok("Removed 'signal' from ~/.claude.json");
    } else {
      ok("Not in config");
    }
  } catch {
    ok("No config to update");
  }
}

// --- Main ---

async function main() {
  const keepSignalCli = process.argv.includes("--keep-signal-cli");

  log("\nSignal Channel Uninstall");
  log("========================\n");

  killDaemon();

  // Wait for locks to release
  await new Promise((r) => setTimeout(r, 2000));

  await unregisterDevice();

  if (!keepSignalCli) {
    removeSignalCli();
  } else {
    log("\n[3/6] Remove signal-cli");
    ok("Kept (--keep-signal-cli)");
  }

  removeState();
  removeSkills();
  removeMcpConfig();

  log("\n========================");
  log("Uninstall complete.\n");
  log("Also remove 'Claude Code' from Signal on your phone:");
  log("  Settings > Linked Devices > Claude Code > Remove\n");
}

main().catch((err) => {
  console.error(`\nUninstall failed: ${err.message}`);
  process.exit(1);
});
