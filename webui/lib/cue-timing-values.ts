// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { durationToSeconds } from "./duration";
import { normalizeAttributeName } from "./utils";
import {
  projectResolvedSpatialSelection,
  resolveTransitionModes,
  type SpatialProjectionResponse,
  type TransitionModeResolutionRequest,
} from "./wasm-bridge";

export type TimingField = "fade_in" | "delay_in" | "fade_out" | "delay_out";

export type CueTimingValue = {
  value: number;
  inherited: boolean;
};

export type CueTransitionDurations = {
  delayIn: number;
  fadeIn: number;
  delayOut: number;
  fadeOut: number;
  inDuration: number;
  outDuration: number;
  totalDuration: number;
};

export type SelectionTimingPosition = {
  offset: number;
  total: number;
};

export type SelectionTimingIndex = {
  members: types.FixtureRef[];
};

type SpatialProjectionProjector = (
  selection: types.SpatialSelection,
) => Promise<SpatialProjectionResponse | null>;

type TransitionModeResolverProjector = (
  requests: TransitionModeResolutionRequest[],
) => Promise<types.Duration[] | null>;

let spatialProjectionProjector: SpatialProjectionProjector =
  projectResolvedSpatialSelection;
let transitionModeResolverProjector: TransitionModeResolverProjector =
  resolveTransitionModes;

/**
 * Installs a spatial projection implementation for node tests that cannot load browser WASM assets.
 */
export function setSpatialProjectionProjectorForTesting(
  projector: SpatialProjectionProjector,
): () => void {
  spatialProjectionProjector = projector;
  return () => {
    spatialProjectionProjector = projectResolvedSpatialSelection;
  };
}

/**
 * Installs a transition-mode resolver implementation for node tests that cannot load browser WASM assets.
 */
export function setTransitionModeResolverForTesting(
  projector: TransitionModeResolverProjector,
): () => void {
  transitionModeResolverProjector = projector;
  return () => {
    transitionModeResolverProjector = resolveTransitionModes;
  };
}

export type TransitionModeResolver = {
  /** Resolve one transition mode at the supplied selection offset. */
  resolve: (
    mode: types.TransitionMode | undefined,
    offset?: number,
    total?: number,
  ) => Promise<number>;
};

export const TIMING_COLUMNS: ReadonlyArray<{
  field: TimingField;
  title: string;
}> = [
  { field: "delay_in", title: "Delay In" },
  { field: "fade_in", title: "Fade In" },
  { field: "delay_out", title: "Delay Out" },
  { field: "fade_out", title: "Fade Out" },
];

/**
 * Creates a transition-mode resolver that batches requests made in the same tick through WASM.
 */
export function createTransitionModeResolver(): TransitionModeResolver {
  type PendingRequest = {
    request: TransitionModeResolutionRequest;
    resolve: (value: number) => void;
  };

  const pending = new Map<string, PendingRequest>();
  const cache = new Map<string, Promise<number>>();
  let flushScheduled = false;

  /** Flushes all queued transition-mode requests through the WASM bridge. */
  const flush = async () => {
    flushScheduled = false;
    const entries = [...pending.entries()];
    pending.clear();
    const durations = await transitionModeResolverProjector(
      entries.map(([, pendingRequest]) => pendingRequest.request),
    );

    for (const [index, [, pendingRequest]] of entries.entries()) {
      pendingRequest.resolve(durationToSeconds(durations?.[index]));
    }
  };

  return {
    resolve(mode, offset = 0, total = 1) {
      if (!mode) return Promise.resolve(0);

      const key = JSON.stringify({ mode, offset, total });
      const cached = cache.get(key);
      if (cached) return cached;

      const promise = new Promise<number>((resolve) => {
        pending.set(key, { request: { mode, offset, total }, resolve });
      });
      cache.set(key, promise);

      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          void flush();
        });
      }

      return promise;
    },
  };
}

/**
 * Finds the transition override for an attribute, accepting both exact and normalized names.
 */
function transitionForAttribute(
  transitions: Record<string, types.PartialTransition> | undefined,
  attr: string,
): types.PartialTransition | undefined {
  if (!transitions) return undefined;
  return (
    transitions[attr] ??
    Object.entries(transitions).find(
      ([key]) => normalizeAttributeName(key) === attr,
    )?.[1]
  );
}

/** Returns true when two fixture references point at the same fixture and element. */
function sameFixtureRef(
  left: types.FixtureRef | undefined,
  right: types.FixtureRef | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    sameFixtureUid(left.fixture_uid, right.fixture_uid) &&
    (left.index ?? undefined) === (right.index ?? undefined)
  );
}

/** Returns true when UUID strings match across hyphenated and simple serialization forms. */
export function sameFixtureUid(left: string, right: string): boolean {
  return normalizeFixtureUid(left) === normalizeFixtureUid(right);
}

/** Normalizes UUID text for comparisons across Rust and TypeScript serializers. */
function normalizeFixtureUid(uid: string): string {
  return uid.replace(/-/g, "").toLowerCase();
}

/** Converts an element-level fixture reference into a fixture-wide reference. */
function fixtureWideRefFor(
  fixtureRef: types.FixtureRef | undefined,
): types.FixtureRef | undefined {
  if (!fixtureRef?.index) return undefined;
  return { fixture_uid: fixtureRef.fixture_uid };
}

/**
 * Resolves fixture-specific attribute timing, merging fixture-wide and element-specific overrides.
 */
export function transitionForFixtureAttribute(
  instruction: types.CueInstruction,
  fixtureRef: types.FixtureRef | undefined,
  attr: string,
): types.PartialTransition | undefined {
  if (!fixtureRef) return undefined;

  const fixtureWide = fixtureWideRefFor(fixtureRef);
  const fixtureWideTransition = transitionForAttribute(
    instruction.transitions_by_fixture_attribute?.find((entry) =>
      sameFixtureRef(entry.fixture, fixtureWide),
    )?.transitions_by_attribute,
    attr,
  );
  const exactTransition = transitionForAttribute(
    instruction.transitions_by_fixture_attribute?.find((entry) =>
      sameFixtureRef(entry.fixture, fixtureRef),
    )?.transitions_by_attribute,
    attr,
  );

  if (!fixtureWideTransition) return exactTransition;
  if (!exactTransition) return fixtureWideTransition;
  return {
    ...fixtureWideTransition,
    ...exactTransition,
  };
}

/**
 * Resolves the timing value shown for one cue instruction, marking values inherited from broader cue defaults.
 */
export async function resolveCueInstructionTiming(
  resolver: TransitionModeResolver,
  cue: types.Cue,
  instruction: types.CueInstruction,
  attr: string,
  field: TimingField,
  offset: number,
  total: number,
  fixtureRef?: types.FixtureRef,
): Promise<CueTimingValue> {
  if (fixtureRef) {
    const exactTransition = transitionForAttribute(
      instruction.transitions_by_fixture_attribute?.find((entry) =>
        sameFixtureRef(entry.fixture, fixtureRef),
      )?.transitions_by_attribute,
      attr,
    );
    const exactMode = exactTransition?.[field];
    if (exactMode) {
      return {
        value: await resolver.resolve(exactMode, offset, total),
        inherited: false,
      };
    }

    const fixtureWideRef = fixtureWideRefFor(fixtureRef);
    const fixtureWideTransition = transitionForAttribute(
      instruction.transitions_by_fixture_attribute?.find((entry) =>
        sameFixtureRef(entry.fixture, fixtureWideRef),
      )?.transitions_by_attribute,
      attr,
    );
    const fixtureWideMode = fixtureWideTransition?.[field];
    if (fixtureWideMode) {
      return {
        value: await resolver.resolve(fixtureWideMode, offset, total),
        inherited: fixtureRef.index != null,
      };
    }
  }

  const instructionAttributeTransition = transitionForAttribute(
    instruction.transitions_by_attribute,
    attr,
  );
  const ownMode = instructionAttributeTransition?.[field];
  if (ownMode) {
    return {
      value: await resolver.resolve(ownMode, offset, total),
      inherited: fixtureRef?.index != null,
    };
  }

  const cueAttributeTransition = transitionForAttribute(
    cue.transitions_by_attribute,
    attr,
  );
  const inheritedMode =
    instruction.transitions[field] ??
    cueAttributeTransition?.[field] ??
    cue.transitions[field];
  return {
    value: await resolver.resolve(inheritedMode, offset, total),
    inherited: true,
  };
}

/** Returns the display attribute name represented by parameter metadata. */
function attributeNameFromMetadata(param: types.ParameterMetadata): string {
  const attr = param.attribute as types.Attribute;
  if (attr.type === "Custom" && attr.data) {
    return attr.data.label;
  }
  if (attr.type === "VirtualIntensity") {
    return "Intensity";
  }
  return attr.type;
}

/** Checks whether a selected fixture or element exposes the requested attribute. */
function selectedElementHasAttribute(
  fixture: types.Fixture | undefined,
  index: number | null | undefined,
  attr: string,
): boolean {
  if (!fixture) return true;
  if (index === null || index === undefined) {
    return fixture.elements.some((element) =>
      element.parameters.some(
        (param) =>
          normalizeAttributeName(attributeNameFromMetadata(param)) === attr,
      ),
    );
  }

  const element = fixture.elements[index - 1];
  if (!element) return false;
  return element.parameters.some(
    (param) =>
      normalizeAttributeName(attributeNameFromMetadata(param)) === attr,
  );
}

/**
 * Replays spatial selection clauses in Rust and returns the fixture groups used for timing offsets.
 */
export async function resolvedSelectionTimingIndexes(
  selection: types.SpatialSelection,
): Promise<SelectionTimingIndex[]> {
  if (selection.source.type !== "Resolved") return [{ members: [] }];
  if (selection.source.data.length === 0) return [{ members: [] }];

  const projected = await spatialProjectionProjector(selection);
  const indexes = projected?.resolved.indexes ?? [];
  const timingIndexes = indexes
    .map((index) => ({
      members: index.members.map((member) => ({ ...member.fixture })),
    }))
    .filter((index) => index.members.length > 0);

  return timingIndexes.length > 0 ? timingIndexes : [{ members: [] }];
}

/**
 * Finds the timing offset for a fixture attribute within a spatial selection.
 */
export async function selectionTimingPositionForFixtureAttribute(
  selection: types.SpatialSelection,
  fixturesByUid: ReadonlyMap<string, types.Fixture>,
  fixtureUid: string,
  attr: string,
): Promise<SelectionTimingPosition> {
  const resolvedIndexes = await resolvedSelectionTimingIndexes(selection);
  const total = Math.max(1, resolvedIndexes.length);
  let firstFixtureOffset: number | undefined;

  for (const [offset, index] of resolvedIndexes.entries()) {
    for (const ref of index.members) {
      if (!sameFixtureUid(ref.fixture_uid, fixtureUid)) continue;
      firstFixtureOffset ??= offset;
      if (
        selectedElementHasAttribute(
          fixturesByUid.get(fixtureUid),
          ref.index ?? null,
          attr,
        )
      ) {
        return { offset, total };
      }
    }
  }

  return { offset: firstFixtureOffset ?? 0, total };
}

/** Lists normalized attribute names written by a cue instruction. */
function attributesForInstruction(instruction: types.CueInstruction): string[] {
  return Object.keys(instruction.values ?? {}).map(normalizeAttributeName);
}

/** Resolves cue part timing with parent cue timing underneath part overrides. */
function inheritPartTransitions(
  cueTransitions: types.PartialTransition,
  partTransitions: types.PartialTransition,
): types.PartialTransition {
  return {
    delay_in: partTransitions.delay_in ?? cueTransitions.delay_in,
    fade_in: partTransitions.fade_in ?? cueTransitions.fade_in,
    curve_in: partTransitions.curve_in ?? cueTransitions.curve_in,
    delay_out: partTransitions.delay_out ?? cueTransitions.delay_out,
    fade_out: partTransitions.fade_out ?? cueTransitions.fade_out,
    curve_out: partTransitions.curve_out ?? cueTransitions.curve_out,
  };
}

/**
 * Calculates the longest in, out, and total transition durations represented by a cue.
 */
export async function calculateCueTransitionDurations(
  cue: types.Cue | undefined,
): Promise<CueTransitionDurations> {
  const durations: CueTransitionDurations = {
    delayIn: 0,
    fadeIn: 0,
    delayOut: 0,
    fadeOut: 0,
    inDuration: 0,
    outDuration: 0,
    totalDuration: 0,
  };
  if (!cue) return durations;

  const transitionResolver = createTransitionModeResolver();

  const accumulateInstructionDurations = async (
    items: readonly types.BoundCueInstruction[],
    transitions: types.PartialTransition,
    transitionsByAttribute: types.AttributeTransitions,
  ) => {
    const timingCue = {
      ...cue,
      transitions,
      transitions_by_attribute: transitionsByAttribute,
    };

    for (const item of items) {
      const instruction = item.cue_instruction;
      const attrs = attributesForInstruction(instruction);
      const timingIndexes = await resolvedSelectionTimingIndexes(
        item.selection,
      );
      const selectionSize = Math.max(1, timingIndexes.length);
      const durationUpdates: Promise<void>[] = [];

      for (const [offset, timingIndex] of timingIndexes.entries()) {
        if (attrs.length === 0) {
          durationUpdates.push(
            Promise.all([
              transitionResolver.resolve(
                instruction.transitions.delay_in ?? transitions.delay_in,
                offset,
                selectionSize,
              ),
              transitionResolver.resolve(
                instruction.transitions.fade_in ?? transitions.fade_in,
                offset,
                selectionSize,
              ),
              transitionResolver.resolve(
                instruction.transitions.delay_out ?? transitions.delay_out,
                offset,
                selectionSize,
              ),
              transitionResolver.resolve(
                instruction.transitions.fade_out ?? transitions.fade_out,
                offset,
                selectionSize,
              ),
            ]).then(([delayIn, fadeIn, delayOut, fadeOut]) => {
              updateMaxDurations(durations, delayIn, fadeIn, delayOut, fadeOut);
            }),
          );
          continue;
        }

        for (const attr of attrs) {
          const fixtureRefs =
            timingIndex.members.length > 0 ? timingIndex.members : [undefined];
          for (const fixtureRef of fixtureRefs) {
            durationUpdates.push(
              Promise.all([
                resolveCueInstructionTiming(
                  transitionResolver,
                  timingCue,
                  instruction,
                  attr,
                  "delay_in",
                  offset,
                  selectionSize,
                  fixtureRef,
                ),
                resolveCueInstructionTiming(
                  transitionResolver,
                  timingCue,
                  instruction,
                  attr,
                  "fade_in",
                  offset,
                  selectionSize,
                  fixtureRef,
                ),
                resolveCueInstructionTiming(
                  transitionResolver,
                  timingCue,
                  instruction,
                  attr,
                  "delay_out",
                  offset,
                  selectionSize,
                  fixtureRef,
                ),
                resolveCueInstructionTiming(
                  transitionResolver,
                  timingCue,
                  instruction,
                  attr,
                  "fade_out",
                  offset,
                  selectionSize,
                  fixtureRef,
                ),
              ]).then(([delayIn, fadeIn, delayOut, fadeOut]) => {
                updateMaxDurations(
                  durations,
                  delayIn.value,
                  fadeIn.value,
                  delayOut.value,
                  fadeOut.value,
                );
              }),
            );
          }
        }
      }

      await Promise.all(durationUpdates);
    }
  };

  await accumulateInstructionDurations(
    cue.instructions ?? [],
    cue.transitions,
    cue.transitions_by_attribute,
  );
  for (const part of cue.parts ?? []) {
    await accumulateInstructionDurations(
      part.instructions ?? [],
      inheritPartTransitions(cue.transitions, part.transitions),
      part.transitions_by_attribute,
    );
  }

  const hasInstructions =
    (cue.instructions ?? []).length > 0 ||
    (cue.parts ?? []).some((part) => (part.instructions ?? []).length > 0);
  if (!hasInstructions) {
    const [delayIn, fadeIn, delayOut, fadeOut] = await Promise.all([
      transitionResolver.resolve(cue.transitions.delay_in),
      transitionResolver.resolve(cue.transitions.fade_in),
      transitionResolver.resolve(cue.transitions.delay_out),
      transitionResolver.resolve(cue.transitions.fade_out),
    ]);
    updateMaxDurations(durations, delayIn, fadeIn, delayOut, fadeOut);
  }

  return durations;
}

/** Updates accumulated maxima with one resolved delay/fade tuple. */
function updateMaxDurations(
  durations: CueTransitionDurations,
  delayIn: number,
  fadeIn: number,
  delayOut: number,
  fadeOut: number,
) {
  const inDuration = delayIn + fadeIn;
  if (inDuration > durations.inDuration) {
    durations.delayIn = delayIn;
    durations.fadeIn = fadeIn;
    durations.inDuration = inDuration;
  }

  const outDuration = delayOut + fadeOut;
  if (outDuration > durations.outDuration) {
    durations.delayOut = delayOut;
    durations.fadeOut = fadeOut;
    durations.outDuration = outDuration;
  }

  durations.totalDuration = Math.max(
    durations.totalDuration,
    durations.inDuration,
    durations.outDuration,
  );
}

/** Adds or replaces a fixture-specific transition mode for one instruction attribute. */
export function upsertInstructionFixtureAttributeTiming(
  instruction: types.CueInstruction,
  fixtureRef: types.FixtureRef,
  attr: string,
  field: TimingField,
  mode: types.TransitionMode,
) {
  instruction.transitions_by_fixture_attribute ??= [];
  let fixtureTransition = instruction.transitions_by_fixture_attribute.find(
    (entry) => sameFixtureRef(entry.fixture, fixtureRef),
  );
  if (!fixtureTransition) {
    fixtureTransition = {
      fixture: fixtureRef,
      transitions_by_attribute: {},
    };
    instruction.transitions_by_fixture_attribute.push(fixtureTransition);
  }
  fixtureTransition.transitions_by_attribute[attr] ??= {};
  fixtureTransition.transitions_by_attribute[attr][field] = mode;
}

/** Deletes an instruction-level attribute timing override and prunes empty entries. */
export function deleteInstructionAttributeTiming(
  instruction: types.CueInstruction,
  attr: string,
  field: TimingField,
) {
  const transitions = instruction.transitions_by_attribute;
  if (!transitions) return;
  const keys = Object.keys(transitions).filter(
    (key) => key === attr || normalizeAttributeName(key) === attr,
  );

  for (const key of keys) {
    delete transitions[key][field];
    if (Object.keys(transitions[key]).length === 0) {
      delete transitions[key];
    }
  }
}

/** Deletes a fixture-specific attribute timing override and prunes empty entries. */
export function deleteInstructionFixtureAttributeTiming(
  instruction: types.CueInstruction,
  fixtureRef: types.FixtureRef,
  attr: string,
  field: TimingField,
) {
  const transitions = instruction.transitions_by_fixture_attribute;
  if (!transitions) return;
  const exactMatch = transitions.some((entry) =>
    sameFixtureRef(entry.fixture, fixtureRef),
  );
  const fixtureWideRef = fixtureWideRefFor(fixtureRef);

  for (const entry of transitions) {
    const matches = exactMatch
      ? sameFixtureRef(entry.fixture, fixtureRef)
      : sameFixtureRef(entry.fixture, fixtureWideRef);
    if (!matches) continue;
    const keys = Object.keys(entry.transitions_by_attribute).filter(
      (key) => key === attr || normalizeAttributeName(key) === attr,
    );
    for (const key of keys) {
      delete entry.transitions_by_attribute[key][field];
      if (Object.keys(entry.transitions_by_attribute[key]).length === 0) {
        delete entry.transitions_by_attribute[key];
      }
    }
  }

  instruction.transitions_by_fixture_attribute = transitions.filter(
    (entry) => Object.keys(entry.transitions_by_attribute).length > 0,
  );
}
