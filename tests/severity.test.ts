import assert from "node:assert/strict";
import test from "node:test";
import { rulesById } from "../src/rules";
import type { Severity } from "../src/types";

function severity(ruleId: string): Severity {
  const rule = rulesById.get(ruleId);
  assert.ok(rule, `missing ${ruleId}`);
  return rule.severity;
}

test("default rule severities follow the documented severity policy", () => {
  const expected: Record<string, Severity> = {
    "react-luau/no-derived-state-effect": "warning",
    "react-luau/rerender-state-only-in-handlers": "warning",
    "react-luau/no-array-index-as-key": "suggestion",
    "react-luau/unstable-context-value": "warning",
    "react-luau/no-effect-with-fresh-deps": "error",
    "react-luau/no-mutable-in-deps": "error",
    "react-luau/no-set-state-in-render": "warning",
    "react-luau/no-direct-state-mutation": "warning",
    "react-luau/no-side-effects-in-render": "error",
  };

  for (const [ruleId, expectedSeverity] of Object.entries(expected)) {
    assert.equal(severity(ruleId), expectedSeverity, ruleId);
  }
});

test("review-only and uncertain rules remain suggestions by default", () => {
  for (const ruleId of [
    "react-luau/no-array-index-as-key",
    "react-luau/prefer-binding-over-state-candidate",
    "react-luau/prefer-use-ref-for-mutable-cell",
  ]) {
    assert.equal(severity(ruleId), "suggestion", ruleId);
  }
});

test("explicit severity overrides per-finding confidence defaults", async () => {
  const { scanPath } = await import("../src/scanner");
  const path = await import("node:path");
  const fixture = path.resolve(import.meta.dir, "fixtures/deps-advanced-confidence.luau");
  for (const setting of ["error", "warning", "suggestion", "off"] as const) {
    const report = await scanPath(fixture, { cache: false, config: { rules: { "react-luau/exhaustive-deps": setting } } });
    const findings = report.diagnostics.filter(d => d.rule === "react-luau/exhaustive-deps");
    if (setting === "off") assert.equal(findings.length, 0);
    else {
      assert.ok(findings.length > 0);
      assert.ok(findings.every(d => d.severity === setting));
    }
  }
});
