import path from "node:path";
import * as vscode from "vscode";

import {
  LanguageClient,
  TransportKind,
  State,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

import {
  rescanRequest,
  explainFindingRequest,
  statusNotification,
  type AnalysisStatus,
  type ExplainFindingParams,
} from "../../../src/lsp/editor-protocol.js";

import { ExplanationTerminal } from "./explanation-terminal.js";

let client: LanguageClient | undefined;

function settings() {
  const config = vscode.workspace.getConfiguration("reactLuauDoctor");

  return {
    enable: config.get("enable", true),
    liveDebounceMs: config.get("liveDebounceMs", 250),
    deepOnSave: config.get("deepOnSave", true),
    workspaceScan: config.get("workspaceScan", false),
    respectFileFilters: config.get("respectFileFilters", false),
  };
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join("server", "server.js"));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };

  const fileWatchers = [
    vscode.workspace.createFileSystemWatcher("**/*.{luau,lua}"),
    vscode.workspace.createFileSystemWatcher(
      "**/react-luau-doctor.config.json",
    ),
  ];

  context.subscriptions.push(...fileWatchers);

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "luau" },
      { scheme: "file", language: "lua" },
    ],

    initializationOptions: settings,

    synchronize: {
      configurationSection: "reactLuauDoctor",

      fileEvents: fileWatchers,
    },
  };

  client = new LanguageClient(
    "reactLuauDoctor",
    "React-Luau Doctor",
    serverOptions,
    clientOptions,
  );

  const languageClient = client;

  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );

  status.name = "React-Luau Doctor";
  status.command = "reactLuauDoctor.showOutput";
  let analysis: AnalysisStatus = { state: "idle" };
  const analyses = new Map<string, AnalysisStatus>();
  let explanationTerminal: vscode.Terminal | undefined;
  let explanationPty: ExplanationTerminal | undefined;

  function updateStatus(): void {
    const editor = vscode.window.activeTextEditor;

    if (
      !editor ||
      !["lua", "luau"].includes(editor.document.languageId) ||
      editor.document.uri.scheme !== "file"
    ) {
      status.hide();

      return;
    }

    const rootUri = vscode.workspace
      .getWorkspaceFolder(editor.document.uri)
      ?.uri.toString();
    const activeAnalysis = rootUri
      ? (analyses.get(rootUri) ?? { state: "idle" })
      : analysis;
    const state = languageClient.state;

    const failed =
      state === State.StartFailed ||
      state === State.Stopped ||
      activeAnalysis.state === "error";

    const analyzing =
      state === State.Starting || activeAnalysis.state === "analyzing";

    const background = activeAnalysis.state === "background";
    const disabled = activeAnalysis.state === "disabled";

    const count = vscode.languages
      .getDiagnostics(editor.document.uri)
      .filter((diagnostic) => diagnostic.source === "React-Luau Doctor").length;

    status.text = failed
      ? "$(warning) Doctor"
      : disabled
        ? "$(circle-slash) Doctor"
        : analyzing || background
          ? "$(sync~spin) Doctor"
          : `$(pulse) Doctor${count ? `: ${count}` : ""}`;

    status.backgroundColor = failed
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;

    status.tooltip = failed
      ? `${activeAnalysis.message ?? "Language server stopped\nRun React-Luau Doctor: Restart Language Server"}\nClick to open output`
      : disabled
        ? "React-Luau Doctor is disabled\nEnable it in Settings"
        : analyzing
          ? "React-Luau Doctor is analyzing your project\nClick to open output"
          : background
            ? "React-Luau Doctor is checking unopened files\nClick to open output"
            : `React-Luau Doctor: ${count} finding${count === 1 ? "" : "s"} in this file\nClick to open output`;

    status.show();
  }

  async function runCommand(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const message = `React-Luau Doctor: ${String(error)}`;
      languageClient.outputChannel.error(message);
      void vscode.window.showErrorMessage(message);
    }
  }

  context.subscriptions.push(
    client,
    status,
    languageClient.onNotification(
      statusNotification,
      (value: AnalysisStatus) => {
        analysis = value;

        if (value.rootUri) analyses.set(value.rootUri, value);

        updateStatus();
      },
    ),
    languageClient.onDidChangeState(({ newState }) => {
      if (newState === State.Starting) analyses.clear();

      if (newState === State.Starting)
        languageClient.outputChannel.info("Starting language server");
      else if (newState === State.Running)
        languageClient.outputChannel.info("Language server connected");
      else if (newState === State.Stopped)
        languageClient.outputChannel.info("Language server stopped");
      else if (newState === State.StartFailed)
        languageClient.outputChannel.error("Language server failed to start");

      updateStatus();
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(({ removed }) => {
      for (const folder of removed) analyses.delete(folder.uri.toString());

      updateStatus();
    }),
    vscode.languages.onDidChangeDiagnostics(updateStatus),
    vscode.commands.registerCommand("reactLuauDoctor.showOutput", () =>
      languageClient.outputChannel.show(),
    ),
    vscode.commands.registerCommand("reactLuauDoctor.rescan", () =>
      runCommand(async () => {
        if (!settings().enable) {
          void vscode.window.showInformationMessage(
            "Enable React-Luau Doctor in Settings before rescanning",
          );

          return;
        }

        await languageClient.sendRequest(rescanRequest, {
          uri: vscode.window.activeTextEditor?.document.uri.toString(),
        });
      }),
    ),
    vscode.commands.registerCommand("reactLuauDoctor.restart", () =>
      runCommand(async () => {
        languageClient.outputChannel.info("Language server restart requested");
        await languageClient.stop();
        analysis = { state: "idle" };
        await languageClient.start();
      }),
    ),
    vscode.commands.registerCommand(
      "reactLuauDoctor.explainRule",
      (params: ExplainFindingParams) =>
        runCommand(async () => {
          if (
            !params ||
            typeof params.uri !== "string" ||
            typeof params.findingId !== "string"
          )
            return;

          if (!explanationTerminal) {
            const writes = new vscode.EventEmitter<string>();

            explanationPty = new ExplanationTerminal((text) =>
              writes.fire(text),
            );

            const pty = explanationPty;

            explanationTerminal = vscode.window.createTerminal({
              name: "React-Luau Doctor: Why",
              iconPath: new vscode.ThemeIcon("pulse"),

              pty: {
                onDidWrite: writes.event,

                open: (dimensions?: vscode.TerminalDimensions) =>
                  pty.open(dimensions),

                setDimensions: (dimensions: vscode.TerminalDimensions) =>
                  pty.setDimensions(dimensions),

                close: () => {
                  pty.close();
                  writes.dispose();
                  explanationTerminal = undefined;
                  explanationPty = undefined;
                },
              },
            });

            context.subscriptions.push(explanationTerminal);
          }

          explanationPty!.explain(async (columns) => {
            try {
              return await languageClient.sendRequest<string | null>(
                explainFindingRequest,
                { ...params, columns },
              );
            } catch (error) {
              languageClient.outputChannel.error(
                `Explain failed: ${String(error)}`,
              );

              throw error;
            }
          });

          explanationTerminal.show(true);
        }),
    ),
  );

  updateStatus();
  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
