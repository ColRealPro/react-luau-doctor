import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  CodeActionKind,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver/node";

import packageJson from "../../package.json";
import type { EditorSettings } from "./session";
import { WorkspaceManager } from "./workspace-manager";

import {
  rescanRequest,
  explainFindingRequest,
  statusNotification,
  type ExplainFindingParams,
} from "./editor-protocol";

const connection = createConnection(ProposedFeatures.all);

const workspaces = new WorkspaceManager({
  publish: (params) => connection.sendDiagnostics(params),
  log: (message, level) => connection.console[level](message),
  status: (status) => connection.sendNotification(statusNotification, status),
});

let supportsFolderChanges = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaces.initialize(
    params.workspaceFolders,
    params.rootUri,
    params.initializationOptions as Partial<EditorSettings> | undefined,
  );

  supportsFolderChanges =
    params.capabilities.workspace?.workspaceFolders === true;

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
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
  };
});

connection.onInitialized(() => {
  connection.console.info(
    `React-Luau Doctor ${packageJson.version} language server | Node ${process.version}`,
  );
  workspaces.start();

  if (supportsFolderChanges)
    connection.workspace.onDidChangeWorkspaceFolders((event) =>
      workspaces.updateFolders(event),
    );
});

connection.onCodeAction(({ textDocument, range, context }) => {
  if (
    context.only &&
    !context.only.some((kind) => CodeActionKind.QuickFix.startsWith(kind))
  )
    return [];

  return (
    workspaces
      .sessionForUri(textDocument.uri)
      ?.codeActions(textDocument.uri, range) ?? []
  );
});

connection.onRequest(rescanRequest, (params?: { uri?: string }) =>
  workspaces.rescan(params?.uri),
);

connection.onRequest(explainFindingRequest, (params: ExplainFindingParams) =>
  params &&
  typeof params.uri === "string" &&
  typeof params.version === "number" &&
  typeof params.findingId === "string"
    ? (workspaces.sessionForUri(params.uri)?.explainFinding(params) ?? null)
    : null,
);

connection.onDidOpenTextDocument(({ textDocument }) =>
  workspaces.open(textDocument),
);

connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
  const change = contentChanges.at(-1);

  if (change)
    workspaces.change(textDocument.uri, change.text, textDocument.version);
});

connection.onDidSaveTextDocument(({ textDocument }) =>
  workspaces.save(textDocument.uri),
);
connection.onDidCloseTextDocument(({ textDocument }) =>
  workspaces.close(textDocument.uri),
);

connection.onHover(
  ({ textDocument, position }) =>
    workspaces
      .sessionForUri(textDocument.uri)
      ?.hover(textDocument.uri, position) ?? null,
);

connection.onDidChangeConfiguration((params) => {
  const value = (
    params.settings as { reactLuauDoctor?: Partial<EditorSettings> } | undefined
  )?.reactLuauDoctor;
  workspaces.updateSettings(value);
});

connection.onDidChangeWatchedFiles(({ changes }) =>
  workspaces.watchedFilesChanged(changes),
);

connection.onShutdown(() => {
  connection.console.info("Shutting down language server");
  workspaces.dispose();
});

connection.onExit(() => workspaces.dispose());
connection.listen();
