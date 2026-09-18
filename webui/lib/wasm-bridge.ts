// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Bridge module for WASM functions
 * Provides typed wrappers around the WASM selection parsing helpers
 */

import type * as types from "../types";
import {
  browserCommandOffsets,
  commandOffsetMap,
} from "./command-autocomplete-offsets";
import { areExperimentalFlowsEnabled } from "./experimental-features";
import { withoutFlowCompletions } from "./flow-autocomplete";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

// Dynamic import for WASM module - will be loaded at runtime
let wasmModule: typeof import("../assets/wasm/nightfall_wasm_bridge") | null =
  null;
let wasmInitialized = false;

interface CommandAutocompleteTextRange {
  start: number;
  end: number;
}

type CommandAutocompleteParseStatus = "ok" | "error";

type CommandAutocompleteValueKind =
  | "blueprint_address"
  | "text"
  | "color_path_reference"
  | "numeric_digit"
  | "identifier_expression"
  | "value_range"
  | "duration_value"
  | "dmx_address";

export type CommandAutocompleteExpectedToken =
  | { kind: "token"; value: string }
  | { kind: "placeholder"; value: CommandAutocompleteValueKind }
  | { kind: "literal"; value: string };

interface CommandAutocompleteParseSnapshot {
  status: CommandAutocompleteParseStatus;
  furthest_pos: number;
  frontier: {
    alternatives: Array<{
      frontier_path: CommandAutocompleteClauseInstance[];
      replace: CommandAutocompleteTextRange;
      rule: string;
      clause_path: CommandAutocompleteClauseInstance[];
      slot: CommandAutocompleteSlotRef | null;
      next_clause: string | null;
      expected_tokens: CommandAutocompleteExpectedToken[];
    }>;
    expected_rules: string[];
    expected_tokens: CommandAutocompleteExpectedToken[];
  };
  committed_clause_path: CommandAutocompleteClauseInstance[];
  projected_clause_paths: CommandAutocompleteClauseInstance[][];
}

type CommandAutocompleteSlot =
  | "keyword"
  | "object_type"
  | "selection_type"
  | "attribute_type"
  | "duration_unit"
  | "transport_name"
  | "playback_action"
  | "flow_action"
  | "fx_action"
  | "number"
  | "value";

type CommandAutocompleteCandidateSource = "grammar_token" | "grammar_rule";

export interface CommandAutocompleteCompletionGroup {
  candidate_ids: string[];
  auto_advance_candidate_id: string | null;
  group_id: string;
  label: string;
  priority: number;
  candidates: CommandAutocompleteExpectedToken[];
  slots: string[];
  active_slots: CommandAutocompleteSlotRef[];
  frontier_sources: number[];
  auto_advance_singleton: string | null;
  inline_placeholder: CommandAutocompleteValueKind | null;
}

interface CommandAutocompleteClauseInstance {
  clause: string;
  instance: number;
}

interface CommandAutocompleteSlotRef {
  slot: string;
  clause: CommandAutocompleteClauseInstance | null;
}

export type CommandAutocompleteBreadcrumb =
  | { state: "none" }
  | {
      state: "ambiguous_clause_path";
      paths: CommandAutocompleteClauseInstance[][];
    }
  | {
      state: "current_clause_path";
      path: CommandAutocompleteClauseInstance[];
    };

export interface CommandAutocompleteCandidate {
  id: string;
  expected: CommandAutocompleteExpectedToken;
  frontier_sources: number[];
  label: string;
  insert_text: string;
  apply_text: string;
  detail: string | null;
  replace: CommandAutocompleteTextRange;
  source: CommandAutocompleteCandidateSource;
  slot?: CommandAutocompleteSlot | null;
  completable: boolean;
}

export interface CommandAutocompleteObjectReferenceRequest {
  id: string;
  object_kind: "blueprint";
  slot: CommandAutocompleteSlotRef;
  frontier_sources: number[];
  replace: CommandAutocompleteTextRange;
  query: string;
  before_value: string;
  after_value: string;
}

export interface CommandAutocompleteResponse {
  object_reference_requests: CommandAutocompleteObjectReferenceRequest[];
  input_len: number;
  cursor: number;
  segment_start: number;
  segment_end: number;
  replace: CommandAutocompleteTextRange;
  parse: CommandAutocompleteParseSnapshot;
  slot_plan: {
    loose_candidate_ids: string[];
    breadcrumb: CommandAutocompleteBreadcrumb;
    committed_path: CommandAutocompleteClauseInstance[];
    active_slots: CommandAutocompleteSlotRef[];
    filled: unknown[];
    completion_groups: CommandAutocompleteCompletionGroup[];
    loose_candidates: CommandAutocompleteExpectedToken[];
    suppression: unknown[];
    next_clause_options: string[];
  };
  candidates: CommandAutocompleteCandidate[];
}

export interface CommandValidationResponse {
  status: CommandAutocompleteParseStatus;
  furthest_pos: number;
  expected_rules: string[];
  expected_tokens: string[];
  message: string | null;
}

export interface SpatialProjectionResponse {
  resolved: types.ResolvedSelection;
  issues: string[];
}

export interface SpannedSpatialProjectionRequest {
  spans: types.FixtureRef[][];
  clauses: types.SpatialClause[];
}

interface SpatialSelectionResolutionRequest {
  selection: types.SpatialSelection;
  fixtures: Array<{
    id: number;
    fixture_uid: string;
    element_count: number;
  }>;
  groups: types.Group[];
}

export interface TransitionModeResolutionRequest {
  mode: types.TransitionMode;
  offset: number;
  total: number;
}

export interface LookaheadProjectionInstruction {
  fixtures: types.FixtureRef[];
  values: Record<string, types.ValueSource>;
}

export interface LookaheadProjectionCuePart {
  part_id: number;
  lookahead?: boolean;
  instructions: LookaheadProjectionInstruction[];
}

export interface LookaheadProjectionCue {
  cue_uid: string;
  cue_id: number;
  lookahead?: boolean;
  instructions: LookaheadProjectionInstruction[];
  parts: LookaheadProjectionCuePart[];
}

export interface SequenceLookaheadProjectionRequest {
  sequence_id: number;
  wrap?: boolean;
  target_cue_uid: string;
  setup_instructions: LookaheadProjectionInstruction[];
  cues: LookaheadProjectionCue[];
}

export interface ProjectedLookaheadSource {
  cue_uid: string;
  cue_id: number;
  sequence_id: number;
  part_id: number;
  has_additional_parts: boolean;
}

export interface ProjectedLookaheadValue {
  fixture: types.FixtureRef;
  attribute: string;
  value: types.ParameterValue;
  source: ProjectedLookaheadSource;
}

export interface SequenceDurationSummaryStep {
  cue_uid: string;
  trigger: types.CueTriggerType;
  transitions: types.PartialTransition;
  parts: Array<{
    transitions: types.PartialTransition;
  }>;
  duration_profile: types.CueDurationProfile;
}

export interface SequenceDurationSummaryRequest {
  wrap?: boolean;
  default_timing: types.Transition;
  steps: SequenceDurationSummaryStep[];
}

export interface SequenceDurationCueSummary {
  cue_uid: string;
  start_time?: types.Duration;
  duration?: types.Duration;
}

export interface SequenceDurationSummary {
  cues: SequenceDurationCueSummary[];
  total?: types.Duration;
}

/**
 * Initialize the WASM module
 */
async function initWasm() {
  if (wasmInitialized) return;

  try {
    // Import the WASM module
    wasmModule = await import("../assets/wasm/nightfall_wasm_bridge.js");

    // Initialize the WASM module (required before calling any functions)
    if (typeof window === "undefined") {
      const importNodeModule = new Function(
        "specifier",
        "return import(specifier)",
      ) as (
        specifier: string,
      ) => Promise<{ readFile(path: URL): Promise<Uint8Array> }>;
      const { readFile } = await importNodeModule("node:fs/promises");
      const wasmBytes = await readFile(
        new URL(
          "../assets/wasm/nightfall_wasm_bridge_bg.wasm",
          import.meta.url,
        ),
      );
      await wasmModule.default({ module_or_path: wasmBytes });
    } else {
      await wasmModule.default();
    }

    wasmInitialized = true;
  } catch (error) {
    log.error("Failed to load WASM module:", error);
    throw error;
  }
}

/**
 * Parse a spatial selection string into a SpatialSelection using the WASM bridge.
 */
export async function parseSpatialSelection(
  input: string,
): Promise<types.SpatialSelection | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    const result = wasmModule.parse_spatial_selection(input);
    return result as types.SpatialSelection;
  } catch (error) {
    log.error("Failed to parse spatial selection:", error);
    return null;
  }
}

/**
 * Format a SpatialSelection as a CLI-style string using the WASM bridge.
 */
export async function formatSpatialSelection(
  selection: types.SpatialSelection,
): Promise<string> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      throw new Error("WASM module not loaded");
    }

    return wasmModule.format_spatial_selection(JSON.stringify(selection));
  } catch (error) {
    log.error("Failed to format spatial selection:", error);
    throw error;
  }
}

/** Parses authored Step FX phase syntax into normalized waypoint data. */
export async function parseStepFxPhase(
  input: string,
): Promise<types.StepFxPhase | null> {
  try {
    await initWasm();
    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }
    return wasmModule.parse_step_fx_phase(input) as types.StepFxPhase;
  } catch (error) {
    log.error("Failed to parse Step FX phase", error);
    return null;
  }
}

/** Formats authored Step FX waypoints as canonical degree syntax. */
export async function formatStepFxPhase(
  phase: types.StepFxPhase,
): Promise<string> {
  try {
    await initWasm();
    if (!wasmModule) throw new Error("WASM module not loaded");
    return wasmModule.format_step_fx_phase(JSON.stringify(phase));
  } catch (error) {
    log.error("Failed to format Step FX phase", error);
    throw error;
  }
}

/**
 * Project an already-resolved spatial selection through Rust spatial replay logic.
 */
export async function projectResolvedSpatialSelection(
  selection: types.SpatialSelection,
): Promise<SpatialProjectionResponse | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return wasmModule.project_resolved_spatial_selection(
      JSON.stringify(selection),
    ) as SpatialProjectionResponse;
  } catch (error) {
    log.error("Failed to project spatial selection:", error);
    return null;
  }
}

/** Projects explicit source spans through the shared Rust spatial replay implementation. */
export async function projectSpannedSpatialSelection(
  request: SpannedSpatialProjectionRequest,
): Promise<SpatialProjectionResponse | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return wasmModule.project_spanned_spatial_selection(
      JSON.stringify(request),
    ) as SpatialProjectionResponse;
  } catch (error) {
    log.error("Failed to project spanned spatial selection:", error);
    return null;
  }
}

/** Resolves a complete selection through the Rust engine using browser lookup snapshots. */
export async function resolveSpatialSelection(
  selection: types.SpatialSelection,
  fixtures: Record<string, types.Fixture>,
  groups: Record<string, types.Group>,
): Promise<SpatialProjectionResponse | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    const request: SpatialSelectionResolutionRequest = {
      selection,
      fixtures: Object.values(fixtures).map((fixture) => ({
        id: fixture.identifiers.id,
        fixture_uid: fixture.identifiers.uid,
        element_count: fixture.elements.length,
      })),
      groups: Object.values(groups),
    };
    return wasmModule.resolve_spatial_selection(
      JSON.stringify(request),
    ) as SpatialProjectionResponse;
  } catch (error) {
    log.error("Failed to resolve spatial selection:", error);
    return null;
  }
}

/**
 * Resolve transition modes through Rust timing distribution logic.
 */
export async function resolveTransitionModes(
  requests: TransitionModeResolutionRequest[],
): Promise<types.Duration[] | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return wasmModule.resolve_transition_modes(requests) as types.Duration[];
  } catch (error) {
    log.error("Failed to resolve transition modes:", error);
    return null;
  }
}

/**
 * Project authored sequence lookahead values using the shared Rust evaluator.
 */
export async function projectSequenceLookahead(
  request: SequenceLookaheadProjectionRequest,
): Promise<ProjectedLookaheadValue[] | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return wasmModule.project_sequence_lookahead(
      request,
    ) as ProjectedLookaheadValue[];
  } catch (error) {
    log.error("Failed to project sequence lookahead:", error);
    return null;
  }
}

/**
 * Compute sequence-view duration values using shared Rust cue timing semantics.
 */
export async function calculateSequenceDurationSummary(
  request: SequenceDurationSummaryRequest,
): Promise<SequenceDurationSummary | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return wasmModule.sequence_duration_summary(
      request,
    ) as SequenceDurationSummary;
  } catch (error) {
    log.error("Failed to calculate sequence duration summary:", error);
    return null;
  }
}

/**
 * Get command autocomplete metadata at the given cursor position.
 */
export async function completeCommand(
  input: string,
  cursor: number,
): Promise<CommandAutocompleteResponse | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    const byteCursor = commandOffsetMap(input).toBytes(cursor);
    const result = browserCommandOffsets(
      input,
      wasmModule.complete_command(
        input,
        byteCursor,
      ) as CommandAutocompleteResponse,
    );
    return areExperimentalFlowsEnabled()
      ? result
      : withoutFlowCompletions(result);
  } catch (error) {
    log.error("Failed to compute command autocomplete:", error);
    return null;
  }
}

/**
 * Validate a full command string against the command grammar.
 */
export async function validateCommand(
  input: string,
): Promise<CommandValidationResponse | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    const result = wasmModule.validate_command(
      input,
    ) as CommandValidationResponse;
    return {
      ...result,
      furthest_pos: commandOffsetMap(input).toCodeUnits(result.furthest_pos),
    };
  } catch (error) {
    log.error("Failed to validate command:", error);
    return null;
  }
}

/** Splits one command-line input using the Rust command grammar's statement boundaries. */
export async function splitCommandStatements(
  input: string,
): Promise<string[] | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return stringArrayFromWasmValue(wasmModule.split_command_statements(input));
  } catch (error) {
    log.error("Failed to split command statements:", error);
    return null;
  }
}

/**
 * Converts a WASM-returned JavaScript value into a string array.
 */
function stringArrayFromWasmValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Returns reserved network DMX output target keywords from the Rust WASM bridge.
 */
export async function reservedNetworkDmxTargetKeywords(): Promise<
  string[] | null
> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return stringArrayFromWasmValue(
      wasmModule.reserved_network_dmx_target_keywords(),
    );
  } catch (error) {
    log.error("Failed to load reserved network DMX target keywords:", error);
    return null;
  }
}

/**
 * Returns reserved USB DMX output target keywords from the Rust WASM bridge.
 */
export async function reservedUsbDmxTargetKeywords(): Promise<string[] | null> {
  try {
    await initWasm();

    if (!wasmModule) {
      log.error("WASM module not loaded");
      return null;
    }

    return stringArrayFromWasmValue(
      wasmModule.reserved_usb_dmx_target_keywords(),
    );
  } catch (error) {
    log.error("Failed to load reserved USB DMX target keywords:", error);
    return null;
  }
}
