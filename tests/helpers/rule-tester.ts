import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanPath } from "../../src/scanner";
import type { Diagnostic, DoctorConfig, ScanOptions } from "../../src/types";

type Files = string | Record<string, string>;

interface Case {
  name?: string;
  code?: string;
  files?: Record<string, string>;
  filename?: string;
  config?: DoctorConfig;
}

type ExpectedError = Partial<Omit<Diagnostic, "location" | "message">> & {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message?: string | RegExp;
};

interface InvalidCase extends Case {
  errors: ExpectedError[];
}

export function dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
  const text = strings.reduce((result, part, index) => result + part + (index < values.length ? String(values[index]) : ""), "");
  const lines = text.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "").split("\n");
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)![0].length);
  const margin = Math.min(...indents);

  return lines.map((line) => line.slice(margin)).join("\n");
}

export async function lint(files: Files, { filename = "Component.luau", ...options }: ScanOptions & { filename?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-rule-"));
  const entries = typeof files === "string" ? { [filename]: files } : files;

  try {
    for (const [file, code] of Object.entries(entries)) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, code);
    }

    return await scanPath(root, { cache: false, parallel: false, ...options });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function caseName(item: Case, files: Files): string {
  if (item.name) return item.name;

  const source = typeof files === "string" ? files : Object.values(files)[0]!;
  return source.trim().split("\n")[0]!.trim();
}

function expectedDiagnostic({ message, ...error }: ExpectedError) {
  if (message === undefined) return error;

  return { ...error, message: message instanceof RegExp ? expect.stringMatching(message) : message };
}

async function runCase(ruleId: string, item: Case, files: Files, errors: ExpectedError[]) {
  const report = await lint(files, { config: item.config, filename: item.filename });

  // Rule cases must parse so syntax errors cannot hide expected diagnostics
  expect(report.unverifiedFiles).toBeUndefined();

  // Container findings keep focused primary spans and put their evidence in highlights
  expect(report.diagnostics.filter((diagnostic) => diagnostic.location.line !== diagnostic.location.endLine)).toEqual([]);

  const actual = report.diagnostics
    .filter((diagnostic) => diagnostic.rule === ruleId)
    .map(({ location, ...diagnostic }) => ({ ...diagnostic, ...location }));

  expect(actual).toMatchObject(errors.map(expectedDiagnostic));
}

export function ruleTester(ruleId: string, cases: { valid?: Array<Case | string>; invalid?: InvalidCase[] }) {
  describe(ruleId, () => {
    describe("valid", () => {
      for (const entry of cases.valid ?? []) {
        const item = typeof entry === "string" ? { code: entry } : entry;
        const files = item.files ?? item.code!;

        test(caseName(item, files), () => runCase(ruleId, item, files, []));
      }
    });

    describe("invalid", () => {
      for (const item of cases.invalid ?? []) {
        const files = item.files ?? item.code!;

        test(caseName(item, files), () => runCase(ruleId, item, files, item.errors));
      }
    });
  });
}
