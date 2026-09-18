// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  CommandAutocompleteCandidate,
  CommandAutocompleteCompletionGroup,
  CommandAutocompleteResponse,
} from "./wasm-bridge";

const MAX_SUGGESTIONS = 8;
const MAX_INTENT_ROWS = 4;
const MAX_HINT_CHIPS = 3;

type IntentSuggestionId = string;

interface RankedCommandSuggestionBase {
  label: string;
  detail: string | null;
  replace: { start: number; end: number };
}

export interface RankedCommandTokenSuggestion
  extends RankedCommandSuggestionBase {
  kind: "token";
  candidateId: string;
  insertText: string;
  applyText: string;
  completable: boolean;
}

export interface RankedCommandIntentSuggestion
  extends RankedCommandSuggestionBase {
  kind: "intent";
  autoAdvanceCandidateId: string | null;
  hasInlinePlaceholder: boolean;
  intentId: IntentSuggestionId;
  hints: string[];
  hintOverflow: boolean;
  tokenOptions: RankedCommandTokenSuggestion[];
}

export type RankedCommandSuggestion =
  | RankedCommandTokenSuggestion
  | RankedCommandIntentSuggestion;

export function isTokenSuggestion(
  suggestion: RankedCommandSuggestion,
): suggestion is RankedCommandTokenSuggestion {
  return suggestion.kind === "token";
}

export function isIntentSuggestion(
  suggestion: RankedCommandSuggestion,
): suggestion is RankedCommandIntentSuggestion {
  return suggestion.kind === "intent";
}

function scoreCandidate(
  candidate: CommandAutocompleteCandidate,
  prefixLower: string,
): number {
  const labelLower = candidate.label.toLowerCase();
  const insertLower = candidate.insert_text.toLowerCase();

  let score = 0;
  if (candidate.source === "grammar_token") score += 100;
  if (prefixLower.length === 0) return score;

  if (insertLower.startsWith(prefixLower)) score += 30;
  else if (labelLower.startsWith(prefixLower)) score += 20;
  else if (insertLower.includes(prefixLower)) score += 10;

  return score;
}

function prefixForReplaceRange(
  input: string,
  cursor: number,
  replace: { start: number; end: number },
): string {
  const start = Math.min(replace.start, input.length);
  const end = Math.min(Math.max(replace.start, replace.end), input.length);
  const boundedCursor = Math.min(Math.max(cursor, start), end);
  return input.slice(start, boundedCursor).toLowerCase();
}

function toRankedTokenSuggestion(
  candidate: CommandAutocompleteCandidate,
): RankedCommandTokenSuggestion {
  return {
    kind: "token",
    candidateId: candidate.id,
    label: candidate.label,
    insertText: candidate.insert_text,
    applyText: candidate.apply_text,
    detail: candidate.detail,
    replace: candidate.replace,
    completable: candidate.completable,
  };
}

function buildRankedTokenSuggestions(
  response: CommandAutocompleteResponse,
  input: string,
  cursor: number,
): RankedCommandTokenSuggestion[] {
  const looseIds = new Set(response.slot_plan.loose_candidate_ids);
  const candidates = response.candidates
    .filter((candidate) => looseIds.has(candidate.id))
    .map((candidate) => {
      const candidatePrefixLower = prefixForReplaceRange(
        input,
        cursor,
        candidate.replace,
      );
      return {
        candidate,
        score: scoreCandidate(candidate, candidatePrefixLower),
      };
    })
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const ranked: RankedCommandTokenSuggestion[] = [];
  for (const { candidate } of candidates) {
    if (!candidate.insert_text) continue;
    const key = `${candidate.insert_text.toLowerCase()}:${candidate.replace.start}:${candidate.replace.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(toRankedTokenSuggestion(candidate));
  }

  return ranked;
}

function hintChipsForOptions(options: RankedCommandTokenSuggestion[]): {
  hints: string[];
  hintOverflow: boolean;
} {
  const hints = options
    .map((item) => item.insertText)
    .filter((value, index, values) => values.indexOf(value) === index);
  return {
    hints: hints.slice(0, MAX_HINT_CHIPS),
    hintOverflow: hints.length > MAX_HINT_CHIPS,
  };
}

/** Resolves group options to complete parser-provided edits without reconstructing syntax. */
function tokenOptionsForIntentGroup(
  response: CommandAutocompleteResponse,
  group: CommandAutocompleteCompletionGroup,
): RankedCommandTokenSuggestion[] {
  const byId = new Map(
    response.candidates.map((candidate) => [candidate.id, candidate]),
  );
  return group.candidate_ids.flatMap((id) => {
    const candidate = byId.get(id);
    return candidate ? [toRankedTokenSuggestion(candidate)] : [];
  });
}

function buildIntentSuggestions(
  response: CommandAutocompleteResponse,
): RankedCommandIntentSuggestion[] {
  const intentGroups = [...(response.slot_plan.completion_groups ?? [])].sort(
    (a, b) => b.priority - a.priority,
  );

  const suggestions: RankedCommandIntentSuggestion[] = [];
  for (const group of intentGroups) {
    const tokenOptions = tokenOptionsForIntentGroup(response, group);
    if (tokenOptions.length === 0) {
      continue;
    }

    const { hints, hintOverflow } = hintChipsForOptions(tokenOptions);
    suggestions.push({
      kind: "intent",
      autoAdvanceCandidateId: group.auto_advance_candidate_id,
      hasInlinePlaceholder: Boolean(group.inline_placeholder),
      intentId: group.group_id,
      label: group.label,
      detail: null,
      replace: tokenOptions[0]?.replace ?? response.replace,
      hints,
      hintOverflow,
      tokenOptions,
    });
  }

  return suggestions;
}

export function rankCommandAutocomplete(
  response: CommandAutocompleteResponse,
  input: string,
  cursor: number,
): RankedCommandSuggestion[] {
  const tokenSuggestions = buildRankedTokenSuggestions(response, input, cursor);
  const intentSuggestions = buildIntentSuggestions(response);
  const coveredIds = new Set(
    intentSuggestions.flatMap((intent) =>
      intent.tokenOptions.map((option) => option.candidateId),
    ),
  );
  const uncoveredTokenSuggestions = tokenSuggestions.filter(
    (token) => !coveredIds.has(token.candidateId),
  );

  const ranked: RankedCommandSuggestion[] = [];
  for (const intent of intentSuggestions.slice(0, MAX_INTENT_ROWS)) {
    ranked.push(intent);
    if (ranked.length >= MAX_SUGGESTIONS) {
      return ranked;
    }
  }
  for (const token of uncoveredTokenSuggestions) {
    ranked.push(token);
    if (ranked.length >= MAX_SUGGESTIONS) {
      break;
    }
  }

  return ranked;
}

export function singleIntentAutoExpandTarget(
  suggestions: RankedCommandSuggestion[],
): RankedCommandIntentSuggestion | null {
  const intentSuggestions = suggestions.filter(isIntentSuggestion);
  if (intentSuggestions.length !== 1) {
    return null;
  }
  const hasLooseTokenSuggestion = suggestions.some(isTokenSuggestion);
  if (hasLooseTokenSuggestion) {
    return null;
  }
  const onlyIntent = intentSuggestions[0];
  if (onlyIntent.tokenOptions.length === 0 || onlyIntent.hasInlinePlaceholder) {
    return null;
  }
  return onlyIntent;
}
