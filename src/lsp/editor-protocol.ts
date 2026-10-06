export interface AnalysisStatus {
  state: "idle" | "analyzing" | "disabled" | "error";
  message?: string;
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
