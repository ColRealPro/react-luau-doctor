import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  FileEvent,
  PublishDiagnosticsParams,
} from "vscode-languageserver/node";

import { loadConfigWithSource, validateKnownRules } from "../config";

import {
  WorkspaceSession,
  defaultEditorSettings,
  type EditorSettings,
} from "./session";

import type { AnalysisStatus } from "./editor-protocol";

interface WorkspaceCallbacks {
  publish: (params: PublishDiagnosticsParams) => void;
  log: (message: string, level: "info" | "debug" | "error") => void;
  status: (status: AnalysisStatus) => void;
}

interface OpenDocument {
  absolutePath: string;
  source: string;
  version: number;
  dirty: boolean;
  session?: WorkspaceSession;
}

function containsPath(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);

  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export class WorkspaceManager {
  private readonly sessions = new Map<string, WorkspaceSession>();
  private readonly publishedOwners = new Map<string, WorkspaceSession>();
  private readonly documents = new Map<string, OpenDocument>();
  private settings = defaultEditorSettings;
  private fallbackRoot?: string;

  constructor(private readonly callbacks: WorkspaceCallbacks) {}

  initialize(
    folders: readonly { uri: string }[] | null | undefined,
    rootUri: string | null,
    settings: Partial<EditorSettings> = {},
  ): void {
    this.settings = { ...defaultEditorSettings, ...settings };

    if (folders?.length) {
      for (const folder of folders) this.addFolder(folder.uri);
    } else {
      this.fallbackRoot = this.addFolder(
        rootUri ?? pathToFileURL(process.cwd()).href,
      )?.root;
    }
  }

  start(): void {
    for (const session of this.sessions.values()) this.configure(session);
  }

  sessionForUri(uri: string): WorkspaceSession | undefined {
    if (!uri.startsWith("file:")) return undefined;

    const filename = fileURLToPath(uri);
    let selected: WorkspaceSession | undefined;

    for (const [root, session] of this.sessions) {
      if (
        containsPath(root, filename) &&
        (!selected || root.length > selected.root.length)
      )
        selected = session;
    }

    return (
      selected ??
      (this.fallbackRoot ? this.sessions.get(this.fallbackRoot) : undefined)
    );
  }

  updateFolders(event: {
    added: readonly { uri: string }[];
    removed: readonly { uri: string }[];
  }): void {
    for (const folder of event.removed) this.removeFolder(folder.uri);

    for (const folder of event.added) this.addFolder(folder.uri);

    const changedRoots = [...event.added, ...event.removed]
      .filter((folder) => folder.uri.startsWith("file:"))
      .map((folder) => path.resolve(fileURLToPath(folder.uri)));

    // Nested roots change which session may publish diagnostics for their files
    for (const session of this.sessions.values()) {
      if (changedRoots.some((root) => containsPath(session.root, root)))
        this.configure(session);
    }

    for (const [uri, document] of this.documents) {
      const session = this.sessionForUri(uri);

      if (document.session === session) continue;

      document.session?.close(uri);
      document.session = session;
      this.publishedOwners.delete(uri);

      this.callbacks.publish({
        uri,
        version: document.version,
        diagnostics: [],
      });

      this.openInSession(uri, document);
    }
  }

  updateSettings(settings: Partial<EditorSettings> | undefined): void {
    this.log("Editor settings changed");

    if (settings) this.settings = { ...defaultEditorSettings, ...settings };

    this.start();
  }

  rescan(uri?: string): boolean {
    this.log("Project rescan requested");
    const session = uri ? this.sessionForUri(uri) : undefined;

    const selected = uri
      ? session
        ? [session]
        : []
      : [...this.sessions.values()];

    const results = selected.map((session) => this.configure(session));

    return results.length > 0 && results.every(Boolean);
  }

  open(document: { uri: string; text: string; version: number }): void {
    if (!document.uri.startsWith("file:")) return;

    const absolutePath = fileURLToPath(document.uri);

    if (!/\.(?:luau|lua)$/i.test(absolutePath)) return;

    const buffer: OpenDocument = {
      absolutePath,
      source: document.text,
      version: document.version,
      dirty: false,
      session: this.sessionForUri(document.uri),
    };

    this.documents.set(document.uri, buffer);
    this.openInSession(document.uri, buffer);
  }

  change(uri: string, source: string, version: number): void {
    const document = this.documents.get(uri);

    if (!document || version <= document.version) return;

    document.source = source;
    document.version = version;
    document.dirty = true;
    document.session?.change(uri, source, version);
  }

  save(uri: string): void {
    const document = this.documents.get(uri);

    if (!document) return;

    document.dirty = false;
    document.session?.save(uri);
  }

  close(uri: string): void {
    this.documents.get(uri)?.session?.close(uri);
    this.documents.delete(uri);
  }

  watchedFilesChanged(changes: FileEvent[]): void {
    for (const session of this.sessions.values()) {
      const relevant = changes.filter(
        (change) => this.sessionForUri(change.uri) === session,
      );

      if (relevant.length === 0) continue;

      if (
        relevant.some((change) =>
          /react-luau-doctor\.config\.json$/i.test(change.uri),
        )
      ) {
        this.log(`Project config changed: ${session.root}`);
        this.configure(session);
      } else session.watchedFilesChanged(relevant);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();

    this.sessions.clear();
    this.documents.clear();
    this.publishedOwners.clear();
  }

  private log(
    message: string,
    level: "info" | "debug" | "error" = "info",
  ): void {
    this.callbacks.log(message, level);
  }

  private openInSession(uri: string, document: OpenDocument): void {
    document.session?.open(
      uri,
      document.absolutePath,
      document.source,
      document.version,
      document.dirty,
    );
  }

  private configure(session: WorkspaceSession): boolean {
    this.log(`Project root: ${session.root}`);

    try {
      const { config, filename } = loadConfigWithSource(session.root);
      validateKnownRules(config);

      this.log(
        filename
          ? `Loaded project config: ${filename}`
          : "Using default project configuration (no config file found)",
      );

      this.log(
        `Project filters | Include: ${config.include?.length ? config.include.join(", ") : "all Luau files"} | Ignore: ${config.ignore?.length ? config.ignore.join(", ") : "default exclusions"}`,
      );

      this.log(
        `Rule overrides: ${
          Object.entries(config.rules ?? {})
            .map(([rule, value]) => `${rule}=${value}`)
            .join(", ") || "none"
        }`,
      );

      session.updateConfig(config, this.settings);

      if (this.settings.enable && !this.settings.workspaceScan)
        this.log("Ready for open files | Background workspace scanning is off");

      return true;
    } catch (error) {
      session.configurationError(`Configuration failed: ${String(error)}`);

      return false;
    }
  }

  private addFolder(uri: string): WorkspaceSession | undefined {
    if (!uri.startsWith("file:")) return undefined;

    const root = path.resolve(fileURLToPath(uri));

    if (this.sessions.has(root)) return undefined;

    const session = new WorkspaceSession(
      root,
      {},
      this.settings,
      (documentUri, version, diagnostics) => {
        if (this.sessionForUri(documentUri) !== session) return;

        if (diagnostics.length > 0)
          this.publishedOwners.set(documentUri, session);
        else this.publishedOwners.delete(documentUri);

        this.callbacks.publish({ uri: documentUri, version, diagnostics });
      },
      (message, level) =>
        this.log(
          this.sessions.size > 1 ? `[${root}] ${message}` : message,
          level,
        ),
      {
        onStatus: (status) =>
          this.callbacks.status({ ...status, rootUri: uri }),
      },
    );

    this.sessions.set(root, session);

    return session;
  }

  private removeFolder(uri: string): void {
    if (!uri.startsWith("file:")) return;

    const root = path.resolve(fileURLToPath(uri));
    const session = this.sessions.get(root);

    if (!session) return;

    this.sessions.delete(root);
    session.dispose();

    for (const [documentUri, owner] of this.publishedOwners) {
      if (owner !== session) continue;

      this.publishedOwners.delete(documentUri);
      this.callbacks.publish({ uri: documentUri, diagnostics: [] });
    }

    this.log(`Removed project root: ${root}`);
  }
}
