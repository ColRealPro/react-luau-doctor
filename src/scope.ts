import path from "node:path";
import { loadConfig } from "./config";
import { isSelectedLuauPath } from "./files";
import { createGitScopePlan, type GitScopePlan } from "./git";
import { createScanAnalysisSession, rebuildReport, scanPath, scoreDiagnostics, type ScanAnalysisSession } from "./scanner";
import type {
  Category,
  Diagnostic,
  DoctorConfig,
  ScanOptions,
  ScanProgress,
  ScanReport,
  ScanScope,
  Severity,
} from "./types";

export interface ScopedScanOptions {
  scope: ScanScope;
  targetRoot?: string;
  base?: string;
  includeUntracked?: boolean;
  staged?: boolean;
  changedFilesFrom?: string;
  minSeverity?: Severity;
  categories?: Category[];
  config?: DoctorConfig;
  respectInlineDisables?: boolean;
  deadlineAt?: number;
  onProgress?: (progress: ScanProgress) => void;
  cache?: boolean;
  analysisSession?: ScanAnalysisSession;
}

function diagnosticFingerprint(diagnostic: Diagnostic): string {
  return `${diagnostic.file}\0${diagnostic.rule}\0${diagnostic.severity}\0${diagnostic.message}`;
}

function introducedDiagnostics(current: Diagnostic[], baseline: Diagnostic[]): Diagnostic[] {
  const baselineCounts = new Map<string, number>();
  for (const diagnostic of baseline) {
    const fingerprint = diagnosticFingerprint(diagnostic);
    baselineCounts.set(fingerprint, (baselineCounts.get(fingerprint) ?? 0) + 1);
  }

  const introduced: Diagnostic[] = [];
  for (const diagnostic of current) {
    const fingerprint = diagnosticFingerprint(diagnostic);
    const remaining = baselineCounts.get(fingerprint) ?? 0;
    if (remaining > 0) baselineCounts.set(fingerprint, remaining - 1);
    else introduced.push(diagnostic);
  }
  return introduced;
}

function touchesChangedLines(diagnostic: Diagnostic, ranges: Array<{ start: number; end: number }>): boolean {
  const locations = [diagnostic.location, ...(diagnostic.highlights ?? [])];
  return locations.some((location) =>
    ranges.some((range) => location.endLine >= range.start && location.line <= range.end)
  );
}

function filterGitScopePlan(plan: GitScopePlan, config: DoctorConfig): GitScopePlan {
  const selected = (relativePath: string | undefined): boolean =>
    relativePath !== undefined && isSelectedLuauPath(relativePath, config);

  return {
    ...plan,
    changedFiles: plan.changedFiles.filter((file) => isSelectedLuauPath(file, config)),
    currentFiles: plan.currentFiles.filter((file) => selected(file.relativePath)),
    baselineFiles: plan.baselineFiles.filter((file) => selected(file.relativePath)),
    changedLines: new Map(
      [...plan.changedLines].filter(([file]) => isSelectedLuauPath(file, config)),
    ),
  };
}

function sharedScanOptions(options: ScopedScanOptions, projectRoot: string, phase?: string): ScanOptions & { analysisSession?: ScanAnalysisSession } {
  return {
    projectRoot,
    minSeverity: options.minSeverity,
    categories: options.categories,
    config: options.config,
    respectInlineDisables: options.respectInlineDisables,
    deadlineAt: options.deadlineAt,
    onProgress: options.onProgress,
    progressPhase: phase,
    cache: options.cache,
    analysisSession: options.analysisSession,
  };
}

export async function scanProjectWithScope(projectRoot: string, options: ScopedScanOptions): Promise<ScanReport> {
  const targetRoot = path.resolve(options.targetRoot ?? projectRoot);
  const config = options.config ?? loadConfig(projectRoot);
  const configuredOptions = options.config ? options : { ...options, config };

  if (options.scope === "full" && !options.staged && !options.changedFilesFrom) {
    const report = await scanPath(targetRoot, sharedScanOptions(configuredOptions, projectRoot));
    return { ...report, scope: "full" };
  }

  const effectiveScope: Exclude<ScanScope, "full"> = options.staged
    ? options.scope === "lines"
      ? "lines"
      : "files"
    : options.scope === "full"
      ? "files"
      : options.scope;
  const scanOptions: ScopedScanOptions = effectiveScope === "changed"
    ? { ...configuredOptions, analysisSession: options.analysisSession ?? createScanAnalysisSession() }
    : configuredOptions;

  const plan = filterGitScopePlan(createGitScopePlan(targetRoot, {
    scope: effectiveScope,
    base: options.base,
    includeUntracked: options.includeUntracked,
    staged: options.staged,
    changedFilesFrom: options.changedFilesFrom,
  }, projectRoot), config);

  const current = await scanPath(targetRoot, {
    ...sharedScanOptions(scanOptions, projectRoot, effectiveScope === "changed" ? "current" : undefined),
    files: plan.currentFiles,
  });

  let diagnostics = current.diagnostics;
  let partial = current.partial;
  let skippedFiles = current.skippedFiles;

  if (effectiveScope === "changed") {
    const baseline = await scanPath(targetRoot, {
      ...sharedScanOptions(scanOptions, projectRoot, "baseline"),
      files: plan.baselineFiles,
    });
    const baselineSkipped = new Set(baseline.skippedFiles ?? []);
    const baselinePaths = new Set(plan.baselineFiles.map((file) => file.relativePath ?? ""));
    const comparableCurrent = current.diagnostics.filter(
      (diagnostic) => !baselinePaths.has(diagnostic.file) || !baselineSkipped.has(diagnostic.file),
    );
    diagnostics = introducedDiagnostics(comparableCurrent, baseline.diagnostics);
    partial = partial || Boolean(baseline.partial);
    skippedFiles = [...new Set([...(current.skippedFiles ?? []), ...(baseline.skippedFiles ?? [])])].sort();
  } else if (effectiveScope === "lines") {
    diagnostics = current.diagnostics.filter((diagnostic) =>
      touchesChangedLines(diagnostic, plan.changedLines.get(diagnostic.file) ?? []),
    );
  }

  return rebuildReport(current, diagnostics, {
    partial,
    skippedFiles,
    scope: options.staged ? "staged" : effectiveScope,
    base: plan.base,
    changedFiles: plan.changedFiles,
  });
}

function normalize(value: string): string {
  return value.split(path.sep).join("/");
}

function prefixDiagnostic(diagnostic: Diagnostic, prefix: string): Diagnostic {
  if (!prefix || prefix === ".") return diagnostic;
  return { ...diagnostic, file: normalize(path.posix.join(prefix, diagnostic.file)) };
}

export function aggregateReports(root: string, reports: Array<{ projectRoot: string; report: ScanReport }>): ScanReport {
  const startedDuration = reports.reduce((total, entry) => total + entry.report.durationMs, 0);
  const diagnostics: Diagnostic[] = [];
  const skippedFiles: string[] = [];
  const changedFiles: string[] = [];
  const notes: string[] = [];
  const projects: string[] = [];
  let scannedFiles = 0;
  let candidateFiles = 0;
  let partial = false;

  for (const { projectRoot, report } of reports) {
    const prefix = normalize(path.relative(root, projectRoot));
    projects.push(prefix || ".");
    scannedFiles += report.scannedFiles;
    candidateFiles += report.candidateFiles ?? 0;
    partial = partial || Boolean(report.partial);
    diagnostics.push(...report.diagnostics.map((diagnostic) => prefixDiagnostic(diagnostic, prefix)));
    skippedFiles.push(...(report.skippedFiles ?? []).map((file) => (prefix ? normalize(path.posix.join(prefix, file)) : file)));
    changedFiles.push(...(report.changedFiles ?? []).map((file) => (prefix ? normalize(path.posix.join(prefix, file)) : file)));
    notes.push(...(report.notes ?? []));
  }

  diagnostics.sort(
    (a, b) => a.file.localeCompare(b.file) || a.location.line - b.location.line || b.severity.localeCompare(a.severity),
  );
  const counts: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;

  const scopes = new Set(reports.map((entry) => entry.report.scope).filter(Boolean));
  const bases = new Set(reports.map((entry) => entry.report.base).filter(Boolean));

  return {
    schemaVersion: 1,
    root,
    scannedFiles,
    candidateFiles,
    durationMs: Math.round(startedDuration * 100) / 100,
    score: scoreDiagnostics(diagnostics, scannedFiles),
    counts,
    diagnostics,
    partial,
    skippedFiles: [...new Set(skippedFiles)].sort(),
    scope: scopes.size === 1 ? [...scopes][0] : undefined,
    base: bases.size === 1 ? [...bases][0] : undefined,
    changedFiles: [...new Set(changedFiles)].sort(),
    projects,
    notes: notes.length > 0 ? [...new Set(notes)] : undefined,
  };
}
