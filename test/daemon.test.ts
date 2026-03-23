import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DaemonManager, checkSignalCliVersion } from "../src/daemon.js";

describe("DaemonManager", () => {
  it("constructs with correct config", () => {
    const dm = new DaemonManager({
      signalCliPath: "signal-cli",
      account: "+1234567890",
      port: 7583,
    });
    assert.ok(dm);
  });

  it("builds correct spawn args", () => {
    const dm = new DaemonManager({
      signalCliPath: "signal-cli",
      account: "+1234567890",
      port: 7583,
    });
    const args = dm.getSpawnArgs();
    assert.deepEqual(args, [
      "-a", "+1234567890",
      "daemon", "--tcp", "localhost:7583",
    ]);
  });
});

describe("Version check", () => {
  it("parses signal-cli version output", () => {
    const result = checkSignalCliVersion("signal-cli 0.13.4");
    assert.equal(result.version, "0.13.4");
  });

  it("detects version below minimum", () => {
    const result = checkSignalCliVersion("signal-cli 0.12.0");
    assert.equal(result.supported, false);
  });

  it("accepts supported version", () => {
    const result = checkSignalCliVersion("signal-cli 0.13.4");
    assert.equal(result.supported, true);
  });

  it("handles unknown version format", () => {
    const result = checkSignalCliVersion("garbage output");
    assert.equal(result.version, "unknown");
    assert.equal(result.supported, false);
  });
});
