import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";

export interface UpdateInstallCommand {
  manager: "bun" | "npm";
  command: string;
  args: string[];
  display: string;
}

function normalizedPath(filename: string): string {
  return filename.replaceAll("\\", "/");
}

export function updateInstallCommandForPath(filename: string): UpdateInstallCommand | null {
  const normalized = normalizedPath(filename);
  const spec = `${packageJson.name}@latest`;

  if (normalized.includes("/.bun/install/global/node_modules/")) {
    return {
      manager: "bun",
      command: "bun",
      args: ["add", "-g", spec],
      display: `bun add -g ${spec}`,
    };
  }

  if (normalized.includes("/.bun/install/cache/") || normalized.includes("/.npm/_npx/")) return null;

  if (normalized.includes("/node_modules/")) {
    return {
      manager: "npm",
      command: "npm",
      args: ["install", "-g", spec],
      display: `npm install -g ${spec}`,
    };
  }

  return null;
}

export function currentUpdateInstallCommand(): UpdateInstallCommand | null {
  return updateInstallCommandForPath(fileURLToPath(import.meta.url));
}

export function installLatestVersion(command: UpdateInstallCommand): void {
  const result = spawnSync(command.command, command.args, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.display} exited with code ${result.status ?? "unknown"}`);
}
