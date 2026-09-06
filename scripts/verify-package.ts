import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import packageJson from "../package.json";

const root = path.resolve(import.meta.dir, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-package-"));
function run(command: string[], cwd = temporary): string {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
try {
  const npm = Bun.which("npm") ? ["npm"] : ["bunx", "--bun", "npm"];
  const output = JSON.parse(run([...npm, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root));
  const entry = Array.isArray(output) ? output[0] : Object.values(output)[0] as any;
  const files = new Set(entry.files.map((file: { path: string }) => file.path));
  for (const required of ["dist/cli.js", "vendor/tree-sitter-luau.wasm", "vendor/tree-sitter-luau.LICENSE", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
    assert.ok(files.has(required), `Missing ${required}`);
  }
  assert.ok([...files].every(file => !/^(skills|src|tests|node_modules)\//.test(String(file))), "Unexpected development or removed files in package");

  run(["tar", "-xzf", path.join(temporary, entry.filename)]);
  const installed = path.join(temporary, "package");
  run([process.execPath, "install", "--production"], installed);
  const cli = path.join(installed, "dist/cli.js");
  assert.equal(run([process.execPath, cli, "--version"]).trim(), packageJson.version);
  const report = JSON.parse(run([process.execPath, cli, path.join(root, "examples/bad-component.luau"), "--json", "--json-compact", "--blocking", "none", "--no-cache"]));
  assert.ok(report.diagnostics.some((finding: any) => finding.help));

  const consumer = path.join(temporary, "consumer");
  fs.mkdirSync(consumer);
  run([process.execPath, cli, "ci", "install", "--yes"], consumer);
  const workflowPath = path.join(consumer, ".github/workflows/react-luau-doctor.yml");
  assert.ok(fs.existsSync(workflowPath));
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.ok(workflow.includes(`${packageJson.name}@${packageJson.version}`), "Generated CI should pin the published package version");
  console.log(`Verified ${packageJson.name}@${packageJson.version}: package contents, isolated install, scan, and npm-backed CI generation`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
