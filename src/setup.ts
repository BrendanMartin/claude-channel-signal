#!/usr/bin/env npx tsx
/**
 * Signal channel setup script.
 *
 * 1. Checks Java
 * 2. Downloads signal-cli if missing
 * 3. Links device (QR code in browser)
 * 4. Adds MCP config to ~/.claude.json
 * 5. Installs global slash commands
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { get } from "node:https";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import tar from "tar";
import { linkDevice } from "./link.js";

const IS_WIN = platform() === "win32";
const SIGNAL_CLI_DIR = join(homedir(), ".local", "share", "signal-cli");
const SCRIPT_DIR = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")));
const REPO_DIR = resolve(SCRIPT_DIR, "..");

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question(question, (answer) => { rl.close(); res(answer.trim()); });
  });
}

function log(msg: string) { console.error(msg); }
function step(n: number, name: string) { log(`\n[${n}/5] ${name}`); }
function ok(msg: string) { log(`  ✓ ${msg}`); }
function fail(msg: string) { log(`  ✗ ${msg}`); process.exit(1); }

// --- Step 1: Check Java ---

function checkJava(): void {
  step(1, "Check Java");
  try {
    const out = execSync("java -version 2>&1", { encoding: "utf8" });
    const match = out.match(/version "(\d+)/);
    if (match && parseInt(match[1]) >= 25) {
      ok(`Java ${match[1]} found`);
    } else {
      fail(`Java 25+ required. Found: ${out.trim()}\nInstall from https://adoptium.net/temurin/releases/?package=jre`);
    }
  } catch {
    fail("Java not found. Install Java 25+ from https://adoptium.net/temurin/releases/?package=jre");
  }
}

// --- Step 2: Install signal-cli ---

function findSignalCli(): string | null {
  try {
    const out = execSync("signal-cli --version 2>&1", { encoding: "utf8" });
    if (out.includes("signal-cli")) return "signal-cli";
  } catch {}

  const bin = IS_WIN
    ? join(SIGNAL_CLI_DIR, "bin", "signal-cli.bat")
    : join(SIGNAL_CLI_DIR, "bin", "signal-cli");
  if (existsSync(bin)) return bin;

  return null;
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "signal-channel-setup" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location!).then(resolve, reject);
      }
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function installSignalCli(): Promise<string> {
  step(2, "Install signal-cli");

  const existing = findSignalCli();
  if (existing) {
    const version = execSync(`"${existing}" --version 2>&1`, { encoding: "utf8" }).trim();
    ok(`${version} found at ${existing}`);
    return existing;
  }

  log("  Downloading signal-cli...");

  const json = await httpsGet("https://api.github.com/repos/AsamK/signal-cli/releases/latest");
  const version = JSON.parse(json).tag_name.replace(/^v/, "");
  log(`  Latest version: ${version}`);

  const url = `https://github.com/AsamK/signal-cli/releases/download/v${version}/signal-cli-${version}.tar.gz`;
  mkdirSync(SIGNAL_CLI_DIR, { recursive: true });

  // Download and extract using Node (no curl/tar dependency)
  await new Promise<void>((resolve, reject) => {
    const download = (u: string) => {
      get(u, { headers: { "User-Agent": "signal-channel-setup" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return download(res.headers.location!);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(tar.extract({ cwd: SIGNAL_CLI_DIR, strip: 1 }))
          .on("finish", resolve)
          .on("error", reject);
      }).on("error", reject);
    };
    download(url);
  });

  if (!IS_WIN) {
    chmodSync(join(SIGNAL_CLI_DIR, "bin", "signal-cli"), 0o755);
  }

  const bin = IS_WIN
    ? join(SIGNAL_CLI_DIR, "bin", "signal-cli.bat")
    : join(SIGNAL_CLI_DIR, "bin", "signal-cli");

  const ver = execSync(`"${bin}" --version 2>&1`, { encoding: "utf8" }).trim();
  ok(`${ver} installed to ${SIGNAL_CLI_DIR}`);
  return bin;
}

// --- Step 3: Link device (uses link.ts) ---

async function doLinkDevice(signalCliPath: string): Promise<string> {
  step(3, "Link device");
  log("  Get your phone ready — a QR code will open in your browser.");
  log("  Open Signal > Settings > Linked Devices > Link New Device\n");

  const account = await linkDevice(signalCliPath);
  ok(`Linked as ${account}`);
  return account;
}

// --- Step 4: Configure Claude Code ---

async function configureClaudeCode(signalCliPath: string, account: string): Promise<void> {
  step(4, "Configure Claude Code");

  const configPath = join(homedir(), ".claude.json");
  const serverPath = join(REPO_DIR, "src", "signal.ts");

  const entry = IS_WIN
    ? { type: "stdio", command: "cmd", args: ["/c", "npx", "tsx", serverPath], env: { SIGNAL_ACCOUNT: account, SIGNAL_CLI_PATH: signalCliPath } }
    : { type: "stdio", command: "npx", args: ["tsx", serverPath], env: { SIGNAL_ACCOUNT: account, SIGNAL_CLI_PATH: signalCliPath } };

  log("\n  MCP server config:");
  log(`  ${JSON.stringify({ signal: entry }, null, 2).split("\n").join("\n  ")}`);

  if (!process.argv.includes("--yes")) {
    const answer = await ask("\n  Add to ~/.claude.json? [Y/n] ");
    if (answer.toLowerCase() === "n") {
      log("  Skipped. Add the config above to ~/.claude.json manually.");
      return;
    }
  }

  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    config = {};
  }

  config.mcpServers = config.mcpServers || {};
  config.mcpServers.signal = entry;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  ok("Added to ~/.claude.json");
}

// --- Step 5: Install skills ---

function installSkills(): void {
  step(5, "Install slash commands");

  const skillsDir = join(homedir(), ".claude", "skills");
  const srcSkills = join(REPO_DIR, "skills");
  const skills = ["signal-access", "signal-send", "signal-uninstall"];

  for (const skill of skills) {
    const src = join(srcSkills, skill, "SKILL.md");
    if (!existsSync(src)) continue;
    const dest = join(skillsDir, skill);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), readFileSync(src, "utf8"));
  }
  ok(`Installed: ${skills.map(s => "/" + s.replace("signal-", "signal:")).join(", ")}`);
}

// --- Main ---

async function main() {
  log("\nSignal Channel Setup");
  log("====================\n");
  log("This will set up the Signal channel for Claude Code.");
  log("You'll be able to message Claude from your phone via Note to Self.\n");

  checkJava();
  const signalCliPath = await installSignalCli();
  const account = await doLinkDevice(signalCliPath);
  await configureClaudeCode(signalCliPath, account);
  installSkills();

  log("\n====================");
  log("Setup complete!\n");
  log("Start Claude Code with the channel:");
  log("  claude --dangerously-load-development-channels server:signal\n");
  log("Then send a Note to Self on Signal. Claude will see it and reply.");
  log("");
  log("Tip: To avoid all Note to Self messages going to Claude, set a prefix.");
  log('Start messages with "cc" (or your chosen prefix) to route them to Claude.');
  log('Add SIGNAL_PREFIX to your MCP config in ~/.claude.json:');
  log('  "env": { "SIGNAL_ACCOUNT": "...", "SIGNAL_PREFIX": "cc" }');
  log("");
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
