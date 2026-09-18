// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import type {
  Attribute,
  FxDirection,
  FxTrack,
  StepFxCycleScale,
  StepFxPreviewPlaybackStatus,
} from "../../../types";
import type { StepFxPositionUnit } from "./step-fx-editor-model";
import type { StepFxPreviewTrackKind } from "./step-fx-preview-clock";

/** Keyboard modifiers applied when selecting an authored step from the waveform. */
export interface StepFxWaveformSelectionModifiers {
  extend: boolean;
  toggle: boolean;
}

/** Identifies the editor field currently controlled by a waveform drag. */
export type StepFxWaveformDragTarget =
  | { kind: "start-position" }
  | { kind: "spread" }
  | {
      kind: "control-point";
      stepUid: string;
      point: "ramp-start" | "ramp-end";
    }
  | {
      kind: "width";
      stepUids: readonly [string, ...string[]];
      resizeCycle: boolean;
    };

export interface StepFxWaveformProps {
  track: FxTrack;
  direction: FxDirection;
  previewActive: boolean;
  previewStatus?: StepFxPreviewPlaybackStatus;
  beatDurationSeconds: number;
  attribute: Attribute;
  trackKind: StepFxPreviewTrackKind;
  selectionPhaseOffset: number;
  selectionPhaseOffsets: readonly number[];
  selectionSpread: number;
  selectionPhaseWrapsCycle: boolean;
  selectionLabels: readonly string[];
  previewIndex: number;
  showAllPlayheads: boolean;
  centerSelectedFixture: boolean;
  positionUnit: StepFxPositionUnit;
  cycleScale: StepFxCycleScale;
  selectedStepUids: ReadonlySet<string>;
  titleControls?: (samplingWarning: JSX.Element) => JSX.Element;
  onLiveStepChange?: (stepUid: string | undefined) => void;
  onStepSelect: (
    stepUid: string,
    modifiers: StepFxWaveformSelectionModifiers,
  ) => void;
  onDragTargetChange?: (target: StepFxWaveformDragTarget | undefined) => void;
  onStepControlPointChange: (
    stepUid: string,
    point: "ramp-start" | "ramp-end",
    transitionPosition: number,
    value?: number,
  ) => void;
  onStepWidthChange: (stepUid: string, widthBeats: number) => void;
  onStepBoundaryChange: (
    leadingStepUid: string,
    trailingStepUid: string,
    leadingWidthBeats: number,
    trailingWidthBeats: number,
  ) => void;
  onStartPositionChange: (selectionPhaseOffset: number) => void;
  onSpreadChange: (spread: number) => void;
}
