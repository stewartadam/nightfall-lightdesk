// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

interface ReleaseCueTimingSources {
  byProjectionKey: Map<string, types.CueInstruction[]>;
  byFixtureAttribute: Map<string, types.PartialTransition[]>;
}

/** Returns a structured clone suitable for mutating store payloads. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Checks whether a cue contains any parent or part instruction rows. */
export function hasCueInstructionRows(cue: types.Cue): boolean {
  return (
    cue.instructions.length > 0 ||
    (cue.parts ?? []).some((part) => part.instructions.length > 0)
  );
}

/** Checks whether an instruction writes at least one parameter value. */
function instructionWritesValues(
  instruction: types.BoundCueInstruction,
): boolean {
  return Object.keys(instruction.cue_instruction.values ?? {}).length > 0;
}

/** Returns normalized attribute names written by an instruction. */
function instructionAttributes(
  instruction: types.BoundCueInstruction,
): string[] {
  return Object.keys(instruction.cue_instruction.values ?? {}).sort();
}

/** Builds a stable matching key for timing overrides copied between projections. */
function instructionProjectionKey(
  instruction: types.BoundCueInstruction,
  scope: string,
): string {
  return JSON.stringify({
    scope,
    selection: instruction.selection,
    attrs: instructionAttributes(instruction),
  });
}

/** Builds a stable matching key for one fixture and attribute timing override. */
function fixtureAttributeTimingKey(
  fixture: types.FixtureRef,
  attr: string,
): string {
  return JSON.stringify({
    fixture_uid: fixture.fixture_uid,
    index: fixture.index ?? null,
    attr,
  });
}

/** Adds one timing override row to the matching-key index. */
function addTimingSource(
  sources: ReleaseCueTimingSources,
  instruction: types.BoundCueInstruction,
  scope: string,
) {
  const key = instructionProjectionKey(instruction, scope);
  const values = sources.byProjectionKey.get(key) ?? [];
  values.push(instruction.cue_instruction);
  sources.byProjectionKey.set(key, values);

  for (const entry of instruction.cue_instruction
    .transitions_by_fixture_attribute ?? []) {
    for (const [attr, transition] of Object.entries(
      entry.transitions_by_attribute,
    )) {
      const fixtureAttributeKey = fixtureAttributeTimingKey(
        entry.fixture,
        attr,
      );
      const fixtureValues =
        sources.byFixtureAttribute.get(fixtureAttributeKey) ?? [];
      fixtureValues.push(transition);
      sources.byFixtureAttribute.set(fixtureAttributeKey, fixtureValues);
    }
  }
}

/** Indexes stored release cue timings by projected row identity and fixture attribute. */
function timingSourcesForReleaseCue(cue: types.Cue): ReleaseCueTimingSources {
  const sources: ReleaseCueTimingSources = {
    byProjectionKey: new Map<string, types.CueInstruction[]>(),
    byFixtureAttribute: new Map<string, types.PartialTransition[]>(),
  };
  for (const instruction of cue.instructions) {
    addTimingSource(sources, instruction, "parent");
  }
  for (const part of cue.parts ?? []) {
    const scope = `part:${part.identifiers.id}`;
    for (const instruction of part.instructions) {
      addTimingSource(sources, instruction, scope);
    }
  }
  return sources;
}

/** Returns the next stored timing source matching one projected row. */
function consumeTimingSource(
  sources: ReleaseCueTimingSources,
  instruction: types.BoundCueInstruction,
  scope: string,
): types.CueInstruction | undefined {
  const key = instructionProjectionKey(instruction, scope);
  const values = sources.byProjectionKey.get(key);
  return values?.shift();
}

/** Returns the resolved fixture refs directly stored on an instruction selection. */
function resolvedFixtureRefs(
  instruction: types.BoundCueInstruction,
): types.FixtureRef[] {
  return instruction.selection.source.type === "Resolved"
    ? instruction.selection.source.data
    : [];
}

/** Returns fallback fixture timings that still apply after a projected row identity changes. */
function consumeFallbackFixtureAttributeTimings(
  sources: ReleaseCueTimingSources,
  instruction: types.BoundCueInstruction,
): types.FixtureAttributeTransition[] {
  const attrs = instructionAttributes(instruction);
  return resolvedFixtureRefs(instruction)
    .map((fixture) => {
      const transitionsByAttribute = Object.fromEntries(
        attrs.flatMap((attr) => {
          const timings = sources.byFixtureAttribute.get(
            fixtureAttributeTimingKey(fixture, attr),
          );
          const timing = timings?.shift();
          return timing ? [[attr, clone(timing)]] : [];
        }),
      );
      return {
        fixture: clone(fixture),
        transitions_by_attribute: transitionsByAttribute,
      };
    })
    .filter((entry) => Object.keys(entry.transitions_by_attribute).length > 0);
}

/** Returns a JSON-safe value with stable object key ordering. */
function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }
  return value;
}

/** Serializes a value with stable object key ordering. */
function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

/** Returns the non-empty transition fields in a deterministic shape. */
function normalizedPartialTransition(
  transition: types.PartialTransition | undefined,
): types.PartialTransition {
  return Object.fromEntries(
    Object.entries(transition ?? {}).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  ) as types.PartialTransition;
}

/** Returns whether a transition override has any defined fields. */
function hasTransitionFields(transition: types.PartialTransition): boolean {
  return Object.keys(transition).length > 0;
}

/** Normalizes attribute transition overrides for stable semantic comparison. */
function normalizedAttributeTransitions(
  transitions: types.AttributeTransitions | undefined,
): types.AttributeTransitions {
  const normalizedEntries: [string, types.PartialTransition][] = Object.entries(
    transitions ?? {},
  )
    .map(
      ([attribute, transition]) =>
        [attribute, normalizedPartialTransition(transition)] as [
          string,
          types.PartialTransition,
        ],
    )
    .filter(([, transition]) => hasTransitionFields(transition));

  return Object.fromEntries(
    normalizedEntries.sort((left, right) => left[0].localeCompare(right[0])),
  ) as types.AttributeTransitions;
}

/** Normalizes per-fixture timing overrides for stable semantic comparison. */
function normalizedFixtureAttributeTransitions(
  transitions: types.FixtureAttributeTransition[] | undefined,
): types.FixtureAttributeTransition[] {
  return (transitions ?? [])
    .map((fixtureTransition) => ({
      fixture: stableJsonValue(fixtureTransition.fixture) as types.FixtureRef,
      transitions_by_attribute: normalizedAttributeTransitions(
        fixtureTransition.transitions_by_attribute,
      ),
    }))
    .filter(
      (fixtureTransition) =>
        Object.keys(fixtureTransition.transitions_by_attribute).length > 0,
    )
    .sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right)),
    );
}

/** Builds a normalized signature for one projected release cue instruction row. */
function releaseInstructionProjectionSignature(
  instruction: types.BoundCueInstruction,
) {
  return {
    selection: stableJsonValue(instruction.selection),
    values: stableJsonValue(instruction.cue_instruction.values ?? {}),
    transitions: normalizedPartialTransition(
      instruction.cue_instruction.transitions,
    ),
    transitions_by_attribute: normalizedAttributeTransitions(
      instruction.cue_instruction.transitions_by_attribute,
    ),
    transitions_by_fixture_attribute: normalizedFixtureAttributeTransitions(
      instruction.cue_instruction.transitions_by_fixture_attribute,
    ),
  };
}

/** Builds a normalized signature for one projected release cue part. */
function releasePartProjectionSignature(part: types.CuePart) {
  return {
    identifiers: stableJsonValue(part.identifiers),
    transitions: normalizedPartialTransition(part.transitions),
    transitions_by_attribute: normalizedAttributeTransitions(
      part.transitions_by_attribute,
    ),
    instructions: part.instructions.map(releaseInstructionProjectionSignature),
    tracking_flags: part.tracking_flags,
  };
}

/** Builds the stable semantic signature used to decide whether projection persistence is needed. */
export function releaseCueProjectionSignature(cue: types.Cue): string {
  return stableStringify({
    identifiers: cue.identifiers,
    trigger: cue.trigger,
    transitions: normalizedPartialTransition(cue.transitions),
    transitions_by_attribute: normalizedAttributeTransitions(
      cue.transitions_by_attribute,
    ),
    instructions: cue.instructions.map(releaseInstructionProjectionSignature),
    parts: (cue.parts ?? []).map(releasePartProjectionSignature),
    tracking_flags: cue.tracking_flags,
  });
}

/** Builds a release-cue instruction row from a normal cue instruction. */
function releaseInstructionFrom(
  instruction: types.BoundCueInstruction,
): types.BoundCueInstruction {
  return {
    selection: clone(instruction.selection),
    cue_instruction: {
      values: clone(instruction.cue_instruction.values ?? {}),
      transitions: {},
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/** Builds a stable synthetic identifier for a release cue part derived from a source part. */
function releasePartIdentifiers(
  releaseCueUid: string,
  sourcePart: types.CuePart,
): types.Identifiers {
  return {
    id: sourcePart.identifiers.id,
    uid: `${releaseCueUid}:part:${sourcePart.identifiers.id}`,
    label: sourcePart.identifiers.label,
  };
}

/** Builds a release cue part corresponding to a source cue part ID. */
function releasePartFromSourcePart(
  releaseCueUid: string,
  releasePartSource: types.CuePart | undefined,
  sourcePart: types.CuePart,
): types.CuePart {
  return {
    identifiers:
      releasePartSource?.identifiers ??
      releasePartIdentifiers(releaseCueUid, sourcePart),
    transitions: clone(releasePartSource?.transitions ?? {}),
    transitions_by_attribute: clone(
      releasePartSource?.transitions_by_attribute ?? {},
    ),
    instructions: [],
    tracking_flags:
      releasePartSource?.tracking_flags ?? sourcePart.tracking_flags,
  };
}

/** Builds the release cue shell whose cue-wide timing is inherited by projected rows. */
function releaseCueShellFromStoredReleaseCue(storedReleaseCue: types.Cue) {
  const releaseCue = clone(storedReleaseCue);
  releaseCue.instructions = [];
  releaseCue.parts = [];
  return releaseCue;
}

/** Applies stored fixture timing overrides to one freshly projected release row. */
function applyStoredTimingOverridesToInstruction(
  sources: ReleaseCueTimingSources,
  instruction: types.BoundCueInstruction,
  scope: string,
) {
  const timingSource = consumeTimingSource(sources, instruction, scope);
  instruction.cue_instruction.transitions_by_fixture_attribute = clone(
    timingSource?.transitions_by_fixture_attribute?.length
      ? timingSource.transitions_by_fixture_attribute
      : consumeFallbackFixtureAttributeTimings(sources, instruction),
  );
}

/** Applies stored release cue timing overrides after fresh projection is complete. */
function applyStoredTimingOverrides(
  releaseCue: types.Cue,
  storedReleaseCue: types.Cue,
) {
  const timingSources = timingSourcesForReleaseCue(storedReleaseCue);
  for (const instruction of releaseCue.instructions) {
    applyStoredTimingOverridesToInstruction(
      timingSources,
      instruction,
      "parent",
    );
  }
  for (const part of releaseCue.parts ?? []) {
    const scope = `part:${part.identifiers.id}`;
    for (const instruction of part.instructions) {
      applyStoredTimingOverridesToInstruction(
        timingSources,
        instruction,
        scope,
      );
    }
  }
}

/**
 * Projects release cue instruction rows from the sequence's asserted cue parameters.
 *
 * The copied values identify the fixture attributes that can receive release
 * timing overrides. Source cue transition data is intentionally ignored. The
 * projection keeps the stored release cue shell so rows inherit cue-wide and
 * part-wide release timing, then reapplies stored fixture timing overrides that
 * still match the projected rows.
 */
export function projectReleaseCueFromSequence(
  sequence: types.Sequence,
  cueMap: Readonly<Record<string, types.Cue>>,
): types.Cue {
  const releaseCue = releaseCueShellFromStoredReleaseCue(sequence.release_cue);

  for (const cueUid of sequence.steps) {
    const cue = cueMap[cueUid];
    if (!cue) continue;

    for (const instruction of cue.instructions) {
      if (!instructionWritesValues(instruction)) continue;
      releaseCue.instructions.push(releaseInstructionFrom(instruction));
    }

    for (const part of cue.parts ?? []) {
      const releasePartSource = sequence.release_cue.parts?.find(
        (candidate) => candidate.identifiers.id === part.identifiers.id,
      );
      const releasePart = releasePartFromSourcePart(
        releaseCue.identifiers.uid,
        releasePartSource,
        part,
      );
      for (const instruction of part.instructions) {
        if (!instructionWritesValues(instruction)) continue;
        releasePart.instructions.push(releaseInstructionFrom(instruction));
      }
      releaseCue.parts ??= [];
      releaseCue.parts.push(releasePart);
    }
  }

  applyStoredTimingOverrides(releaseCue, sequence.release_cue);

  return releaseCue;
}
