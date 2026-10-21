import type { RuleDefinition } from "../types";

export const parseErrors: RuleDefinition = {
  id: "react-luau/parse-error",
  category: "Correctness",
  severity: "error",
  lspEnabled: false,
  description: "Report Luau syntax errors that keep the file from forming a complete syntax tree",

  run(context) {
    return context.tree.errors.map((error) => ({
      node: error.node,
      message: error.message,
      help: "Fix the syntax error before relying on downstream React-Luau diagnostics in this file",
    }));
  },
};
