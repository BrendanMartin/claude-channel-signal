import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface PendingEntry {
  senderId: string;
  senderName: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
}

export interface AccessData {
  dmPolicy: "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  pending: Record<string, PendingEntry>;
}

function defaultAccess(): AccessData {
  return { dmPolicy: "pairing", allowFrom: [], pending: {} };
}

export class AccessManager {
  private filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "access.json");
  }

  list(): string[] {
    return this.read().allowFrom;
  }

  isAllowed(phone: string): boolean {
    const data = this.read();
    if (data.dmPolicy === "disabled") return false;
    return data.allowFrom.includes(phone);
  }

  add(phone: string): void {
    const data = this.read();
    if (!data.allowFrom.includes(phone)) {
      data.allowFrom.push(phone);
      this.write(data);
    }
  }

  remove(phone: string): void {
    const data = this.read();
    data.allowFrom = data.allowFrom.filter((p) => p !== phone);
    this.write(data);
  }

  getPolicy(): AccessData["dmPolicy"] {
    return this.read().dmPolicy;
  }

  setPolicy(mode: AccessData["dmPolicy"]): void {
    const data = this.read();
    data.dmPolicy = mode;
    this.write(data);
  }

  /** Server-initiated: create a pending entry when an unknown sender DMs. */
  createPending(senderId: string, senderName: string): string | null {
    const data = this.read();
    this.pruneExpiredFrom(data);

    // Check if sender already has a pending entry
    for (const [code, p] of Object.entries(data.pending)) {
      if (p.senderId === senderId) return code;
    }

    // Max 3 pending
    if (Object.keys(data.pending).length >= 3) return null;

    const code = randomBytes(3).toString("hex");
    const now = Date.now();
    data.pending[code] = {
      senderId,
      senderName,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1 hour
      replies: 1,
    };
    this.write(data);
    return code;
  }

  /** Get pending entry for a sender (for re-send detection). */
  getPending(senderId: string): { code: string; entry: PendingEntry } | null {
    const data = this.read();
    for (const [code, p] of Object.entries(data.pending)) {
      if (p.senderId === senderId && p.expiresAt > Date.now()) {
        return { code, entry: p };
      }
    }
    return null;
  }

  /** Increment reply counter for rate limiting re-sends. */
  incrementReplies(code: string): void {
    const data = this.read();
    if (data.pending[code]) {
      data.pending[code].replies = (data.pending[code].replies ?? 1) + 1;
      this.write(data);
    }
  }

  /** User-initiated from skill: approve a pending pairing. */
  approvePairing(code: string): { senderId: string; senderName: string } | null {
    const data = this.read();
    const entry = data.pending[code];
    if (!entry || entry.expiresAt < Date.now()) return null;

    if (!data.allowFrom.includes(entry.senderId)) {
      data.allowFrom.push(entry.senderId);
    }
    delete data.pending[code];
    this.write(data);
    return { senderId: entry.senderId, senderName: entry.senderName };
  }

  /** User-initiated from skill: deny a pending pairing. */
  denyPairing(code: string): boolean {
    const data = this.read();
    if (!data.pending[code]) return false;
    delete data.pending[code];
    this.write(data);
    return true;
  }

  /** Remove expired pending entries. Returns true if anything changed. */
  pruneExpired(): boolean {
    const data = this.read();
    const changed = this.pruneExpiredFrom(data);
    if (changed) this.write(data);
    return changed;
  }

  /** Get full state for status display. */
  getStatus(): AccessData {
    const data = this.read();
    this.pruneExpiredFrom(data);
    return data;
  }

  private pruneExpiredFrom(data: AccessData): boolean {
    const now = Date.now();
    let changed = false;
    for (const [code, p] of Object.entries(data.pending)) {
      if (p.expiresAt < now) {
        delete data.pending[code];
        changed = true;
      }
    }
    return changed;
  }

  private read(): AccessData {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AccessData>;
      return {
        dmPolicy: parsed.dmPolicy ?? "pairing",
        allowFrom: parsed.allowFrom ?? [],
        pending: parsed.pending ?? {},
      };
    } catch {
      return defaultAccess();
    }
  }

  private write(data: AccessData): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, this.filePath);
  }
}
