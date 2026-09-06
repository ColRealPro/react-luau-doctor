import fs from "node:fs";
import path from "node:path";
import type { DoctorConfig } from "./types";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "Packages",
  "DevPackages",
  "ServerPackages",
  "build",
  "dist",
  "out",
  "vendor",
  "coverage",
]);

function normalize(value: string): string {
  return value.split(path.sep).join("/");
}

function wildcardToRegex(pattern: string): RegExp {
  const normalized = normalize(pattern);
  let source = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${source}$`);
}

function matchesAny(relative: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = normalize(relative);
  return patterns.some((pattern) => wildcardToRegex(pattern).test(normalized));
}

function isLuauFile(filename: string): boolean {
  return filename.endsWith(".lua") || filename.endsWith(".luau");
}

/**
 * Apply the same include/ignore selection used by directory discovery to a
 * project-root-relative file path. Git scopes supply explicit file inputs, so
 * they must call this instead of relying on discoverLuauFiles to filter them.
 */
export function isSelectedLuauPath(relativePath: string, config: DoctorConfig): boolean {
  const normalized = normalize(relativePath).replace(/^\.\//, "");
  if (!isLuauFile(normalized)) return false;

  const segments = normalized.split("/");
  let directory = "";
  for (const segment of segments.slice(0, -1)) {
    if (DEFAULT_IGNORES.has(segment)) return false;
    directory = directory ? `${directory}/${segment}` : segment;
    if (matchesAny(`${directory}/`, config.ignore)) return false;
  }

  if (matchesAny(normalized, config.ignore)) return false;
  if (config.include && config.include.length > 0 && !matchesAny(normalized, config.include)) return false;
  return true;
}

export function discoverLuauFiles(root: string, config: DoctorConfig, patternRoot = root): string[] {
  const targetStat = fs.statSync(root);
  if (targetStat.isFile()) {
    return isLuauFile(root) ? [root] : [];
  }
  if (!targetStat.isDirectory()) return [];

  const results: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(patternRoot, absolute);

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORES.has(entry.name) || matchesAny(`${normalize(relative)}/`, config.ignore)) continue;
        visit(absolute);
        continue;
      }

      if (!entry.isFile() || !isLuauFile(entry.name)) continue;
      if (!isSelectedLuauPath(relative, config)) continue;
      results.push(absolute);
    }
  };

  visit(root);
  return results.sort();
}
