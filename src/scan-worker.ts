import { parentPort } from "node:worker_threads";
import { analyzeReactFile } from "./file-analysis";
import type { ReactScanWorkerRequest, ReactScanWorkerResponse } from "./parallel";

if (!parentPort) throw new Error("Analysis worker requires a parent port");

parentPort.on("message", async (request: ReactScanWorkerRequest) => {
  try {
    if (request.type !== "react-scan") throw new Error(`Unknown analysis worker request: ${(request as { type?: string }).type ?? "unknown"}`);
    const results = [];
    for (const file of request.files) results.push(await analyzeReactFile(file));
    parentPort!.postMessage({ type: "react-scan", results } satisfies ReactScanWorkerResponse);
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    parentPort!.postMessage({ type: "error", message: value.message, stack: value.stack });
  }
});
