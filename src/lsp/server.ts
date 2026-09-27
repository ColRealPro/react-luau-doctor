import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver/node";

import { loadConfig, validateKnownRules } from "../config";

import {
  WorkspaceSession,
  defaultEditorSettings,
  type EditorSettings,
} from "./session";

const connection = createConnection(ProposedFeatures.all);
let session: WorkspaceSession | null = null;
let root = process.cwd();
let settings = defaultEditorSettings;

function isRelevant(filename: string): boolean {
  return /\.(?:luau|lua)$/i.test(filename);
}

function projectConfig() {
  const config = loadConfig(root);
  validateKnownRules(config);

  return config;
}

function configure(): void {
  try {
    session?.updateConfig(projectConfig(), settings);
  } catch (error) {
    connection.console.error(`Configuration failed: ${String(error)}`);
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
    projectConfig(),
    settings,
    (documentUri, version, diagnostics) =>
      connection.sendDiagnostics({ uri: documentUri, version, diagnostics }),
    (message) => connection.console.error(message),
  );

  session.start();

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: true },
      },

      hoverProvider: true,
    },
  };
});

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
    configure();
  } else {
    session?.watchedFilesChanged(changes);
  }
});

connection.onShutdown(() => {
  session?.dispose();
  session = null;
});

connection.onExit(() => {
  session?.dispose();
  session = null;
});

connection.listen();
