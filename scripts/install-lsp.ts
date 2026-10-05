import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const extension = path.join(root, "editors", "vscode");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "package.json"), "utf8"));
const vsix = path.join(extension, `${manifest.name}-${manifest.version}.vsix`);
const code = Bun.which("code");

if (!code) {
  console.error("VS Code CLI not found. Add the 'code' command to PATH, then rerun bun run install:lsp.");
  process.exit(1);
}

if (!fs.existsSync(vsix)) {
  console.error(`VSIX not found: ${vsix}. Run bun run build:lsp first.`);
  process.exit(1);
}

const result = Bun.spawnSync([code, "--install-extension", vsix, "--force"], {
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) process.exit(result.exitCode || 1);
console.log("Extension installed. Reload your VS Code window to use the new build.");
