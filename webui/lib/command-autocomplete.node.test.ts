// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isIntentSuggestion,
  isTokenSuggestion,
  rankCommandAutocomplete,
  singleIntentAutoExpandTarget,
} from "./command-autocomplete";
import { withoutFlowCompletions } from "./flow-autocomplete";
import type {
  CommandAutocompleteCandidate,
  CommandAutocompleteResponse,
} from "./wasm-bridge";

/**
 * Builds an autocomplete response with overridable completion groups.
 */
function makeResponse(
  partial: Omit<
    Partial<CommandAutocompleteResponse>,
    "candidates" | "slot_plan"
  > & {
    candidates?: Array<
      Pick<
        CommandAutocompleteCandidate,
        "insert_text" | "label" | "detail" | "replace" | "source"
      > &
        Partial<CommandAutocompleteCandidate>
    >;
    slot_plan?: Omit<
      CommandAutocompleteResponse["slot_plan"],
      "loose_candidate_ids"
    > & { loose_candidate_ids?: string[] };
  },
): CommandAutocompleteResponse {
  const candidates = (partial.candidates ?? []).map(
    (candidate): CommandAutocompleteCandidate => ({
      id: candidate.insert_text.toLowerCase(),
      expected: { kind: "literal", value: candidate.insert_text },
      frontier_sources: [],
      apply_text: candidate.insert_text,
      completable: candidate.insert_text !== "0..9",
      ...candidate,
    }),
  );
  const groupedIds = new Set(
    partial.slot_plan?.completion_groups.flatMap(
      (group) => group.candidate_ids,
    ),
  );
  const looseIds =
    partial.slot_plan?.loose_candidate_ids ??
    candidates
      .filter((candidate) => !groupedIds.has(candidate.id))
      .map((candidate) => candidate.id);
  const { slot_plan: _plan, candidates: _candidates, ...metadata } = partial;
  return {
    object_reference_requests: [],
    input_len: 0,
    cursor: 0,
    segment_start: 0,
    segment_end: 0,
    replace: { start: 0, end: 0 },
    parse: {
      status: "error",
      furthest_pos: 0,
      frontier: {
        alternatives: [],
        expected_rules: [],
        expected_tokens: [],
      },
      committed_clause_path: [],
      projected_clause_paths: [],
    },
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
      ...partial.slot_plan,
      loose_candidate_ids: looseIds,
    },
    ...metadata,
    candidates,
  };
}

/**
 * Builds a completion group with default command metadata.
 */
function makeCompletionGroup(
  intent: string,
  label: string,
  priority: number,
  tokens: Array<{ insert_text: string; label?: string; completable?: boolean }>,
): CommandAutocompleteResponse["slot_plan"]["completion_groups"][number] {
  return {
    candidate_ids: tokens.map((token) => token.insert_text.toLowerCase()),
    auto_advance_candidate_id: null,
    group_id: intent,
    label,
    priority,
    candidates: tokens.map((token) =>
      token.insert_text === "0..9"
        ? { kind: "placeholder" as const, value: "numeric_digit" as const }
        : { kind: "literal" as const, value: token.insert_text },
    ),
    slots: ["active_slot"],
    active_slots: [{ slot: "active_slot", clause: null }],
    frontier_sources: [],
    auto_advance_singleton: null,
    inline_placeholder: null,
  };
}

/**
 * Extracts token insertion text from an autocomplete response.
 */
function tokenInsertTexts(
  suggestions: ReturnType<typeof rankCommandAutocomplete>,
): string[] {
  return suggestions
    .filter(isTokenSuggestion)
    .map((suggestion) => suggestion.insertText);
}

/**
 * Extracts completion group labels from an autocomplete response.
 */
function groupLabels(
  suggestions: ReturnType<typeof rankCommandAutocomplete>,
): string[] {
  return suggestions
    .filter(isIntentSuggestion)
    .map((suggestion) => suggestion.label);
}

test("rankCommandAutocomplete favors grammar tokens and prefix matches", () => {
  const input = "fx 1 st";
  const cursor = input.length;
  const response = makeResponse({
    replace: { start: 5, end: 7 },
    candidates: [
      {
        label: "Step",
        insert_text: "step",
        detail: "Expected token",
        replace: { start: 5, end: 7 },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "Stop",
        insert_text: "stop",
        detail: "Expected token",
        replace: { start: 5, end: 7 },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "StartFx",
        insert_text: "start",
        detail: "Expected rule",
        replace: { start: 5, end: 7 },
        source: "grammar_rule",
        slot: "fx_action",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, input, cursor);
  assert.deepEqual(tokenInsertTexts(ranked), ["step", "stop", "start"]);
});

test("rankCommandAutocomplete removes duplicates by insert text", () => {
  const response = makeResponse({
    candidates: [
      {
        label: "start",
        insert_text: "start",
        detail: null,
        replace: { start: 0, end: 0 },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "Start",
        insert_text: "start",
        detail: null,
        replace: { start: 0, end: 0 },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, "", 0);
  assert.equal(tokenInsertTexts(ranked).length, 1);
  assert.equal(tokenInsertTexts(ranked)[0], "start");
});

test("rankCommandAutocomplete ignores candidates without insert text", () => {
  const response = makeResponse({
    candidates: [
      {
        label: "FlowActions",
        insert_text: "",
        detail: "Expected rule",
        replace: { start: 0, end: 0 },
        source: "grammar_rule",
        slot: "flow_action",
      },
      {
        label: "go",
        insert_text: "go",
        detail: "Expected token",
        replace: { start: 0, end: 0 },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, "", 0);
  assert.deepEqual(tokenInsertTexts(ranked), ["go"]);
});

test("rankCommandAutocomplete ranks parser-provided top-level command candidates", () => {
  const input = "pa";
  const response = makeResponse({
    replace: { start: 0, end: 2 },
    candidates: [
      {
        label: "patch",
        insert_text: "patch",
        detail: "Command keyword",
        replace: { start: 0, end: 2 },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "parameter",
        insert_text: "param",
        detail: "Command keyword",
        replace: { start: 0, end: 2 },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.equal(tokenInsertTexts(ranked)[0], "patch");
  assert.ok(tokenInsertTexts(ranked).includes("param"));
});

test("rankCommandAutocomplete uses candidate replace range for continuation tokens", () => {
  const input = "fix 311 red @ 100";
  const response = makeResponse({
    replace: { start: 14, end: 17 },
    candidates: [
      {
        label: "fade",
        insert_text: "fade",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "delay",
        insert_text: "delay",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.ok(tokenInsertTexts(ranked).includes("fade"));
  assert.ok(tokenInsertTexts(ranked).includes("delay"));
});

test("rankCommandAutocomplete keeps structural continuation token after completed word", () => {
  const input = "patch sacn";
  const response = makeResponse({
    replace: { start: 6, end: 10 },
    candidates: [
      {
        label: "@",
        insert_text: "@",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.ok(tokenInsertTexts(ranked).includes("@"));
});

test("rankCommandAutocomplete preserves parser-provided raw tokens", () => {
  const input = "fixture 211";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "3d",
        insert_text: "3d",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "@",
        insert_text: "@",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.ok(tokenInsertTexts(ranked).includes("3d"));
  assert.ok(tokenInsertTexts(ranked).includes("@"));
});

test("rankCommandAutocomplete uses parser-provided token labels", () => {
  const input = "fixture 211";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "3D Visualizer Position",
        insert_text: "3d",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  const threeD = ranked.find(
    (suggestion) =>
      isTokenSuggestion(suggestion) && suggestion.insertText === "3d",
  );
  assert.ok(threeD && isTokenSuggestion(threeD));
  assert.equal(
    isTokenSuggestion(threeD) ? threeD.label : "",
    "3D Visualizer Position",
  );
});

test("rankCommandAutocomplete keeps parser insertion metadata", () => {
  const input = "fix ";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "0..9",
        insert_text: "0..9",
        apply_text: "0..9",
        completable: false,
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "value",
      },
      {
        label: "3D Visualizer Position",
        insert_text: "3d",
        apply_text: " 3d ",
        completable: true,
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  const placeholder = ranked.find(
    (suggestion) =>
      isTokenSuggestion(suggestion) && suggestion.insertText === "0..9",
  );
  const visualizer = ranked.find(
    (suggestion) =>
      isTokenSuggestion(suggestion) && suggestion.insertText === "3d",
  );
  assert.ok(placeholder && isTokenSuggestion(placeholder));
  assert.ok(visualizer && isTokenSuggestion(visualizer));
  if (isTokenSuggestion(placeholder)) {
    assert.equal(placeholder.completable, false);
    assert.equal(placeholder.applyText, "0..9");
  }
  if (isTokenSuggestion(visualizer)) {
    assert.equal(visualizer.completable, true);
    assert.equal(visualizer.applyText, " 3d ");
  }
});

test("rankCommandAutocomplete groups intensity and attribute tokens from rust completion groups", () => {
  const input = "fixture 211";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "@",
        insert_text: "@",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "@@",
        insert_text: "@@",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "b",
        insert_text: "b",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "blue",
        insert_text: "blue",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("programmer/intensity", "Intensity", 690, [
          { insert_text: "@@" },
          { insert_text: "@" },
        ]),
        makeCompletionGroup("programmer/attribute", "Attribute", 680, [
          { insert_text: "b" },
          { insert_text: "blue" },
        ]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.ok(groupLabels(ranked).includes("Intensity"));
  assert.ok(groupLabels(ranked).includes("Attribute"));
  assert.ok(!tokenInsertTexts(ranked).includes("@"));
  assert.ok(!tokenInsertTexts(ranked).includes("@@"));
  assert.ok(!tokenInsertTexts(ranked).includes("b"));
  assert.ok(!tokenInsertTexts(ranked).includes("blue"));
});

test("rankCommandAutocomplete renders completion groups from rust response", () => {
  const input = "patch sacn";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: ":",
        insert_text: ":",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "@",
        insert_text: "@",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("patch/dmx_address", "Universe address :a.b", 780, [
          { insert_text: ":" },
        ]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.deepEqual(groupLabels(ranked), ["Universe address :a.b"]);
  assert.deepEqual(tokenInsertTexts(ranked), ["@"]);
});

test("rankCommandAutocomplete suppresses raw tokens covered by completion group options", () => {
  const input = "rm ";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "patch",
        insert_text: "patch",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("rm/object_type", "Object type", 720, [
          { insert_text: "patch" },
        ]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.deepEqual(groupLabels(ranked), ["Object type"]);
  assert.equal(tokenInsertTexts(ranked).includes("patch"), false);
});

test("rankCommandAutocomplete preserves uncovered raw tokens alongside completion groups", () => {
  const input = "patch sacn@console";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "priority",
        insert_text: "priority",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "/clone",
        insert_text: "/clone",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
      {
        label: "@",
        insert_text: "@",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("patch/priority", "Priority", 760, [
          { insert_text: "priority" },
        ]),
        makeCompletionGroup("patch/clone", "Clone", 740, [
          { insert_text: "/clone" },
        ]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.deepEqual(groupLabels(ranked), ["Priority", "Clone"]);
  assert.ok(tokenInsertTexts(ranked).includes("@"));
});

test("rankCommandAutocomplete surfaces rate completion group for fx step selection tail", () => {
  const input = "store fx 1 step group 14 ";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "0..9",
        insert_text: "0..9",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "value",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("fx/rate", "Rate", 700, [{ insert_text: "0..9" }]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.deepEqual(groupLabels(ranked), ["Rate"]);
});

test("rankCommandAutocomplete surfaces attribute completion group after fx duration", () => {
  const input = "store fx 1 step group 14 1s ";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "int",
        insert_text: "int",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("fx/attribute", "Attribute", 680, [
          { insert_text: "int" },
        ]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  assert.deepEqual(groupLabels(ranked), ["Attribute"]);
});

test("singleIntentAutoExpandTarget returns completion group row when it is the only suggestion", () => {
  const input = "rm ";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "patch",
        insert_text: "patch",
        apply_text: "patch ",
        detail: null,
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("rm/object_type", "Object type", 720, [
          { insert_text: "patch" },
        ]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  const target = singleIntentAutoExpandTarget(ranked);
  assert.equal(target?.label, "Object type");
});

test("singleIntentAutoExpandTarget returns null when loose token suggestions remain", () => {
  const input = "patch sacn";
  const response = makeResponse({
    replace: { start: input.length, end: input.length },
    candidates: [
      {
        label: "@",
        insert_text: "@",
        detail: "Expected token",
        replace: { start: input.length, end: input.length },
        source: "grammar_token",
        slot: "keyword",
      },
    ],
    slot_plan: {
      breadcrumb: { state: "none" },
      committed_path: [],
      active_slots: [],
      filled: [],
      completion_groups: [
        makeCompletionGroup("patch/dmx_address", "Universe address :a.b", 780, [
          { insert_text: ":" },
        ]),
      ],
      loose_candidates: [],
      suppression: [],
      next_clause_options: [],
    },
  });

  const ranked = rankCommandAutocomplete(response, input, input.length);
  const target = singleIntentAutoExpandTarget(ranked);
  assert.equal(target, null);
});

/** Missing WASM Option values behave like null when deciding whether an intent has a placeholder. */
test("absent WASM placeholder metadata permits deterministic group expansion", () => {
  const response = makeResponse({
    candidates: [
      {
        label: "fixture",
        insert_text: "fixture",
        detail: null,
        replace: { start: 0, end: 1 },
        source: "grammar_token",
      },
    ],
  });
  const group = makeCompletionGroup("command", "Command Type", 1, [
    { insert_text: "fixture" },
  ]);
  Reflect.deleteProperty(group, "inline_placeholder");
  response.slot_plan.completion_groups = [group];
  response.slot_plan.loose_candidate_ids = [];
  const ranked = rankCommandAutocomplete(response, "f", 1);
  assert.equal(singleIntentAutoExpandTarget(ranked)?.label, "Command Type");
});

/** Verifies disabled flows disappear from both ranked tokens and grouped command discovery. */
test("experimental flow completion filtering preserves ordinary commands", () => {
  const response = makeResponse({
    candidates: ["flow", "fixture", "cue"].map((token) => ({
      label: token,
      insert_text: token,
      detail: null,
      replace: { start: 0, end: 0 },
      source: "grammar_token" as const,
    })),
  });
  response.slot_plan.completion_groups = [
    makeCompletionGroup("objects", "Objects", 1, [
      { insert_text: "flow" },
      { insert_text: "fixture" },
    ]),
  ];
  response.slot_plan.loose_candidates = [
    { kind: "token", value: "flow" },
    { kind: "token", value: "cue" },
  ];
  response.slot_plan.next_clause_options = ["flow", "cue"];
  const filtered = withoutFlowCompletions(response);
  assert.deepEqual(filtered.slot_plan.completion_groups[0].candidates, [
    { kind: "literal", value: "fixture" },
  ]);
  assert.deepEqual(filtered.slot_plan.loose_candidates, [
    { kind: "token", value: "cue" },
  ]);
  assert.deepEqual(filtered.slot_plan.next_clause_options, ["cue"]);
  assert.deepEqual(filtered.slot_plan.completion_groups[0].candidate_ids, [
    "fixture",
  ]);
  assert.ok(
    filtered.slot_plan.loose_candidate_ids.every((id) =>
      filtered.candidates.some((candidate) => candidate.id === id),
    ),
  );
  assert.equal(response.slot_plan.loose_candidates.length, 2);
});

/** Verifies entering a flow command cannot reveal start/stop actions through completion. */
test("experimental flow completion filtering suppresses active flow paths", () => {
  const response = makeResponse({});
  response.slot_plan.committed_path = [{ clause: "flow", instance: 0 }];
  response.slot_plan.completion_groups = [
    makeCompletionGroup("actions", "Actions", 1, [{ insert_text: "start" }]),
  ];
  assert.deepEqual(
    withoutFlowCompletions(response).slot_plan.completion_groups,
    [],
  );
});
