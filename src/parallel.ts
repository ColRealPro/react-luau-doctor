import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ReactFileAnalysisInput, ReactFileAnalysisResult } from "./file-analysis";
import type {
  AnalyzedEffectWorkerModule,
  EffectWorkerIndexInput,
  IndexedEffectWorkerModule,
} from "./project-effects";
import type { SourceEffectModuleSummary } from "./types";

export const MIN_PARALLEL_FILES = 16;
const MAX_ANALYSIS_WORKERS = 8;

export interface ReactScanWorkerRequest {
  type: "react-scan";
  files: ReactFileAnalysisInput[];
}

export interface ReactScanWorkerResponse {
  type: "react-scan";
  results: ReactFileAnalysisResult[];
}

export interface EffectIndexWorkerRequest {
  type: "effect-index";
  files: EffectWorkerIndexInput[];
  moduleAliases: Map<string, string>;
}

export interface EffectIndexWorkerResponse {
  type: "effect-index";
  modules: IndexedEffectWorkerModule[];
}

export interface EffectAnalyzeWorkerRequest {
  type: "effect-analyze";
  moduleSummaries: Map<string, SourceEffectModuleSummary>;
  exportedFunctions: Map<string, string>;
}

export interface EffectAnalyzeWorkerResponse {
  type: "effect-analyze";
  modules: AnalyzedEffectWorkerModule[];
}

interface WorkerErrorResponse {
  type: "error";
  message: string;
  stack?: string;
}

export type AnalysisWorkerRequest = ReactScanWorkerRequest | EffectIndexWorkerRequest | EffectAnalyzeWorkerRequest;
export type AnalysisWorkerResponse = ReactScanWorkerResponse | EffectIndexWorkerResponse | EffectAnalyzeWorkerResponse | WorkerErrorResponse;

function workerUrl(): URL {
  const filename = import.meta.url.endsWith(".ts") ? "scan-worker.ts" : "scan-worker.js";
  return new URL(`./${filename}`, import.meta.url);
}

export function analysisWorkerCount(fileCount: number): number {
  if (fileCount < MIN_PARALLEL_FILES) return 1;
  return Math.max(1, Math.min(MAX_ANALYSIS_WORKERS, availableParallelism(), Math.ceil(fileCount / 8)));
}

function balancedIndexes(files: Array<{ source: string }>, workerCount: number): number[] {
  const sizes = new Array<number>(workerCount).fill(0);
  const indexes = new Array<number>(files.length);
  const ordered = files.map((file, index) => ({ file, index })).sort((left, right) => right.file.source.length - left.file.source.length);

  for (const { file, index } of ordered) {
    let target = 0;
    for (let workerIndex = 1; workerIndex < workerCount; workerIndex += 1) {
      if (sizes[workerIndex] < sizes[target]) target = workerIndex;
    }
    indexes[index] = target;
    sizes[target] += file.source.length;
  }

  return indexes;
}

export class AnalysisWorkerPool {
  private readonly workers: Worker[];
  private readonly effectOwners = new Map<string, number>();

  constructor(workerCount: number) {
    this.workers = Array.from({ length: workerCount }, () => new Worker(workerUrl()));
  }

  async indexEffectModules(
    files: EffectWorkerIndexInput[],
    moduleAliases: Map<string, string>,
    onBatchComplete?: (count: number, file?: string) => void,
  ): Promise<IndexedEffectWorkerModule[]> {
    if (files.length === 0) return [];
    const assignments = balancedIndexes(files, this.workers.length);
    const batches = Array.from({ length: this.workers.length }, () => [] as EffectWorkerIndexInput[]);
    for (let index = 0; index < files.length; index += 1) {
      const owner = assignments[index];
      const file = files[index];
      batches[owner].push(file);
      this.effectOwners.set(file.relativePath, owner);
    }

    const results = await Promise.all(batches.map(async (batch, index) => {
      if (batch.length === 0) return [];
      const response = await this.send(this.workers[index], {
        type: "effect-index",
        files: batch,
        moduleAliases,
      });
      if (response.type !== "effect-index") throw new Error(`Unexpected analysis worker response: ${response.type}`);
      onBatchComplete?.(batch.length, batch.at(-1)?.relativePath);
      return response.modules;
    }));
    return results.flat();
  }

  async analyzeEffectModules(
    moduleSummaries: Map<string, SourceEffectModuleSummary>,
    exportedFunctions: Map<string, string>,
    onBatchComplete?: (count: number) => void,
  ): Promise<AnalyzedEffectWorkerModule[]> {
    const results = await Promise.all(this.workers.map(async (worker) => {
      const response = await this.send(worker, { type: "effect-analyze", moduleSummaries, exportedFunctions });
      if (response.type !== "effect-analyze") throw new Error(`Unexpected analysis worker response: ${response.type}`);
      onBatchComplete?.(response.modules.length);
      return response.modules;
    }));
    return results.flat();
  }

  async scanReactFiles(
    files: ReactFileAnalysisInput[],
    onBatchComplete?: (count: number, file?: string) => void,
  ): Promise<ReactFileAnalysisResult[]> {
    if (files.length === 0) return [];
    const batches = Array.from({ length: this.workers.length }, () => [] as ReactFileAnalysisInput[]);
    const sizes = new Array<number>(this.workers.length).fill(0);
    const unassigned: ReactFileAnalysisInput[] = [];

    for (const file of files) {
      const owner = this.effectOwners.get(file.relativePath);
      if (owner === undefined) {
        unassigned.push(file);
        continue;
      }
      batches[owner].push(file);
      sizes[owner] += file.source.length;
    }

    for (const file of [...unassigned].sort((left, right) => right.source.length - left.source.length)) {
      let target = 0;
      for (let index = 1; index < this.workers.length; index += 1) {
        if (sizes[index] < sizes[target]) target = index;
      }
      batches[target].push(file);
      sizes[target] += file.source.length;
    }

    const results = await Promise.all(batches.map(async (batch, index) => {
      if (batch.length === 0) return [];
      const response = await this.send(this.workers[index], { type: "react-scan", files: batch });
      if (response.type !== "react-scan") throw new Error(`Unexpected analysis worker response: ${response.type}`);
      onBatchComplete?.(batch.length, batch.at(-1)?.relativePath);
      return response.results;
    }));
    return results.flat();
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private send(worker: Worker, request: AnalysisWorkerRequest): Promise<AnalysisWorkerResponse> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const onMessage = (response: AnalysisWorkerResponse): void => {
        cleanup();
        if (response.type === "error") {
          const error = new Error(response.message);
          if (response.stack) error.stack = response.stack;
          reject(error);
          return;
        }
        resolve(response);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        if (code === 0) return;
        cleanup();
        reject(new Error(`Analysis worker exited with code ${code}`));
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage(request);
    });
  }
}
