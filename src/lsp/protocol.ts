import type { DoctorConfig, Diagnostic, ProjectModel } from "../types";

export interface OpenBuffer {
  absolutePath: string;
  relativePath: string;
  source: string;
  version: number;
}

export interface DeepRequest {
  id: number;
  root: string;
  config: DoctorConfig;
  buffers: OpenBuffer[];
  diagnose: boolean;
  diagnoseFiles?: string[];
  fullScan?: boolean;
}

export interface DeepResponse {
  id: number;
  project: ProjectModel;

  diagnostics: Array<{
    relativePath: string;
    version: number;
    diagnostics: Diagnostic[];
  }>;

  files?: string[];
  affectedFiles?: string[];
  error?: string;
}

export interface WorkspaceFileRequest {
  kind: "workspace-file";
  id: number;
  root: string;
  absolutePath: string;
  config: DoctorConfig;
}

export interface WorkspaceFileResponse {
  kind: "workspace-file";
  id: number;
  absolutePath: string;
  source?: string;
  diagnostics?: Diagnostic[];
  error?: string;
}
