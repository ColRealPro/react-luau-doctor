import path from "node:path";
import * as vscode from "vscode";

import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function settings() {
  const config = vscode.workspace.getConfiguration("reactLuauDoctor");

  return {
    enable: config.get("enable", true),
    liveDebounceMs: config.get("liveDebounceMs", 250),
    deepOnSave: config.get("deepOnSave", true),
    workspaceScan: config.get("workspaceScan", false),
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

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "luau" },
      { scheme: "file", language: "lua" },
    ],

    initializationOptions: settings(),

    synchronize: {
      configurationSection: "reactLuauDoctor",

      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/*.{luau,lua}"),
        vscode.workspace.createFileSystemWatcher(
          "**/react-luau-doctor.config.json",
        ),
      ],
    },
  };

  client = new LanguageClient(
    "reactLuauDoctor",
    "React-Luau Doctor",
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(client);
  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
