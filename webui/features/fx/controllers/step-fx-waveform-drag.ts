// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, onCleanup } from "solid-js";
import {
  stepFxPositionUnitScale,
  stepFxPositionUnitSuffix,
} from "../model/step-fx-editor-model";
import {
  type StepFxWaveformModel,
  type StepFxWaveformSegment,
  snapStepFxWaveformValue,
} from "../model/step-fx-waveform-model";

import {
  clamp,
  directionalPhaseDelta,
  draggedPhaseOffset,
  formatWaveformValue,
  leadingSegmentIndex,
  PLOT_HEIGHT,
  PLOT_LEFT,
  PLOT_WIDTH,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from "../model/step-fx-waveform-plot";
import type {
  StepFxWaveformDragTarget,
  StepFxWaveformProps,
} from "../model/step-fx-waveform-types";

const MIN_DRAGGED_STEP_WIDTH_BEATS = 0.01;
interface StepFxWaveformDragSession {
  pointerId: number;
  target: StepFxWaveformDragTarget;
  cycleBounds: DOMRect;
  model: StepFxWaveformModel;
  selectionPhaseOffset: number;
  selectionSpread: number;
  controlSegment?: StepFxWaveformSegment;
  pointerStartPosition: { x: number; y: number };
  leadingStepStartBeat?: number;
  leadingStepWidthBeats?: number;
  combinedStepWidthBeats?: number;
}

interface StepFxWaveformDragLabel {
  text: string;
  left: string;
  top: string;
}

type StepFxWaveformDragOptions = Pick<
  StepFxWaveformProps,
  | "previewActive"
  | "centerSelectedFixture"
  | "direction"
  | "positionUnit"
  | "selectionPhaseOffset"
  | "selectionSpread"
  | "onDragTargetChange"
  | "onStepControlPointChange"
  | "onStepWidthChange"
  | "onStepBoundaryChange"
  | "onStartPositionChange"
  | "onSpreadChange"
>;

/** Owns a captured geometry snapshot and pointer listeners for one waveform edit. */
export function createStepFxWaveformDrag(props: StepFxWaveformDragOptions) {
  const [activeDragTarget, setActiveDragTarget] =
    createSignal<StepFxWaveformDragTarget>();
  const [dragLabel, setDragLabel] = createSignal<StepFxWaveformDragLabel>();
  let dragSession: StepFxWaveformDragSession | undefined;
  /** Disables geometry editing while a running preview translates the waveform. */
  const dragEditingDisabled = (): boolean =>
    props.previewActive && props.centerSelectedFixture;

  /** Publishes drag ownership to the waveform and its corresponding sheet field. */
  const setDragTarget = (
    target: StepFxWaveformDragTarget | undefined,
  ): void => {
    setActiveDragTarget(target);
    props.onDragTargetChange?.(target);
  };

  /** Converts a pointer position into the fixed SVG viewbox used by one cycle. */
  const dragViewPosition = (
    event: PointerEvent,
    session: StepFxWaveformDragSession,
  ): { x: number; y: number } => ({
    x:
      ((event.clientX - session.cycleBounds.left) / session.cycleBounds.width) *
      VIEW_WIDTH,
    y:
      ((event.clientY - session.cycleBounds.top) / session.cycleBounds.height) *
      VIEW_HEIGHT,
  });

  /** Places the active value label near the pointer without clipping it at plot edges. */
  const updateDragLabel = (
    text: string,
    position: { x: number; y: number },
  ): void => {
    setDragLabel({
      text,
      left: `${clamp((position.x / VIEW_WIDTH) * 100, 8, 92)}%`,
      top: `${clamp((position.y / VIEW_HEIGHT) * 100, 18, 92)}%`,
    });
  };

  /** Shows the captured field's current value before the pointer has moved. */
  const showInitialDragLabel = (session: StepFxWaveformDragSession): void => {
    const position = session.pointerStartPosition;
    if (session.target.kind === "control-point" && session.controlSegment) {
      const segment = session.controlSegment;
      const stepWidth = segment.endBeat - segment.startBeat;
      const transitionPosition =
        session.target.point === "ramp-start"
          ? (segment.transitionStartBeat - segment.startBeat) / stepWidth
          : (segment.transitionEndBeat - segment.startBeat) / stepWidth;
      updateDragLabel(
        session.target.point === "ramp-start"
          ? `Step ${segment.stepIndex + 1} ramp start: ${formatWaveformValue(transitionPosition * 100)}%`
          : `Step ${segment.stepIndex + 1} ramp end: ${formatWaveformValue(transitionPosition * 100)}% · Value: ${formatWaveformValue(segment.targetValue * 100)}%`,
        position,
      );
      return;
    }
    if (session.target.kind === "width") {
      const leadingWidth = session.leadingStepWidthBeats ?? 0;
      const leadingIndex = leadingSegmentIndex(
        session.model,
        session.target.stepUids[0],
      );
      const trailingWidth =
        (session.combinedStepWidthBeats ?? leadingWidth) - leadingWidth;
      updateDragLabel(
        session.target.resizeCycle
          ? `Step ${leadingIndex + 1} width: ${formatWaveformValue(leadingWidth)} beats`
          : `Step ${leadingIndex + 1}: ${formatWaveformValue(leadingWidth)} beats · Step ${leadingIndex + 2}: ${formatWaveformValue(trailingWidth)} beats`,
        position,
      );
      return;
    }
    const scale = stepFxPositionUnitScale(props.positionUnit);
    const suffix = stepFxPositionUnitSuffix(props.positionUnit);
    updateDragLabel(
      session.target.kind === "spread"
        ? `Spread: ${formatWaveformValue(session.selectionSpread * scale)}${suffix}`
        : `Start: ${formatWaveformValue(session.selectionPhaseOffset * scale)}${suffix}`,
      position,
    );
  };

  /** Applies one captured pointer movement to its authored field. */
  const updateWaveformDrag = (event: PointerEvent): void => {
    const session = dragSession;
    if (!session || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    const position = dragViewPosition(event, session);
    if (session.target.kind === "control-point") {
      const segment = session.controlSegment;
      if (!segment) return;
      const stepWidth = segment.endBeat - segment.startBeat;
      const initialTransitionBeat =
        session.target.point === "ramp-start"
          ? segment.transitionStartBeat
          : segment.transitionEndBeat;
      const oppositeTransitionPosition =
        session.target.point === "ramp-start"
          ? (segment.transitionEndBeat - segment.startBeat) / stepWidth
          : (segment.transitionStartBeat - segment.startBeat) / stepWidth;
      const draggedTransitionPosition =
        (initialTransitionBeat -
          segment.startBeat +
          ((position.x - session.pointerStartPosition.x) / PLOT_WIDTH) *
            session.model.totalBeats) /
        stepWidth;
      const transitionPosition =
        session.target.point === "ramp-start"
          ? clamp(draggedTransitionPosition, 0, oppositeTransitionPosition)
          : clamp(draggedTransitionPosition, oppositeTransitionPosition, 1);
      const value =
        session.target.point === "ramp-end"
          ? snapStepFxWaveformValue(
              session.model,
              segment.targetValue -
                ((position.y - session.pointerStartPosition.y) / PLOT_HEIGHT) *
                  (session.model.maximumValue - session.model.minimumValue),
            )
          : undefined;
      props.onStepControlPointChange(
        session.target.stepUid,
        session.target.point,
        transitionPosition,
        value,
      );
      updateDragLabel(
        session.target.point === "ramp-start"
          ? `Step ${segment.stepIndex + 1} ramp start: ${formatWaveformValue(transitionPosition * 100)}%`
          : `Step ${segment.stepIndex + 1} ramp end: ${formatWaveformValue(transitionPosition * 100)}% · Value: ${formatWaveformValue((value ?? segment.targetValue) * 100)}%`,
        position,
      );
      return;
    }
    if (session.target.kind === "width") {
      const startBeat = session.leadingStepStartBeat;
      const leadingStepWidth = session.leadingStepWidthBeats;
      const combinedWidth = session.combinedStepWidthBeats;
      if (
        startBeat === undefined ||
        leadingStepWidth === undefined ||
        combinedWidth === undefined
      )
        return;
      const pointerPosition = clamp(
        (position.x - PLOT_LEFT) / PLOT_WIDTH,
        0,
        session.target.resizeCycle ? 0.995 : 1,
      );
      if (session.target.resizeCycle) {
        const fixedCycleWidth = session.model.totalBeats - leadingStepWidth;
        const minimumWidth = Math.min(
          MIN_DRAGGED_STEP_WIDTH_BEATS,
          leadingStepWidth / 2,
        );
        const width = Math.max(
          minimumWidth,
          (pointerPosition * fixedCycleWidth - startBeat) /
            (1 - pointerPosition),
        );
        props.onStepWidthChange(session.target.stepUids[0], width);
        updateDragLabel(
          `Step ${leadingSegmentIndex(session.model, session.target.stepUids[0]) + 1} width: ${formatWaveformValue(width)} beats`,
          position,
        );
        return;
      }
      const pointerBeat = pointerPosition * session.model.totalBeats;
      const minimumWidth = Math.min(
        MIN_DRAGGED_STEP_WIDTH_BEATS,
        combinedWidth / 4,
      );
      const leadingWidth = clamp(
        pointerBeat - startBeat,
        minimumWidth,
        combinedWidth - minimumWidth,
      );
      props.onStepBoundaryChange(
        session.target.stepUids[0],
        session.target.stepUids[1],
        leadingWidth,
        combinedWidth - leadingWidth,
      );
      const leadingIndex = leadingSegmentIndex(
        session.model,
        session.target.stepUids[0],
      );
      updateDragLabel(
        `Step ${leadingIndex + 1}: ${formatWaveformValue(leadingWidth)} beats · Step ${leadingIndex + 2}: ${formatWaveformValue(combinedWidth - leadingWidth)} beats`,
        position,
      );
      return;
    }
    if (session.target.kind === "spread") {
      const pointerDelta =
        (position.x - session.pointerStartPosition.x) / PLOT_WIDTH;
      const spread =
        session.selectionSpread +
        directionalPhaseDelta(
          pointerDelta,
          session.selectionPhaseOffset,
          props.direction,
        );
      props.onSpreadChange(spread);
      updateDragLabel(
        `Spread: ${formatWaveformValue(spread * stepFxPositionUnitScale(props.positionUnit))}${stepFxPositionUnitSuffix(props.positionUnit)}`,
        position,
      );
      return;
    }
    const authoredPosition = clamp((position.x - PLOT_LEFT) / PLOT_WIDTH, 0, 1);
    const startPosition = draggedPhaseOffset(
      authoredPosition,
      session.selectionPhaseOffset,
      props.direction,
    );
    props.onStartPositionChange(startPosition);
    updateDragLabel(
      `Start: ${formatWaveformValue(startPosition * stepFxPositionUnitScale(props.positionUnit))}${stepFxPositionUnitSuffix(props.positionUnit)}`,
      position,
    );
  };

  /** Finishes the current drag and removes its window-level pointer listeners. */
  const finishWaveformDrag = (event?: PointerEvent): void => {
    if (event && event.pointerId !== dragSession?.pointerId) return;
    dragSession = undefined;
    window.removeEventListener("pointermove", updateWaveformDrag);
    window.removeEventListener("pointerup", finishWaveformDrag);
    window.removeEventListener("pointercancel", finishWaveformDrag);
    setDragTarget(undefined);
    setDragLabel(undefined);
  };

  /** Captures a stable geometry snapshot before reactive draft updates begin. */
  const startWaveformDrag = (
    event: PointerEvent,
    target: StepFxWaveformDragTarget,
    waveform: StepFxWaveformModel,
    leadingSegment?: StepFxWaveformSegment,
    trailingSegment?: StepFxWaveformSegment,
  ): void => {
    if (dragEditingDisabled() || dragSession || event.button !== 0) return;
    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof Element)) return;
    const cycle = currentTarget.closest<HTMLElement>(
      "[data-step-fx-waveform-cycle]",
    );
    if (!cycle) return;
    event.preventDefault();
    event.stopPropagation();
    const dragTarget: StepFxWaveformDragTarget =
      target.kind === "width"
        ? {
            ...target,
            resizeCycle: event.shiftKey,
            stepUids: event.shiftKey ? [target.stepUids[0]] : target.stepUids,
          }
        : target.kind === "start-position" && event.shiftKey
          ? { kind: "spread" }
          : target;
    const cycleBounds = cycle.getBoundingClientRect();
    dragSession = {
      pointerId: event.pointerId,
      target: dragTarget,
      cycleBounds,
      model: waveform,
      selectionPhaseOffset: props.selectionPhaseOffset,
      selectionSpread: props.selectionSpread,
      controlSegment:
        dragTarget.kind === "control-point" ? leadingSegment : undefined,
      pointerStartPosition: {
        x:
          ((event.clientX - cycleBounds.left) / cycleBounds.width) * VIEW_WIDTH,
        y:
          ((event.clientY - cycleBounds.top) / cycleBounds.height) *
          VIEW_HEIGHT,
      },
      leadingStepStartBeat: leadingSegment?.startBeat,
      leadingStepWidthBeats: leadingSegment
        ? leadingSegment.endBeat - leadingSegment.startBeat
        : undefined,
      combinedStepWidthBeats:
        leadingSegment && trailingSegment
          ? leadingSegment.endBeat -
            leadingSegment.startBeat +
            trailingSegment.endBeat -
            trailingSegment.startBeat
          : undefined,
    };
    setDragTarget(dragTarget);
    showInitialDragLabel(dragSession);
    window.addEventListener("pointermove", updateWaveformDrag);
    window.addEventListener("pointerup", finishWaveformDrag);
    window.addEventListener("pointercancel", finishWaveformDrag);
  };

  /** Releases drag ownership and window listeners when the waveform unmounts. */
  onCleanup(() => finishWaveformDrag());
  return {
    activeDragTarget,
    dragLabel,
    dragEditingDisabled,
    startWaveformDrag,
  };
}
