import path from "node:path";

export interface ModuleIdentity {
  id: string;
  keys: string[];
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

export function moduleKeys(relativePath: string): string[] {
  let normalized = normalizeRelative(relativePath).replace(/\.(?:lua|luau)$/i, "");
  if (normalized.endsWith("/init")) normalized = normalized.slice(0, -"/init".length);
  const segments = normalized.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() === "src") segments.shift();

  const keys = new Set<string>();
  for (let index = 0; index < segments.length; index += 1) {
    const suffix = segments.slice(index).join(".").toLowerCase();
    if (suffix) keys.add(suffix);
  }
  return [...keys];
}

export function normalizeRequireTarget(text: string): string {
  return (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).join(".").toLowerCase();
}

function isSegmentSuffix(target: string, key: string): boolean {
  return target === key || target.endsWith(`.${key}`);
}

/**
 * Builds feature aliases only when an alias uniquely identifies one module in
 * the entire project. This prevents basename collisions and overlapping names
 * when one module name is merely a suffix of another or when multiple
 * directories contain modules with the same basename.
 */
export function buildUniqueFeatureAliases<T>(
  modules: ModuleIdentity[],
  featureByModuleId: Map<string, T>,
): Map<string, T> {
  const owners = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const key of module.keys) {
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(module.id);
      owners.set(key, ids);
    }
  }

  const aliases = new Map<string, T>();
  for (const module of modules) {
    const value = featureByModuleId.get(module.id);
    if (value === undefined) continue;
    for (const key of module.keys) {
      const ids = owners.get(key);
      if (ids?.size === 1 && ids.has(module.id)) aliases.set(key, value);
    }
  }
  return aliases;
}

export function resolveModuleReference<T>(target: string, aliases: Map<string, T>): T | null {
  let bestKey: string | null = null;
  let bestValue: T | null = null;

  for (const [key, value] of aliases) {
    if (!isSegmentSuffix(target, key)) continue;
    if (bestKey === null || key.length > bestKey.length) {
      bestKey = key;
      bestValue = value;
    }
  }

  return bestValue;
}
