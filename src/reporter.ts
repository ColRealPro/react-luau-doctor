import packageJson from "../package.json";
import type { Diagnostic, RuleDefinition, ScanReport, Severity } from "./types";

const VERSION = packageJson.version;

const SYMBOLS: Record<Severity, string> = {
  error: "x",
  warning: "!",
  suggestion: "i",
};

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
};

function paint(value: string, ...codes: string[]): string {
  return `${codes.join("")}${value}${ANSI.reset}`;
}

function severityPaint(severity: Severity, value: string): string {
  if (severity === "error") return paint(value, ANSI.bold, ANSI.red);
  if (severity === "warning") return paint(value, ANSI.bold, ANSI.yellow);
  return paint(value, ANSI.bold, ANSI.magenta);
}

function scoreLabel(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 50) return "Needs work";
  return "Critical";
}

function scorePaint(score: number, value: string): string {
  if (score >= 75) return paint(value, ANSI.bold, ANSI.green);
  if (score >= 50) return paint(value, ANSI.bold, ANSI.yellow);
  return paint(value, ANSI.bold, ANSI.red);
}

function terminalWidth(value: number): number {
  return Math.max(32, value || 120);
}

function wrapWords(value: string, width: number): string[] {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return [""];
  if (width <= 1) return [normalized];

  const lines: string[] = [];
  let line = "";
  for (const word of normalized.split(" ")) {
    if (!line) {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

function wrapFirstThen(value: string, firstWidth: number, continuationWidth: number): string[] {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return [""];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let width = Math.max(1, firstWidth);
  let line = "";

  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
    width = Math.max(1, continuationWidth);
  }
  if (line) lines.push(line);
  return lines;
}

function renderDiagnosticLines(diagnostic: Diagnostic, colorized: boolean, width: number, baseIndent = "  "): string[] {
  const symbol = SYMBOLS[diagnostic.severity];
  const location = `${diagnostic.file}:${diagnostic.location.line}:${diagnostic.location.column}`;
  const prefixVisible = baseIndent.length + symbol.length + 1 + location.length + 2;
  const continuationIndent = "    ";
  const continuationWidth = Math.max(16, width - continuationIndent.length);
  const firstWidth = width - prefixVisible;
  const splitMessage = firstWidth < 24;
  const messageLines = splitMessage
    ? wrapWords(diagnostic.message, continuationWidth)
    : wrapFirstThen(diagnostic.message, firstWidth, continuationWidth);
  const rendered: string[] = [];

  const symbolText = colorized ? severityPaint(diagnostic.severity, symbol) : symbol;
  const locationText = colorized ? paint(location, ANSI.bold) : location;

  if (splitMessage) {
    rendered.push(`${baseIndent}${symbolText} ${locationText}`);
    for (const messageLine of messageLines) rendered.push(`${continuationIndent}${messageLine}`);
    return rendered;
  }

  rendered.push(`${baseIndent}${symbolText} ${locationText}  ${messageLines[0]}`);
  for (const messageLine of messageLines.slice(1)) rendered.push(`${continuationIndent}${messageLine}`);
  return rendered;
}

function renderIndentedWrapped(value: string, colorized: boolean, width: number, indent = "    "): string[] {
  const wrapped = wrapWords(value, Math.max(16, width - indent.length));
  return wrapped.map((line) => `${indent}${colorized ? paint(line, ANSI.dim) : line}`);
}

export function renderRulesList(
  ruleDefinitions: RuleDefinition[],
  terminalWidth = 120,
  severityOverrides: ReadonlyMap<string, string> = new Map(),
  colorized = false,
): string {
  const title = colorized ? paint("React-Luau Doctor Rules", ANSI.bold, ANSI.magenta) : "React-Luau Doctor Rules";
  if (ruleDefinitions.length === 0) return `${title}\n0 rules`;

  const ruleWidth = Math.max("Rule ID".length, ...ruleDefinitions.map((rule) => rule.id.length));
  const severityWidth = Math.max(
    "Severity".length,
    ...ruleDefinitions.map((rule) => (severityOverrides.get(rule.id) ?? rule.severity).length),
  );
  const categoryWidth = Math.max("Category".length, ...ruleDefinitions.map((rule) => rule.category.length));
  const gap = "  ";
  const fixedWidth = ruleWidth + severityWidth + categoryWidth + gap.length * 3;
  const tableWidth = Math.max(96, Math.min(160, terminalWidth || 120));
  const descriptionWidth = Math.max(28, tableWidth - fixedWidth);
  const descriptionIndent = " ".repeat(fixedWidth);

  const header = `${"Rule ID".padEnd(ruleWidth)}${gap}${"Severity".padEnd(severityWidth)}${gap}${"Category".padEnd(categoryWidth)}${gap}Description`;
  const separator = `${"-".repeat(ruleWidth)}${gap}${"-".repeat(severityWidth)}${gap}${"-".repeat(categoryWidth)}${gap}${"-".repeat(descriptionWidth)}`;
  const lines: string[] = [title, `${ruleDefinitions.length} rules`, "", colorized ? paint(header, ANSI.bold) : header, colorized ? paint(separator, ANSI.dim) : separator];

  for (const rule of ruleDefinitions) {
    const severity = severityOverrides.get(rule.id) ?? rule.severity;
    const descriptionLines = wrapWords(rule.description, descriptionWidth);
    const ruleCell = rule.id.padEnd(ruleWidth);
    const severityCell = severity.padEnd(severityWidth);
    const categoryCell = rule.category.padEnd(categoryWidth);
    const firstLine = colorized
      ? `${paint(ruleCell, ANSI.bold)}${gap}${severity === "off" ? paint(severityCell, ANSI.dim) : severityPaint(severity as Severity, severityCell)}${gap}${paint(categoryCell, ANSI.dim)}${gap}${descriptionLines[0]}`
      : `${ruleCell}${gap}${severityCell}${gap}${categoryCell}${gap}${descriptionLines[0]}`;
    lines.push(firstLine);
    for (const continuation of descriptionLines.slice(1)) {
      lines.push(colorized ? `${descriptionIndent}${paint(continuation, ANSI.dim)}` : `${descriptionIndent}${continuation}`);
    }
  }

  return lines.join("\n");
}

function renderCounts(report: ScanReport, colorized: boolean): string {
  if (!colorized) {
    return `${report.counts.error} errors, ${report.counts.warning} warnings, ${report.counts.suggestion} suggestions`;
  }
  return [
    severityPaint("error", `${report.counts.error} errors`),
    severityPaint("warning", `${report.counts.warning} warnings`),
    severityPaint("suggestion", `${report.counts.suggestion} suggestions`),
  ].join(", ");
}

function renderHeader(report: ScanReport, colorized: boolean): string[] {
  const title = colorized
    ? `${paint("React-Luau Doctor", ANSI.bold, ANSI.magenta)} ${paint(`v${VERSION}`, ANSI.dim)}`
    : `React-Luau Doctor v${VERSION}`;
  const scopeSuffix = report.scope && report.scope !== "full" ? ` (${report.scope} scope)` : "";
  const lines = [title, `Scanned ${report.scannedFiles} React-Luau files in ${report.durationMs.toFixed(2)}ms${scopeSuffix}`];
  if (report.partial) {
    const message = `Partial scan: ${(report.skippedFiles ?? []).length} candidate files skipped after the time budget.`;
    lines.push(colorized ? severityPaint("warning", message) : message);
  }
  return lines;
}

function renderVerboseDiagnostics(report: ScanReport, colorized: boolean, width: number): string[] {
  if (report.diagnostics.length === 0) {
    return [colorized ? paint("No issues found.", ANSI.bold, ANSI.green) : "No issues found."];
  }

  const lines: string[] = [];
  let currentFile = "";
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.file !== currentFile) {
      if (currentFile) lines.push("");
      currentFile = diagnostic.file;
      lines.push(colorized ? paint(currentFile, ANSI.bold, ANSI.cyan) : currentFile);
    }
    lines.push(...renderDiagnosticLines(diagnostic, colorized, width));
    const metadata = `${diagnostic.rule} [${diagnostic.category}]`;
    lines.push(...renderIndentedWrapped(metadata, colorized, width));
    if (diagnostic.help) lines.push(...renderIndentedWrapped(diagnostic.help, colorized, width));
  }
  return lines;
}

interface RuleGroup {
  rule: string;
  category: string;
  severity: Severity;
  diagnostics: Diagnostic[];
}

function groupedDiagnostics(report: ScanReport): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();
  const rank: Record<Severity, number> = { error: 2, warning: 1, suggestion: 0 };
  for (const diagnostic of report.diagnostics) {
    const existing = groups.get(diagnostic.rule);
    if (existing) {
      existing.diagnostics.push(diagnostic);
      if (rank[diagnostic.severity] > rank[existing.severity]) existing.severity = diagnostic.severity;
    } else {
      groups.set(diagnostic.rule, {
        rule: diagnostic.rule,
        category: diagnostic.category,
        severity: diagnostic.severity,
        diagnostics: [diagnostic],
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => rank[b.severity] - rank[a.severity] || b.diagnostics.length - a.diagnostics.length || a.rule.localeCompare(b.rule),
  );
}

function renderCompactDiagnostics(report: ScanReport, colorized: boolean, width: number): string[] {
  if (report.diagnostics.length === 0) {
    return [colorized ? paint("No issues found.", ANSI.bold, ANSI.green) : "No issues found."];
  }

  const groups = groupedDiagnostics(report);
  const shown = groups.slice(0, 3);
  const lines: string[] = ["Top rules:"];
  let shownFindings = 0;

  for (const group of shown) {
    shownFindings += group.diagnostics.length;
    const symbol = colorized ? severityPaint(group.severity, SYMBOLS[group.severity]) : SYMBOLS[group.severity];
    const countLabel = `${group.diagnostics.length} finding${group.diagnostics.length === 1 ? "" : "s"}`;
    const ruleLabel = colorized ? paint(group.rule, ANSI.bold) : group.rule;
    const metadata = colorized ? paint(`[${group.category}]`, ANSI.dim) : `[${group.category}]`;
    lines.push(`${symbol} ${ruleLabel} ${metadata}  ${countLabel}`);

    for (const diagnostic of group.diagnostics.slice(0, 3)) {
      const location = `${diagnostic.file}:${diagnostic.location.line}:${diagnostic.location.column}`;
      const detail = `${location}  ${diagnostic.message}`;
      const wrapped = wrapWords(detail, Math.max(16, width - 4));
      for (const line of wrapped) lines.push(colorized ? `    ${paint(line, ANSI.dim)}` : `    ${line}`);
    }
    if (group.diagnostics.length > 3) lines.push(`    +${group.diagnostics.length - 3} more`);
  }

  const hiddenRules = groups.length - shown.length;
  const hiddenFindings = report.diagnostics.length - shownFindings;
  if (hiddenRules > 0 || hiddenFindings > 0) {
    lines.push("");
    lines.push(`+${hiddenRules} more rules and ${hiddenFindings} more findings. Run react-luau-doctor --verbose for every finding.`);
  }
  return lines;
}

export function renderTextReport(
  report: ScanReport,
  showScore = true,
  colorized = false,
  verbose = true,
  outputWidth = 120,
): string {
  const width = terminalWidth(outputWidth);
  const lines = renderHeader(report, colorized);
  lines.push("");
  lines.push(...(verbose ? renderVerboseDiagnostics(report, colorized, width) : renderCompactDiagnostics(report, colorized, width)));
  lines.push("");
  lines.push(renderCounts(report, colorized));
  if (showScore) {
    const score = `Score: ${report.score}/100 (${scoreLabel(report.score)})`;
    lines.push(colorized ? scorePaint(report.score, score) : score);
  }
  if (report.notes && report.notes.length > 0) {
    lines.push("");
    for (const note of report.notes) {
      const wrapped = wrapWords(`Note: ${note}`, width);
      for (const line of wrapped) lines.push(colorized ? paint(line, ANSI.dim) : line);
    }
  }
  return lines.join("\n");
}

function escapeWorkflowData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeWorkflowProperty(value: string): string {
  return escapeWorkflowData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function renderAnnotations(report: ScanReport): string {
  return report.diagnostics
    .map((diagnostic) => {
      const level = diagnostic.severity === "error" ? "error" : "warning";
      const properties = [
        `file=${escapeWorkflowProperty(diagnostic.file)}`,
        `line=${diagnostic.location.line}`,
        `col=${diagnostic.location.column}`,
        `endLine=${diagnostic.location.endLine}`,
        `endColumn=${diagnostic.location.endColumn}`,
        `title=${escapeWorkflowProperty(diagnostic.rule)}`,
      ].join(",");
      return `::${level} ${properties}::${escapeWorkflowData(diagnostic.message)}`;
    })
    .join("\n");
}
