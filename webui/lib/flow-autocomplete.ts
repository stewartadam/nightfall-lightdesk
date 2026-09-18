// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  CommandAutocompleteExpectedToken,
  CommandAutocompleteResponse,
} from "./wasm-bridge";

/** Hides experimental flow keywords and flow-specific completion paths without rewriting user input. */
export function withoutFlowCompletions(
  response: CommandAutocompleteResponse,
): CommandAutocompleteResponse {
  /** Identifies grammar keywords that expose flow authoring or playback. */
  const isFlow = (value: string) => /^(?:flow|flows|flow_.*)$/i.test(value);
  /** Retains ordinary grammar tokens, literals, and value placeholders. */
  const allowed = (token: CommandAutocompleteExpectedToken) =>
    token.kind === "placeholder" || !isFlow(token.value);
  const inFlow =
    response.slot_plan.committed_path.some((part) => isFlow(part.clause)) ||
    response.slot_plan.active_slots.some((slot) => isFlow(slot.slot));
  const candidates = inFlow
    ? []
    : response.candidates.filter(
        (candidate) =>
          !isFlow(candidate.insert_text) && candidate.slot !== "flow_action",
      );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  return {
    ...response,
    candidates,
    object_reference_requests: inFlow ? [] : response.object_reference_requests,
    slot_plan: {
      ...response.slot_plan,
      loose_candidate_ids: response.slot_plan.loose_candidate_ids.filter((id) =>
        candidateIds.has(id),
      ),
      completion_groups: inFlow
        ? []
        : response.slot_plan.completion_groups
            .filter(
              (group) =>
                !group.active_slots.some(
                  (slot) =>
                    isFlow(slot.slot) || isFlow(slot.clause?.clause ?? ""),
                ),
            )
            .map((group) => ({
              ...group,
              candidate_ids: group.candidate_ids.filter((id) =>
                candidateIds.has(id),
              ),
              auto_advance_candidate_id:
                group.auto_advance_candidate_id &&
                candidateIds.has(group.auto_advance_candidate_id)
                  ? group.auto_advance_candidate_id
                  : null,
              candidates: group.candidates.filter(allowed),
              auto_advance_singleton:
                group.auto_advance_singleton &&
                isFlow(group.auto_advance_singleton)
                  ? null
                  : group.auto_advance_singleton,
            }))
            .filter((group) => group.candidate_ids.length > 0),
      loose_candidates: inFlow
        ? []
        : response.slot_plan.loose_candidates.filter(allowed),
      next_clause_options: response.slot_plan.next_clause_options.filter(
        (clause) => !isFlow(clause),
      ),
    },
  };
}
