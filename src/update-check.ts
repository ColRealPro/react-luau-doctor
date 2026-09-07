import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import packageJson from "../package.json";
import { cacheBaseDirectory } from "./cache";

export const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const UPDATE_REQUEST_TIMEOUT_MS = 5_000;
const UPDATE_CACHE_FILENAME = "update-check.json";

interface UpdateCache {
  checkedAt: number;
  latest?: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface UpdateNotice {
  current: string;
  latest: string;
}

function updateCacheFilename(): string {
  return path.join(cacheBaseDirectory(), UPDATE_CACHE_FILENAME);
}

function readUpdateCache(): UpdateCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateCacheFilename(), "utf8")) as Partial<UpdateCache>;
    if (typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return null;
    if (parsed.latest !== undefined && typeof parsed.latest !== "string") return null;
    return {
      checkedAt: parsed.checkedAt,
      latest: parsed.latest,
    };
  } catch {
    return null;
  }
}

function writeUpdateCache(cache: UpdateCache): void {
  try {
    const filename = updateCacheFilename();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `${JSON.stringify(cache)}\n`);
  } catch {
    // Update checks are advisory and should never make the analyzer fail.
  }
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber < rightNumber ? -1 : 1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function updateRegistryUrl(): string {
  const registry = process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY
    ?? process.env.npm_config_registry
    ?? process.env.NPM_CONFIG_REGISTRY
    ?? "https://registry.npmjs.org/";
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  return new URL(`${encodeURIComponent(packageJson.name)}/latest`, base).toString();
}

async function fetchLatestVersion(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(updateRegistryUrl(), {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const body = await response.json() as { version?: unknown };
    if (typeof body.version !== "string" || compareVersions(body.version, body.version) === null) {
      throw new Error("npm registry returned an invalid package version");
    }
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

export function updateCacheIsStale(now = Date.now()): boolean {
  const cache = readUpdateCache();
  return !cache || now - cache.checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

export async function refreshUpdateCache(options: { silent?: boolean; now?: number } = {}): Promise<string | null> {
  const now = options.now ?? Date.now();
  try {
    const latest = await fetchLatestVersion();
    writeUpdateCache({ checkedAt: now, latest });
    return latest;
  } catch (error) {
    const previous = readUpdateCache();
    writeUpdateCache({ checkedAt: now, latest: previous?.latest });
    if (options.silent) return null;
    throw error;
  }
}

export function startBackgroundUpdateRefresh(): void {
  if (!updateCacheIsStale()) return;
  const script = process.argv[1];
  if (!script) return;
  try {
    const child = spawn(process.execPath, [script, "__update-cache"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {
    // A failed advisory update check should never affect a scan.
  }
}

export function getCachedUpdateNotice(currentVersion: string): UpdateNotice | null {
  const cache = readUpdateCache();
  if (!cache?.latest) return null;
  const comparison = compareVersions(cache.latest, currentVersion);
  if (comparison === null || comparison <= 0) return null;
  return { current: currentVersion, latest: cache.latest };
}

export async function checkForUpdatesNow(currentVersion: string): Promise<{ latest: string; updateAvailable: boolean }> {
  const latest = await refreshUpdateCache();
  if (!latest) throw new Error("Could not check npm for updates");
  const comparison = compareVersions(latest, currentVersion);
  if (comparison === null) throw new Error(`Could not compare installed version ${currentVersion} with ${latest}`);
  return { latest, updateAvailable: comparison > 0 };
}
