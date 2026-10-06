import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { analyzeReactFile } from "../file-analysis";
import { parseLuau } from "../parser";
import type { DoctorConfig, ProjectModel } from "../types";
import { liveRules } from "./live-rules";
import { toLspDiagnostics } from "./positions";

import type {
  DeepRequest,
  DeepResponse,
  OpenBuffer,
  WorkspaceFileRequest,
  WorkspaceFileResponse,
} from "./protocol";
import type { AnalysisStatus } from "./editor-protocol";

import type {
  Diagnostic, Hover, Position,
} from "vscode-languageserver/node";
import { diagnosticHover } from "./hover";

const MAX_RECENT_DEEP_FILES = 32;
const WORKSPACE_FILE_DELAY_MS = 40;
const UNSAVED_DEEP_IDLE_MS = 1500;
const UNSAVED_DEEP_MIN_INTERVAL_MS = 3000;
const WORKSPACE_EDIT_QUIET_MS = 2000;
const liveRuleCodes = new Set(liveRules.map((rule) => rule.id));

const sourceHash = (source: string) =>
  createHash("sha256").update(source).digest("hex");

export interface EditorSettings {
  enable: boolean;
  liveDebounceMs: number;
  deepOnSave: boolean;
  workspaceScan: boolean;
}

export const defaultEditorSettings: EditorSettings = {
  enable: true,
  liveDebounceMs: 250,
  deepOnSave: true,
  workspaceScan: false,
};

interface Document extends OpenBuffer {
  uri: string;
  timer?: ReturnType<typeof setTimeout>;
  deepVersion?: number;
  bufferDirty?: boolean;
  liveRunning?: boolean;
  liveQueued?: boolean;
}

export class WorkspaceSession {
  private readonly documents = new Map<string, Document>();
  private worker: Worker | null = null;
  private project: ProjectModel | null = null;
  private running = false;
  private dirty = false;
  private dirtyIdle = false;
  private requestId = 0;
  private generation = 0;
  private runningGeneration = 0;
  private disposed = false;
  private readonly published = new Map<string, Diagnostic[]>();
  private readonly publishedSourceHashes = new Map<string, string>();

  private readonly recentDeep = new Map<
    string,
    { source: string; diagnostics: Diagnostic[]; generation: number }
  >();

  private workspaceQueue: string[] = [];
  private workspaceTimer?: ReturnType<typeof setTimeout>;

  private workspaceInFlight?: {
    id: number;
    generation: number;
    absolutePath: string;
    projectRevision: number;
  };

  private projectRevision = 0;
  private workspaceResumeAt = 0;
  private unsavedDeepTimer?: ReturnType<typeof setTimeout>;
  private unsavedDeepSerial = 0;
  private lastUnsavedDeepStartedAt = 0;
  private statusError?: string;
  private deepStartedAt = 0;
  private workspaceStartedAt = 0;
  private workspaceFilesProcessed = 0;
  private workspaceFindings = 0;

  constructor(
    readonly root: string,
    private config: DoctorConfig,
    private settings: EditorSettings,
    private readonly publish: (
      uri: string,
      version: number | undefined,
      diagnostics: Diagnostic[],
    ) => void,
    private readonly log: (
      message: string,
      level: "info" | "debug" | "error",
    ) => void = () => {},
    private readonly runtime: {
      createWorker?: (filename: string) => Worker;
      analyzeFile?: typeof analyzeReactFile;
      onStatus?: (status: AnalysisStatus) => void;
    } = {},
  ) {}

  start(): void {
    this.updateStatus();
    if (this.settings.enable && this.settings.workspaceScan)
      this.refresh(false);
  }

  open(
    uri: string,
    absolutePath: string,
    source: string,
    version: number,
  ): void {
    this.cancelUnsavedDeep();
    this.deferWorkspaceFiles();

    const relativePath = path
      .relative(this.root, absolutePath)
      .split(path.sep)
      .join("/");

    if (this.documents.has(uri)) this.close(uri);

    const document: Document = {
      uri,
      absolutePath,
      relativePath,
      source,
      version,
    };

    this.documents.set(uri, document);
    this.log(`Opened ${relativePath}`, "info");

    if (!this.settings.enable) return;

    const cached = this.project ? this.recentDeep.get(absolutePath) : undefined;

    if (
      cached &&
      cached.source === source &&
      cached.generation === this.generation
    ) {
      document.deepVersion = version;
      this.published.set(uri, cached.diagnostics);
      this.publish(uri, version, cached.diagnostics);
      this.log(`Reused diagnostics for ${relativePath} | Editor findings: ${cached.diagnostics.length}`, "debug");
      this.scheduleUnsavedDeep();

      return;
    }

    if (
      this.published.has(uri) &&
      this.publishedSourceHashes.get(uri) !== sourceHash(source)
    ) {
      this.published.delete(uri);
      this.publishedSourceHashes.delete(uri);
      this.publish(uri, version, []);
    }

    this.refresh(true);
  }

  change(uri: string, source: string, version: number): void {
    const document = this.documents.get(uri);

    if (!document || version <= document.version) return;

    if (this.dirtyIdle) {
      this.dirty = false;
      this.dirtyIdle = false;
    }

    this.deferWorkspaceFiles();
    document.source = source;
    document.version = version;
    document.deepVersion = undefined;
    document.bufferDirty = true;
    this.recentDeep.delete(document.absolutePath);
    this.publishedSourceHashes.delete(uri);

    if (document.timer) clearTimeout(document.timer);

    document.timer = undefined;
    const previous = this.published.get(uri) ?? [];

    const live = previous.filter((diagnostic) =>
      liveRuleCodes.has(String(diagnostic.code)),
    );

    this.published.set(uri, live);

    if (live.length !== previous.length) this.publish(uri, version, live);

    if (this.settings.enable) {
      this.scheduleLive(uri);
      this.scheduleUnsavedDeep();
    }
  }

  save(uri: string): void {
    const document = this.documents.get(uri);

    if (!document) return;

    this.log(`Saved ${document.relativePath}${this.settings.deepOnSave ? "" : " (project analysis on save disabled)"}`, "info");
    this.cancelUnsavedDeep();
    document.bufferDirty = false;

    if (this.published.has(uri))
      this.publishedSourceHashes.set(uri, sourceHash(document.source));

    if (this.settings.enable && this.settings.deepOnSave) {
      this.deferWorkspaceFiles();

      if (document.timer) clearTimeout(document.timer);

      document.timer = undefined;
      this.refresh(true);
    } else this.scheduleUnsavedDeep();
  }

  close(uri: string): void {
    const document = this.documents.get(uri);

    if (!document) return;

    if (document.timer) clearTimeout(document.timer);

    this.cancelUnsavedDeep();
    this.documents.delete(uri);
    this.log(`Closed ${document.relativePath}${document.bufferDirty ? " (unsaved diagnostics cleared)" : " (saved diagnostics retained)"}`, "info");

    if (document.bufferDirty) {
      this.published.delete(uri);
      this.publishedSourceHashes.delete(uri);
      this.publish(uri, undefined, []);
    } else {
      this.publish(uri, undefined, this.published.get(uri) ?? []);
    }

    if (document.bufferDirty) {
      this.recentDeep.delete(document.absolutePath);
      this.project = null;

      if (
        this.settings.enable &&
        (this.documents.size > 0 || this.settings.workspaceScan)
      )
        this.refresh(false);
    }

    if (
      [...this.documents.values()].some(
        (entry) => entry.bufferDirty && entry.deepVersion !== entry.version,
      )
    )
      this.scheduleUnsavedDeep();
  }

  updateConfig(config: DoctorConfig, settings: EditorSettings): void {
    this.cancelUnsavedDeep();
    this.generation++;
    this.recentDeep.clear();
    this.clearWorkspaceQueue();
    this.config = config;
    this.settings = settings;
    this.statusError = undefined;
    this.log(
      `Diagnostics ${settings.enable ? "enabled" : "disabled"} | Live debounce: ${settings.liveDebounceMs}ms | Deep on save: ${settings.deepOnSave ? "on" : "off"} | Workspace scan: ${settings.workspaceScan ? "on" : "off"}`,
      "info",
    );

    for (const [uri] of this.published)
      this.publish(uri, this.documents.get(uri)?.version, []);

    for (const document of this.documents.values()) {
      if (document.timer) clearTimeout(document.timer);

      document.deepVersion = undefined;
      this.publish(document.uri, document.version, []);
    }

    this.published.clear();
    this.publishedSourceHashes.clear();
    this.updateStatus();

    if (!settings.enable) return;

    if (this.documents.size > 0 || settings.workspaceScan) this.refresh(true);
  }

  configurationError(message: string): void {
    this.updateConfig({}, { ...this.settings, enable: false });
    this.reportError(message);
  }

  watchedFilesChanged(
    changes: Array<{ uri: string; type: number }> = [],
  ): void {
    if (changes.length > 0)
      this.log(`Project files changed: ${changes.length}`, "debug");
    this.cancelUnsavedDeep();
    this.generation++;
    this.recentDeep.clear();
    this.clearWorkspaceQueue();

    for (const change of changes) {
      if (this.documents.has(change.uri)) continue;

      if (this.published.has(change.uri)) {
        this.published.delete(change.uri);
        this.publishedSourceHashes.delete(change.uri);
        this.publish(change.uri, undefined, []);
      }
    }

    if (
      this.settings.enable &&
      (this.documents.size > 0 || this.settings.workspaceScan)
    )
      this.refresh(true);
  }

  hover(uri: string, position: Position): Hover | null {
    const document = this.documents.get(uri);

    if (!document) return null;

    return diagnosticHover(this.published.get(uri) ?? [], position);
  }

  private updateStatus(): void {
    if (this.disposed) return;

    const busy = this.running || this.workspaceInFlight ||
      this.workspaceQueue.length > 0 ||
      [...this.documents.values()].some((document) => document.liveRunning);
    const state = this.statusError ? "error"
      : !this.settings.enable ? "disabled"
      : busy ? "analyzing" : "idle";

    this.runtime.onStatus?.({ state, message: this.statusError });
  }

  private reportError(message: string): void {
    this.statusError = message;
    this.log(message, "error");
    this.updateStatus();
  }

  private scheduleLive(uri: string): void {
    const document = this.documents.get(uri);

    if (!document || !this.project || document.deepVersion === document.version)
      return;

    if (document.timer) clearTimeout(document.timer);

    document.timer = setTimeout(
      () => {
        document.timer = undefined;

        if (document.liveRunning) {
          document.liveQueued = true;

          return;
        }

        void this.analyzeLive(uri, document.version, document.source);
      },
      Math.max(0, this.settings.liveDebounceMs),
    );
  }

  private cancelUnsavedDeep(): void {
    this.unsavedDeepSerial++;

    if (this.unsavedDeepTimer) clearTimeout(this.unsavedDeepTimer);

    this.unsavedDeepTimer = undefined;
  }

  private scheduleUnsavedDeep(): void {
    this.cancelUnsavedDeep();

    if (
      !this.settings.enable ||
      ![...this.documents.values()].some(
        (document) =>
          document.bufferDirty && document.deepVersion !== document.version,
      )
    )
      return;

    const serial = this.unsavedDeepSerial;

    const delay = Math.max(
      UNSAVED_DEEP_IDLE_MS,
      this.lastUnsavedDeepStartedAt + UNSAVED_DEEP_MIN_INTERVAL_MS - Date.now(),
    );

    this.workspaceResumeAt = Math.max(
      this.workspaceResumeAt,
      Date.now() + delay + 500,
    );

    if (this.workspaceTimer) clearTimeout(this.workspaceTimer);

    this.workspaceTimer = undefined;
    this.scheduleWorkspaceFile();

    this.unsavedDeepTimer = setTimeout(() => {
      this.unsavedDeepTimer = undefined;
      void this.runUnsavedDeep(serial);
    }, delay);
  }

  private async runUnsavedDeep(serial: number): Promise<void> {
    const snapshots = [...this.documents.values()]
      .filter(
        (document) =>
          document.bufferDirty && document.deepVersion !== document.version,
      )
      .map(({ uri, version, source }) => ({ uri, version, source }));

    if (snapshots.length === 0) return;

    try {
      // Incomplete source is common during editing. Avoid turning a pause in the
      // middle of a statement into Doctor parse errors or a misleading project model.
      for (const snapshot of snapshots) {
        const tree = await parseLuau(snapshot.source);

        try {
          if (tree.rootNode.hasError) {
            this.log(`Deferred project analysis for ${this.documents.get(snapshot.uri)?.relativePath ?? snapshot.uri}: incomplete syntax`, "debug");
            return;
          }
        } finally {
          tree.delete?.();
        }

        if (serial !== this.unsavedDeepSerial) return;
      }

      if (
        serial !== this.unsavedDeepSerial ||
        this.disposed ||
        !this.settings.enable
      )
        return;

      if (
        snapshots.some(
          ({ uri, version }) => this.documents.get(uri)?.version !== version,
        )
      )
        return;

      this.lastUnsavedDeepStartedAt = Date.now();
      this.refresh(true, true);
    } catch (error) {
      this.reportError(`Unsaved deep analysis preparation failed: ${String(error)}`);
    }
  }

  private async analyzeLive(
    uri: string,
    version: number,
    source: string,
  ): Promise<void> {
    const document = this.documents.get(uri);
    const project = this.project;
    const generation = this.generation;

    if (!document || !project || !this.settings.enable) return;

    document.liveRunning = true;
    this.updateStatus();
    const startedAt = Date.now();

    try {
      const input = {
        absolutePath: document.absolutePath,
        relativePath: document.relativePath,
        source,
        forceScan: false,
        lsp: true,
        project,
        config: this.config,
        categories: this.config.categories,
        minSeverity: "suggestion" as const,
        respectInlineDisables: this.config.respectInlineDisables ?? true,
      };

      let result;

      if (this.runtime.analyzeFile)
        result = await this.runtime.analyzeFile(input, undefined, liveRules);
      else {
        const tree = await parseLuau(source);

        try {
          result = tree.rootNode.hasError
            ? {
                relativePath: document.relativePath,
                isReactFile: false,
                scanned: false,
                diagnostics: [],
              }
            : await analyzeReactFile(input, tree, liveRules);
        } finally {
          tree.delete?.();
        }
      }

      if (
        this.documents.get(uri)?.version !== version ||
        this.documents.get(uri)?.deepVersion === version ||
        this.generation !== generation ||
        !this.settings.enable ||
        this.disposed
      )
        return;

      const diagnostics = toLspDiagnostics(source, result.diagnostics);
      this.published.set(uri, diagnostics);
      this.publish(uri, version, diagnostics);
      this.log(`Live analysis finished for ${document.relativePath} in ${Date.now() - startedAt}ms | Findings: ${result.diagnostics.length} | Version: ${version}`, "debug");
    } catch (error) {
      if (this.generation === generation && !this.disposed)
        this.reportError(`Live analysis failed: ${String(error)}`);
    } finally {
      document.liveRunning = false;
      this.updateStatus();

      if (this.documents.get(uri) === document && document.liveQueued) {
        document.liveQueued = false;

        if (!document.timer) this.scheduleLive(uri);
      }
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const filename = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "deep-worker.js",
    );

    const worker = this.runtime.createWorker?.(filename) ?? new Worker(filename);
    this.worker = worker;
    this.log("Started project analysis worker", "info");

    this.worker.on(
      "message",
      (response: DeepResponse | WorkspaceFileResponse) => {
        if (this.worker !== worker) return;
        if ("kind" in response) this.onWorkspaceFileResult(response);
        else this.onDeepResult(response);
      },
    );

    worker.on("error", (error) => {
      if (this.disposed || this.worker !== worker) return;
      this.running = false;
      this.dirty = false;
      this.workspaceInFlight = undefined;
      this.clearWorkspaceQueue();
      this.worker = null;
      this.reportError(`Deep worker failed: ${String(error)}`);
    });

    worker.on("exit", (code) => {
      if (this.disposed || this.worker !== worker) return;
      this.running = false;
      this.dirty = false;
      this.workspaceInFlight = undefined;
      this.clearWorkspaceQueue();
      this.worker = null;
      this.reportError(`Deep worker exited with code ${code}`);
    });

    return this.worker;
  }

  private refresh(diagnose: boolean, idle = false): void {
    if (
      this.disposed ||
      !this.settings.enable ||
      (this.documents.size === 0 && !this.settings.workspaceScan)
    )
      return;

    if (this.workspaceTimer) clearTimeout(this.workspaceTimer);

    this.workspaceTimer = undefined;

    if (this.running) {
      if (!this.dirty || !idle) this.dirtyIdle = idle;

      this.dirty = true;

      return;
    }

    this.running = true;
    this.deepStartedAt = Date.now();
    this.statusError = undefined;
    this.updateStatus();
    this.projectRevision++;
    this.runningGeneration = this.generation;

    const request: DeepRequest = {
      id: ++this.requestId,
      root: this.root,
      config: this.config,

      buffers: [...this.documents.values()].map(
        ({ absolutePath, relativePath, source, version }) => ({
          absolutePath,
          relativePath,
          source,
          version,
        }),
      ),

      diagnose,
    };

    this.log(`Starting project analysis${idle ? " after typing paused" : ""} | Open files: ${request.buffers.length}`, "info");
    this.ensureWorker().postMessage(request);
  }

  private onDeepResult(response: DeepResponse): void {
    if (this.disposed) return;

    this.running = false;

    if (this.documents.size === 0 && !this.settings.workspaceScan) {
      this.project = null;
      this.dirty = false;
      this.dirtyIdle = false;
      this.updateStatus();

      return;
    }

    if (this.runningGeneration !== this.generation) {
      this.log("Discarded project analysis after configuration or project files changed", "debug");
      this.dirty = false;
      this.dirtyIdle = false;
      this.refresh(this.documents.size > 0);

      return;
    }

    if (response.error) {
      this.reportError(`Deep analysis failed: ${response.error}`);
      this.clearWorkspaceQueue();

      for (const document of this.documents.values())
        this.scheduleLive(document.uri);
    } else {
      this.project = response.project;

      if (this.settings.workspaceScan) {
        const openPaths = new Set(
          [...this.documents.values()].map((document) =>
            path.resolve(document.absolutePath),
          ),
        );

        this.workspaceQueue = (response.files ?? []).filter(
          (filename) => !openPaths.has(path.resolve(filename)),
        );
        this.workspaceStartedAt = this.workspaceQueue.length > 0 ? Date.now() : 0;
        this.workspaceFilesProcessed = 0;
        this.workspaceFindings = 0;
      }

      const covered = new Set<string>();
      const counts = { error: 0, warning: 0, suggestion: 0 };

      for (const item of response.diagnostics) {
        const document = [...this.documents.values()].find(
          (entry) => entry.relativePath === item.relativePath,
        );

        if (!document) continue;

        if (document.version !== item.version) {
          this.scheduleLive(document.uri);
          continue;
        }

        if (!this.settings.enable) continue;

        covered.add(document.uri);
        for (const finding of item.diagnostics) counts[finding.severity]++;
        const diagnostics = toLspDiagnostics(document.source, item.diagnostics);
        document.deepVersion = document.version;
        this.published.set(document.uri, diagnostics);

        this.publishedSourceHashes.set(
          document.uri,
          sourceHash(document.source),
        );

        this.recentDeep.delete(document.absolutePath);

        this.recentDeep.set(document.absolutePath, {
          source: document.source,
          diagnostics,
          generation: this.generation,
        });

        if (this.recentDeep.size > MAX_RECENT_DEEP_FILES)
          this.recentDeep.delete(this.recentDeep.keys().next().value!);

        this.publish(document.uri, document.version, diagnostics);
      }

      for (const document of this.documents.values())
        if (!covered.has(document.uri)) this.scheduleLive(document.uri);

      this.log(
        `Project analysis finished in ${Date.now() - this.deepStartedAt}ms${response.files ? ` | Project files: ${response.files.length}` : ""} | Open files checked: ${covered.size} | Errors: ${counts.error} | Warnings: ${counts.warning} | Suggestions: ${counts.suggestion}`,
        "info",
      );
      if (this.workspaceQueue.length > 0)
        this.log(`Queued unopened files for background analysis: ${this.workspaceQueue.length}`, "info");
    }

    if (this.dirty) {
      const idle = this.dirtyIdle;
      this.dirty = false;
      this.dirtyIdle = false;
      this.refresh(this.documents.size > 0, idle);
    } else this.scheduleWorkspaceFile();

    this.updateStatus();
  }

  private clearWorkspaceQueue(): void {
    this.workspaceQueue = [];
    this.workspaceStartedAt = 0;
    this.workspaceFilesProcessed = 0;
    this.workspaceFindings = 0;

    if (this.workspaceTimer) clearTimeout(this.workspaceTimer);

    this.workspaceTimer = undefined;
  }

  private deferWorkspaceFiles(): void {
    this.workspaceResumeAt = Date.now() + WORKSPACE_EDIT_QUIET_MS;

    if (this.workspaceTimer) clearTimeout(this.workspaceTimer);

    this.workspaceTimer = undefined;
    this.scheduleWorkspaceFile();
  }

  private scheduleWorkspaceFile(): void {
    if (this.workspaceStartedAt > 0 && !this.workspaceInFlight && this.workspaceQueue.length === 0) {
      this.log(
        `Background analysis finished in ${Date.now() - this.workspaceStartedAt}ms | Files processed: ${this.workspaceFilesProcessed} | Findings: ${this.workspaceFindings}`,
        "info",
      );
      this.workspaceStartedAt = 0;
    }
    if (
      !this.settings.enable ||
      !this.settings.workspaceScan ||
      this.running ||
      this.dirty ||
      this.workspaceInFlight ||
      this.workspaceTimer ||
      this.workspaceQueue.length === 0
    )
      return;

    this.workspaceTimer = setTimeout(
      () => {
        this.workspaceTimer = undefined;

        if (
          this.running ||
          this.dirty ||
          this.workspaceInFlight ||
          !this.settings.workspaceScan
        )
          return;

        let absolutePath: string | undefined;

        while (this.workspaceQueue.length > 0 && !absolutePath) {
          const candidate = this.workspaceQueue.shift()!;

          if (
            ![...this.documents.values()].some(
              (document) =>
                path.resolve(document.absolutePath) === path.resolve(candidate),
            )
          )
            absolutePath = candidate;
        }

        if (!absolutePath) {
          this.scheduleWorkspaceFile();
          this.updateStatus();
          return;
        }

        const request: WorkspaceFileRequest = {
          kind: "workspace-file",
          id: ++this.requestId,
          root: this.root,
          absolutePath,
          config: this.config,
        };

        this.workspaceInFlight = {
          id: request.id,
          generation: this.generation,
          absolutePath,
          projectRevision: this.projectRevision,
        };

        this.updateStatus();
        this.ensureWorker().postMessage(request);
      },
      Math.max(WORKSPACE_FILE_DELAY_MS, this.workspaceResumeAt - Date.now()),
    );
  }

  private onWorkspaceFileResult(response: WorkspaceFileResponse): void {
    const inFlight = this.workspaceInFlight;

    if (!inFlight || inFlight.id !== response.id || this.disposed) return;

    this.workspaceInFlight = undefined;
    const uri = pathToFileURL(response.absolutePath).href;

    if (
      inFlight.generation === this.generation &&
      inFlight.projectRevision === this.projectRevision &&
      this.settings.workspaceScan &&
      !this.documents.has(uri)
    ) {
      this.workspaceFilesProcessed++;
      if (response.error)
        this.reportError(
          `Workspace analysis failed for ${response.absolutePath}: ${response.error}`,
        );
      else {
        this.workspaceFindings += response.diagnostics?.length ?? 0;
        this.log(
          `Background analysis finished for ${path.relative(this.root, response.absolutePath)} | Findings: ${response.diagnostics?.length ?? 0}`,
          "debug",
        );
        const diagnostics =
          response.source === undefined
            ? []
            : toLspDiagnostics(response.source, response.diagnostics ?? []);

        if (diagnostics.length > 0 || this.published.has(uri)) {
          if (diagnostics.length > 0) {
            this.published.set(uri, diagnostics);

            this.publishedSourceHashes.set(
              uri,
              sourceHash(response.source ?? ""),
            );
          } else {
            this.published.delete(uri);
            this.publishedSourceHashes.delete(uri);
          }

          this.publish(uri, undefined, diagnostics);
        }
      }
    }

    this.scheduleWorkspaceFile();
    this.updateStatus();
  }

  dispose(): void {
    if (this.worker) this.log("Stopping project analysis worker", "info");
    this.disposed = true;
    this.cancelUnsavedDeep();

    for (const document of this.documents.values())
      if (document.timer) clearTimeout(document.timer);

    this.documents.clear();
    this.recentDeep.clear();
    this.publishedSourceHashes.clear();
    this.clearWorkspaceQueue();
    void this.worker?.terminate();
    this.worker = null;
  }
}
