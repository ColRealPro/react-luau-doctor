import type { SyntaxNode, SyntaxTree } from "./syntax";

export type Severity = "error" | "warning" | "suggestion";
export type Category =
  | "Correctness"
  | "Hooks"
  | "Effects"
  | "Performance"
  | "Roblox"
  | "Architecture";
export type ScanScope = "full" | "files" | "changed" | "lines";
export type BlockingLevel = "error" | "warning" | "none";

export interface Location {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface FixPreview {
  before: string;
  after: string;
  note?: string;
  kind?: "exact" | "pattern";
}

export interface Diagnostic {
  id: string;
  rule: string;
  category: Category;
  severity: Severity;
  message: string;
  help?: string;
  file: string;
  location: Location;
  highlights?: Location[];
  fixPreview?: FixPreview;
}

export interface RuleDefinition {
  id: string;
  category: Category;
  severity: Severity;
  description: string;
  run(context: RuleContext): DiagnosticInput[];
}

export interface DiagnosticInput {
  node: SyntaxNode;
  highlights?: SyntaxNode[];
  message: string;
  help?: string;
  severity?: Severity;
  fixPreview?: FixPreview;
}

export interface FunctionInfo {
  node: SyntaxNode;
  body: SyntaxNode | null;
  name: string | null;
  parameters: string[];
  isComponent: boolean;
  isHook: boolean;
}

export interface StateBinding {
  valueName: string;
  setterName: string;
  declaration: SyntaxNode;
  call: SyntaxNode;
  initializer: SyntaxNode | null;
  owner: FunctionInfo | null;
}

export interface ReactModel {
  allNodes: SyntaxNode[];
  isReactFile: boolean;
  reactNamespaces: Set<string>;
  reactRobloxNamespaces: Set<string>;
  aliases: Map<string, string>;
  stateSetters: Map<string, string>;
  stateValues: Map<string, string>;
  stateBindings: StateBinding[];
  refVariables: Set<string>;
  bindingSetters: Set<string>;
  stableVariables: Set<string>;
  refVariablesByFunction: Map<number, Set<string>>;
  stableVariablesByFunction: Map<number, Set<string>>;
  externalMutableVariablesByFunction: Map<number, Set<string>>;
  instanceVariablesByFunction: Map<number, Set<string>>;
  componentLocals: Map<number, Set<string>>;
  functions: FunctionInfo[];
  functionByNode: Map<number, FunctionInfo>;
}

export type BindingCandidateSourceKind =
  | "measurement"
  | "external-state"
  | "derived-external-state";

export interface BindingCandidateHookSummary {
  name: string;
  highFrequency: boolean;
  external: boolean;
  sourceKind: BindingCandidateSourceKind;
  bindingModeParameterIndex?: number;
  bindingModeParameterName?: string;
  bindingWhenTruthy?: boolean;
}

export interface ConditionalHookModeSummary {
  name?: string;
  parameterIndexes: number[];
  parameterNames: string[];
  conditionVariables: Record<string, number>;
  knownCallSites: number;
  dynamicCallSites: number;
}

export interface ExternalCallbackFunctionSummary {
  name: string;
  callbackParameterIndexes: number[];
  highFrequency: boolean;
}


export interface SourceEffectModuleSummary {
  effectfulMembers: Set<string>;
  effectfulExport: boolean;
  /** Members that mutate their receiver but are not otherwise proven globally effectful. */
  mutatingMembers: Set<string>;
  /** Parameters mutated by the module's exported function. */
  mutatingExportParameters: Set<number>;
  /** Parameters mutated by exported/member functions, keyed by member name. */
  mutatingMemberParameters: Map<string, Set<number>>;
  /** Parameters mutated by named module-local functions in this source file. */
  localMutatingParameters: Map<string, Set<number>>;
  instanceFactories: Set<string>;
}

export interface ProjectModel {
  memoizedModules: Map<string, "shallow" | "custom">;
  bindingCandidateHooks: Map<string, BindingCandidateHookSummary>;
  externalCallbackModules: Map<string, ExternalCallbackFunctionSummary>;
  bindingApiAlternatives: Map<string, string>;
  bindingCompatibleComponentProps: Map<string, Set<string>>;
  staticIterationTables: Map<string, Set<string>>;
  conditionalHookModes: Map<string, ConditionalHookModeSummary>;
  sourceEffects: Map<string, SourceEffectModuleSummary>;
}

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  source: string;
  tree: SyntaxTree;
  root: SyntaxNode;
  model: ReactModel;
  project: ProjectModel;
}

export interface RuleContext extends SourceFile {
  findCalls(): SyntaxNode[];
  getCallPath(node: SyntaxNode): string | null;
  resolveCallPath(path: string): string;
  callArguments(node: SyntaxNode): SyntaxNode[];
  nearestFunction(node: SyntaxNode): FunctionInfo | null;
  containingComponent(node: SyntaxNode): FunctionInfo | null;
  isDirectlyExecutedInFunction(node: SyntaxNode, fn: FunctionInfo): boolean;
  walk(node?: SyntaxNode): Iterable<SyntaxNode>;
}

export type RuleSetting = "off" | Severity;

export interface DoctorConfig {
  include?: string[];
  ignore?: string[];
  rules?: Record<string, RuleSetting>;
  scope?: ScanScope;
  diff?: boolean | string;
  base?: string;
  verbose?: boolean;
  blocking?: BlockingLevel;
  warnings?: boolean;
  respectInlineDisables?: boolean;
  projects?: string[];
  categories?: Category[];
}

export interface ScanFileInput {
  absolutePath: string;
  relativePath?: string;
  source?: string;
  forceScan?: boolean;
}

export interface ScanProgress {
  current: number;
  total: number;
  file?: string;
  phase?: string;
  label?: string;
  partial?: boolean;
}

export interface ScanOptions {
  cwd?: string;
  projectRoot?: string;
  minSeverity?: Severity;
  config?: DoctorConfig;
  files?: ScanFileInput[];
  categories?: Category[];
  respectInlineDisables?: boolean;
  maxDurationMs?: number;
  deadlineAt?: number;
  onProgress?: (progress: ScanProgress) => void;
  progressPhase?: string;
  cache?: boolean;
  parallel?: boolean;
}

export interface ScanReport {
  schemaVersion: 1;
  root: string;
  scannedFiles: number;
  candidateFiles?: number;
  durationMs: number;
  score: number;
  counts: Record<Severity, number>;
  diagnostics: Diagnostic[];
  partial?: boolean;
  skippedFiles?: string[];
  scope?: ScanScope | "staged";
  base?: string;
  changedFiles?: string[];
  projects?: string[];
  notes?: string[];
}
