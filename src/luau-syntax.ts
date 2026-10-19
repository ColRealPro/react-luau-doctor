import type { SyntaxError, SyntaxNode, SyntaxPoint, SyntaxTree } from "./syntax";

// Adapts Luau's AST into the node types, fields, and ranges of the
// tree-sitter-luau grammar the rules were written against, so rules can keep
// matching on names like `function_call` and `variable_declaration`

// Raw node emitted by native/luau-parser/encode.cpp. Offsets are UTF-8 bytes
interface RawNode {
  t: string;
  s: number;
  e: number;
  [key: string]: any;
}

type RawRange = [number, number];

export interface LuauParseOutput {
  root: RawNode;
  errors: Array<{ range: RawRange; message: string }>;
  comments: RawRange[];
}

export interface LuauSyntaxTree extends SyntaxTree {
  rootNode: LuauNode;
  errors: SyntaxError[];
}

const BINARY_OPERATORS = ["+", "-", "*", "/", "//", "%", "^", "..", "~=", "==", "<", "<=", ">", ">=", "and", "or"];
const UNARY_OPERATORS = ["not", "-", "#"];
const BUILTIN_TYPES = new Set(["thread", "buffer", "any", "userdata", "unknown", "never", "string", "number", "table", "boolean", "nil"]);

const enum TableItemKind {
  List,
  Record,
  General,
}

class TreeState {
  private lineStarts: number[] | null = null;
  private nextId = 1;

  constructor(readonly source: string) {}

  id(): number {
    return this.nextId++;
  }

  point(index: number): SyntaxPoint {
    const starts = (this.lineStarts ??= lineStarts(this.source));
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
      const middle = (low + high + 1) >> 1;

      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }

    return { row: low, column: index - starts[low] };
  }
}

function lineStarts(source: string): number[] {
  const starts = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }

  return starts;
}

// Most nodes are leaf tokens or have no field names, so they share these
// instead of allocating their own
const NO_CHILDREN = Object.freeze([]) as unknown as LuauNode[];
const NO_FIELDS = Object.freeze([]) as unknown as Array<string | null>;

export class LuauNode implements SyntaxNode {
  readonly id: number;
  parent: LuauNode | null = null;
  children = NO_CHILDREN;
  fields = NO_FIELDS;
  isError = false;
  readonly isMissing = false;
  hasError = false;
  private named: LuauNode[] | null = null;

  constructor(
    private readonly state: TreeState,
    readonly type: string,
    public startIndex: number,
    public endIndex: number,
    readonly isNamed: boolean,
  ) {
    this.id = state.id();
  }

  get text(): string {
    return this.state.source.slice(this.startIndex, this.endIndex);
  }

  get startPosition(): SyntaxPoint {
    return this.state.point(this.startIndex);
  }

  get endPosition(): SyntaxPoint {
    return this.state.point(this.endIndex);
  }

  get namedChildren(): LuauNode[] {
    if (this.children === NO_CHILDREN) return NO_CHILDREN;

    return (this.named ??= this.children.filter((child) => child.isNamed));
  }

  childForFieldName(name: string): LuauNode | null {
    const index = this.fields.indexOf(name);

    return index < 0 ? null : this.children[index];
  }

  childrenForFieldName(name: string): LuauNode[] {
    return this.children.filter((_, index) => this.fields[index] === name);
  }

  append(child: LuauNode | null | undefined, field: string | null = null): void {
    if (!child) return;

    child.parent = this;

    if (this.children === NO_CHILDREN) this.children = [];

    this.children.push(child);
    this.named = null;

    if (field !== null) {
      if (this.fields === NO_FIELDS) this.fields = new Array(this.children.length - 1).fill(null);

      this.fields.push(field);
    } else if (this.fields !== NO_FIELDS) {
      this.fields.push(null);
    }
  }

  insert(index: number, child: LuauNode): void {
    child.parent = this;

    if (this.children === NO_CHILDREN) this.children = [];

    this.children.splice(index, 0, child);
    this.named = null;

    if (this.fields !== NO_FIELDS) this.fields.splice(index, 0, null);
  }
}

function byteToUtf16(source: string): ((offset: number) => number) | null {
  let ascii = true;

  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) > 0x7f) {
      ascii = false;
      break;
    }
  }

  if (ascii) return null;

  const map: number[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const code = source.codePointAt(index)!;
    const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;

    for (let byte = 0; byte < bytes; byte += 1) map.push(index);

    if (code >= 0x10000) index += 1;
  }

  map.push(source.length);

  return (offset) => map[Math.min(offset, map.length - 1)];
}

class Builder {
  private readonly state: TreeState;
  private readonly toUtf16: ((offset: number) => number) | null;
  private readonly comments: RawRange[];
  private commentCursor = 0;
  private readonly errorNodes: LuauNode[] = [];

  constructor(private readonly source: string, comments: RawRange[]) {
    this.state = new TreeState(source);
    this.toUtf16 = byteToUtf16(source);
    this.comments = comments.map(([start, end]) => [this.index(start), this.index(end)]);
  }

  index(offset: number): number {
    return this.toUtf16 ? this.toUtf16(offset) : offset;
  }

  node(type: string, start: number, end: number, named = true): LuauNode {
    return new LuauNode(this.state, type, start, end, named);
  }

  // Wraps children into a node that spans them, as Tree-sitter does for lists
  span(type: string, children: Array<[LuauNode | null | undefined, string | null]>): LuauNode | null {
    const present = children.filter((entry): entry is [LuauNode, string | null] => Boolean(entry[0]));

    if (present.length === 0) return null;

    const node = this.node(type, present[0][0].startIndex, present[present.length - 1][0].endIndex);

    for (const [child, field] of present) node.append(child, field);

    return node;
  }

  private commentAt(position: number): RawRange | null {
    while (this.commentCursor < this.comments.length && this.comments[this.commentCursor][1] <= position) {
      this.commentCursor += 1;
    }

    for (let index = this.commentCursor; index < this.comments.length; index += 1) {
      const comment = this.comments[index];

      if (comment[0] > position) return null;

      if (comment[0] <= position && position < comment[1]) return comment;
    }

    return null;
  }

  private skipTrivia(position: number, limit = this.source.length): number {
    let current = position;

    while (current < limit) {
      const code = this.source.charCodeAt(current);

      if (code === 32 || code === 9 || code === 10 || code === 13 || code === 59) {
        current += 1;
        continue;
      }

      const comment = this.source.startsWith("--", current) ? this.commentAt(current) : null;

      if (comment) {
        current = comment[1];
        continue;
      }

      break;
    }

    return current;
  }

  // Finds the next token after trivia, returning null when the source differs
  token(text: string, from: number, limit = this.source.length): LuauNode | null {
    const start = this.skipTrivia(from, limit);

    if (!this.source.startsWith(text, start)) return null;

    return this.node(text, start, start + text.length, false);
  }

  tokenEndingAt(text: string, end: number): LuauNode | null {
    const start = end - text.length;

    if (start < 0 || !this.source.startsWith(text, start)) return null;

    return this.node(text, start, end, false);
  }

  start(raw: RawNode): number {
    return this.index(raw.s);
  }

  end(raw: RawNode): number {
    return this.index(raw.e);
  }

  range(raw: RawRange): [number, number] {
    return [this.index(raw[0]), this.index(raw[1])];
  }

  build(output: LuauParseOutput): LuauSyntaxTree {
    const root = this.node("chunk", 0, this.source.length);

    for (const statement of this.statements(output.root.body)) root.append(...statement);

    root.endIndex = this.source.length;
    this.attachComments(root);

    const errors = output.errors.map((error) => {
      const [startIndex, endIndex] = this.range(error.range);
      const node = this.node("ERROR", startIndex, Math.max(endIndex, startIndex));
      node.isError = true;

      return { node, message: error.message };
    });

    markErrors(root, this.errorNodes, errors);

    return { rootNode: root, errors };
  }

  private attachComments(root: LuauNode): void {
    for (const [start, end] of this.comments) {
      let container = root;

      for (;;) {
        const inner = container.children.find(
          (child) => child.isNamed && child.startIndex <= start && end <= child.endIndex && child.children.length > 0,
        );

        if (!inner) break;

        container = inner;
      }

      const comment = this.node("comment", start, end);
      let position = container.children.findIndex((child) => child.startIndex >= end);

      if (position < 0) position = container.children.length;

      container.insert(position, comment);
    }
  }

  // Statements

  statements(raw: RawNode[]): Array<[LuauNode, string | null]> {
    const result: Array<[LuauNode, string | null]> = [];

    for (const statement of raw) {
      const node = this.statement(statement);

      if (!node) continue;

      // Luau folds some trailing semicolons into a statement's location, while
      // the rules expect a return to keep its semicolon and any other one to
      // be an empty statement
      if (node.type !== "ERROR" && this.source.charCodeAt(node.endIndex - 1) === 59) {
        node.endIndex -= 1;

        while (/\s/.test(this.source[node.endIndex - 1] ?? "")) node.endIndex -= 1;
      }

      const local = statement.t === "LocalStat" || statement.t === "LocalFunction";
      result.push([node, local ? "local_declaration" : null]);

      for (let semicolon = this.semicolonAfter(node.endIndex); semicolon; semicolon = this.semicolonAfter(semicolon.endIndex)) {
        if (node.type === "return_statement" && node.endIndex === semicolon.startIndex) {
          node.endIndex = semicolon.endIndex;
          continue;
        }

        result.push([this.node("empty_statement", semicolon.startIndex, semicolon.endIndex), null]);
      }
    }

    return result;
  }

  block(raw: RawNode | null): LuauNode | null {
    if (!raw) return null;

    return this.span("block", this.statements(raw.body));
  }

  statement(raw: RawNode): LuauNode | null {
    switch (raw.t) {
      case "LocalStat":
        return this.localStatement(raw);

      case "LocalFunction":
        return this.localFunction(raw);

      case "FunctionStat":
        return this.functionStatement(raw);

      case "Assign":
        return this.assignment(raw);

      case "CompoundAssign":
        return this.compoundAssignment(raw);

      case "ExprStat":
        return this.expression(raw.expr);

      case "If":
        return this.ifStatement(raw);

      case "While": {
        const node = this.node("while_statement", this.start(raw), this.end(raw));
        node.append(this.token("while", node.startIndex));
        node.append(this.expression(raw.condition), "condition");
        node.append(this.block(raw.body), "body");
        node.append(this.tokenEndingAt("end", node.endIndex));

        return node;
      }

      case "Repeat": {
        const node = this.node("repeat_statement", this.start(raw), this.end(raw));
        node.append(this.token("repeat", node.startIndex));
        node.append(this.block(raw.body), "body");
        node.append(this.expression(raw.condition), "condition");

        return node;
      }

      case "For":
        return this.numericFor(raw);

      case "ForIn":
        return this.genericFor(raw);

      case "Block": {
        const node = this.node("do_statement", this.start(raw), this.end(raw));
        node.append(this.token("do", node.startIndex));
        node.append(this.block(raw), "body");
        node.append(this.tokenEndingAt("end", node.endIndex));

        return node;
      }

      case "Return": {
        const node = this.node("return_statement", this.start(raw), this.end(raw));
        node.append(this.token("return", node.startIndex));
        node.append(this.expressionList(raw.list, null));

        return node;
      }

      case "Break":
        return this.node("break_statement", this.start(raw), this.end(raw));

      case "Continue":
        return this.node("continue_statement", this.start(raw), this.end(raw));

      case "TypeAlias":
        return this.typeAlias(raw);

      case "TypeFunctionStat":

      case "Declare":
        return this.node("type_definition", this.start(raw), this.end(raw));

      case "StatError":
        return this.errorNode(raw, [...raw.expressions.map((item: RawNode) => this.expression(item)), ...raw.statements.map((item: RawNode) => this.statement(item))]);

      default:
        return this.node("unknown_statement", this.start(raw), this.end(raw));
    }
  }

  errorNode(raw: RawNode, children: Array<LuauNode | null>): LuauNode {
    const node = this.node("ERROR", this.start(raw), this.end(raw));
    node.isError = true;
    this.errorNodes.push(node);

    for (const child of children) node.append(child);

    return node;
  }

  // Exported declarations start at `export`, and `const` declares like `local`
  declarationKeyword(node: LuauNode): LuauNode | null {
    const exported = this.token("export", node.startIndex);
    const from = exported?.endIndex ?? node.startIndex;
    const keyword = this.token("local", from) ?? this.token("const", from);

    if (!keyword) return null;

    node.startIndex = keyword.startIndex;

    return this.node("local", keyword.startIndex, keyword.endIndex, false);
  }

  localStatement(raw: RawNode): LuauNode {
    const node = this.node("variable_declaration", this.start(raw), this.end(raw));
    node.append(this.declarationKeyword(node));
    const variables = this.bindingList(raw.vars);

    if (raw.values.length === 0) {
      node.append(variables);

      return node;
    }

    const values = this.expressionList(raw.values, "value");
    const equals = variables && values ? this.token("=", variables.endIndex, values.startIndex) : null;
    node.append(this.span("assignment_statement", [[variables, null], [equals, null], [values, null]]));

    return node;
  }

  bindingList(locals: RawNode[]): LuauNode | null {
    const children: Array<[LuauNode | null, string | null]> = [];

    for (const [index, local] of locals.entries()) {
      if (index > 0) children.push([this.token(",", children.at(-1)?.[0]?.endIndex ?? this.start(local)), null]);

      const name = this.localName(local);
      children.push([name, "name"]);

      if (local.annotation) {
        children.push([this.token(":", name.endIndex), null]);
        children.push([this.type(local.annotation), null]);
      }
    }

    return this.span("variable_list", children);
  }

  localName(local: RawNode): LuauNode {
    const start = this.start(local);

    return this.node("identifier", start, start + local.name.length);
  }

  localFunction(raw: RawNode): LuauNode {
    const node = this.node("function_declaration", this.start(raw), this.end(raw));
    node.append(this.declarationKeyword(node));
    node.append(this.token("function", node.children.at(-1)?.endIndex ?? node.startIndex));
    node.append(this.localName(raw.name), "name");
    this.functionBody(node, raw.func);

    return node;
  }

  functionStatement(raw: RawNode): LuauNode {
    const node = this.node("function_declaration", this.start(raw), this.end(raw));
    const keyword = this.token("function", this.start(raw.func));
    node.startIndex = keyword?.startIndex ?? node.startIndex;
    node.append(keyword);
    node.append(this.functionName(raw.name), "name");
    this.functionBody(node, raw.func);

    return node;
  }

  functionName(raw: RawNode): LuauNode | null {
    if (raw.t === "IndexName" && raw.op === ":") return this.methodIndex(raw);

    return this.expression(raw);
  }

  functionBody(node: LuauNode, raw: RawNode): void {
    const nameEnd = node.children.at(-1)?.endIndex ?? node.startIndex;

    if (raw.generics) {
      node.append(this.genericTypeList(raw, nameEnd));
    }

    node.append(this.parameters(raw, node.children.at(-1)?.endIndex ?? nameEnd), "parameters");

    if (raw.returnAnnotation) {
      const parameters = node.childForFieldName("parameters");
      node.append(this.token(":", parameters?.endIndex ?? nameEnd));
      node.append(this.typePack(raw.returnAnnotation));
    }

    node.append(this.block(raw.body), "body");
    node.append(this.tokenEndingAt("end", node.endIndex));
  }

  genericTypeList(raw: RawNode, from: number): LuauNode | null {
    const open = this.token("<", from);
    const children: Array<[LuauNode | null, string | null]> = [[open, null]];

    for (const generic of [...raw.generics, ...raw.genericPacks].sort((left: RawNode, right: RawNode) => left.s - right.s)) {
      const start = this.start(generic);
      children.push([this.node("identifier", start, start + generic.name.length), null]);

      if (generic.t === "GenericTypePack") {
        const dots = this.token("...", start + generic.name.length);

        if (dots) children.push([this.node("vararg_expression", dots.startIndex, dots.endIndex), null]);
      }
    }

    const last = children.at(-1)?.[0];
    children.push([last ? this.token(">", last.endIndex) : null, null]);

    return this.span("generic_type_list", children);
  }

  parameters(raw: RawNode, from: number): LuauNode | null {
    const [start, end] = raw.argLocation ? this.range(raw.argLocation) : [from, from];
    const node = this.node("parameters", start, end);
    node.append(this.token("(", start, end));

    for (const arg of raw.args) {
      const name = this.localName(arg);
      const parameter = this.node("parameter", name.startIndex, name.endIndex);
      parameter.append(name);

      if (arg.annotation) {
        parameter.append(this.token(":", name.endIndex));
        const type = this.type(arg.annotation);
        parameter.append(type);

        if (type) parameter.endIndex = type.endIndex;
      }

      node.append(parameter);
    }

    if (raw.vararg) {
      const [varargStart, varargEnd] = this.range(raw.vararg);
      const parameter = this.node("parameter", varargStart, varargEnd);
      parameter.append(this.node("vararg_expression", varargStart, varargEnd));

      if (raw.varargAnnotation) {
        parameter.append(this.token(":", varargEnd));
        const type = this.typePack(raw.varargAnnotation);
        parameter.append(type);

        if (type) parameter.endIndex = type.endIndex;
      }

      node.append(parameter);
    }

    node.append(this.tokenEndingAt(")", end));

    return node;
  }

  assignment(raw: RawNode): LuauNode {
    const node = this.node("assignment_statement", this.start(raw), this.end(raw));
    const variables = this.expressionList(raw.vars, "name", "variable_list");
    const values = this.expressionList(raw.values, "value");
    node.append(variables);
    node.append(variables && values ? this.token("=", variables.endIndex, values.startIndex) : null);
    node.append(values);

    return node;
  }

  compoundAssignment(raw: RawNode): LuauNode {
    const node = this.node("update_statement", this.start(raw), this.end(raw));
    const variables = this.expressionList([raw.var], "name", "variable_list");
    const values = this.expressionList([raw.value], "value");
    node.append(variables);
    node.append(variables ? this.token(`${BINARY_OPERATORS[raw.op]}=`, variables.endIndex) : null);
    node.append(values);

    return node;
  }

  expressionList(raw: RawNode[], field: string | null, type = "expression_list"): LuauNode | null {
    const children: Array<[LuauNode | null, string | null]> = [];

    for (const item of raw) {
      const previous = children.at(-1)?.[0];

      if (previous) children.push([this.token(",", previous.endIndex), null]);

      children.push([this.expression(item), field]);
    }

    return this.span(type, children);
  }

  ifStatement(raw: RawNode): LuauNode {
    const node = this.node("if_statement", this.start(raw), this.end(raw));
    node.append(this.token("if", node.startIndex));
    node.append(this.expression(raw.condition), "condition");
    node.append(this.block(raw.thenbody), "consequence");

    let elseBody: RawNode | null = raw.elsebody;
    let elseStart = raw.elseLocation ? this.range(raw.elseLocation)[0] : null;

    while (elseBody) {
      if (elseBody.t === "If" && elseStart !== null && this.source.startsWith("elseif", elseStart)) {
        const clause = this.node("elseif_statement", elseStart, this.blockEnd(elseBody.thenbody, this.end(elseBody.condition)));
        clause.append(this.token("elseif", elseStart));
        clause.append(this.expression(elseBody.condition), "condition");
        clause.append(this.block(elseBody.thenbody), "consequence");
        node.append(clause, "alternative");
        elseStart = elseBody.elseLocation ? this.range(elseBody.elseLocation)[0] : null;
        elseBody = elseBody.elsebody;
        continue;
      }

      const start = elseStart ?? this.start(elseBody);
      const clause = this.node("else_statement", start, this.blockEnd(elseBody, start + 4));
      clause.append(this.token("else", start));
      clause.append(this.block(elseBody), "body");
      node.append(clause, "alternative");
      break;
    }

    node.append(this.tokenEndingAt("end", node.endIndex));

    return node;
  }

  blockEnd(raw: RawNode, fallback: number): number {
    const last = raw.body.at(-1);

    return last ? this.end(last) : fallback;
  }

  numericFor(raw: RawNode): LuauNode {
    const node = this.node("for_statement", this.start(raw), this.end(raw));
    node.append(this.token("for", node.startIndex));
    const name = this.localName(raw.var);
    const clause = this.node("for_numeric_clause", name.startIndex, this.end(raw.step ?? raw.to));
    clause.append(name, "name");

    if (raw.var.annotation) {
      clause.append(this.token(":", name.endIndex));
      clause.append(this.type(raw.var.annotation));
    }

    const from = this.expression(raw.from);
    clause.append(from ? this.token("=", clause.children.at(-1)!.endIndex, from.startIndex) : null);
    clause.append(from, "start");
    const to = this.expression(raw.to);
    clause.append(to && from ? this.token(",", from.endIndex) : null);
    clause.append(to, "end");

    if (raw.step) {
      clause.append(to ? this.token(",", to.endIndex) : null);
      clause.append(this.expression(raw.step), "step");
    }

    node.append(clause, "clause");
    node.append(this.block(raw.body), "body");
    node.append(this.tokenEndingAt("end", node.endIndex));

    return node;
  }

  genericFor(raw: RawNode): LuauNode {
    const node = this.node("for_statement", this.start(raw), this.end(raw));
    node.append(this.token("for", node.startIndex));
    const variables = this.bindingList(raw.vars);
    const values = this.expressionList(raw.values, null);
    const keyword = variables && values ? this.token("in", variables.endIndex, values.startIndex) : null;
    node.append(this.span("for_generic_clause", [[variables, null], [keyword, null], [values, null]]), "clause");
    node.append(this.block(raw.body), "body");
    node.append(this.tokenEndingAt("end", node.endIndex));

    return node;
  }

  typeAlias(raw: RawNode): LuauNode {
    const node = this.node("type_definition", this.start(raw), this.end(raw));
    const [nameStart, nameEnd] = this.range(raw.nameLocation);
    node.append(this.node("identifier", nameStart, nameEnd), "name");
    const type = this.type(raw.type);
    node.append(type ? this.token("=", nameEnd, type.startIndex) : null);
    node.append(type);

    return node;
  }

  // Expressions

  expression(raw: RawNode | null): LuauNode | null {
    if (!raw) return null;

    const start = this.start(raw);
    const end = this.end(raw);

    switch (raw.t) {
      case "Global":

      case "ExprLocal":
        return this.node("identifier", start, end);

      case "Nil": {
        const node = this.node("nil", start, end);
        node.append(this.node("nil", start, end, false));

        return node;
      }

      case "Bool":
        return this.node(raw.value ? "true" : "false", start, end);

      case "Number":
        return this.node("number", start, end);

      case "String":
        return this.string(start, end);

      case "InterpString":
        return this.interpolatedString(raw, start, end);

      case "Varargs":
        return this.node("vararg_expression", start, end);

      case "Group": {
        const node = this.node("parenthesized_expression", start, end);
        node.append(this.node("(", start, start + 1, false));
        node.append(this.expression(raw.expr));
        node.append(this.tokenEndingAt(")", end));

        return node;
      }

      case "IndexName":
        if (raw.op === ":") return this.methodIndex(raw);

        return this.dotIndex(raw, start, end);

      case "IndexExpr": {
        const node = this.node("bracket_index_expression", start, end);
        const table = this.expression(raw.expr);
        node.append(table, "table");
        node.append(this.token("[", table?.endIndex ?? start));
        node.append(this.expression(raw.index), "field");
        node.append(this.tokenEndingAt("]", end));

        return node;
      }

      case "Call":
        return this.call(raw, start, end);

      case "Function": {
        const node = this.node("function_definition", start, end);
        const keyword = this.token("function", start);
        node.append(keyword);
        this.functionBody(node, raw);

        return node;
      }

      case "Table":
        return this.table(raw, start, end);

      case "Unary": {
        const node = this.node("unary_expression", start, end);
        node.append(this.token(UNARY_OPERATORS[raw.op], start));
        node.append(this.expression(raw.expr), "operand");

        return node;
      }

      case "Binary": {
        const node = this.node("binary_expression", start, end);
        const left = this.expression(raw.left);
        const right = this.expression(raw.right);
        node.append(left, "left");
        node.append(left && right ? this.token(BINARY_OPERATORS[raw.op], left.endIndex, right.startIndex) : null);
        node.append(right, "right");

        return node;
      }

      case "Cast": {
        const node = this.node("cast_expression", start, end);
        const value = this.expression(raw.expr);
        node.append(value);
        node.append(value ? this.token("::", value.endIndex) : null);
        node.append(this.type(raw.annotation));

        return node;
      }

      case "IfElse":
        return this.ifExpression(raw, start, end);

      case "Instantiate":
        return this.expression(raw.expr);

      case "ExprError":
        return this.errorNode(raw, raw.expressions.map((item: RawNode) => this.expression(item)));

      default:
        return this.node("unknown_expression", start, end);
    }
  }

  string(start: number, end: number): LuauNode {
    const node = this.node("string", start, end);
    const text = this.source.slice(start, end);
    const open = /^\[=*\[/.exec(text)?.[0] ?? text[0] ?? "";
    const close = open.startsWith("[") ? open.replaceAll("[", "]") : open;

    if (open && end - start >= open.length + close.length) {
      node.append(this.node(open, start, start + open.length, false), "start");
      node.append(this.node("string_content", start + open.length, end - close.length), "content");
      node.append(this.node(close, end - close.length, end, false), "end");
    }

    return node;
  }

  interpolatedString(raw: RawNode, start: number, end: number): LuauNode {
    const node = this.node("string", start, end);
    let cursor = start + 1;

    for (const expression of raw.expressions as RawNode[]) {
      const value = this.expression(expression);

      if (!value) continue;

      const open = this.source.lastIndexOf("{", value.startIndex - 1);

      if (open > cursor) node.append(this.node("string_content", cursor, open), "content");

      const close = this.source.indexOf("}", value.endIndex);
      const interpolation = this.node("interpolation", open, close + 1);
      interpolation.append(this.node("{", open, open + 1, false));
      interpolation.append(value);
      interpolation.append(this.node("}", close, close + 1, false));
      node.append(interpolation);
      cursor = close + 1;
    }

    if (end - 1 > cursor) node.append(this.node("string_content", cursor, end - 1), "content");

    return node;
  }

  dotIndex(raw: RawNode, start: number, end: number): LuauNode {
    const node = this.node("dot_index_expression", start, end);
    const table = this.expression(raw.expr);
    const [fieldStart, fieldEnd] = this.range(raw.indexLocation);
    node.append(table, "table");
    node.append(this.token(".", table?.endIndex ?? start, fieldStart));
    node.append(this.node("identifier", fieldStart, fieldEnd), "field");

    return node;
  }

  methodIndex(raw: RawNode): LuauNode {
    const table = this.expression(raw.expr);
    const [methodStart, methodEnd] = this.range(raw.indexLocation);
    const node = this.node("method_index_expression", table?.startIndex ?? this.start(raw), methodEnd);
    node.append(table, "table");
    node.append(this.token(":", table?.endIndex ?? methodStart, methodStart));
    node.append(this.node("identifier", methodStart, methodEnd), "method");

    return node;
  }

  call(raw: RawNode, start: number, end: number): LuauNode {
    const node = this.node("function_call", start, end);
    const name = raw.self ? this.methodIndex(raw.func) : this.expression(raw.func);
    node.append(name, "name");

    const [innerStart, innerEnd] = this.range(raw.argLocation);
    // Luau's argument location starts just after an opening parenthesis
    const open = this.tokenEndingAt("(", innerStart);
    const close = open ? this.tokenEndingAt(")", innerEnd) : null;
    const parenthesized = Boolean(open);
    const argumentsStart = open?.startIndex ?? innerStart;
    const argumentsEnd = close?.endIndex ?? innerEnd;
    const args = this.node("arguments", argumentsStart, Math.max(argumentsEnd, argumentsStart));
    args.append(open);

    for (const [index, argument] of (raw.args as RawNode[]).entries()) {
      const value = this.expression(argument);

      if (index > 0 && value) args.append(this.token(",", args.children.at(-1)?.endIndex ?? argumentsStart, value.startIndex));

      args.append(value);
    }

    args.append(close);

    if (!parenthesized && args.children.length > 0) {
      args.startIndex = args.children[0].startIndex;
      args.endIndex = args.children.at(-1)!.endIndex;
    }

    node.append(args, "arguments");
    node.endIndex = Math.max(node.endIndex, args.endIndex);

    return node;
  }

  table(raw: RawNode, start: number, end: number): LuauNode {
    const node = this.node("table_constructor", start, end);
    node.append(this.node("{", start, start + 1, false));

    for (const item of raw.items as Array<{ kind: TableItemKind; key: RawNode | null; value: RawNode }>) {
      const value = this.expression(item.value);

      if (!value) continue;

      const previous = node.children.at(-1);

      if (previous && previous.type !== "{") {
        const separator = this.token(",", previous.endIndex, value.startIndex) ?? this.semicolon(previous.endIndex, value.startIndex);
        node.append(separator);
      }

      if (item.kind === TableItemKind.List || !item.key) {
        const field = this.node("field", value.startIndex, value.endIndex);
        field.append(value, "value");
        node.append(field);
        continue;
      }

      if (item.kind === TableItemKind.Record) {
        const keyStart = this.start(item.key);
        const name = this.node("identifier", keyStart, this.end(item.key));
        const field = this.node("field", keyStart, value.endIndex);
        field.append(name, "name");
        field.append(this.token("=", name.endIndex, value.startIndex));
        field.append(value, "value");
        node.append(field);
        continue;
      }

      const key = this.expression(item.key);
      const open = key ? this.source.lastIndexOf("[", key.startIndex) : -1;
      const field = this.node("field", open >= 0 ? open : value.startIndex, value.endIndex);

      if (open >= 0) field.append(this.node("[", open, open + 1, false));

      field.append(key, "name");
      const close = key ? this.token("]", key.endIndex) : null;
      field.append(close);
      field.append(this.token("=", close?.endIndex ?? key?.endIndex ?? field.startIndex, value.startIndex));
      field.append(value, "value");
      node.append(field);
    }

    const last = node.children.at(-1);

    if (last && last.type !== "{") node.append(this.token(",", last.endIndex, end) ?? this.semicolon(last.endIndex, end));

    node.append(this.tokenEndingAt("}", end));

    return node;
  }

  semicolonAfter(from: number): LuauNode | null {
    let position = from;

    while (position < this.source.length) {
      const code = this.source.charCodeAt(position);

      if (code === 59) return this.node(";", position, position + 1, false);

      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return null;

      position += 1;
    }

    return null;
  }

  semicolon(from: number, limit: number): LuauNode | null {
    const position = this.source.indexOf(";", from);

    if (position < 0 || position >= limit) return null;

    return this.node(";", position, position + 1, false);
  }

  ifExpression(raw: RawNode, start: number, end: number): LuauNode {
    const node = this.node("if_expression", start, end);
    node.append(this.token("if", start));
    node.append(this.expression(raw.condition), "condition");
    node.append(this.expression(raw.trueExpr), "consequence");

    let alternative: RawNode | null = raw.falseExpr;
    let previousEnd = node.children.at(-1)?.endIndex ?? start;

    while (alternative) {
      const keywordStart = this.skipKeyword(previousEnd);

      if (alternative.t === "IfElse" && this.source.startsWith("elseif", keywordStart)) {
        const consequence = this.expression(alternative.trueExpr);
        const clause = this.node("elseif_clause", keywordStart, consequence?.endIndex ?? this.end(alternative));
        clause.append(this.token("elseif", keywordStart));
        clause.append(this.expression(alternative.condition), "condition");
        clause.append(consequence, "consequence");
        node.append(clause);
        previousEnd = clause.endIndex;
        alternative = alternative.falseExpr;
        continue;
      }

      const value = this.expression(alternative);
      const clause = this.node("else_clause", keywordStart, value?.endIndex ?? end);
      clause.append(this.token("else", keywordStart));
      clause.append(value, "consequence");
      node.append(clause);
      break;
    }

    return node;
  }

  skipKeyword(from: number): number {
    const token = this.token("else", from);

    return token?.startIndex ?? from;
  }

  // Types

  type(raw: RawNode | null): LuauNode | null {
    if (!raw) return null;

    const start = this.start(raw);
    const end = this.end(raw);

    switch (raw.t) {
      case "TypeReference": {
        let base: LuauNode;

        if (raw.prefix) {
          base = this.node("field_type", start, this.nameEnd(start, raw));
          const prefixEnd = start + raw.prefix.length;
          base.append(this.node("identifier", start, prefixEnd));
          const dot = this.token(".", prefixEnd);
          base.append(dot);
          const nameStart = this.skipTrivia(dot?.endIndex ?? prefixEnd);
          base.append(this.node("identifier", nameStart, nameStart + raw.name.length));
          base.endIndex = nameStart + raw.name.length;
        } else if (BUILTIN_TYPES.has(raw.name)) {
          base = this.node("builtin_type", start, start + raw.name.length);
          base.append(this.node(raw.name, start, start + raw.name.length, false));
        } else {
          base = this.node("identifier", start, start + raw.name.length);
        }

        if (!raw.parameters) return base;

        const node = this.node("generic_type", start, end);
        node.append(base);
        node.append(this.token("<", base.endIndex));

        for (const parameter of raw.parameters) node.append(this.typeOrPack(parameter));

        node.append(this.tokenEndingAt(">", end));

        return node;
      }

      case "TypeTable": {
        const node = this.node("object_type", start, end);
        node.append(this.node("{", start, start + 1, false));
        const entries: Array<[number, () => void]> = [];

        for (const prop of raw.props) {
          entries.push([prop.location[0], () => {
            const [nameStart, nameEnd] = this.range(prop.location);
            const name = this.node("identifier", nameStart, nameEnd);
            node.append(name);
            node.append(this.token(":", nameEnd));
            node.append(this.type(prop.type));
          }]);
        }

        if (raw.indexer) {
          const indexer = raw.indexer;

          entries.push([indexer.location[0], () => {
            const index = this.type(indexer.indexType);
            const result = this.type(indexer.resultType);
            const open = index ? this.source.lastIndexOf("[", index.startIndex) : -1;

            if (index && open >= 0 && this.source.slice(open, index.startIndex).trim() === "[") {
              const close = this.token("]", index.endIndex);
              const key = this.node("object_field_type", open, close?.endIndex ?? index.endIndex);
              key.append(this.node("[", open, open + 1, false));
              key.append(index);
              key.append(close);
              node.append(key);
              node.append(this.token(":", key.endIndex));
            }

            node.append(result);
          }]);
        }

        for (const [, append] of entries.sort((left, right) => left[0] - right[0])) append();

        node.append(this.tokenEndingAt("}", end));

        return node;
      }

      case "TypeFunction": {
        const node = this.node("function_type", start, end);
        const types: RawNode[] = raw.argTypes.types;

        for (const [index, argument] of types.entries()) {
          const name = raw.argNames[index];

          if (name) {
            const [nameStart, nameEnd] = this.range(name.location);
            node.append(this.node("identifier", nameStart, nameEnd));
          }

          node.append(this.type(argument));
        }

        if (raw.argTypes.tail) node.append(this.typePack(raw.argTypes.tail));

        node.append(this.typePack(raw.returnTypes));

        return node;
      }

      case "TypeUnion": {
        const members: RawNode[] = raw.types;
        const optional = members.filter((member) => member.t === "TypeOptional");
        const values = members.filter((member) => member.t !== "TypeOptional");
        let node = this.binaryType("union_type", values);

        for (const marker of optional) {
          const markerEnd = this.end(marker);

          if (!node) break;

          const wrapped = this.node("optional_type", node.startIndex, markerEnd);
          wrapped.append(node);
          wrapped.append(this.node("?", markerEnd - 1, markerEnd, false));
          node = wrapped;
        }

        return node;
      }

      case "TypeIntersection":
        return this.binaryType("intersection_type", raw.types);

      case "TypeSingletonString": {
        const node = this.node("literal_type", start, end);
        node.append(this.string(start, end));

        return node;
      }

      case "TypeSingletonBool": {
        const node = this.node("literal_type", start, end);
        node.append(this.node(this.source.startsWith("true", start) ? "true" : "false", start, end));

        return node;
      }

      case "TypeGroup": {
        const node = this.node("tuple_type", start, end);
        node.append(this.type(raw.type));

        return node;
      }

      case "TypeTypeof":
        return this.node("builtin_type", start, end);

      case "TypeError":
        return this.errorNode(raw, raw.types.map((item: RawNode) => this.type(item)));

      default:
        return this.node("builtin_type", start, end);
    }
  }

  nameEnd(start: number, raw: RawNode): number {
    return start + (raw.prefix?.length ?? 0) + 1 + raw.name.length;
  }

  binaryType(type: string, members: RawNode[]): LuauNode | null {
    let node: LuauNode | null = null;

    for (const member of members) {
      const value = this.type(member);

      if (!value) continue;

      if (!node) {
        node = value;
        continue;
      }

      const combined: LuauNode = this.node(type, node.startIndex, value.endIndex);
      combined.append(node);
      combined.append(this.token(type === "union_type" ? "|" : "&", node.endIndex, value.startIndex));
      combined.append(value);
      node = combined;
    }

    return node;
  }

  typeOrPack(raw: RawNode | null): LuauNode | null {
    if (!raw) return null;

    return raw.t.startsWith("TypePack") ? this.typePack(raw) : this.type(raw);
  }

  typePack(raw: RawNode | null): LuauNode | null {
    if (!raw) return null;

    const start = this.start(raw);
    const end = this.end(raw);

    switch (raw.t) {
      case "TypePackExplicit": {
        const types: RawNode[] = raw.typeList.types;

        if (types.length === 1 && !raw.typeList.tail && !this.source.startsWith("(", start)) return this.type(types[0]);

        if (types.length === 0 && !raw.typeList.tail) return this.node("empty_type", start, end);

        const node = this.node("tuple_type", start, end);

        for (const type of types) node.append(this.type(type));

        if (raw.typeList.tail) node.append(this.typePack(raw.typeList.tail));

        return node;
      }

      case "TypePackVariadic": {
        const node = this.node("variadic_type", start, end);
        node.append(this.type(raw.type));

        return node;
      }

      case "TypePackGeneric": {
        const node = this.node("variadic_type", start, end);
        node.append(this.node("identifier", start, start + raw.name.length));

        return node;
      }

      default:
        return this.node("builtin_type", start, end);
    }
  }
}

// Luau only produces error nodes alongside reported errors, so a clean parse
// needs no marking at all
function markErrors(root: LuauNode, errorNodes: LuauNode[], errors: SyntaxError[]): void {
  for (const node of errorNodes) {
    for (let current: LuauNode | null = node; current && !current.hasError; current = current.parent) current.hasError = true;
  }

  for (const { node } of errors) {
    let current: LuauNode | null = root;

    while (current) {
      current.hasError = true;

      current =
        current.children.find(
          (child) => child.isNamed && child.startIndex <= node.startIndex && node.startIndex < child.endIndex,
        ) ?? null;
    }
  }
}

export function buildLuauSyntaxTree(source: string, output: LuauParseOutput): LuauSyntaxTree {
  return new Builder(source, output.comments).build(output);
}
