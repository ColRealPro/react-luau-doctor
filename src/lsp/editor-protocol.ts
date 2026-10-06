export interface AnalysisStatus {
  state: "idle" | "analyzing" | "disabled" | "error";
  message?: string;
}

export const statusNotification = "reactLuauDoctor/status";
export const rescanRequest = "reactLuauDoctor/rescan";
