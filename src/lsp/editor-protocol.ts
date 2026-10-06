export interface AnalysisStatus {
  rootUri?: string;
  state: "idle" | "analyzing" | "background" | "disabled" | "error";
  message?: string;
  progress?: { completed: number; total: number };
}

export interface ExplainFindingParams {
  uri: string;
  version: number;
  findingId: string;
  columns?: number;
}

export const statusNotification = "reactLuauDoctor/status";
export const rescanRequest = "reactLuauDoctor/rescan";
export const explainFindingRequest = "reactLuauDoctor/explainFinding";
