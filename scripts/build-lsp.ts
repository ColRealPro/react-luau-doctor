import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dir, "..");
const extension = path.join(root, "editors", "vscode");
const server = path.join(extension, "server");

fs.mkdirSync(server, { recursive: true });
fs.mkdirSync(path.join(extension, "vendor"), { recursive: true });

await build({
  entryPoints: [
    path.join(root, "src", "lsp", "server.ts"),
    path.join(root, "src", "lsp", "deep-worker.ts"),
  ],

  outdir: server,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["web-tree-sitter", "vscode-languageserver/node"],
});

await build({
  entryPoints: [path.join(extension, "src", "extension.ts")],
  outfile: path.join(extension, "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
});

fs.copyFileSync(
  path.join(root, "vendor", "tree-sitter-luau.wasm"),
  path.join(extension, "vendor", "tree-sitter-luau.wasm"),
);

fs.copyFileSync(
  path.join(root, "vendor", "tree-sitter-luau.LICENSE"),
  path.join(extension, "vendor", "tree-sitter-luau.LICENSE"),
);

fs.copyFileSync(
  path.join(root, "THIRD_PARTY_NOTICES.md"),
  path.join(extension, "THIRD_PARTY_NOTICES.md"),
);
