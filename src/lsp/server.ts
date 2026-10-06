import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  CodeActionKind,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver/node";

import { loadConfigWithSource, validateKnownRules } from "../config";
import packageJson from "../../package.json";

import {
  WorkspaceSession,
  defaultEditorSettings,
  type EditorSettings,
} from "./session";
import {
  rescanRequest, explainFindingRequest, statusNotification, type ExplainFindingParams,
} from "./editor-protocol";

const connection = createConnection(ProposedFeatures.all);
let session: WorkspaceSession | null = null;
let root = process.cwd();
let settings = defaultEditorSettings;

function isRelevant(filename: string): boolean {
  return /\.(?:luau|lua)$/i.test(filename);
}

function projectConfig() {
  const loaded = loadConfigWithSource(root);
  validateKnownRules(loaded.config);

  return loaded;
}

function configure(): boolean {
  try {
    const { config, filename } = projectConfig();
    connection.console.info(filename ? `Loaded project config: ${filename}` : "Using default project configuration (no config file found)");
    connection.console.info(`Project filters | Include: ${config.include?.length ? config.include.join(", ") : "all Luau files"} | Ignore: ${config.ignore?.length ? config.ignore.join(", ") : "default exclusions"}`);
    connection.console.info(`Rule overrides: ${Object.entries(config.rules ?? {}).map(([rule, value]) => `${rule}=${value}`).join(", ") || "none"}`);
    session?.updateConfig(config, settings);
    return true;
  } catch (error) {
    const message = `Configuration failed: ${String(error)}`;
    session?.configurationError(message);
    return false;
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const uri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;

  if (uri?.startsWith("file:")) root = path.resolve(fileURLToPath(uri));

  settings = {
    ...defaultEditorSettings,
    ...(params.initializationOptions as Partial<EditorSettings> | undefined),
  };

  session = new WorkspaceSession(
    root,
    {},
    settings,
    (documentUri, version, diagnostics) =>
      connection.sendDiagnostics({ uri: documentUri, version, diagnostics }),
    (message, level) => connection.console[level](message),
    { onStatus: (status) => connection.sendNotification(statusNotification, status) },
  );

  return {
    serverInfo: { name: "React-Luau Doctor", version: packageJson.version },
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: true },
      },

      hoverProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
  };
});

connection.onInitialized(() => {
  connection.console.info(`React-Luau Doctor ${packageJson.version} language server | Node ${process.version}`);
  connection.console.info(`Project root: ${root}`);
  if (configure() && settings.enable && !settings.workspaceScan)
    connection.console.info("Ready for open files | Background workspace scanning is off");
});

connection.onCodeAction(async ({ textDocument, range, context }) => {
  if (context.only &&
    !context.only.some((kind) => CodeActionKind.QuickFix.startsWith(kind)))
    return [];
  return session?.codeActions(textDocument.uri, range) ?? [];
});

connection.onRequest(rescanRequest, () => {
  connection.console.info("Project rescan requested");
  return configure();
});
connection.onRequest(explainFindingRequest, (params: ExplainFindingParams) =>
  params && typeof params.uri === "string" && typeof params.version === "number" &&
    typeof params.findingId === "string" ? session?.explainFinding(params) ?? null : null,
);

connection.onDidOpenTextDocument(({ textDocument }) => {
  if (!session || !textDocument.uri.startsWith("file:")) return;

  const filename = fileURLToPath(textDocument.uri);

  if (isRelevant(filename)) {
    session.open(
      textDocument.uri,
      filename,
      textDocument.text,
      textDocument.version,
    );
  }
});

connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
  const change = contentChanges.at(-1);

  if (change) {
    session?.change(textDocument.uri, change.text, textDocument.version);
  }
});

connection.onDidSaveTextDocument(({ textDocument }) =>
  session?.save(textDocument.uri),
);

connection.onDidCloseTextDocument(({ textDocument }) =>
  session?.close(textDocument.uri),
);

connection.onHover(
  ({ textDocument, position }) =>
    session?.hover(textDocument.uri, position) ?? null,
);

connection.onDidChangeConfiguration((params) => {
  connection.console.info("Editor settings changed");
  const value = (
    params.settings as { reactLuauDoctor?: Partial<EditorSettings> } | undefined
  )?.reactLuauDoctor;

  if (value) {
    settings = { ...defaultEditorSettings, ...value };
  }

  configure();
});

connection.onDidChangeWatchedFiles(({ changes }) => {
  if (
    changes.some((change) =>
      /react-luau-doctor\.config\.json$/i.test(change.uri),
    )
  ) {
    connection.console.info("Project config changed");
    configure();
  } else {
    session?.watchedFilesChanged(changes);
  }
});

connection.onShutdown(() => {
  connection.console.info("Shutting down language server");
  session?.dispose();
  session = null;
});

connection.onExit(() => {
  session?.dispose();
  session = null;
});

connection.listen();
