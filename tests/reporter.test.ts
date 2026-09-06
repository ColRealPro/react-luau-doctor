import assert from "node:assert/strict";
import test from "node:test";
import { renderAnnotations, renderRulesList, renderTextReport } from "../src/reporter";
import type { RuleDefinition, ScanReport } from "../src/types";

const noopRule = (): RuleDefinition["run"] => () => [];

const testRules: RuleDefinition[] = [
  {
    id: "react-luau/short-rule",
    severity: "warning",
    category: "Hooks",
    description: "A short description.",
    run: noopRule(),
  },
  {
    id: "react-luau/a-much-longer-rule-name",
    severity: "error",
    category: "Correctness",
    description: "A long description that should wrap cleanly under the description column rather than breaking table alignment.",
    run: noopRule(),
  },
];

const report: ScanReport = {
  schemaVersion: 1,
  root: ".",
  scannedFiles: 1,
  durationMs: 12.34,
  score: 42,
  counts: { error: 1, warning: 0, suggestion: 0 },
  diagnostics: [
    {
      id: "diagnostic-id",
      rule: "react-luau/no-prop-mutation",
      category: "Correctness",
      severity: "error",
      message: "Component mutates props directly.",
      help: "Treat props as immutable.",
      file: "src/Test.luau",
      location: { line: 8, column: 2, endLine: 8, endColumn: 10 },
    },
  ],
};

test("rules list renders an aligned table without tab-separated columns", () => {
  const output = renderRulesList(testRules, 100);
  assert.match(output, /^React-Luau Doctor Rules\n2 rules\n\nRule ID\s+Severity\s+Category\s+Description/m);
  assert.equal(output.includes("\t"), false);
  assert.match(output, /react-luau\/short-rule\s+warning\s+Hooks\s+A short description\./);
  assert.match(output, /cleanly under the description column\n\s+rather than breaking table alignment\./);
});

test("colorized text reports emit ANSI colors only when explicitly enabled", () => {
  const plain = renderTextReport(report, true, false);
  const colorized = renderTextReport(report, true, true);

  assert.equal(plain.includes("\u001b["), false);
  assert.equal(colorized.includes("\u001b["), true);
  assert.match(colorized, /src\/Test\.luau/);
});

test("verbose reports word-wrap messages and help at the terminal width", () => {
  const wrappedReport: ScanReport = {
    ...report,
    diagnostics: [{
      ...report.diagnostics[0],
      file: "src/interface/Components/Example.luau",
      message: "This diagnostic message is intentionally long enough to wrap across multiple words without relying on the terminal to split individual characters.",
      help: "Return cleanup for the resource when it must stop with the effect instead of leaving ownership ambiguous across rerenders.",
    }],
  };

  const output = renderTextReport(wrappedReport, true, false, true, 72);
  const lines = output.split("\n");
  assert.equal(lines.every((line) => line.length <= 72), true, output);
  assert.match(output, /wrap across multiple words without\n\s+relying on the terminal/);
  assert.match(output, /must stop with the effect\n\s+instead of leaving ownership ambiguous across rerenders/);
});

test("non-verbose reports summarize the top three rules", () => {
  const multiReport: ScanReport = {
    ...report,
    counts: { error: 1, warning: 3, suggestion: 0 },
    diagnostics: [
      report.diagnostics[0],
      {
        ...report.diagnostics[0],
        id: "warning-1",
        rule: "react-luau/exhaustive-deps",
        severity: "warning",
        message: "Missing dependency.",
        file: "src/A.luau",
      },
      {
        ...report.diagnostics[0],
        id: "warning-2",
        rule: "react-luau/effect-needs-cleanup",
        severity: "warning",
        message: "Missing cleanup.",
        file: "src/B.luau",
      },
      {
        ...report.diagnostics[0],
        id: "warning-3",
        rule: "react-luau/no-array-index-as-key",
        severity: "warning",
        message: "Index key.",
        file: "src/C.luau",
      },
    ],
  };

  const output = renderTextReport(multiReport, true, false, false);
  assert.match(output, /Top rules:/);
  assert.match(output, /\+1 more rules and 1 more findings/);
  assert.equal(output.includes("Treat props as immutable."), false);
});

test("GitHub Actions annotations include precise locations and rule titles", () => {
  const output = renderAnnotations(report);
  assert.match(output, /^::error file=src\/Test\.luau,line=8,col=2,endLine=8,endColumn=10,title=react-luau\/no-prop-mutation::Component mutates props directly\.$/);
});
