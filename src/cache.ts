import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json";
import type { CachedSourceEffectModule } from "./project-effects";
import type {
  Diagnostic,
  ProjectModel,
  ScanFileInput,
  SourceEffectModuleSummary,
} from "./types";

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHED_REPORTS = 8;

interface CachedFileState {
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  hash: string;
  isReactFile?: boolean;
}

interface SerializedSourceEffectSummary {
  effectfulMembers: string[];
  effectfulExport: boolean;
  mutatingMembers: string[];
  instanceFactories: string[];
}

interface SerializedProjectModel {
  memoizedModules: Array<[string, "shallow" | "custom"]>;
  bindingCandidateHooks: Array<[string, ProjectModel["bindingCandidateHooks"] extends Map<string, infer V> ? V : never]>;
  externalCallbackModules: Array<[string, ProjectModel["externalCallbackModules"] extends Map<string, infer V> ? V : never]>;
  bindingApiAlternatives: Array<[string, string]>;
  bindingCompatibleComponentProps: Array<[string, string[]]>;
  staticIterationTables: Array<[string, string[]]>;
  conditionalHookModes: Array<[string, ProjectModel["conditionalHookModes"] extends Map<string, infer V> ? V : never]>;
  sourceEffects: Array<[string, SerializedSourceEffectSummary]>;
}

export interface CachedReportData {
  scannedFiles: number;
  candidateFiles: number;
  diagnostics: Diagnostic[];
}

interface CachedReportEntry extends CachedReportData {
  lastUsedAt: number;
}

interface ProjectCachePayload {
  schemaVersion: number;
  analyzerVersion: string;
  root: string;
  fingerprint: string;
  files: Record<string, CachedFileState>;
  projectModel?: SerializedProjectModel;
  effectModules?: Record<string, CachedSourceEffectModule>;
  reports?: Record<string, CachedReportEntry>;
  lastUsedAt: number;
}

export interface ProjectCacheSession {
  enabled: boolean;
  root: string;
  filename: string | null;
  fingerprint: string;
  files: Record<string, CachedFileState>;
  sources: Map<string, string>;
  previous: ProjectCachePayload | null;
  exact: boolean;
  effectModules?: Record<string, CachedSourceEffectModule>;
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableCacheKey(value: unknown): string {
  return hashText(JSON.stringify(stableValue(value))).slice(0, 24);
}

export function cacheBaseDirectory(): string {
  if (process.env.REACT_LUAU_DOCTOR_CACHE_DIR) return path.resolve(process.env.REACT_LUAU_DOCTOR_CACHE_DIR);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "react-luau-doctor", "Cache");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "react-luau-doctor");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "react-luau-doctor");
}

function projectCacheFilename(root: string): string {
  const canonical = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  return path.join(cacheBaseDirectory(), `project-${hashText(canonical).slice(0, 24)}.json`);
}

function readPayload(filename: string, root: string): ProjectCachePayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as ProjectCachePayload;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.analyzerVersion !== packageJson.version ||
      path.resolve(parsed.root) !== path.resolve(root) ||
      !parsed.files ||
      typeof parsed.fingerprint !== "string"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePayload(filename: string, payload: ProjectCachePayload): void {
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload));
    fs.renameSync(temporary, filename);
  } catch {
    // Caching is an optimization. A read-only or unavailable cache directory must
    // never prevent the analyzer from running.
  }
}

function fileStateMatches(previous: CachedFileState | undefined, stat: fs.Stats): boolean {
  return Boolean(
    previous &&
    previous.size === stat.size &&
    previous.mtimeMs === stat.mtimeMs &&
    previous.ctimeMs === stat.ctimeMs &&
    previous.hash,
  );
}

export function prepareProjectCache(
  root: string,
  candidates: ScanFileInput[],
  enabled = true,
  onProgress?: (current: number, total: number, file?: string) => void,
): ProjectCacheSession {
  const cacheEnabled = enabled && process.env.REACT_LUAU_DOCTOR_DISABLE_CACHE !== "1";
  const filename = cacheEnabled ? projectCacheFilename(root) : null;
  const previous = filename ? readPayload(filename, root) : null;
  const files: Record<string, CachedFileState> = {};
  const sources = new Map<string, string>();
  const fingerprintParts: string[] = [];

  onProgress?.(0, candidates.length);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const relativePath = normalizeRelative(candidate.relativePath ?? path.relative(root, candidate.absolutePath));
    const previousState = previous?.files[relativePath];
    let state: CachedFileState;

    if (candidate.source !== undefined) {
      const hash = hashText(candidate.source);
      sources.set(relativePath, candidate.source);
      state = { hash, isReactFile: previousState?.hash === hash ? previousState.isReactFile : undefined };
    } else {
      try {
        const stat = fs.statSync(candidate.absolutePath);
        if (fileStateMatches(previousState, stat)) {
          state = { ...previousState! };
        } else {
          const source = fs.readFileSync(candidate.absolutePath, "utf8");
          const hash = hashText(source);
          sources.set(relativePath, source);
          state = {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            hash,
            isReactFile: previousState?.hash === hash ? previousState.isReactFile : undefined,
          };
        }
      } catch {
        onProgress?.(index + 1, candidates.length, relativePath);
        continue;
      }
    }

    files[relativePath] = state;
    fingerprintParts.push(`${relativePath}\0${state.hash}`);
    onProgress?.(index + 1, candidates.length, relativePath);
  }

  const fingerprint = hashText(fingerprintParts.join("\0"));
  return {
    enabled: cacheEnabled,
    root,
    filename,
    fingerprint,
    files,
    sources,
    previous,
    exact: Boolean(previous && previous.fingerprint === fingerprint),
  };
}

export function materializeProjectCandidates(session: ProjectCacheSession, candidates: ScanFileInput[]): ScanFileInput[] {
  return candidates.map((candidate) => {
    if (candidate.source !== undefined) return candidate;
    const relativePath = normalizeRelative(candidate.relativePath ?? path.relative(session.root, candidate.absolutePath));
    const cachedSource = session.sources.get(relativePath);
    if (cachedSource !== undefined) return { ...candidate, relativePath, source: cachedSource };
    try {
      const source = fs.readFileSync(candidate.absolutePath, "utf8");
      session.sources.set(relativePath, source);
      return { ...candidate, relativePath, source };
    } catch {
      return { ...candidate, relativePath };
    }
  });
}

function serializeSourceEffect(summary: SourceEffectModuleSummary): SerializedSourceEffectSummary {
  return {
    effectfulMembers: [...summary.effectfulMembers].sort(),
    effectfulExport: summary.effectfulExport,
    mutatingMembers: [...summary.mutatingMembers].sort(),
    instanceFactories: [...summary.instanceFactories].sort(),
  };
}

function deserializeSourceEffect(summary: SerializedSourceEffectSummary): SourceEffectModuleSummary {
  return {
    effectfulMembers: new Set(summary.effectfulMembers),
    effectfulExport: summary.effectfulExport,
    mutatingMembers: new Set(summary.mutatingMembers ?? []),
    instanceFactories: new Set(summary.instanceFactories),
  };
}

export function serializeProjectModel(project: ProjectModel): SerializedProjectModel {
  return {
    memoizedModules: [...project.memoizedModules],
    bindingCandidateHooks: [...project.bindingCandidateHooks],
    externalCallbackModules: [...project.externalCallbackModules],
    bindingApiAlternatives: [...project.bindingApiAlternatives],
    bindingCompatibleComponentProps: [...project.bindingCompatibleComponentProps].map(([key, value]) => [key, [...value].sort()]),
    staticIterationTables: [...project.staticIterationTables].map(([key, value]) => [key, [...value].sort()]),
    conditionalHookModes: [...project.conditionalHookModes],
    sourceEffects: [...project.sourceEffects].map(([key, value]) => [key, serializeSourceEffect(value)]),
  };
}

export function deserializeProjectModel(project: SerializedProjectModel): ProjectModel {
  return {
    memoizedModules: new Map(project.memoizedModules),
    bindingCandidateHooks: new Map(project.bindingCandidateHooks),
    externalCallbackModules: new Map(project.externalCallbackModules),
    bindingApiAlternatives: new Map(project.bindingApiAlternatives),
    bindingCompatibleComponentProps: new Map(project.bindingCompatibleComponentProps.map(([key, value]) => [key, new Set(value)])),
    staticIterationTables: new Map(project.staticIterationTables.map(([key, value]) => [key, new Set(value)])),
    conditionalHookModes: new Map(project.conditionalHookModes),
    sourceEffects: new Map(project.sourceEffects.map(([key, value]) => [key, deserializeSourceEffect(value)])),
  };
}

export function cachedEffectModules(session: ProjectCacheSession): Record<string, CachedSourceEffectModule> {
  return session.previous?.effectModules ?? {};
}

export function previousProjectModel(session: ProjectCacheSession): ProjectModel | null {
  if (!session.previous?.projectModel) return null;
  try {
    return deserializeProjectModel(session.previous.projectModel);
  } catch {
    return null;
  }
}

export function projectModelFeatureKey(project: ProjectModel): string {
  const serialized = serializeProjectModel(project);
  return stableCacheKey({
    memoizedModules: serialized.memoizedModules,
    bindingCandidateHooks: serialized.bindingCandidateHooks,
    externalCallbackModules: serialized.externalCallbackModules,
    bindingApiAlternatives: serialized.bindingApiAlternatives,
    bindingCompatibleComponentProps: serialized.bindingCompatibleComponentProps,
    staticIterationTables: serialized.staticIterationTables,
    conditionalHookModes: serialized.conditionalHookModes,
  });
}

export function cachedProjectModel(session: ProjectCacheSession): ProjectModel | null {
  if (!session.exact || !session.previous?.projectModel) return null;
  try {
    return deserializeProjectModel(session.previous.projectModel);
  } catch {
    return null;
  }
}

export function previousCachedReport(session: ProjectCacheSession, key: string): CachedReportData | null {
  const report = session.previous?.reports?.[key];
  if (!report) return null;
  return {
    scannedFiles: report.scannedFiles,
    candidateFiles: report.candidateFiles,
    diagnostics: report.diagnostics,
  };
}

export function cachedReport(session: ProjectCacheSession, key: string): CachedReportData | null {
  if (!session.exact) return null;
  const report = session.previous?.reports?.[key];
  if (!report) return null;
  return {
    scannedFiles: report.scannedFiles,
    candidateFiles: report.candidateFiles,
    diagnostics: report.diagnostics,
  };
}

export function cacheHasSameFileSet(session: ProjectCacheSession): boolean {
  if (!session.previous) return false;
  const previousFiles = Object.keys(session.previous.files).sort();
  const currentFiles = Object.keys(session.files).sort();
  return previousFiles.length === currentFiles.length && previousFiles.every((file, index) => file === currentFiles[index]);
}

export function changedProjectFiles(session: ProjectCacheSession): string[] {
  if (!session.previous) return Object.keys(session.files);
  const all = new Set([...Object.keys(session.previous.files), ...Object.keys(session.files)]);
  return [...all].filter((file) => session.previous?.files[file]?.hash !== session.files[file]?.hash).sort();
}

export function knownReactFile(session: ProjectCacheSession, relativePath: string): boolean | undefined {
  return session.files[normalizeRelative(relativePath)]?.isReactFile;
}

export function recordReactFile(session: ProjectCacheSession, relativePath: string, isReactFile: boolean): void {
  const state = session.files[normalizeRelative(relativePath)];
  if (state) state.isReactFile = isReactFile;
}

export function saveProjectCache(
  session: ProjectCacheSession,
  project: ProjectModel,
  effectModules: Record<string, CachedSourceEffectModule> = session.previous?.effectModules ?? {},
  reportKey?: string,
  report?: CachedReportData,
): void {
  if (!session.enabled || !session.filename) return;
  const reports: Record<string, CachedReportEntry> = session.exact ? { ...(session.previous?.reports ?? {}) } : {};
  if (reportKey && report) reports[reportKey] = { ...report, lastUsedAt: Date.now() };
  const prunedReports = Object.fromEntries(
    Object.entries(reports)
      .sort(([, left], [, right]) => right.lastUsedAt - left.lastUsedAt)
      .slice(0, MAX_CACHED_REPORTS),
  );
  writePayload(session.filename, {
    schemaVersion: CACHE_SCHEMA_VERSION,
    analyzerVersion: packageJson.version,
    root: path.resolve(session.root),
    fingerprint: session.fingerprint,
    files: session.files,
    projectModel: serializeProjectModel(project),
    effectModules,
    reports: prunedReports,
    lastUsedAt: Date.now(),
  });
}

export function projectCachePath(root: string): string {
  return projectCacheFilename(root);
}
