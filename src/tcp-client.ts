import { Socket } from "node:net";
import { EventEmitter } from "node:events";

export interface SignalMessage {
  type: "message";
  sender: string;
  senderName: string;
  text: string;
  timestamp: number;
}

let requestId = 0;

export function parseJsonRpcMessage(raw: string): SignalMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (msg.method !== "receive") return null;

    const envelope = msg.params?.result?.envelope;
    if (!envelope) return null;

    // Regular incoming message
    const dataMessage = envelope.dataMessage;
    if (dataMessage) {
      if (dataMessage.groupInfo) return null;
      if (!dataMessage.message) return null;
      return {
        type: "message" as const,
        sender: envelope.source,
        senderName: envelope.sourceName ?? envelope.source,
        text: dataMessage.message,
        timestamp: envelope.timestamp ?? Date.now(),
      };
    }

    // Sync message (Note to Self / sent from another linked device)
    const sentMessage = envelope.syncMessage?.sentMessage;
    if (sentMessage) {
      if (sentMessage.groupInfo) return null;
      if (!sentMessage.message) return null;
      return {
        type: "message" as const,
        sender: envelope.source,
        senderName: envelope.sourceName ?? envelope.source,
        text: sentMessage.message,
        timestamp: envelope.timestamp ?? Date.now(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function buildJsonRpcRequest(
  method: string,
  params: Record<string, unknown>
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: `req-${++requestId}`,
    method,
    params,
  });
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class SignalTcpClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private reconnectCount = 0;
  // Never stop retrying: the daemon can take 15-20s (or longer, under its own
  // crash-restart backoff) to come back, and a channel that gives up leaves
  // Claude alive but permanently deaf — daemon up, subscription gone.
  // Delay is already capped at 30s, so eternal retries are cheap.
  private maxReconnects = Number.POSITIVE_INFINITY;
  private stopping = false;
  private account: string;

  constructor(
    private host: string,
    private port: number,
    account?: string
  ) {
    super();
    this.account = account ?? "";
  }

  async connect(): Promise<void> {
    this.stopping = false;
    this.reconnectCount = 0;
    await this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();
      this.socket.connect(this.port, this.host, () => {
        this.reconnectCount = 0;
        this.subscribe();
        resolve();
      });
      this.socket.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
      this.socket.on("close", () => {
        this.emit("close");
        if (!this.stopping) this.maybeReconnect();
      });
      this.socket.on("data", (data) => this.onData(data));
    });
  }

  private async maybeReconnect(): Promise<void> {
    if (this.reconnectCount >= this.maxReconnects) {
      this.emit("error", new Error("TCP reconnect failed after max retries"));
      return;
    }
    this.reconnectCount++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectCount), 30_000);
    this.emit("log", `TCP reconnecting in ${delay}ms (attempt ${this.reconnectCount}/${this.maxReconnects})`);
    await new Promise((r) => setTimeout(r, delay));
    if (!this.stopping) {
      try { await this.doConnect(); } catch { /* error emitted via event */ }
    }
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const json = JSON.parse(trimmed);

        if (json.id && this.pending.has(json.id)) {
          const p = this.pending.get(json.id)!;
          this.pending.delete(json.id);
          if (json.error) {
            p.reject(new Error(json.error.message ?? "RPC error"));
          } else {
            p.resolve(json.result);
          }
          continue;
        }

        const msg = parseJsonRpcMessage(trimmed);
        if (msg) {
          this.emit("message", msg);
        }
      } catch {
        // Malformed JSON - skip
      }
    }
  }

  private subscribe(): void {
    const params: Record<string, unknown> = {};
    if (this.account) params.account = this.account;
    const req = buildJsonRpcRequest("subscribeReceive", params);
    this.socket?.write(req + "\n");
  }

  async send(recipient: string, message: string, account?: string, attachments?: string[]): Promise<unknown> {
    const params: Record<string, unknown> = {
      recipient: [recipient],
      message,
    };
    if (account) params.account = account;
    if (attachments && attachments.length > 0) params.attachments = attachments;

    return this.request("send", params);
  }

  /** Mark an inbound message as read on the sender's device (filled check). */
  async sendReceipt(recipient: string, targetTimestamp: number): Promise<unknown> {
    // NB: unlike send, signal-cli's sendReceipt requires recipient as a plain
    // string — an array gets mis-parsed as a phone number (verified live,
    // signal-cli 0.14.5).
    const params: Record<string, unknown> = {
      recipient,
      targetTimestamp,
      type: "read",
    };
    if (this.account) params.account = this.account;
    return this.request("sendReceipt", params);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const req = buildJsonRpcRequest(method, params);
    const parsed = JSON.parse(req);
    const id = parsed.id;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket?.write(req + "\n");

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timeout after 30s`));
        }
      }, 30_000);
    });
  }

  disconnect(): void {
    this.stopping = true;
    this.socket?.destroy();
    this.socket = null;
    for (const [, p] of this.pending) {
      p.reject(new Error("Disconnected"));
    }
    this.pending.clear();
  }
}
