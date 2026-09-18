// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  isIntentSuggestion,
  type RankedCommandSuggestion,
  rankCommandAutocomplete,
  singleIntentAutoExpandTarget,
} from "../../../lib/command-autocomplete";
import { validateCommandSemantics } from "../../../lib/command-semantic-validation";
import { completeCommand, validateCommand } from "../../../lib/wasm-bridge";
import { blueprints } from "../../../state/appStores";
import { blueprintAddressSuggestions } from "../model/blueprint-address-suggestions";
import { frontierBreadcrumbLabel } from "../model/breadcrumbs";

export type CommandAutocompleteResult = {
  suggestions: RankedCommandSuggestion[];
  breadcrumbLabel: string | null;
  autoExpandTarget: ReturnType<typeof singleIntentAutoExpandTarget>;
  selectedIndex: number;
};

export type CommandValidationResult =
  | { status: "valid" }
  | { status: "invalid"; message: string; severity: "warning" | "error" };

/** Completes and ranks one command input using the parser's slot plan. */
export async function analyzeCommandAutocomplete(
  value: string,
  cursor: number,
): Promise<CommandAutocompleteResult | null> {
  const response = await completeCommand(value, cursor);
  if (!response) return null;

  const parserSuggestions = rankCommandAutocomplete(response, value, cursor);
  const objectSuggestions = blueprintAddressSuggestions(
    response.object_reference_requests,
    blueprints.get(),
  );
  const suggestions = [...objectSuggestions, ...parserSuggestions]
    .filter(
      (suggestion, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.kind === suggestion.kind &&
            candidate.label === suggestion.label &&
            candidate.replace.start === suggestion.replace.start,
        ) === index,
    )
    .slice(0, 8);
  const plannerPreferredIntentId =
    response.slot_plan.completion_groups[0]?.group_id ?? null;
  const autoExpandTarget = singleIntentAutoExpandTarget(suggestions);
  const plannerIntentIndex = plannerPreferredIntentId
    ? suggestions.findIndex(
        (candidate) =>
          isIntentSuggestion(candidate) &&
          candidate.intentId === plannerPreferredIntentId,
      )
    : -1;

  return {
    suggestions,
    breadcrumbLabel: frontierBreadcrumbLabel(response.slot_plan.breadcrumb),
    autoExpandTarget,
    selectedIndex:
      objectSuggestions.length === 0 && plannerIntentIndex >= 0
        ? plannerIntentIndex
        : 0,
  };
}

/** Validates command syntax and settings-dependent semantic constraints. */
export async function analyzeCommandValidation(
  value: string,
  settings: Parameters<typeof validateCommandSemantics>[1],
): Promise<CommandValidationResult> {
  const response = await validateCommand(value);
  if (!response) return { status: "valid" };

  if (response.status === "ok") {
    const semanticValidation = await validateCommandSemantics(value, settings);
    if (semanticValidation.status === "error") {
      return {
        status: "invalid",
        message: semanticValidation.message,
        severity: "warning",
      };
    }
    return { status: "valid" };
  }

  return {
    status: "invalid",
    message: response.message ?? "Invalid command.",
    severity: "warning",
  };
}
