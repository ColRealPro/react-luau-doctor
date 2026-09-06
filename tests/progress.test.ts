import assert from "node:assert/strict";
import test from "node:test";
import { createProgressRenderer, formatScanProgress } from "../src/progress";

class FakeTTY {
  isTTY = true;
  columns = 100;
  output = "";

  write(value: string): void {
    this.output += value;
  }
}

test("progress bar reports percentage and candidate counts", () => {
  const output = formatScanProgress({ current: 25, total: 100, file: "src/interface/Component.luau" }, 100, false);
  assert.match(output, /25% 25\/100/);
  assert.match(output, /█/);
  assert.match(output, /░/);
});

test("progress renderer clears its terminal line", () => {
  const stream = new FakeTTY();
  const renderer = createProgressRenderer({ stream, enabled: true, colorized: true, throttleMs: 0 });
  renderer.update({ current: 1, total: 2, file: "A.luau" });
  renderer.update({ current: 2, total: 2, file: "B.luau" });
  renderer.clear();

  assert.equal(stream.output.endsWith("\r\u001b[2K"), true);
});

test("progress phases can use explicit human-readable labels", () => {
  const output = formatScanProgress({ current: 12, total: 100, label: "Analyzing project effects", phase: "effects" }, 100, false);
  assert.match(output, /^Analyzing project effects /);
  assert.equal(output.includes("Scanning Analyzing"), false);
});
