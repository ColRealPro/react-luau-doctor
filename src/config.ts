import fs from "node:fs";
import path from "node:path";
import type {
  BlockingLevel,
  Category,
  DoctorConfig,
  RuleSetting,
  ScanScope,
  Severity,
} from "./types";

const CONFIG_NAME = "react-luau-doctor.config.json";
const SEVERITIES = new Set<RuleSetting>(["off", "error", "warning", "suggestion"]);
const SCOPES = new Set<ScanScope>(["full", "files", "changed", "lines"]);
const BLOCKING_LEVELS = new Set<BlockingLevel>(["error", "warning", "none"]);
const CATEGORIES = new Set<Category>(["Correctness", "Hooks", "Effects", "Performance", "Roblox", "Architecture"]);

export interface LoadedConfig {
  config: DoctorConfig;
  filename: string | null;
}

export function loadConfigWithSource(root: string): LoadedConfig {
  const candidate = path.join(root, CONFIG_NAME);
  if (!fs.existsSync(candidate)) return { config: {}, filename: null };
  const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as DoctorConfig;
  validateConfig(parsed, candidate);
  return { config: parsed, filename: candidate };
}

export function loadConfig(root: string): DoctorConfig {
  return loadConfigWithSource(root).config;
}

function validateStringArray(value: unknown, field: string, filename: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${filename}: ${field} must be an array of strings`);
  }
}

function validateConfig(config: DoctorConfig, filename: string): void {
  if (config.include !== undefined) validateStringArray(config.include, "include", filename);
  if (config.ignore !== undefined) validateStringArray(config.ignore, "ignore", filename);
  if (config.projects !== undefined) validateStringArray(config.projects, "projects", filename);

  if (config.categories !== undefined) {
    if (!Array.isArray(config.categories) || config.categories.some((category) => !CATEGORIES.has(category))) {
      throw new Error(`${filename}: categories must contain valid React-Luau Doctor categories`);
    }
  }

  if (config.rules) {
    for (const [rule, value] of Object.entries(config.rules)) {
      if (!SEVERITIES.has(value)) throw new Error(`${filename}: invalid severity ${String(value)} for ${rule}`);
    }
  }

  if (config.scope !== undefined && !SCOPES.has(config.scope)) {
    throw new Error(`${filename}: scope must be full, files, changed, or lines`);
  }
  if (config.diff !== undefined && typeof config.diff !== "boolean" && typeof config.diff !== "string") {
    throw new Error(`${filename}: diff must be a boolean or git ref string`);
  }
  if (config.base !== undefined && typeof config.base !== "string") throw new Error(`${filename}: base must be a string`);
  if (config.verbose !== undefined && typeof config.verbose !== "boolean") throw new Error(`${filename}: verbose must be a boolean`);
  if (config.warnings !== undefined && typeof config.warnings !== "boolean") throw new Error(`${filename}: warnings must be a boolean`);
  if (config.respectInlineDisables !== undefined && typeof config.respectInlineDisables !== "boolean") {
    throw new Error(`${filename}: respectInlineDisables must be a boolean`);
  }
  if (config.blocking !== undefined && !BLOCKING_LEVELS.has(config.blocking)) {
    throw new Error(`${filename}: blocking must be error, warning, or none`);
  }
}

export function effectiveSeverity(
  defaultSeverity: Severity,
  ruleId: string,
  config: DoctorConfig,
): Severity | null {
  const configured = config.rules?.[ruleId];
  if (!configured) return defaultSeverity;
  return configured === "off" ? null : configured;
}

function configPathForWrite(root: string): string {
  const loaded = loadConfigWithSource(root);
  return loaded.filename ?? path.join(root, CONFIG_NAME);
}

export function writeConfig(root: string, update: (config: DoctorConfig) => DoctorConfig): string {
  const loaded = loadConfigWithSource(root);
  const next = update(structuredClone(loaded.config));
  validateConfig(next, loaded.filename ?? CONFIG_NAME);
  const filename = loaded.filename ?? configPathForWrite(root);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(next, null, 2)}\n`);
  return filename;
}

export function normalizeRuleSetting(value: string): RuleSetting | null {
  const normalized = value.toLowerCase();
  if (normalized === "warn") return "warning";
  if (normalized === "off" || normalized === "error" || normalized === "warning" || normalized === "suggestion") {
    return normalized;
  }
  return null;
}

export function normalizeCategory(value: string): Category | null {
  const normalized = value.toLowerCase();
  for (const category of CATEGORIES) {
    if (category.toLowerCase() === normalized) return category;
  }
  return null;
}
