interface SuppressionState {
  active: Set<string>;
  oneLine: Map<number, Set<string>>;
}

function normalizeRuleToken(token: string): string {
  const normalized = token.trim();
  if (!normalized || normalized === "all" || normalized === "*") return "*";
  return normalized.includes("/") ? normalized : `react-luau/${normalized}`;
}

function parseRuleTokens(value: string): Set<string> {
  const withoutReason = value.split("--", 1)[0] ?? "";
  const tokens = withoutReason
    .split(/[\s,]+/)
    .map(normalizeRuleToken)
    .filter(Boolean);
  return new Set(tokens.length > 0 ? tokens : ["*"]);
}

function matchesRule(rules: Set<string> | undefined, ruleId: string): boolean {
  return Boolean(rules && (rules.has("*") || rules.has(ruleId)));
}

export function createInlineSuppressionChecker(source: string): (ruleId: string, line: number) => boolean {
  const state: SuppressionState = {
    active: new Set<string>(),
    oneLine: new Map<number, Set<string>>(),
  };
  const activeByLine = new Map<number, Set<string>>();
  const lines = source.split(/\r?\n/);
  const directive = /--\s*react-luau-doctor-(disable|enable)(?:-(next-line|line))?\b(.*)$/i;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    activeByLine.set(lineNumber, new Set(state.active));

    const match = lines[index].match(directive);
    if (!match) continue;

    const action = match[1].toLowerCase();
    const placement = match[2]?.toLowerCase();
    const rules = parseRuleTokens(match[3] ?? "");

    if (placement === "line" || placement === "next-line") {
      if (action !== "disable") continue;
      const targetLine = placement === "line" ? lineNumber : lineNumber + 1;
      const existing = state.oneLine.get(targetLine) ?? new Set<string>();
      for (const rule of rules) existing.add(rule);
      state.oneLine.set(targetLine, existing);
      continue;
    }

    if (action === "disable") {
      for (const rule of rules) state.active.add(rule);
    } else if (rules.has("*")) {
      state.active.clear();
    } else {
      for (const rule of rules) state.active.delete(rule);
    }
  }

  return (ruleId: string, line: number): boolean =>
    matchesRule(activeByLine.get(line), ruleId) || matchesRule(state.oneLine.get(line), ruleId);
}
