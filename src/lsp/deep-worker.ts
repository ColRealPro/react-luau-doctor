import path from "node:path";
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

import {
  cachedEffectModules,
  cachedProjectModel,
  materializeProjectCandidates,
  prepareProjectCache,
  projectModelFeatureKey,
  saveProjectCache,
  stableCacheKey,
  transitiveAffectedFiles,
} from "../cache";

import { discoverLuauFiles } from "../files";
import { analyzeReactFile } from "../file-analysis";

import {
  buildProjectModel,
  type ProjectModelModuleCacheEntry,
} from "../project-model";

import {
  buildProjectSourceEffects,
  type CachedSourceEffectModule,
  type ProjectEffectParseCacheEntry,
} from "../project-effects";

import type { ProjectModel, ScanFileInput } from "../types";

import type {
  DeepRequest,
  DeepResponse,
  WorkspaceFileRequest,
  WorkspaceFileResponse,
} from "./protocol";

const moduleCaches = new Map<
  string,
  Map<string, ProjectModelModuleCacheEntry>
>();

const stableProjects = new Map<
  string,
  {
    project: ProjectModel;
    hashes: Record<string, string>;
    effects: Record<string, CachedSourceEffectModule>;
    configKey: string;
  }
>();

export async function analyzeDeepRequest(
  request: DeepRequest,
): Promise<DeepResponse> {
  const { root, config, buffers } = request;
  const previous = stableProjects.get(root);

  const overlays = new Map(
    buffers.map((buffer) => [path.resolve(buffer.absolutePath), buffer]),
  );

  const candidates: ScanFileInput[] = discoverLuauFiles(root, config).map(
    (absolutePath) => {
      const buffer = overlays.get(path.resolve(absolutePath));

      return { absolutePath, source: buffer?.source };
    },
  );

  const present = new Set(
    candidates.map((entry) => path.resolve(entry.absolutePath)),
  );

  for (const buffer of buffers) {
    if (!present.has(path.resolve(buffer.absolutePath)))
      candidates.push({
        absolutePath: buffer.absolutePath,
        source: buffer.source,
      });
  }

  const session = prepareProjectCache(root, candidates, true, undefined, "lsp");

  const fileHashes = Object.fromEntries(
    Object.entries(session.files).map(([name, state]) => [name, state.hash]),
  );

  const moduleCache =
    moduleCaches.get(root) ?? new Map<string, ProjectModelModuleCacheEntry>();

  moduleCaches.set(root, moduleCache);

  const materialized = materializeProjectCandidates(
    session,
    candidates.map((candidate) => {
      if (candidate.source !== undefined) return candidate;

      const relativePath = path
        .relative(root, candidate.absolutePath)
        .split(path.sep)
        .join("/");
      const cached = moduleCache.get(relativePath);

      return cached?.hash === fileHashes[relativePath]
        ? { ...candidate, relativePath, source: cached.analysis.originalSource }
        : candidate;
    }),
  );

  let project = cachedProjectModel(session);
  let effects = cachedEffectModules(session);

  if (project && moduleCache.size === 0)
    buildProjectModel(root, materialized, { fileHashes, moduleCache });

  if (!project) {
    project = buildProjectModel(root, materialized, {
      fileHashes,
      moduleCache,
    });

    for (const filename of moduleCache.keys())
      if (!(filename in session.files)) moduleCache.delete(filename);

    const parsed = new Map<string, ProjectEffectParseCacheEntry>();

    try {
      const effectBuild = await buildProjectSourceEffects(
        root,
        materialized,
        parsed,
        undefined,
        fileHashes,
        previous?.effects ?? effects,
      );

      project.sourceEffects = effectBuild.effects;
      effects = effectBuild.cacheModules;
    } finally {
      for (const entry of parsed.values()) entry.tree.delete?.();
    }
  }

  saveProjectCache(session, project, effects);

  const configKey = stableCacheKey(config);
  const names = Object.keys(fileHashes);

  const sameFiles =
    previous &&
    names.length === Object.keys(previous.hashes).length &&
    names.every((name) => name in previous.hashes);

  // Global aliases and settings can affect files without a dependency edge
  const incremental =
    previous &&
    sameFiles &&
    !request.fullScan &&
    previous.configKey === configKey &&
    projectModelFeatureKey(previous.project) ===
      projectModelFeatureKey(project);

  const changed = names.filter(
    (name) => previous?.hashes[name] !== fileHashes[name],
  );

  const affected = incremental
    ? transitiveAffectedFiles(changed, previous.effects, effects)
    : new Set(names);

  stableProjects.set(root, { project, hashes: fileHashes, effects, configKey });

  const diagnostics: DeepResponse["diagnostics"] = [];

  if (request.diagnose) {
    for (const buffer of buffers) {
      if (
        request.diagnoseFiles &&
        !affected.has(buffer.relativePath) &&
        !request.diagnoseFiles.includes(buffer.absolutePath)
      )
        continue;

      const result = await analyzeReactFile({
        absolutePath: buffer.absolutePath,
        relativePath: buffer.relativePath,
        source: buffer.source,
        forceScan: false,
        lsp: true,
        project,
        config,
        minSeverity: "suggestion",
        respectInlineDisables: config.respectInlineDisables ?? true,
        categories: config.categories,
      });

      diagnostics.push({
        relativePath: buffer.relativePath,
        version: buffer.version,
        diagnostics: result.diagnostics,
      });
    }
  }

  return {
    id: request.id,
    project,
    diagnostics,
    files: candidates.map((entry) => entry.absolutePath),

    affectedFiles: candidates
      .filter((entry) =>
        affected.has(
          path.relative(root, entry.absolutePath).split(path.sep).join("/"),
        ),
      )
      .map((entry) => entry.absolutePath),
  };
}

async function analyzeWorkspaceFile(
  request: WorkspaceFileRequest,
): Promise<WorkspaceFileResponse> {
  const project = stableProjects.get(request.root)?.project;

  if (!project)
    return {
      kind: "workspace-file",
      id: request.id,
      absolutePath: request.absolutePath,
      error: "Project snapshot unavailable",
    };

  if (!fs.existsSync(request.absolutePath))
    return {
      kind: "workspace-file",
      id: request.id,
      absolutePath: request.absolutePath,
      diagnostics: [],
    };

  const source = fs.readFileSync(request.absolutePath, "utf8");

  const relativePath = path
    .relative(request.root, request.absolutePath)
    .split(path.sep)
    .join("/");

  const result = await analyzeReactFile({
    absolutePath: request.absolutePath,
    relativePath,
    source,
    forceScan: false,
    lsp: true,
    project,
    config: request.config,
    minSeverity: "suggestion",
    respectInlineDisables: request.config.respectInlineDisables ?? true,
    categories: request.config.categories,
  });

  return {
    kind: "workspace-file",
    id: request.id,
    absolutePath: request.absolutePath,
    source,
    diagnostics: result.diagnostics,
  };
}

// Serialize work in this one worker. A workspace request covers only one file, so a
// new open-file refresh waits for at most that file rather than the entire project.
let work = Promise.resolve();

parentPort?.on("message", (request: DeepRequest | WorkspaceFileRequest) => {
  work = work.then(async () => {
    try {
      parentPort!.postMessage(
        "kind" in request
          ? await analyzeWorkspaceFile(request)
          : await analyzeDeepRequest(request),
      );
    } catch (error) {
      parentPort!.postMessage(
        "kind" in request
          ? {
              kind: "workspace-file",
              id: request.id,
              absolutePath: request.absolutePath,
              error: String(error),
            }
          : { id: request.id, error: String(error), diagnostics: [] },
      );
    }
  });
});
