import crypto from "node:crypto";
import type { SyntaxTree } from "./syntax";
import { createRuleContext } from "./ast/context";
import { buildReactModel } from "./ast/react-model";
import { effectiveSeverity } from "./config";
import { createInlineSuppressionChecker } from "./inline-disables";
import { parseLuau } from "./parser";
import { rules } from "./rules";
import type {
  Category,
  Diagnostic,
  DiagnosticInput,
  DoctorConfig,
  ProjectModel,
  Severity,
  SourceFile,
} from "./types";

const SEVERITY_RANK: Record<Severity, number> = {
  suggestion: 0,
  warning: 1,
  error: 2,
};

export interface ReactFileAnalysisInput {
  absolutePath: string;
  relativePath: string;
  source: string;
  forceScan: boolean;
  project: ProjectModel;
  config: DoctorConfig;
  categories?: Category[];
  minSeverity: Severity;
  respectInlineDisables: boolean;
}

export interface ReactFileAnalysisResult {
  relativePath: string;
  isReactFile: boolean;
  scanned: boolean;
  diagnostics: Diagnostic[];
}

function diagnosticId(file: string, rule: string, startIndex: number, message: string): string {
  return crypto.createHash("sha256").update(`${file}\0${rule}\0${startIndex}\0${message}`).digest("hex").slice(0, 16);
}

function nodeLocation(node: DiagnosticInput["node"]): Diagnostic["location"] {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

function sameLocation(left: Diagnostic["location"], right: Diagnostic["location"]): boolean {
  return left.line === right.line
    && left.column === right.column
    && left.endLine === right.endLine
    && left.endColumn === right.endColumn;
}

function removeSupersededDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.rule !== "react-luau/rerender-high-frequency-state") return true;

    return !diagnostics.some((candidate) =>
      candidate.rule === "react-luau/prefer-binding-over-state"
      && sameLocation(candidate.location, diagnostic.location)
      && SEVERITY_RANK[candidate.severity] >= SEVERITY_RANK[diagnostic.severity]
    );
  });
}

function toDiagnostic(
  file: SourceFile,
  ruleId: string,
  category: Diagnostic["category"],
  severity: Severity,
  input: DiagnosticInput,
): Diagnostic {
  const node = input.node;
  const highlights = input.highlights?.map(nodeLocation);
  return {
    id: diagnosticId(file.relativePath, ruleId, node.startIndex, input.message),
    rule: ruleId,
    category,
    severity: input.severity ?? severity,
    message: input.message,
    help: input.help,
    file: file.relativePath,
    location: nodeLocation(node),
    highlights: highlights && highlights.length > 0 ? highlights : undefined,
    fixPreview: input.fixPreview,
  };
}

export async function analyzeReactFile(input: ReactFileAnalysisInput, tree?: SyntaxTree): Promise<ReactFileAnalysisResult> {
  const parsedTree = tree ?? await parseLuau(input.source);
  const model = buildReactModel(parsedTree.rootNode, input.project);
  if (!input.forceScan && !model.isReactFile) {
    return { relativePath: input.relativePath, isReactFile: false, scanned: false, diagnostics: [] };
  }

  const file: SourceFile = {
    absolutePath: input.absolutePath,
    relativePath: input.relativePath,
    source: input.source,
    tree: parsedTree,
    root: parsedTree.rootNode,
    model,
    project: input.project,
  };
  const context = createRuleContext(file);
  const categorySet = input.categories && input.categories.length > 0 ? new Set(input.categories) : null;
  const isSuppressed = input.respectInlineDisables ? createInlineSuppressionChecker(input.source) : () => false;
  const diagnostics: Diagnostic[] = [];

  for (const rule of rules) {
    if (categorySet && !categorySet.has(rule.category)) continue;
    const severity = effectiveSeverity(rule.severity, rule.id, input.config);
    if (!severity) continue;
    const findings = rule.run(context);
    for (const finding of findings) {
      const configuredSeverity = input.config.rules?.[rule.id];
      const diagnostic = toDiagnostic(file, rule.id, rule.category, severity, {
        ...finding,
        severity: configuredSeverity && configuredSeverity !== "off" ? severity : finding.severity,
      });
      if (SEVERITY_RANK[diagnostic.severity] < SEVERITY_RANK[input.minSeverity]) continue;
      if (isSuppressed(diagnostic.rule, diagnostic.location.line)) continue;
      diagnostics.push(diagnostic);
    }
    if (rule.id === "react-luau/parse-error" && findings.length > 0) break;
  }

  const filteredDiagnostics = removeSupersededDiagnostics(diagnostics);

  return {
    relativePath: input.relativePath,
    isReactFile: model.isReactFile,
    scanned: true,
    diagnostics: filteredDiagnostics,
  };
}
