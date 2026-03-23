import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { platform } from "node:os";
import { Socket } from "node:net";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.js";

interface DaemonConfig {
  signalCliPath: string;
  account: string;
  port: number;
}

interface VersionInfo {
  version: string;
  supported: boolean;
}

export function checkSignalCliVersion(output: string): VersionInfo {
  const match = output.match(/signal-cli\s+(\d+\.\d+\.\d+)/i);
  if (!match) return { version: "unknown", supported: false };

  const version = match[1];
  const [major, minor] = version.split(".").map(Number);
  const supported = major > 0 || (major === 0 && minor >= 13);
  return { version, supported };
}

/** Check if a TCP port is already in use by trying to connect. */
function checkPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

export class DaemonManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private restartCount = 0;
  private maxRestarts = 3;
  private stopping = false;
  private config: DaemonConfig;
  private reusedExisting = false;

  constructor(config: DaemonConfig) {
    super();
    this.config = config;
  }

  getSpawnArgs(): string[] {
    return [
      "-a", this.config.account,
      "daemon", "--tcp", `localhost:${this.config.port}`,
    ];
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;

    // Check if port is already in use (reuse existing daemon)
    const portInUse = await checkPort("localhost", this.config.port);
    if (portInUse) {
      this.emit("log", `Port ${this.config.port} already in use - reusing existing daemon`);
      this.reusedExisting = true;
      return;
    }

    await this.spawn();
  }

  private async spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = this.getSpawnArgs();
      this.emit("log", `Spawning: ${this.config.signalCliPath} ${args.join(" ")}`);

      this.process = spawn(this.config.signalCliPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Write PID so uninstall can find and kill this specific process
      if (this.process.pid) {
        const pidFile = join(STATE_DIR, "daemon.pid");
        try {
          mkdirSync(STATE_DIR, { recursive: true });
          writeFileSync(pidFile, String(this.process.pid));
        } catch {}
      }

      let started = false;

      this.process.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        this.emit("log", `[signal-cli] ${text.trim()}`);
        if (!started && text.includes("Listening")) {
          started = true;
          resolve();
        }
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        this.emit("log", `[signal-cli stdout] ${data.toString().trim()}`);
      });

      this.process.on("error", (err) => {
        if (!started) {
          started = true;
          reject(err);
        }
        this.emit("error", err);
      });

      this.process.on("close", (code) => {
        this.emit("log", `signal-cli daemon exited with code ${code}`);
        this.process = null;
        if (!this.stopping) this.maybeRestart();
      });

      // Fallback: if daemon doesn't print "Listening" within 30s, assume ready
      setTimeout(() => {
        if (!started) {
          started = true;
          resolve();
        }
      }, 30_000);
    });
  }

  private async maybeRestart(): Promise<void> {
    if (this.restartCount >= this.maxRestarts) {
      this.emit("error", new Error(
        `signal-cli daemon crashed ${this.maxRestarts} times, giving up`
      ));
      return;
    }
    this.restartCount++;
    const delay = Math.min(1000 * Math.pow(2, this.restartCount), 30_000);
    this.emit("log", `Restarting daemon in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);
    await new Promise((r) => setTimeout(r, delay));
    if (!this.stopping) {
      try { await this.spawn(); } catch (err) { this.emit("error", err); }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;

    // Clean up PID file
    try { unlinkSync(join(STATE_DIR, "daemon.pid")); } catch {}

    if (this.reusedExisting || !this.process) return;

    const pid = this.process.pid;
    if (!pid) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          if (platform() === "win32") {
            spawn("taskkill", ["/T", "/F", "/PID", pid.toString()]);
          } else {
            this.process?.kill("SIGKILL");
          }
        } catch {}
        resolve();
      }, 5_000);

      this.process!.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      if (platform() === "win32") {
        spawn("taskkill", ["/T", "/PID", pid.toString()]);
      } else {
        this.process!.kill("SIGTERM");
      }
    });
  }

  isRunning(): boolean {
    return this.reusedExisting || (this.process !== null && !this.process.killed);
  }
}
