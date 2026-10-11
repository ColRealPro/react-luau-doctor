import { scoreLabel } from "../reporter";
import type { Diagnostic, ScanReport } from "../types";

export const SUMMARY_MARKER = "<!-- react-luau-doctor:summary -->";
export const REVIEW_MARKER = "<!-- react-luau-doctor:review -->";
export const SUCCESS_ICON =
  '<img src="https://raw.githubusercontent.com/ColRealPro/react-luau-doctor/main/assets/ci/check-circle.svg" width="14" height="14" alt="">';
export const MAX_COMMENT_LENGTH = 60_000;

export interface FixedDiagnostic extends Diagnostic {
  baselineLocationUncertain?: boolean;
}

export function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()!|#$~]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

export function inlineCode(value: string): string {
  const text = value.replace(/\r?\n/g, " ");
  const fence = "`".repeat(
    Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
  );
  const padding =
    text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" "))
      ? " "
      : "";

  return `${fence}${padding}${text}${padding}${fence}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function issueCount(count: number): string {
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

function statusText(kind: "fixed" | "remaining" | "discussion", text: string): string {
  let rendered = kind === "fixed" ? `**${escapeMarkdown(text)}**` : escapeMarkdown(text);

  // turns out mathjax isn't supported outside of the github website :(
  // const colors = { fixed: "#3fb950", remaining: "#8b949e", discussion: "#d29922" };
  // function escapeMathText(value: string): string {
  //   const symbols: Record<string, string> = {
  //     "\\": "\\textbackslash{}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}",
  //     "<": "\\textless{}", ">": "\\textgreater{}",
  //   };
  //   const text = value
  //     .replace(/\r?\n/g, " ")
  //     .replace(/[\\{}$%&#_^~<>]/g, (symbol) => symbols[symbol] ?? `\\${symbol}`);
  //   // Preserve literal text through Markdown parsing before MathJax consumes the decoded HTML text
  //   return text.replace(/[\\$`*\[\]()!|_&]/g, (symbol) => `&#${symbol.charCodeAt(0)};`);
  // }
  // rendered = `$\\color{${colors[kind]}}\\textsf{${escapeMathText(text)}}$`;

  return rendered;
}

export function renderReviewProgress(
  total: number,
  fixed: number,
  unknown: number,
  discussions?: number,
): string {
  const lines = [`**React-Luau Doctor found ${total} new ${total === 1 ? "issue" : "issues"}**`];
  const status: string[] = [];

  if (unknown > 0) {
    status.push(`${unknown} ${unknown === 1 ? "issue" : "issues"} awaiting verification`);
  }

  if (discussions === undefined && fixed > 0) {
    status.push("discussion status unavailable");
  }

  const discussion = discussions
    ? `${discussions} ${discussions === 1 ? "discussion" : "discussions"} awaiting resolution`
    : "";

  if (fixed > 0) {
    let fixedText = `${fixed} of these ${issueCount(total)} fixed`;

    if (fixed === total) {
      if (total === 1) {
        fixedText = "This issue fixed in later commits";
      } else if (total === 2) {
        fixedText = "Both issues fixed in later commits";
      } else {
        fixedText = `All ${total} issues fixed in later commits`;
      }
    }

    const remaining = total - fixed - unknown;

    if (remaining > 0) {
      status.unshift(`${remaining} still ${remaining === 1 ? "remains" : "remain"} in the PR`);
    }

    lines.push(
      "",
      [
        `${SUCCESS_ICON} ${statusText("fixed", fixedText)}`,
        status.length ? statusText("remaining", `· ${status.join(" · ")}`) : "",
        discussion ? statusText("discussion", `· ${discussion}`) : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  } else if (status.length || discussion) {
    lines.push(
      "",
      [
        status.length ? statusText("remaining", status.join(" · ")) : "",
        discussion ? statusText("discussion", `${status.length ? "· " : ""}${discussion}`) : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  return lines.join("\n");
}

export interface SummaryOptions {
  baseBranch: string;
  fixed: FixedDiagnostic[];
  url: (diagnostic: Diagnostic, baseline: boolean) => string;
  sha: string;
  inlineCount: number;
  runUrl?: string | null;
  incomplete?: boolean;
  skipped?: boolean;
  limit?: number;
  includeDiagnosticDetails?: boolean;
}

function ordered(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.location.line - b.location.line ||
      a.rule.localeCompare(b.rule) ||
      a.message.localeCompare(b.message),
  );
}

function diagnosticDetails(diagnostic: Diagnostic): string {
  const details = [diagnostic.help, diagnostic.explanation, diagnostic.caveat].filter(
    (value): value is string => Boolean(value) && value !== diagnostic.message,
  );

  return details.length ? `\n  ${[...new Set(details)].map(escapeMarkdown).join(" · ")}` : "";
}

export function renderSummaryComment(report: ScanReport, options: SummaryOptions): string {
  const total = report.diagnostics.length;
  const files = new Set(report.diagnostics.map((diagnostic) => diagnostic.file)).size;
  const newLabel = report.scope === "changed" ? "new" : "reported";
  const severity = [
    `${report.counts.error} ${report.counts.error === 1 ? "error" : "errors"}`,
    `${report.counts.warning} ${report.counts.warning === 1 ? "warning" : "warnings"}`,
    `${report.counts.suggestion} ${report.counts.suggestion === 1 ? "suggestion" : "suggestions"}`,
  ].join(" & ");
  const info = options.incomplete
    ? `score unavailable · fixes unverified · vs ${inlineCode(options.baseBranch)}`
    : `score ${report.score}/100 (${scoreLabel(report.score)}) · ${options.fixed.length} fixed · vs ${inlineCode(options.baseBranch)}`;
  let headline: string;

  if (options.incomplete) {
    headline =
      `**React-Luau Doctor analysis incomplete · ${issueCount(total)} reported so far**` +
      "\n\nFindings may be missing and fixes have not been verified";
  } else if (options.skipped || total === 0) {
    headline = `**React-Luau Doctor found no ${newLabel} issues${newLabel === "new" ? ". 🎉" : ""}**`;

    if (options.skipped) {
      headline += "\n\nNo eligible React-Luau files changed in this pull request · scan skipped";
    }
  } else {
    headline =
      `**React-Luau Doctor found ${total} ${newLabel} ${total === 1 ? "issue" : "issues"}` +
      ` in ${files} ${files === 1 ? "file" : "files"} · ${severity} · ${info}**`;
  }

  const lines = [SUMMARY_MARKER, headline];

  if (options.incomplete) {
    lines.push("", `${severity} · ${info}`);
  }

  const sections: Array<{
    title: string;
    diagnostics: Diagnostic[];
    icon: string;
    grouped: boolean;
    baseline: boolean;
  }> = [
    {
      title: "Errors",
      diagnostics: report.diagnostics.filter((d) => d.severity === "error"),
      icon: "❌",
      grouped: false,
      baseline: false,
    },
    {
      title: `⚠️ ${report.counts.warning} ${report.counts.warning === 1 ? "warning" : "warnings"}`,
      diagnostics: report.diagnostics.filter((d) => d.severity === "warning"),
      icon: "⚠️",
      grouped: true,
      baseline: false,
    },
    {
      title: `💡 ${report.counts.suggestion} ${report.counts.suggestion === 1 ? "suggestion" : "suggestions"}`,
      diagnostics: report.diagnostics.filter((d) => d.severity === "suggestion"),
      icon: "💡",
      grouped: true,
      baseline: false,
    },
    {
      title: `${options.fixed.length} fixed vs <code>${escapeHtml(options.baseBranch)}</code>`,
      diagnostics: options.incomplete ? [] : options.fixed,
      icon: SUCCESS_ICON,
      grouped: true,
      baseline: true,
    },
  ];
  const inlineNote =
    options.inlineCount > 0 ? "See inline comments for fixes" : "See this report for findings";
  const footer =
    "\n\n<sub>Reviewed by [React-Luau Doctor](https://github.com/ColRealPro/react-luau-doctor)" +
    ` for commit ${inlineCode(options.sha.slice(0, 7))} · ${inlineNote}</sub>\n`;
  const reportLink = options.runUrl
    ? `[the full workflow report](${options.runUrl})`
    : "the workflow summary and logs";
  const overflow =
    "\n\nAdditional findings were omitted from this comment · See " +
    `${reportLink} for all findings and diagnostic details\n`;
  const fullLink =
    options.runUrl && (total > 0 || options.fixed.length > 0 || options.incomplete)
      ? `\n\n[View full workflow report](${options.runUrl})`
      : "";
  const limit = options.limit ?? MAX_COMMENT_LENGTH;
  const reserve = footer.length + Math.max(overflow.length, fullLink.length);

  let omitted = false;
  let body = lines.join("\n");

  for (const note of report.notes ?? []) {
    const text = `\n\n${escapeMarkdown(note)}`;

    if (body.length + text.length + reserve > limit) {
      omitted = true;
      continue;
    }

    body += text;
  }

  for (const section of sections) {
    if (!section.diagnostics.length) continue;

    const start = section.grouped
      ? `\n\n<details>\n<summary>${section.title}</summary>\n`
      : "\n\n**Errors**\n\n";
    const end = section.grouped ? "\n</details>" : "";
    let content = "";
    let file = "";

    for (const diagnostic of ordered(section.diagnostics)) {
      const group =
        section.grouped && file !== diagnostic.file ? `\n**${inlineCode(diagnostic.file)}**\n` : "";
      const uncertainLocation =
        section.baseline && (diagnostic as FixedDiagnostic).baselineLocationUncertain;
      const location = uncertainLocation
        ? "File"
        : section.grouped
          ? `L${diagnostic.location.line}`
          : inlineCode(`${diagnostic.file}:${diagnostic.location.line}`);
      const message = escapeMarkdown(diagnostic.message);
      const description = section.baseline
        ? statusText("fixed", diagnostic.message)
        : !section.grouped
          ? `**${message}**`
          : message;
      const entry =
        `${group}${group ? "\n" : ""}- ${section.icon} [${location}](${options.url(diagnostic, section.baseline)})` +
        ` ${description} ${inlineCode(diagnostic.rule)}` +
        `${options.includeDiagnosticDetails ? diagnosticDetails(diagnostic) : ""}\n`;

      if (
        body.length + start.length + content.length + entry.length + end.length + reserve >
        limit
      ) {
        omitted = true;
        continue;
      }

      content += entry;
      file = diagnostic.file;
    }

    if (content) body += start + content + end;
  }

  return body + (omitted ? overflow : fullLink) + footer;
}

export function diagnosticDifference(
  left: Diagnostic[],
  right: Diagnostic[],
  anchors?: { left: (diagnostic: Diagnostic) => string; right: (diagnostic: Diagnostic) => string },
): FixedDiagnostic[] {
  const fingerprint = (d: Diagnostic) => `${d.file}\0${d.rule}\0${d.severity}\0${d.message}`;
  const groups = new Map<string, Diagnostic[]>();

  for (const diagnostic of ordered(left)) {
    groups.set(fingerprint(diagnostic), [
      ...(groups.get(fingerprint(diagnostic)) ?? []),
      diagnostic,
    ]);
  }

  const result: FixedDiagnostic[] = [];

  for (const [key, baseline] of groups) {
    const current = right.filter((diagnostic) => fingerprint(diagnostic) === key);
    const matched = new Set<Diagnostic>();
    const used = new Set<Diagnostic>();

    if (anchors) {
      for (const diagnostic of baseline) {
        const anchor = anchors.left(diagnostic);

        if (!anchor || baseline.filter((entry) => anchors.left(entry) === anchor).length !== 1) {
          continue;
        }

        const candidates = current.filter(
          (entry) => !used.has(entry) && anchors.right(entry) === anchor,
        );

        if (candidates.length !== 1) continue;

        matched.add(diagnostic);
        used.add(candidates[0]);
      }
    }

    const remaining = baseline.filter((entry) => !matched.has(entry));
    const count = current.length - used.size;
    const uncertain = count > 0 && count < remaining.length;

    for (const diagnostic of remaining.slice(count)) {
      result.push(uncertain ? { ...diagnostic, baselineLocationUncertain: true } : diagnostic);
    }
  }

  return ordered(result);
}
