import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyToolState,
  cycleToolState,
  formatToolsForDetail,
  getToolState,
} from "./tool_picker_state.js";

describe("getToolState", () => {
  it("returns inactive when not in allowed", () => {
    assert.equal(getToolState("bash", [], []), "inactive");
    assert.equal(getToolState("bash", ["read_file"], []), "inactive");
  });

  it("returns active when in allowed but not in confirm", () => {
    assert.equal(getToolState("bash", ["bash"], []), "active");
  });

  it("returns confirm when in both", () => {
    assert.equal(getToolState("bash", ["bash"], ["bash"]), "confirm");
  });

  it("ignores stray confirm entries that aren't allowed", () => {
    // Defensive: a tool listed only in confirm but not in allowed is inactive.
    assert.equal(getToolState("bash", [], ["bash"]), "inactive");
  });
});

describe("cycleToolState", () => {
  it("cycles inactive → active → confirm → inactive", () => {
    assert.equal(cycleToolState("inactive"), "active");
    assert.equal(cycleToolState("active"), "confirm");
    assert.equal(cycleToolState("confirm"), "inactive");
  });
});

describe("applyToolState", () => {
  it("inactive removes from both sets", () => {
    const r = applyToolState("bash", "inactive", ["bash", "read_file"], ["bash"]);
    assert.deepEqual(r.allowed.sort(), ["read_file"]);
    assert.deepEqual(r.confirm, []);
  });

  it("active adds to allowed, removes from confirm", () => {
    const r = applyToolState("bash", "active", ["read_file"], ["bash"]);
    assert.deepEqual(r.allowed.sort(), ["bash", "read_file"]);
    assert.deepEqual(r.confirm, []);
  });

  it("confirm adds to both", () => {
    const r = applyToolState("bash", "confirm", ["read_file"], []);
    assert.deepEqual(r.allowed.sort(), ["bash", "read_file"]);
    assert.deepEqual(r.confirm, ["bash"]);
  });

  it("is idempotent on repeat", () => {
    const a = applyToolState("bash", "confirm", [], []);
    const b = applyToolState("bash", "confirm", a.allowed, a.confirm);
    assert.deepEqual(a, b);
  });
});

describe("formatToolsForDetail", () => {
  it("marks confirm tools with a trailing !", () => {
    assert.equal(
      formatToolsForDetail(["read_file", "bash", "write"], ["bash", "write"]),
      "read_file, bash!, write!",
    );
  });

  it("returns plain join when confirm is empty", () => {
    assert.equal(formatToolsForDetail(["read_file", "bash"], []), "read_file, bash");
  });
});
