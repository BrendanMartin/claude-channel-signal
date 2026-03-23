#!/usr/bin/env npx tsx
/**
 * Device linking for Signal channel.
 *
 * Exports linkDevice() for use by setup.ts.
 * Also runs standalone via `npm run link`.
 */
import { spawn, exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { toString } from "qrcode";

const IS_WIN = platform() === "win32";

export function findSignalCli(envFile?: string): string {
  const file = envFile ?? join(homedir(), ".claude", "channels", "signal", ".env");
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^SIGNAL_CLI_PATH=(.+)$/);
      if (m) {
        const p = m[1];
        if (IS_WIN && p.startsWith("/")) {
          const winPath = p.replace(/^\/([a-z])\//, (_, d: string) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\");
          if (existsSync(winPath)) return winPath;
          const batPath = winPath.replace(/\\signal-cli$/, "\\signal-cli.bat");
          if (existsSync(batPath)) return batPath;
        }
        if (existsSync(p)) return p;
      }
    }
  } catch {}

  const defaultDir = join(homedir(), ".local", "share", "signal-cli", "bin");
  if (IS_WIN) {
    const bat = join(defaultDir, "signal-cli.bat");
    if (existsSync(bat)) return bat;
  }
  const bin = join(defaultDir, "signal-cli");
  if (existsSync(bin)) return bin;

  return "signal-cli";
}

function openInBrowser(filePath: string): void {
  const cmd = IS_WIN ? `start "" "${filePath}"` :
    platform() === "darwin" ? `open "${filePath}"` :
    `xdg-open "${filePath}"`;
  exec(cmd);
}

/**
 * Link a device via signal-cli. Opens QR code in browser with countdown.
 * Returns the account phone number on success.
 */
export function linkDevice(signalCliPath: string, deviceName = "Claude Code"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(signalCliPath, ["link", "-n", IS_WIN ? `"${deviceName}"` : deviceName], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: IS_WIN,
    });

    let gotUri = false;
    let account = "";

    child.stdout.on("data", async (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (line.startsWith("sgnl://") && !gotUri) {
          gotUri = true;

          const svg = await toString(line, { type: "svg", margin: 2, width: 400 });
          const http = await import("node:http");
          let linkDone = false;
          const srv = http.createServer((_, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.end(linkDone ? "done" : "waiting");
          });

          srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as any).port;
            const html = `<!DOCTYPE html>
<html><head><title>Signal Link</title></head>
<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:system-ui;background:#f5f5f5">
<h2>Scan with Signal</h2>
<p style="color:#666">Settings &gt; Linked Devices &gt; Link New Device</p>
${svg}
<p id="timer" style="color:#999;margin-top:1em;font-size:14px"></p>
<script>
let sec=60;const el=document.getElementById("timer");
const ti=setInterval(()=>{sec--;el.textContent=sec>0?"Expires in "+sec+"s":"Expired — run setup again";if(sec<=10)el.style.color="#c33";if(sec<=0)clearInterval(ti)},1000);
setInterval(()=>fetch("http://127.0.0.1:${port}").then(r=>r.text()).then(t=>{if(t==="done"){document.body.innerHTML="<h2 style='margin-top:40vh'>Linked!</h2><p style='color:#666'>You can close this tab.</p>";clearInterval(ti);setTimeout(()=>window.close(),1000)}}),1000);
</script>
</body></html>`;
            const htmlPath = join(tmpdir(), "signal-link-qr.html");
            writeFileSync(htmlPath, html);
            openInBrowser(htmlPath);

            (child as any)._closeBrowser = () => {
              linkDone = true;
              setTimeout(() => srv.close(), 3000);
            };
          });

          console.error("  QR code opened in browser. Scan it now...");
        } else if (line && gotUri) {
          const phoneMatch = line.match(/(\+\d+)/);
          if (phoneMatch) account = phoneMatch[1];
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const match = data.toString().match(/from (\+\d+)/);
      if (match) account = match[1];
    });

    child.on("close", (code) => {
      (child as any)._closeBrowser?.();
      if (code === 0 && account) {
        setTimeout(() => resolve(account), 3500);
      } else {
        reject(new Error(`Linking failed (exit code ${code})`));
      }
    });

    child.on("error", reject);
  });
}

// --- Standalone entry point ---
const entrypoint = process.argv[1];
if (entrypoint && (entrypoint.includes("link.ts") || entrypoint.includes("link.js"))) {
  const signalCliPath = findSignalCli();
  console.error(`Using: ${signalCliPath}`);
  console.error(`Linking as: "Claude Code"\n`);
  linkDevice(signalCliPath)
    .then((account) => { console.error(`\n  ✓ Linked as ${account}`); process.exit(0); })
    .catch((err) => { console.error(`\n  ✗ ${err.message}`); process.exit(1); });
}
