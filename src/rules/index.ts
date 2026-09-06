import type { RuleDefinition } from "../types";
import { effectNeedsCleanup } from "./effect-needs-cleanup";
import {
  noDerivedStateEffect,
  noEffectWithFreshDeps,
  noMutableInDeps,
  noSelfUpdatingEffect,
} from "./effect-state-rules";
import { exhaustiveDeps } from "./exhaustive-deps";
import { noArrayIndexAsKey } from "./no-array-index-as-key";
import { noCreateContextInRender } from "./no-create-context-in-render";
import { noNestedComponentDefinition } from "./no-nested-component-definition";
import { noPropMutation } from "./no-prop-mutation";
import { noRandomKey } from "./no-random-key";
import { noSetStateInRender } from "./no-set-state-in-render";
import { parseErrors } from "./parse-errors";
import {
  preferUseRefForMutableCell,
  rerenderHighFrequencyState,
  rerenderRepeatedCollectionScan,
  rerenderStaticDiscoveryInRender,
  rerenderStaticState,
  rerenderUnnecessaryUseCallback,
  rerenderUnnecessaryUseMemo,
  rerenderUnstableMemoProps,
} from "./performance-rules";
import { preferBindingOverState, preferBindingOverStateCandidate } from "./prefer-binding-over-state";
import { noCreateRootInRender } from "./react-roblox-lifecycle";
import { noRefCurrentInRender } from "./ref-rules";
import {
  noSideEffectsInRender,
  noTaskSpawnInRender,
  noYieldInRender,
} from "./render-side-effects";
import { rulesOfHooks } from "./rules-of-hooks";
import {
  noDirectStateMutation,
  rerenderFunctionalSetstate,
  rerenderLazyRefInit,
  rerenderLazyStateInit,
  rerenderStateOnlyInHandlers,
} from "./state-performance";
import { unstableContextValue } from "./unstable-context-value";

export const rules: RuleDefinition[] = [
  parseErrors,
  rulesOfHooks,
  exhaustiveDeps,
  effectNeedsCleanup,
  noDerivedStateEffect,
  noSelfUpdatingEffect,
  noEffectWithFreshDeps,
  noMutableInDeps,
  preferBindingOverState,
  preferBindingOverStateCandidate,
  rerenderUnstableMemoProps,
  rerenderHighFrequencyState,
  rerenderUnnecessaryUseMemo,
  rerenderUnnecessaryUseCallback,
  rerenderStaticDiscoveryInRender,
  rerenderRepeatedCollectionScan,
  rerenderStaticState,
  preferUseRefForMutableCell,
  rerenderFunctionalSetstate,
  rerenderLazyStateInit,
  rerenderLazyRefInit,
  rerenderStateOnlyInHandlers,
  noSetStateInRender,
  noDirectStateMutation,
  noRefCurrentInRender,
  noCreateContextInRender,
  noNestedComponentDefinition,
  noRandomKey,
  noYieldInRender,
  noTaskSpawnInRender,
  noSideEffectsInRender,
  noCreateRootInRender,
  noPropMutation,
  noArrayIndexAsKey,
  unstableContextValue,
];

export const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
