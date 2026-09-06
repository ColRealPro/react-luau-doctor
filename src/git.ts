import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ScanFileInput, ScanScope } from "./types";

export interface LineRange {
  start: number;
  end: number;
}

export interface GitScopeOptions {
  scope: Exclude<ScanScope, "full">;
  base?: string;
  includeUntracked?: boolean;
  staged?: boolean;
  changedFilesFrom?: string;
}

export interface GitScopePlan {
  repoRoot: string;
  scanRoot: string;
  base: string;
  changedFiles: string[];
  currentFiles: ScanFileInput[];
  baselineFiles: ScanFileInput[];
  changedLines: Map<string, LineRange[]>;
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], allowFailure = false): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    if (allowFailure) return { status: 1, stdout: "", stderr: result.error.message };
    throw new Error(`git ${args[0] ?? ""} failed: ${result.error.message}`);
  }

  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (status !== 0 && !allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${status}`;
    throw new Error(`git ${args[0] ?? ""} failed: ${detail}`);
  }
  return { status, stdout, stderr };
}

function normalize(value: string): string {
  return value.split(path.sep).join("/");
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isLuauFile(filename: string): boolean {
  return filename.endsWith(".lua") || filename.endsWith(".luau");
}

function lines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function findGitRoot(cwd: string): string {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"], true);
  if (result.status !== 0) throw new Error(`Git scope requires a git repository: ${cwd}`);
  return path.resolve(result.stdout.trim());
}

function verifyCommit(repoRoot: string, ref: string): string | null {
  if (ref.startsWith("-")) throw new Error(`Invalid git ref: ${ref}`);
  const result = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true);
  return result.status === 0 ? result.stdout.trim() : null;
}

function hasWorkingChanges(repoRoot: string): boolean {
  return runGit(repoRoot, ["status", "--porcelain", "--untracked-files=no"], true).stdout.trim().length > 0;
}

function resolveOriginHead(repoRoot: string): string | null {
  const result = runGit(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], true);
  if (result.status !== 0) return null;
  return result.stdout.trim().replace(/^refs\/remotes\//, "");
}

function mergeBase(repoRoot: string, left: string, right = "HEAD"): string | null {
  const result = runGit(repoRoot, ["merge-base", left, right], true);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function resolveGitBase(repoRoot: string, requested?: string): string {
  if (requested) {
    const commit = verifyCommit(repoRoot, requested);
    if (!commit) throw new Error(`Could not resolve git base ref: ${requested}`);
    return mergeBase(repoRoot, commit) ?? commit;
  }

  const environmentBase = process.env.GITHUB_BASE_REF?.trim();
  const candidates = [
    environmentBase ? `origin/${environmentBase}` : null,
    environmentBase ?? null,
    resolveOriginHead(repoRoot),
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const head = verifyCommit(repoRoot, "HEAD");
  for (const candidate of [...new Set(candidates)]) {
    const commit = verifyCommit(repoRoot, candidate);
    if (!commit || commit === head) continue;
    const base = mergeBase(repoRoot, commit);
    if (base) return base;
  }

  if (hasWorkingChanges(repoRoot)) return verifyCommit(repoRoot, "HEAD") ?? "HEAD";
  return verifyCommit(repoRoot, "HEAD") ?? "HEAD";
}

function readChangedFilesFile(filename: string, repoRoot: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filename, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read --changed-files-from file "${filename}": ${detail}`);
  }

  return lines(content).map((entry) => {
    const absolute = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(repoRoot, entry);
    return normalize(path.relative(repoRoot, absolute));
  });
}

function getUntrackedFiles(repoRoot: string): string[] {
  return lines(runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], true).stdout);
}

interface ChangedRepoFile {
  currentPath: string;
  baselinePath: string | null;
}

function parseNameStatusZ(output: string): ChangedRepoFile[] {
  const fields = output.split("\0");
  const changed: ChangedRepoFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const baselinePath = fields[index++];
      const currentPath = fields[index++];
      if (baselinePath && currentPath) changed.push({ currentPath: normalize(currentPath), baselinePath: normalize(baselinePath) });
      continue;
    }
    const currentPath = fields[index++];
    if (!currentPath) continue;
    changed.push({
      currentPath: normalize(currentPath),
      baselinePath: status.startsWith("A") ? null : normalize(currentPath),
    });
  }
  return changed;
}

function getChangedRepoFiles(
  repoRoot: string,
  base: string,
  options: Pick<GitScopeOptions, "includeUntracked" | "staged" | "changedFilesFrom">,
): ChangedRepoFile[] {
  let changed: ChangedRepoFile[];

  if (options.changedFilesFrom) {
    changed = readChangedFilesFile(path.resolve(process.cwd(), options.changedFilesFrom), repoRoot).map((currentPath) => ({
      currentPath: normalize(currentPath),
      baselinePath: normalize(currentPath),
    }));
  } else {
    const args = options.staged
      ? ["diff", "--cached", "--name-status", "-z", "--find-renames", "--diff-filter=ACDMR", "--"]
      : ["diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACDMR", base, "--"];
    changed = parseNameStatusZ(runGit(repoRoot, args).stdout);
  }

  if (options.includeUntracked && !options.staged) {
    changed.push(...getUntrackedFiles(repoRoot).map((currentPath) => ({ currentPath: normalize(currentPath), baselinePath: null })));
  }

  const byCurrentPath = new Map<string, ChangedRepoFile>();
  for (const entry of changed) byCurrentPath.set(entry.currentPath, entry);
  return [...byCurrentPath.values()].sort((a, b) => a.currentPath.localeCompare(b.currentPath));
}

function readGitObject(repoRoot: string, objectSpec: string): string | null {
  const result = runGit(repoRoot, ["show", objectSpec], true);
  return result.status === 0 ? result.stdout : null;
}

function readGitObjects(repoRoot: string, objectSpecs: string[]): Map<string, string | null> {
  const unique = [...new Set(objectSpecs)];
  const values = new Map<string, string | null>();
  if (unique.length === 0) return values;

  const result = spawnSync("git", ["cat-file", "--batch", "-z"], {
    cwd: repoRoot,
    input: `${unique.join("\0")}\0`,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || (result.status ?? 1) !== 0 || !Buffer.isBuffer(result.stdout)) {
    // Fall back to individual reads if a Git version or unusual object name does
    // not support the batch path. Correctness is more important than the speedup.
    for (const spec of unique) values.set(spec, readGitObject(repoRoot, spec));
    return values;
  }

  const output = result.stdout;
  let offset = 0;
  let parseFailed = false;
  for (const spec of unique) {
    const lineEnd = output.indexOf(0x0a, offset);
    if (lineEnd < 0) {
      parseFailed = true;
      break;
    }
    const header = output.subarray(offset, lineEnd).toString("utf8");
    offset = lineEnd + 1;
    if (header.endsWith(" missing")) {
      values.set(spec, null);
      continue;
    }

    const match = header.match(/^[0-9a-f]+\s+\S+\s+(\d+)$/i);
    if (!match) {
      parseFailed = true;
      break;
    }
    const size = Number(match[1]);
    const end = offset + size;
    if (!Number.isSafeInteger(size) || size < 0 || end > output.length) {
      parseFailed = true;
      break;
    }
    values.set(spec, output.subarray(offset, end).toString("utf8"));
    offset = end;
    if (output[offset] === 0x0a) offset += 1;
  }

  if (parseFailed) {
    values.clear();
    for (const spec of unique) values.set(spec, readGitObject(repoRoot, spec));
  }
  return values;
}

function currentSource(repoRoot: string, repoRelativePath: string, staged: boolean): string | null {
  if (staged) return readGitObject(repoRoot, `:${repoRelativePath}`);
  const absolute = path.join(repoRoot, ...repoRelativePath.split("/"));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  return fs.readFileSync(absolute, "utf8");
}

function parseChangedLineRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count <= 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function lineRangesForFile(repoRoot: string, base: string, repoRelativePath: string, staged: boolean, source: string): LineRange[] {
  const args = staged
    ? ["diff", "--cached", "--unified=0", "--no-color", "--", repoRelativePath]
    : ["diff", "--unified=0", "--no-color", base, "--", repoRelativePath];
  const diff = runGit(repoRoot, args, true).stdout;
  const ranges = parseChangedLineRanges(diff);
  if (ranges.length > 0) return ranges;

  const tracked = runGit(repoRoot, ["ls-files", "--error-unmatch", "--", repoRelativePath], true).status === 0;
  if (!tracked) {
    const lineCount = Math.max(1, source.split(/\r?\n/).length);
    return [{ start: 1, end: lineCount }];
  }
  return [];
}

export function createGitScopePlan(scanRootInput: string, options: GitScopeOptions, relativeRootInput = scanRootInput): GitScopePlan {
  const scanRoot = path.resolve(scanRootInput);
  const relativeRoot = path.resolve(relativeRootInput);
  const repoRoot = findGitRoot(scanRoot);
  const base = resolveGitBase(repoRoot, options.base);
  const repoFiles = getChangedRepoFiles(repoRoot, base, options);
  const currentFiles: ScanFileInput[] = [];
  const baselineFiles: ScanFileInput[] = [];
  const changedLines = new Map<string, LineRange[]>();
  const changedFiles: string[] = [];
  const stagedSources = options.staged
    ? readGitObjects(repoRoot, repoFiles.map((file) => `:${file.currentPath}`))
    : new Map<string, string | null>();
  const baselineSources = options.scope === "changed"
    ? readGitObjects(
        repoRoot,
        repoFiles
          .filter((file) => file.baselinePath !== null)
          .map((file) => `${base}:${file.baselinePath}`),
      )
    : new Map<string, string | null>();

  for (const repoFile of repoFiles) {
    const repoRelativePath = repoFile.currentPath;
    if (!isLuauFile(repoRelativePath)) continue;
    const absolutePath = path.resolve(repoRoot, ...repoRelativePath.split("/"));
    if (!isInside(scanRoot, absolutePath)) continue;

    const source = options.staged
      ? stagedSources.get(`:${repoRelativePath}`) ?? null
      : currentSource(repoRoot, repoRelativePath, false);
    const relativePath = normalize(path.relative(relativeRoot, absolutePath));
    changedFiles.push(relativePath);
    if (source !== null) currentFiles.push({ absolutePath, relativePath, source, forceScan: false });

    const baseline = options.scope !== "changed" || repoFile.baselinePath === null
      ? null
      : baselineSources.get(`${base}:${repoFile.baselinePath}`) ?? null;
    if (baseline !== null) baselineFiles.push({ absolutePath, relativePath, source: baseline, forceScan: false });

    if (options.scope === "lines" && source !== null) {
      changedLines.set(relativePath, lineRangesForFile(repoRoot, base, repoRelativePath, Boolean(options.staged), source));
    }
  }

  return {
    repoRoot,
    scanRoot,
    base,
    changedFiles: [...new Set(changedFiles)].sort(),
    currentFiles,
    baselineFiles,
    changedLines,
  };
}
