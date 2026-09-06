import { parentPort } from "node:worker_threads";
import { analyzeReactFile } from "./file-analysis";
import {
  analyzeEffectModuleForWorker,
  indexEffectModuleForWorker,
  type EffectWorkerState,
} from "./project-effects";
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from "./parallel";
import type { Tree } from "web-tree-sitter";

if (!parentPort) throw new Error("Analysis worker requires a parent port");

const effectStates = new Map<string, EffectWorkerState>();
const treeCache = new Map<string, { source: string; tree: Tree }>();

parentPort.on("message", async (request: AnalysisWorkerRequest) => {
  try {
    if (request.type === "effect-index") {
      const modules = [];
      for (const file of request.files) {
        try {
          const result = await indexEffectModuleForWorker(file, request.moduleAliases);
          effectStates.set(file.id, result.state);
          treeCache.set(file.relativePath, { source: file.source, tree: result.tree });
          modules.push(result.indexed);
        } catch {
          // The normal scanner owns parse diagnostics. Failed effect modules are
          // omitted here exactly as they are in the sequential effect pass.
        }
      }
      parentPort!.postMessage({ type: "effect-index", modules } satisfies AnalysisWorkerResponse);
      return;
    }

    if (request.type === "effect-analyze") {
      const modules = [...effectStates.values()].map((state) =>
        analyzeEffectModuleForWorker(state, request.moduleSummaries, request.exportedFunctions)
      );
      parentPort!.postMessage({ type: "effect-analyze", modules } satisfies AnalysisWorkerResponse);
      return;
    }

    if (request.type === "react-scan") {
      const results = [];
      for (const file of request.files) {
        const cached = treeCache.get(file.relativePath);
        results.push(await analyzeReactFile(file, cached?.source === file.source ? cached.tree : undefined));
      }
      parentPort!.postMessage({ type: "react-scan", results } satisfies AnalysisWorkerResponse);
      return;
    }

    throw new Error(`Unknown analysis worker request: ${(request as { type?: string }).type ?? "unknown"}`);
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    parentPort!.postMessage({ type: "error", message: value.message, stack: value.stack } satisfies AnalysisWorkerResponse);
  }
});
