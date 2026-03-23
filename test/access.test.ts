import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccessManager } from "../src/access.js";

describe("AccessManager allowlist", () => {
  let dir: string;
  let access: AccessManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-test-"));
    access = new AccessManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("starts with empty allowlist", () => {
    assert.deepEqual(access.list(), []);
  });

  it("adds a sender and checks allowlist", () => {
    access.add("+1234567890");
    assert.equal(access.isAllowed("+1234567890"), true);
    assert.equal(access.isAllowed("+9999999999"), false);
  });

  it("deduplicates on add", () => {
    access.add("+1234567890");
    access.add("+1234567890");
    assert.equal(access.list().length, 1);
  });

  it("removes a sender", () => {
    access.add("+1234567890");
    access.remove("+1234567890");
    assert.equal(access.isAllowed("+1234567890"), false);
  });

  it("persists to disk and reloads", () => {
    access.add("+1234567890");
    const access2 = new AccessManager(dir);
    assert.equal(access2.isAllowed("+1234567890"), true);
  });

  it("respects disabled policy", () => {
    access.add("+1234567890");
    access.setPolicy("disabled");
    assert.equal(access.isAllowed("+1234567890"), false);
  });

  it("gets and sets policy", () => {
    assert.equal(access.getPolicy(), "pairing");
    access.setPolicy("allowlist");
    assert.equal(access.getPolicy(), "allowlist");
  });
});

describe("Pairing flow", () => {
  let dir: string;
  let access: AccessManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-test-"));
    access = new AccessManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("creates a pending entry for unknown sender", () => {
    const code = access.createPending("+5555555555", "Bob");
    assert.ok(code);
    assert.equal(code!.length, 6);
    assert.match(code!, /^[a-f0-9]{6}$/);
  });

  it("returns same code for same sender", () => {
    const code1 = access.createPending("+5555555555", "Bob");
    const code2 = access.createPending("+5555555555", "Bob");
    assert.equal(code1, code2);
  });

  it("enforces max 3 pending", () => {
    access.createPending("+1111111111", "A");
    access.createPending("+2222222222", "B");
    access.createPending("+3333333333", "C");
    const code = access.createPending("+4444444444", "D");
    assert.equal(code, null);
  });

  it("approves a pairing", () => {
    const code = access.createPending("+5555555555", "Bob")!;
    const result = access.approvePairing(code);
    assert.ok(result);
    assert.equal(result!.senderId, "+5555555555");
    assert.equal(result!.senderName, "Bob");
    assert.equal(access.isAllowed("+5555555555"), true);
  });

  it("removes pending entry on approval", () => {
    const code = access.createPending("+5555555555", "Bob")!;
    access.approvePairing(code);
    assert.equal(access.getPending("+5555555555"), null);
  });

  it("rejects invalid code", () => {
    assert.equal(access.approvePairing("badcod"), null);
  });

  it("denies a pending entry", () => {
    const code = access.createPending("+5555555555", "Bob")!;
    assert.equal(access.denyPairing(code), true);
    assert.equal(access.getPending("+5555555555"), null);
  });

  it("gets pending entry for sender", () => {
    const code = access.createPending("+5555555555", "Bob")!;
    const pending = access.getPending("+5555555555");
    assert.ok(pending);
    assert.equal(pending!.code, code);
    assert.equal(pending!.entry.replies, 1);
  });

  it("increments reply count", () => {
    const code = access.createPending("+5555555555", "Bob")!;
    access.incrementReplies(code);
    const pending = access.getPending("+5555555555");
    assert.equal(pending!.entry.replies, 2);
  });
});
