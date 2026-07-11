import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getReplyToolSchema, handleReply, gate, routeInboundMessage } from "../src/signal.js";
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
