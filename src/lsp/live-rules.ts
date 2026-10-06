import { rulesById } from "../rules";
import type { RuleDefinition } from "../types";

// Audited for use with the current buffer and a stable (possibly older) project snapshot.
// Rules that consult project-derived hooks, source effects, module summaries, or parse
// errors stay deep-only. Adding a rule to Doctor never adds it here automatically.
const LIVE_IDS = [
  "react-luau/no-derived-state-effect",
  "react-luau/no-self-updating-effect",
  "react-luau/no-effect-with-fresh-deps",
  "react-luau/no-mutable-in-deps",
  "react-luau/rerender-unnecessary-usememo",
  "react-luau/rerender-unnecessary-usecallback",
  "react-luau/rerender-static-state",
  "react-luau/prefer-use-ref-for-mutable-cell",
  "react-luau/rerender-functional-setstate",
  "react-luau/rerender-lazy-state-init",
  "react-luau/rerender-lazy-ref-init",
  "react-luau/rerender-state-only-in-handlers",
  "react-luau/no-set-state-in-render",
  "react-luau/no-call-component-as-function",
  "react-luau/no-create-binding-in-render",
  "react-luau/no-binding-getvalue-in-render",
  "react-luau/usememo-must-return",
  "react-luau/no-ref-current-in-render",
  "react-luau/no-create-context-in-render",
  "react-luau/no-nested-component-definition",
  "react-luau/no-random-key",
  "react-luau/no-create-root-in-render",
  "react-luau/no-static-name-prop",
  "react-luau/no-array-index-as-key",
  "react-luau/unstable-context-value",
] as const;

export const liveRules: readonly RuleDefinition[] = LIVE_IDS.map((id) => {
  const rule = rulesById.get(id);

  if (!rule) throw new Error(`Unknown live rule: ${id}`);

  return rule;
});
