// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

const cloneCue = (cue: types.Cue): types.Cue => JSON.parse(JSON.stringify(cue));

const zeroTransitionMode: types.TransitionMode = {
  type: "Fixed",
  data: { secs: 0, nanos: 0 },
};

/**
 * Builds transition overrides that force a value to establish immediately.
 */
function immediateTransitions(): types.PartialTransition {
  return {
    fade_in: zeroTransitionMode,
    delay_in: zeroTransitionMode,
    fade_out: zeroTransitionMode,
    delay_out: zeroTransitionMode,
  };
}

/**
 * Removes all instruction-specific transition delays while still overriding parent cue timing.
 */
function makeInstructionImmediate(
  instruction: types.BoundCueInstruction,
): void {
  instruction.cue_instruction.transitions = immediateTransitions();
  instruction.cue_instruction.transitions_by_attribute = {};
  instruction.cue_instruction.transitions_by_fixture_attribute = [];
}

/**
 * Resolves cue-part timing through its parent cue before applying sequence defaults.
 */
function inheritPartTransitions(
  cueTransitions: types.PartialTransition,
  partTransitions: types.PartialTransition,
  defaultTiming: types.Transition,
): types.PartialTransition {
  return {
    delay_in:
      partTransitions.delay_in ??
      cueTransitions.delay_in ??
      defaultTiming.delay_in,
    fade_in:
      partTransitions.fade_in ??
      cueTransitions.fade_in ??
      defaultTiming.fade_in,
    curve_in:
      partTransitions.curve_in ??
      cueTransitions.curve_in ??
      defaultTiming.curve_in,
    delay_out:
      partTransitions.delay_out ??
      cueTransitions.delay_out ??
      defaultTiming.delay_out,
    fade_out:
      partTransitions.fade_out ??
      cueTransitions.fade_out ??
      defaultTiming.fade_out,
    curve_out:
      partTransitions.curve_out ??
      cueTransitions.curve_out ??
      defaultTiming.curve_out,
  };
}

/**
 * Sequence payload sent to the backend for sequence-editor preview.
 */
export interface SequencePreviewPayload {
  sequence: types.Sequence;
  cues: types.Cue[];
  position: number;
}

/**
 * Preview timing and tracking options for sequence cue payload construction.
 */
export interface SequencePreviewOptions {
  applyTransitions: boolean;
  trackValues: boolean;
}

/**
 * Builds the cue payload used for previewing a cue in the sequence editor.
 */
export function buildSequencePreviewCue(
  cue: types.Cue,
  defaultTiming: types.Transition | undefined,
  options: { applyTransitions: boolean },
): types.Cue {
  const previewCue = cloneCue(cue);

  if (!options.applyTransitions) {
    previewCue.transitions = {
      ...previewCue.transitions,
      ...immediateTransitions(),
    };
    previewCue.transitions_by_attribute = {};
    for (const instruction of previewCue.instructions) {
      makeInstructionImmediate(instruction);
    }
    for (const part of previewCue.parts ?? []) {
      part.transitions = {
        ...part.transitions,
        ...immediateTransitions(),
      };
      part.transitions_by_attribute = {};
      for (const instruction of part.instructions) {
        makeInstructionImmediate(instruction);
      }
    }
    return previewCue;
  }

  if (!defaultTiming) return previewCue;

  previewCue.transitions = {
    delay_in: previewCue.transitions.delay_in ?? defaultTiming.delay_in,
    fade_in: previewCue.transitions.fade_in ?? defaultTiming.fade_in,
    curve_in: previewCue.transitions.curve_in ?? defaultTiming.curve_in,
    delay_out: previewCue.transitions.delay_out ?? defaultTiming.delay_out,
    fade_out: previewCue.transitions.fade_out ?? defaultTiming.fade_out,
    curve_out: previewCue.transitions.curve_out ?? defaultTiming.curve_out,
  };
  for (const part of previewCue.parts ?? []) {
    part.transitions = inheritPartTransitions(
      previewCue.transitions,
      part.transitions,
      defaultTiming,
    );
  }
  return previewCue;
}

/**
 * Builds the sequence snapshot used for sequence preview.
 */
export function buildSequencePreviewPayload(
  sequence: types.Sequence,
  cueMap: Record<string, types.Cue | undefined>,
  activeCue: types.Cue,
  options: SequencePreviewOptions,
): SequencePreviewPayload {
  const activeIndex = sequence.steps.indexOf(activeCue.identifiers.uid);
  const previewSteps =
    options.trackValues && activeIndex > 0
      ? sequence.steps.slice(0, activeIndex + 1)
      : [activeCue.identifiers.uid];
  const previewCues = previewSteps
    .map((cueUid) =>
      cueUid === activeCue.identifiers.uid ? activeCue : cueMap[cueUid],
    )
    .filter((cue): cue is types.Cue => cue !== undefined)
    .map((cue, index, cues) =>
      buildSequencePreviewCue(cue, sequence.default_timing, {
        applyTransitions: options.applyTransitions && index === cues.length - 1,
      }),
    );

  const previewSequence: types.Sequence = {
    ...sequence,
    steps: previewCues.map((cue) => cue.identifiers.uid),
  };

  return {
    sequence: previewSequence,
    cues: previewCues,
    position: previewCues.length,
  };
}
