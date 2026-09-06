import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ReactFileAnalysisInput, ReactFileAnalysisResult } from "./file-analysis";

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

interface WorkerErrorResponse {
  type: "error";
  message: string;
  stack?: string;
}

type WorkerResponse = ReactScanWorkerResponse | WorkerErrorResponse;

function workerUrl(): URL {
  const filename = import.meta.url.endsWith(".ts") ? "scan-worker.ts" : "scan-worker.js";
  return new URL(`./${filename}`, import.meta.url);
}

export function analysisWorkerCount(fileCount: number): number {
  if (fileCount < MIN_PARALLEL_FILES) return 1;
  return Math.max(1, Math.min(MAX_ANALYSIS_WORKERS, availableParallelism(), Math.ceil(fileCount / 8)));
}

function balanceBySourceSize(files: ReactFileAnalysisInput[], workerCount: number): ReactFileAnalysisInput[][] {
  const batches = Array.from({ length: workerCount }, () => [] as ReactFileAnalysisInput[]);
  const sizes = new Array<number>(workerCount).fill(0);
  const ordered = [...files].sort((left, right) => right.source.length - left.source.length);

  for (const file of ordered) {
    let target = 0;
    for (let index = 1; index < workerCount; index += 1) {
      if (sizes[index] < sizes[target]) target = index;
    }
    batches[target].push(file);
    sizes[target] += file.source.length;
  }

  return batches;
}

export class AnalysisWorkerPool {
  private readonly workers: Worker[];

  constructor(workerCount: number) {
    this.workers = Array.from({ length: workerCount }, () => new Worker(workerUrl()));
  }

  async scanReactFiles(
    files: ReactFileAnalysisInput[],
    onBatchComplete?: (count: number, file?: string) => void,
  ): Promise<ReactFileAnalysisResult[]> {
    if (files.length === 0) return [];
    const batches = balanceBySourceSize(files, Math.min(this.workers.length, files.length));
    const results = await Promise.all(batches.map((batch, index) => this.sendReactBatch(this.workers[index], batch, onBatchComplete)));
    return results.flat();
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private sendReactBatch(
    worker: Worker,
    files: ReactFileAnalysisInput[],
    onBatchComplete?: (count: number, file?: string) => void,
  ): Promise<ReactFileAnalysisResult[]> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const onMessage = (response: WorkerResponse): void => {
        cleanup();
        if (response.type === "error") {
          const error = new Error(response.message);
          if (response.stack) error.stack = response.stack;
          reject(error);
          return;
        }
        onBatchComplete?.(files.length, files.at(-1)?.relativePath);
        resolve(response.results);
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
      worker.postMessage({ type: "react-scan", files } satisfies ReactScanWorkerRequest);
    });
  }
}
