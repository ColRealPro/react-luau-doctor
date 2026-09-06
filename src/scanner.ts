import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRuleContext } from "./ast/context";
import { buildReactModel } from "./ast/react-model";
import {
  cacheHasSameFileSet,
  cachedEffectModules,
  cachedProjectModel,
  cachedReport,
  changedProjectFiles,
  knownReactFile,
  previousCachedReport,
  previousProjectModel,
  projectModelFeatureKey,
  materializeProjectCandidates,
  prepareProjectCache,
  recordReactFile,
  saveProjectCache,
  stableCacheKey,
} from "./cache";
import { effectiveSeverity, loadConfig } from "./config";
import { discoverLuauFiles } from "./files";
import { createInlineSuppressionChecker } from "./inline-disables";
import { parseLuau } from "./parser";
import { buildProjectModel, type ProjectModelModuleCacheEntry } from "./project-model";
import { buildProjectSourceEffects, type CachedSourceEffectModule, type ProjectEffectParseCacheEntry } from "./project-effects";
import { rules } from "./rules";
import type {
  Diagnostic,
  DiagnosticInput,
  DoctorConfig,
  ScanFileInput,
  ScanOptions,
  ScanReport,
  Severity,
  SourceFile,
} from "./types";

const REACT_SOURCE_MARKER = /\bReact(?:Roblox)?\b/i;

export const SEVERITY_RANK: Record<Severity, number> = {
  suggestion: 0,
  warning: 1,
  error: 2,
};

export interface ScanAnalysisSession {
  projectModelModules: Map<string, ProjectModelModuleCacheEntry>;
  effectModules?: Record<string, CachedSourceEffectModule>;
}

export function createScanAnalysisSession(): ScanAnalysisSession {
  return { projectModelModules: new Map() };
}

type ScanRuntimeOptions = ScanOptions & { analysisSession?: ScanAnalysisSession };

function diagnosticId(file: string, rule: string, startIndex: number, message: string): string {
  return crypto.createHash("sha256").update(`${file}\0${rule}\0${startIndex}\0${message}`).digest("hex").slice(0, 16);
}

function nodeLocation(node: DiagnosticInput["node"]): Diagnostic["location"] {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

function toDiagnostic(
  file: SourceFile,
  ruleId: string,
  category: Diagnostic["category"],
  severity: Severity,
  input: DiagnosticInput,
): Diagnostic {
  const node = input.node;
  const highlights = input.highlights?.map(nodeLocation);
  return {
    id: diagnosticId(file.relativePath, ruleId, node.startIndex, input.message),
    rule: ruleId,
    category,
    severity: input.severity ?? severity,
    message: input.message,
    help: input.help,
    file: file.relativePath,
    location: nodeLocation(node),
    highlights: highlights && highlights.length > 0 ? highlights : undefined,
    fixPreview: input.fixPreview,
  };
}

export function scoreDiagnostics(diagnostics: Diagnostic[], scannedFiles: number): number {
  const weightedFindings = diagnostics.reduce((total, diagnostic) => {
    if (diagnostic.severity === "error") return total + 8;
    if (diagnostic.severity === "warning") return total + 3;
    return total + 1;
  }, 0);
  const penalty = (weightedFindings / Math.max(scannedFiles, 1)) * 20;
  return Math.max(0, Math.round(100 - Math.min(100, penalty)));
}

function countDiagnostics(diagnostics: Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}

export function rebuildReport(
  report: ScanReport,
  diagnostics: Diagnostic[],
  metadata: Partial<Omit<ScanReport, "schemaVersion" | "diagnostics" | "counts" | "score">> = {},
): ScanReport {
  const sorted = [...diagnostics].sort(
    (a, b) => a.file.localeCompare(b.file) || a.location.line - b.location.line || b.severity.localeCompare(a.severity),
  );
  const next = { ...report, ...metadata };
  return {
    ...next,
    schemaVersion: 1,
    diagnostics: sorted,
    counts: countDiagnostics(sorted),
    score: scoreDiagnostics(sorted, next.scannedFiles),
  };
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function transitiveAffectedFiles(
  changedFiles: string[],
  previousModules: Readonly<Record<string, CachedSourceEffectModule>>,
  currentModules: Readonly<Record<string, CachedSourceEffectModule>>,
): Set<string> {
  const affected = new Set(changedFiles.map(normalizeRelative));
  const modules = new Map<string, { file: string; id: string }>();
  const reverse = new Map<string, Set<string>>();

  for (const source of [previousModules, currentModules]) {
    for (const [rawFile, module] of Object.entries(source)) {
      const file = normalizeRelative(rawFile);
      modules.set(file, { file, id: module.id });
      for (const dependency of module.importedModuleIds) {
        const importers = reverse.get(dependency) ?? new Set<string>();
        importers.add(file);
        reverse.set(dependency, importers);
      }
    }
  }

  const queue = [...affected].map((file) => modules.get(file)?.id ?? file.toLowerCase());
  const visitedIds = new Set(queue);
  while (queue.length > 0) {
    const moduleId = queue.shift()!;
    for (const importerFile of reverse.get(moduleId) ?? []) {
      if (!affected.has(importerFile)) affected.add(importerFile);
      const importerId = modules.get(importerFile)?.id;
      if (importerId && !visitedIds.has(importerId)) {
        visitedIds.add(importerId);
        queue.push(importerId);
      }
    }
  }
  return affected;
}

function candidateInputs(targetPath: string, projectRoot: string, config: DoctorConfig, options: ScanOptions): ScanFileInput[] {
  if (options.files) return options.files;
  const targetStat = fs.statSync(targetPath);
  return discoverLuauFiles(targetPath, config, projectRoot).map((absolutePath) => ({
    absolutePath,
    forceScan: targetStat.isFile(),
  }));
}

function projectInputs(root: string, config: DoctorConfig, scopedCandidates: ScanFileInput[]): ScanFileInput[] {
  const all = discoverLuauFiles(root, config).map((absolutePath) => ({ absolutePath } satisfies ScanFileInput));
  const overlays = new Map<string, ScanFileInput>();
  for (const candidate of scopedCandidates) {
    const relativePath = normalizeRelative(candidate.relativePath ?? path.relative(root, candidate.absolutePath));
    overlays.set(relativePath, candidate);
  }

  const result: ScanFileInput[] = [];
  const used = new Set<string>();
  for (const candidate of all) {
    const relativePath = normalizeRelative(path.relative(root, candidate.absolutePath));
    result.push(overlays.get(relativePath) ?? candidate);
    used.add(relativePath);
  }
  for (const [relativePath, candidate] of overlays) {
    if (!used.has(relativePath)) result.push(candidate);
  }
  return result;
}

export async function scanPath(target = ".", options: ScanRuntimeOptions = {}): Promise<ScanReport> {
  const startedAt = performance.now();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const targetPath = path.resolve(cwd, target);
  if (!fs.existsSync(targetPath)) throw new Error(`Scan path does not exist: ${target}`);
  const targetStat = fs.statSync(targetPath);
  const defaultRoot = targetStat.isFile() ? path.dirname(targetPath) : targetPath;
  const root = path.resolve(options.projectRoot ?? defaultRoot);
  const config: DoctorConfig = options.config ?? loadConfig(root);

  if (config.rules) {
    const knownRules = new Set(rules.map((rule) => rule.id));
    for (const ruleId of Object.keys(config.rules)) {
      if (!knownRules.has(ruleId)) throw new Error(`Unknown configured rule: ${ruleId}`);
    }
  }

  const candidates = candidateInputs(targetPath, root, config, options);
  const targetIsProjectRoot = path.resolve(targetPath) === path.resolve(root);
  const modelCandidates = options.files || !targetIsProjectRoot ? projectInputs(root, config, candidates) : candidates;
  const hasSourceOverlays = modelCandidates.some((candidate) => candidate.source !== undefined);
  const canPersistCache = !hasSourceOverlays;
  const phaseSuffix = options.progressPhase ? ` (${options.progressPhase})` : "";
  const phaseId = (phase: string): string => [options.progressPhase, phase].filter(Boolean).join(":");
  const progress = (phase: string, label: string, current: number, total: number, file?: string, partial?: boolean): void => {
    options.onProgress?.({ current, total, file, partial, phase: phaseId(phase), label: `${label}${phaseSuffix}` });
  };

  const cacheSession = prepareProjectCache(
    root,
    modelCandidates,
    options.cache ?? true,
    (current, total, file) => progress("index", "Indexing project", current, total, file),
  );

  const deadlineAt = options.deadlineAt ?? (options.maxDurationMs !== undefined ? startedAt + options.maxDurationMs : undefined);
  const categorySet = options.categories && options.categories.length > 0 ? new Set(options.categories) : null;
  const respectInlineDisables = options.respectInlineDisables ?? config.respectInlineDisables ?? true;
  const minSeverity = options.minSeverity ?? "suggestion";
  const reportCacheKey = stableCacheKey({
    minSeverity,
    categories: options.categories ? [...options.categories].sort() : [],
    respectInlineDisables,
    rules: config.rules ?? {},
  });
  const canCacheWholeReport = canPersistCache && targetIsProjectRoot && options.files === undefined && deadlineAt === undefined;
  const previousReport = canCacheWholeReport ? previousCachedReport(cacheSession, reportCacheKey) : null;
  const previousProject = previousProjectModel(cacheSession);
  const previousEffectModules = options.analysisSession?.effectModules ?? cachedEffectModules(cacheSession);
  const changedFiles = changedProjectFiles(cacheSession);

  if (canCacheWholeReport) {
    const reportHit = cachedReport(cacheSession, reportCacheKey);
    if (reportHit) {
      progress("report-cache", "Loading cached results", 1, 1);
      return {
        schemaVersion: 1,
        root,
        scannedFiles: reportHit.scannedFiles,
        candidateFiles: reportHit.candidateFiles,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        score: scoreDiagnostics(reportHit.diagnostics, reportHit.scannedFiles),
        counts: countDiagnostics(reportHit.diagnostics),
        diagnostics: reportHit.diagnostics,
        partial: false,
        skippedFiles: [],
      };
    }
  }

  const projectParseCache = new Map<string, ProjectEffectParseCacheEntry>();
  const fileHashes = Object.fromEntries(Object.entries(cacheSession.files).map(([file, state]) => [file, state.hash]));
  const materializedCandidates = materializeProjectCandidates(cacheSession, modelCandidates);
  let project = cachedProjectModel(cacheSession);
  if (project && !options.analysisSession) {
    progress("project-cache", "Loading cached project analysis", 1, 1);
  } else {
    // Changed-scope scans share per-module project summaries between the current
    // and baseline passes. Even when the aggregate current model is cached, one
    // module-summary pass seeds the in-memory session so the baseline only has to
    // re-analyze files whose Git contents differ.
    progress("model", "Building project model", 0, 1);
    const rebuilt = buildProjectModel(root, materializedCandidates, {
      fileHashes,
      moduleCache: options.analysisSession?.projectModelModules,
    });
    if (project?.sourceEffects) rebuilt.sourceEffects = project.sourceEffects;
    project = rebuilt;
    progress("model", "Building project model", 1, 1);
  }

  if (project.sourceEffects.size === 0) {
    const effectBuild = await buildProjectSourceEffects(
      root,
      materializedCandidates,
      projectParseCache,
      (effectProgress) => {
        if (effectProgress.phase === "parse") {
          progress("effects-parse", "Parsing effect sources", effectProgress.current, effectProgress.total, effectProgress.file);
        } else if (effectProgress.phase === "index-functions") {
          progress("effects-index-functions", "Indexing effect functions", effectProgress.current, effectProgress.total);
        } else if (effectProgress.phase === "analyze-calls") {
          progress("effects-analyze-calls", "Resolving effect calls", effectProgress.current, effectProgress.total);
        } else if (effectProgress.phase === "assemble-graph") {
          progress("effects-assemble-graph", "Building effect graph", effectProgress.current, effectProgress.total);
        } else if (effectProgress.phase === "resolve") {
          progress("effects-resolve", "Linking effect dependencies", effectProgress.current, effectProgress.total);
        } else if (effectProgress.phase === "propagate") {
          progress("effects-propagate", "Propagating project effects", effectProgress.current, effectProgress.total);
        } else {
          progress("effects-summarize", "Finalizing project effects", effectProgress.current, effectProgress.total);
        }
      },
      fileHashes,
      previousEffectModules,
    );
    project.sourceEffects = effectBuild.effects;
    cacheSession.effectModules = effectBuild.cacheModules;
  } else if (!cacheSession.effectModules) {
    cacheSession.effectModules = previousEffectModules;
  }
  if (options.analysisSession) options.analysisSession.effectModules = cacheSession.effectModules ?? previousEffectModules;

  const diagnostics: Diagnostic[] = [];
  const skippedFiles: string[] = [];
  let scannedFiles = 0;
  let scanCandidates = candidates;
  let incrementalReuse = false;

  const currentEffectModules = cacheSession.effectModules ?? previousEffectModules;
  if (
    canCacheWholeReport &&
    previousReport &&
    previousProject &&
    cacheHasSameFileSet(cacheSession) &&
    projectModelFeatureKey(previousProject) === projectModelFeatureKey(project)
  ) {
    const affectedFiles = transitiveAffectedFiles(changedFiles, previousEffectModules, currentEffectModules);
    diagnostics.push(...previousReport.diagnostics.filter((diagnostic) => !affectedFiles.has(normalizeRelative(diagnostic.file))));
    scanCandidates = candidates.filter((candidate) => {
      const relativePath = normalizeRelative(candidate.relativePath ?? path.relative(root, candidate.absolutePath));
      return affectedFiles.has(relativePath);
    });
    incrementalReuse = true;
  }

  let processedCandidates = 0;
  progress("scan", incrementalReuse ? "Scanning affected React files" : "Scanning React files", 0, scanCandidates.length);

  for (let candidateIndex = 0; candidateIndex < scanCandidates.length; candidateIndex += 1) {
    const candidate = scanCandidates[candidateIndex];
    const relativePath = normalizeRelative(candidate.relativePath ?? path.relative(root, candidate.absolutePath));

    if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
      for (const remaining of scanCandidates.slice(candidateIndex)) {
        skippedFiles.push(normalizeRelative(remaining.relativePath ?? path.relative(root, remaining.absolutePath)));
      }
      progress("scan", incrementalReuse ? "Scanning affected React files" : "Scanning React files", processedCandidates, scanCandidates.length, relativePath, true);
      break;
    }

    try {
      if (candidate.source === undefined && !fs.existsSync(candidate.absolutePath)) continue;
      const forceScan = candidate.forceScan ?? targetStat.isFile();
      const cached = projectParseCache.get(relativePath);
      if (!forceScan && !cached && !changedFiles.includes(relativePath) && knownReactFile(cacheSession, relativePath) === false) continue;

      const source = candidate.source ?? cached?.source ?? cacheSession.sources.get(relativePath) ?? fs.readFileSync(candidate.absolutePath, "utf8");

      if (!forceScan && !REACT_SOURCE_MARKER.test(source)) {
        recordReactFile(cacheSession, relativePath, false);
        continue;
      }
      
      const tree = cached && cached.source === source ? cached.tree : await parseLuau(source);
      const model = buildReactModel(tree.rootNode);
      recordReactFile(cacheSession, relativePath, model.isReactFile);
      if (!forceScan && !model.isReactFile) continue;

      scannedFiles += 1;
      const file: SourceFile = {
        absolutePath: candidate.absolutePath,
        relativePath,
        source,
        tree,
        root: tree.rootNode,
        model,
        project,
      };
      const context = createRuleContext(file);
      const isSuppressed = respectInlineDisables ? createInlineSuppressionChecker(source) : () => false;

      for (const rule of rules) {
        if (categorySet && !categorySet.has(rule.category)) continue;
        const severity = effectiveSeverity(rule.severity, rule.id, config);
        if (!severity) continue;
        const findings = rule.run(context);
        for (const finding of findings) {
          const configuredSeverity = config.rules?.[rule.id];
          const diagnostic = toDiagnostic(file, rule.id, rule.category, severity, {
            ...finding,
            severity: configuredSeverity && configuredSeverity !== "off" ? severity : finding.severity,
          });
          if (SEVERITY_RANK[diagnostic.severity] < SEVERITY_RANK[minSeverity]) continue;
          if (isSuppressed(diagnostic.rule, diagnostic.location.line)) continue;
          diagnostics.push(diagnostic);
        }
        if (rule.id === "react-luau/parse-error" && findings.length > 0) break;
      }
    } finally {
      processedCandidates = candidateIndex + 1;
      progress("scan", incrementalReuse ? "Scanning affected React files" : "Scanning React files", processedCandidates, scanCandidates.length, relativePath);
    }
  }

  if (incrementalReuse) {
    scannedFiles = Object.values(cacheSession.files).filter((state) => state.isReactFile === true).length;
  }

  diagnostics.sort(
    (a, b) => a.file.localeCompare(b.file) || a.location.line - b.location.line || b.severity.localeCompare(a.severity),
  );

  const report: ScanReport = {
    schemaVersion: 1,
    root,
    scannedFiles,
    candidateFiles: candidates.length,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    score: scoreDiagnostics(diagnostics, scannedFiles),
    counts: countDiagnostics(diagnostics),
    diagnostics,
    partial: skippedFiles.length > 0,
    skippedFiles,
  };

  if (canPersistCache) saveProjectCache(
    cacheSession,
    project,
    cacheSession.effectModules ?? cachedEffectModules(cacheSession),
    canCacheWholeReport && !report.partial ? reportCacheKey : undefined,
    canCacheWholeReport && !report.partial
      ? { scannedFiles: report.scannedFiles, candidateFiles: report.candidateFiles ?? candidates.length, diagnostics: report.diagnostics }
      : undefined,
  );

  return report;
}
