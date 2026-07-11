import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { getReplyToolSchema, handleReply, gate, routeInboundMessage, validateAttachments, maybeSendReadReceipt } from "../src/signal.js";
import { AccessManager } from "../src/access.js";

describe("Reply tool schema", () => {
  it("exposes correct schema", () => {
    const schema = getReplyToolSchema();
    assert.equal(schema.name, "reply");
    assert.ok(schema.inputSchema.properties.recipient);
    assert.ok(schema.inputSchema.properties.text);
    assert.ok(schema.inputSchema.properties.attachments);
    assert.deepEqual(schema.inputSchema.required, ["recipient", "text"]);
  });
});

describe("validateAttachments", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "attach-root-"));
    writeFileSync(join(root, "chart.png"), "png");
  });

  afterEach(() => {
    rmSync(root, { recursive: true });
  });

  it("passes paths through untouched when no root is configured", () => {
    assert.deepEqual(validateAttachments(["/anywhere/x.png"], ""), ["/anywhere/x.png"]);
  });

  it("returns undefined for empty input", () => {
    assert.equal(validateAttachments(undefined, root), undefined);
    assert.equal(validateAttachments([], root), undefined);
  });

  it("accepts a file inside the root", () => {
    const out = validateAttachments([join(root, "chart.png")], root);
    assert.equal(out!.length, 1);
    assert.ok(out![0].endsWith("chart.png"));
  });

  it("rejects a path that .. -escapes the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "attach-outside-"));
    writeFileSync(join(outside, "secret.txt"), "s");
    try {
      assert.throws(
        () => validateAttachments([join(root, "..", basename(outside), "secret.txt")], root),
        /outside the allowed attachment root/,
      );
    } finally {
      rmSync(outside, { recursive: true });
    }
  });

  it("rejects a symlink pointing outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "attach-outside-"));
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(root, "innocent.png"));
    try {
      assert.throws(
        () => validateAttachments([join(root, "innocent.png")], root),
        /outside the allowed attachment root/,
      );
    } finally {
      rmSync(outside, { recursive: true });
    }
  });


  it("rejects non-array attachments input with a clear error", () => {
    assert.throws(
      () => validateAttachments("/tmp/x.png" as unknown as string[], ""),
      /array of file path strings/,
    );
  });

  it("throws visibly on a missing file when a root is set", () => {
    assert.throws(() => validateAttachments([join(root, "nope.png")], root));
  });
});

describe("maybeSendReadReceipt", () => {
  const msg = { sender: "+1222", timestamp: 123 };

  it("fires with the sender and message timestamp", async () => {
    let got: [string, number] | null = null;
    maybeSendReadReceipt(msg, "+1999", async (r, t) => { got = [r, t]; });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, ["+1222", 123]);
  });

  it("never fires for the own account (Note to Self)", async () => {
    let fired = false;
    maybeSendReadReceipt({ sender: "+1999", timestamp: 1 }, "+1999", async () => { fired = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(fired, false);
  });

  it("swallows receipt failures without throwing", async () => {
    maybeSendReadReceipt(msg, "+1999", async () => { throw new Error("boom"); });
    await new Promise((r) => setImmediate(r));
  });
});

describe("handleReply", () => {
  let dir: string;
  let access: AccessManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-test-"));
    access = new AccessManager(dir);
    access.add("+1111111111");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("rejects reply to unknown recipient", async () => {
    const result = await handleReply(access, "+9999999999", "Hello", async () => {});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("not in the sender allowlist"));
  });

  it("passes attachments through to sendFn", async () => {
    let gotAttachments: string[] | undefined;
    const result = await handleReply(
      access,
      "+1111111111",
      "chart",
      async (_r, _t, attachments) => {
        gotAttachments = attachments;
      },
      undefined,
      ["/tmp/chart.png"],
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(gotAttachments, ["/tmp/chart.png"]);
  });

  it("omits attachments when not provided", async () => {
    let gotAttachments: string[] | undefined = ["sentinel"];
    await handleReply(access, "+1111111111", "hi", async (_r, _t, attachments) => {
      gotAttachments = attachments;
    });
    assert.equal(gotAttachments, undefined);
  });

  it("allows reply to allowed recipient", async () => {
    let sentTo = "";
    const result = await handleReply(access, "+1111111111", "Hello", async (r) => {
      sentTo = r;
    });
    assert.equal(result.isError, undefined);
    assert.equal(sentTo, "+1111111111");
  });
});

describe("gate", () => {
  let dir: string;
  let access: AccessManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-test-"));
    access = new AccessManager(dir);
    access.add("+1111111111");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("delivers allowed sender", () => {
    const result = gate(access, "+1111111111", "Alice");
    assert.equal(result.action, "deliver");
  });

  it("auto-approves own account (Note to Self)", () => {
    const result = gate(access, "+5555555555", "Me", "+5555555555");
    assert.equal(result.action, "deliver");
    assert.equal(access.isAllowed("+5555555555"), true);
  });

  it("creates pairing for unknown sender in pairing mode", () => {
    const result = gate(access, "+9999999999", "Eve");
    assert.equal(result.action, "pair");
    if (result.action === "pair") {
      assert.equal(result.isResend, false);
      assert.ok(result.code);
    }
  });

  it("drops unknown sender in allowlist mode", () => {
    access.setPolicy("allowlist");
    const result = gate(access, "+9999999999", "Eve");
    assert.equal(result.action, "drop");
  });

  it("drops all senders in disabled mode", () => {
    access.setPolicy("disabled");
    const result = gate(access, "+1111111111", "Alice");
    assert.equal(result.action, "drop");
  });

  it("re-sends code on second message from same sender", () => {
    gate(access, "+9999999999", "Eve");
    const result = gate(access, "+9999999999", "Eve");
    assert.equal(result.action, "pair");
    if (result.action === "pair") {
      assert.equal(result.isResend, true);
    }
  });

  it("drops after 2 replies to same sender", () => {
    gate(access, "+9999999999", "Eve");
    gate(access, "+9999999999", "Eve");
    const result = gate(access, "+9999999999", "Eve");
    assert.equal(result.action, "drop");
  });

  it("drops 4th distinct unknown sender (max 3 pending)", () => {
    gate(access, "+2222222222", "A");
    gate(access, "+3333333333", "B");
    gate(access, "+4444444444", "C");
    const result = gate(access, "+5555555555", "D");
    assert.equal(result.action, "drop");
  });
});

describe("routeInboundMessage", () => {
  let dir: string;
  let access: AccessManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-test-"));
    access = new AccessManager(dir);
    access.add("+1111111111");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("forwards allowed sender message", async () => {
    let forwarded = false;
    await routeInboundMessage(
      access,
      { type: "message", sender: "+1111111111", senderName: "Alice", text: "Hi", timestamp: 0 },
      async () => { forwarded = true; },
      async () => {},
    );
    assert.equal(forwarded, true);
  });

  it("replies with pairing code for unknown sender", async () => {
    let replyText = "";
    await routeInboundMessage(
      access,
      { type: "message", sender: "+9999999999", senderName: "Eve", text: "Hi", timestamp: 0 },
      async () => {},
      async (_, text) => { replyText = text; },
    );
    assert.ok(replyText.includes("/signal:access pair"));
  });

  it("drops unknown sender in allowlist mode", async () => {
    access.setPolicy("allowlist");
    let forwarded = false;
    let replied = false;
    await routeInboundMessage(
      access,
      { type: "message", sender: "+9999999999", senderName: "Eve", text: "Hi", timestamp: 0 },
      async () => { forwarded = true; },
      async () => { replied = true; },
    );
    assert.equal(forwarded, false);
    assert.equal(replied, false);
  });

  it("forwards message with matching prefix, stripping it", async () => {
    let text = "";
    await routeInboundMessage(
      access,
      { type: "message", sender: "+1111111111", senderName: "Alice", text: "cc what time is it", timestamp: 0 },
      async (m) => { text = m.text; },
      async () => {},
      "cc",
    );
    assert.equal(text, "what time is it");
  });

  it("drops message without prefix when prefix is set", async () => {
    let forwarded = false;
    await routeInboundMessage(
      access,
      { type: "message", sender: "+1111111111", senderName: "Alice", text: "just a regular note", timestamp: 0 },
      async () => { forwarded = true; },
      async () => {},
      "cc",
    );
    assert.equal(forwarded, false);
  });

  it("prefix matching is case-insensitive", async () => {
    let text = "";
    await routeInboundMessage(
      access,
      { type: "message", sender: "+1111111111", senderName: "Alice", text: "CC do something", timestamp: 0 },
      async (m) => { text = m.text; },
      async () => {},
      "cc",
    );
    assert.equal(text, "do something");
  });
});
