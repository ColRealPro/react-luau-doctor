import { rulesById } from "./rules";
import type { Diagnostic, RuleGuidance } from "./types";

export interface ResolvedPresentation extends RuleGuidance {
  summary: string;
  explanation: string;
}

export function presentationFor(diagnostic: Diagnostic): ResolvedPresentation {
  const rule = rulesById.get(diagnostic.rule);
  const guidance = rule?.guidance;

  return {
    summary: diagnostic.summary ?? guidance?.summary ?? diagnostic.message,

    explanation:
      diagnostic.explanation ??
      guidance?.explanation ??
      rule?.description ??
      diagnostic.message,

    help: diagnostic.help ?? guidance?.help,
    example: diagnostic.fixPreview ?? guidance?.example,
    caveat: diagnostic.caveat ?? guidance?.caveat,
  };
}
