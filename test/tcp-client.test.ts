import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonRpcMessage, buildJsonRpcRequest } from "../src/tcp-client.js";

describe("JSON-RPC parsing", () => {
  it("parses a receive notification", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: {
        subscription: 0,
        result: {
          envelope: {
            source: "+1234567890",
            sourceName: "Alice",
            sourceDevice: 1,
            timestamp: 1693064367769,
            dataMessage: {
              message: "Hello Claude!",
              expiresInSeconds: 0,
              viewOnce: false,
            },
          },
          account: "+0987654321",
        },
      },
    });
    const msg = parseJsonRpcMessage(raw);
    assert.equal(msg?.type, "message");
    assert.equal(msg?.sender, "+1234567890");
    assert.equal(msg?.senderName, "Alice");
    assert.equal(msg?.text, "Hello Claude!");
  });

  it("falls back to phone number when sourceName is missing", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: {
        subscription: 0,
        result: {
          envelope: {
            source: "+1234567890",
            dataMessage: { message: "Hi" },
          },
        },
      },
    });
    const msg = parseJsonRpcMessage(raw);
    assert.equal(msg?.senderName, "+1234567890");
  });

  it("ignores group messages", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: {
        subscription: 0,
        result: {
          envelope: {
            source: "+1234567890",
            sourceName: "Alice",
            dataMessage: {
              message: "Group hello",
              groupInfo: { groupId: "abc123" },
            },
          },
        },
      },
    });
    assert.equal(parseJsonRpcMessage(raw), null);
  });

  it("ignores non-data messages (receipts, typing)", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: {
        subscription: 0,
        result: {
          envelope: {
            source: "+1234567890",
            receiptMessage: { type: "DELIVERY" },
          },
        },
      },
    });
    assert.equal(parseJsonRpcMessage(raw), null);
  });

  it("parses a sync message (Note to Self)", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: {
        subscription: 0,
        result: {
          envelope: {
            source: "+1234567890",
            sourceName: "Me",
            timestamp: 1693064367769,
            syncMessage: {
              sentMessage: {
                message: "Note to self test",
                destination: "+1234567890",
              },
            },
          },
        },
      },
    });
    const msg = parseJsonRpcMessage(raw);
    assert.equal(msg?.type, "message");
    assert.equal(msg?.sender, "+1234567890");
    assert.equal(msg?.text, "Note to self test");
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseJsonRpcMessage("not json {{{"), null);
  });

  it("returns null for non-receive methods", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", method: "other", params: {} });
    assert.equal(parseJsonRpcMessage(raw), null);
  });
});

describe("JSON-RPC request building", () => {
  it("builds a send request", () => {
    const req = buildJsonRpcRequest("send", {
      recipient: ["+1234567890"],
      message: "Hello!",
    });
    const parsed = JSON.parse(req);
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.method, "send");
    assert.deepEqual(parsed.params.recipient, ["+1234567890"]);
    assert.ok(parsed.id);
  });

  it("builds a subscribeReceive request with account", () => {
    const req = buildJsonRpcRequest("subscribeReceive", { account: "+1111111111" });
    const parsed = JSON.parse(req);
    assert.equal(parsed.method, "subscribeReceive");
    assert.equal(parsed.params.account, "+1111111111");
  });
});
