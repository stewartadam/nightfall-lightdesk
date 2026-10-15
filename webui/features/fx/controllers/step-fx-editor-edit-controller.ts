// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor } from "solid-js";
import { getAttributeMetadata } from "../../../lib/attribute-metadata";
import {
  ClipboardUnavailableError,
  readClipboardText,
  writeClipboardText,
} from "../../../lib/clipboard";
import { getLogger } from "../../../lib/logger";
import { createShowObjectUid } from "../../../lib/sequence-factory";
import { pushToast } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  createDefaultStepFxLane,
  createDefaultStepFxTrack,
  deleteStepFxSteps,
  distributeStepFxWidthsEvenly,
  duplicateStepFxSteps,
  editStepFxSteps,
  insertStepFxStep,
  reorderStepFxSteps,
  roundStepFxWidthBeats,
  setStepFxTargetValue,
  stepFxAttributeName,
  stepFxPasteInsertionIndex,
  stepFxPhaseOffset,
  stepFxStepsFromClipboard,
  stepFxTargetValue,
  stepFxTrack,
} from "../model/step-fx-editor-model";
import type { StepFxWaveformSelectionModifiers } from "../model/step-fx-waveform-types";
import type { StepFxEditorPhaseController } from "./step-fx-editor-phase-controller";
import type { StepFxEditorSelectionController } from "./step-fx-editor-selection-controller";

const log = getLogger(import.meta.url);

interface StepFxEditorEditControllerOptions {
  draft: Accessor<types.StepFx | undefined>;
  mutate: (edit: (next: types.StepFx) => void) => void;
  selection: StepFxEditorSelectionController;
  phase: StepFxEditorPhaseController;
}

/** Translates sheet, toolbar, waveform, and keyboard gestures into draft mutations. */
export function createStepFxEditorEditController(
  options: StepFxEditorEditControllerOptions,
) {
  const { draft, mutate, selection, phase } = options;
  const {
    selectedLane,
    trackKind,
    selectedStepUids,
    setSelectedStepUids,
    selectTrack,
    activeTrack,
  } = selection;

  /** Renames the active Step FX through the shared draft mutation pipeline. */
  const renameStepFx = (stepFx: types.StepFx, label: string): void => {
    if (label === stepFx.identifiers.label) return;
    mutate((next) => {
      next.identifiers.label = label;
    });
  };

  /** Replaces the spatial selection whose resolved order drives phase offsets. */
  const setSpatialSelection = (spatialSelection: types.SpatialSelection) =>
    mutate((next) => (next.selection = spatialSelection));

  /** Replaces the effect-wide traversal direction. */
  const setDirection = (direction: types.FxDirection) =>
    mutate((next) => (next.direction = direction));

  /** Replaces the effect-wide beat timing. */
  const setTiming = (timing: types.StepFxTiming) =>
    mutate((next) => (next.timing = timing));

  /** Replaces the effect-wide cycle scaling mode. */
  const setCycleScale = (cycleScale: types.StepFxCycleScale) =>
    mutate((next) => (next.cycle_scale = cycleScale));

  /** Replaces the effect-wide start-position distribution. */
  const setPhase = (nextPhase: types.StepFxPhase) =>
    mutate((next) => (next.phase = nextPhase));

  /** Replaces the selected lane, including its timing and phase overrides. */
  const replaceLane = (lane: types.FxLane) =>
    mutate((next) => (next.lanes[selectedLane()] = lane));

  /** Replaces the active track while preserving every other lane field. */
  const replaceTrack = (track: types.FxTrack): void => {
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      if (!lane) return;
      if (trackKind() === "absolute") lane.absolute = track;
      else lane.relative = track;
    });
  };

  /** Applies one cell edit to the edited row, or to every selected row when it is selected. */
  const editSteps = (
    track: types.FxTrack,
    stepUid: string,
    edit: (step: types.FxStep) => types.FxStep,
  ): void => {
    const affected = selection.editSelectionFor(stepUid);
    replaceTrack(editStepFxSteps(track, affected, edit));
  };

  /** Adds and selects a lane for a newly chosen fixture attribute. */
  const addLane = (name: string): void => {
    mutate((next) => {
      const attribute = getAttributeMetadata(name)?.attribute ?? {
        type: "Custom" as const,
        data: { label: name },
      };
      next.lanes.push(createDefaultStepFxLane(attribute));
      selectTrack(next.lanes.length - 1, "absolute");
    });
  };

  /** Removes one lane and keeps the nearest surviving lane selected. */
  const removeLane = (index: number): void => {
    mutate((next) => next.lanes.splice(index, 1));
    selection.clearTrackSelections();
    selectTrack(
      Math.max(0, Math.min(selectedLane(), (draft()?.lanes.length ?? 1) - 2)),
      trackKind(),
    );
  };

  /** Reconciles authored lanes with the attribute picker: removes the first dropped lane, else adds new ones. */
  const syncAttributeLanes = (attributes: string[]): void => {
    const lanes = draft()?.lanes ?? [];
    const requested = new Set(attributes);
    const removedIndex = lanes.findIndex(
      (lane) => !requested.has(stepFxAttributeName(lane.attribute)),
    );
    if (removedIndex >= 0) {
      removeLane(removedIndex);
      return;
    }
    const existing = new Set(
      lanes.map((lane) => stepFxAttributeName(lane.attribute)),
    );
    for (const attribute of attributes)
      if (!existing.has(attribute)) addLane(attribute);
  };

  /** Selects a lane, keeping the current contribution when that lane authors it. */
  const selectLane = (index: number, lane: types.FxLane): void => {
    selectTrack(
      index,
      stepFxTrack(lane, trackKind())
        ? trackKind()
        : lane.absolute
          ? "absolute"
          : "relative",
    );
  };

  /** Adds the currently selected absolute or relative contribution track. */
  const addTrack = (): void => {
    replaceTrack(createDefaultStepFxTrack(trackKind()));
  };

  /** Removes one contribution track while retaining its attribute lane. */
  const removeTrack = (kind = trackKind()): void => {
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      if (!lane) return;
      if (kind === "absolute") lane.absolute = undefined;
      else lane.relative = undefined;
    });
  };

  /** Inserts one step after the active selection and selects its fresh identity. */
  const insertStep = (): void => {
    const track = activeTrack();
    if (!track) return;
    const selectedIndex = Math.max(
      0,
      track.steps.findIndex((step) => selectedStepUids().has(step.uid)),
    );
    const inserted = insertStepFxStep(track, selectedIndex);
    if (trackKind() === "relative") {
      const step = inserted.track.steps.find(
        (candidate) => candidate.uid === inserted.uid,
      );
      if (step) {
        step.target = setStepFxTargetValue(step.target, 0, "relative");
        step.blueprint_uid = undefined;
      }
    }
    replaceTrack(inserted.track);
    setSelectedStepUids(new Set([inserted.uid]));
  };

  /** Duplicates all selected rows as independent authored steps. */
  const duplicateSteps = (): void => {
    const track = activeTrack();
    if (!track) return;
    const duplicated = duplicateStepFxSteps(track, selectedStepUids());
    replaceTrack(duplicated.track);
    setSelectedStepUids(duplicated.selectedUids);
  };

  /** Shares the selected steps' total duration, or the whole track when selection is singular. */
  const distributeWidthsEvenly = (): void => {
    const track = activeTrack();
    if (!track) return;
    replaceTrack(distributeStepFxWidthsEvenly(track, selectedStepUids()));
  };

  /** Deletes selected rows and chooses the nearest surviving row. */
  const deleteSteps = (): void => {
    const track = activeTrack();
    if (!track) return;
    const deleted = deleteStepFxSteps(track, selectedStepUids());
    replaceTrack(deleted.track);
    setSelectedStepUids(deleted.selectedUids);
  };

  /** Deletes selected rows for a panel shortcut that was not handled locally. */
  const handleDeleteStepsShortcut = (event?: KeyboardEvent): void => {
    if (event?.defaultPrevented) return;
    event?.preventDefault();
    deleteSteps();
  };

  /** Moves the selected authored rows by one position. */
  const moveSteps = (direction: -1 | 1): void => {
    const track = activeTrack();
    if (track)
      replaceTrack(reorderStepFxSteps(track, selectedStepUids(), direction));
  };

  /** Copies selected rows as portable JSON step data. */
  const copySteps = async (): Promise<void> => {
    const selected =
      activeTrack()?.steps.filter((step) => selectedStepUids().has(step.uid)) ??
      [];
    if (selected.length === 0) return;
    try {
      await writeClipboardText(JSON.stringify(selected, null, 2));
    } catch (error) {
      log.warn("failed to copy step FX steps", { error });
      pushToast("error", "Could not copy steps to the clipboard");
    }
  };

  /** Pastes serialized steps or line-separated numeric targets after the selection. */
  const pasteSteps = async (): Promise<void> => {
    const track = activeTrack();
    if (!track) return;
    let text: string;
    try {
      text = await readClipboardText();
    } catch (error) {
      log.warn("failed to read step FX steps from the clipboard", { error });
      pushToast(
        "error",
        error instanceof ClipboardUnavailableError
          ? error.message
          : "Could not read the clipboard",
      );
      return;
    }
    const incoming = stepFxStepsFromClipboard(
      text,
      trackKind(),
      track.steps[0],
    );
    if (incoming.length === 0) return;
    const fresh = incoming.map((step) => ({
      ...structuredClone(step),
      uid: createShowObjectUid(),
      target: setStepFxTargetValue(
        step.target,
        stepFxTargetValue(step.target),
        trackKind(),
      ),
    }));
    const insertionIndex = stepFxPasteInsertionIndex(track, selectedStepUids());
    const steps = track.steps.map((step) => structuredClone(step));
    steps.splice(insertionIndex, 0, ...fresh);
    replaceTrack({ steps });
    setSelectedStepUids(new Set(fresh.map((step) => step.uid)));
  };

  /** Applies shared single, range, or toggle selection from visual step controls. */
  const selectStep = (
    stepUid: string,
    modifiers: StepFxWaveformSelectionModifiers,
  ): void => {
    const track = activeTrack();
    if (!track) return;
    const targetIndex = track.steps.findIndex((step) => step.uid === stepUid);
    if (targetIndex < 0) return;
    if (modifiers.extend) {
      const anchor = track.steps.findIndex((step) =>
        selectedStepUids().has(step.uid),
      );
      const start = Math.min(anchor < 0 ? targetIndex : anchor, targetIndex);
      const end = Math.max(anchor < 0 ? targetIndex : anchor, targetIndex);
      setSelectedStepUids(
        new Set(track.steps.slice(start, end + 1).map((step) => step.uid)),
      );
      return;
    }
    const next = modifiers.toggle
      ? new Set(selectedStepUids())
      : new Set<string>();
    if (next.has(stepUid)) next.delete(stepUid);
    else next.add(stepUid);
    setSelectedStepUids(next);
  };

  /** Replaces the authored fields controlled by one dragged ramp endpoint. */
  const replaceWaveformControlPoint = (
    stepUid: string,
    point: "ramp-start" | "ramp-end",
    transitionPosition: number,
    value?: number,
  ): void => {
    const track = activeTrack();
    if (!track || !Number.isFinite(transitionPosition)) return;
    replaceTrack({
      steps: track.steps.map((step) => {
        if (step.uid !== stepUid) return structuredClone(step);
        const replacement = structuredClone(step);
        if (point === "ramp-start") {
          replacement.transition.start = Number(transitionPosition.toFixed(4));
        } else {
          replacement.transition.end = Number(transitionPosition.toFixed(4));
          if (value !== undefined && Number.isFinite(value)) {
            replacement.target = setStepFxTargetValue(
              step.target,
              Number(value.toFixed(6)),
              trackKind(),
            );
            replacement.blueprint_uid = undefined;
          }
        }
        return replacement;
      }),
    });
  };

  /** Reallocates two adjacent widths around a dragged internal boundary. */
  const replaceWaveformStepBoundary = (
    leadingStepUid: string,
    trailingStepUid: string,
    leadingWidthBeats: number,
    trailingWidthBeats: number,
  ): void => {
    const track = activeTrack();
    if (!track) return;
    replaceTrack({
      steps: track.steps.map((step) => {
        const width =
          step.uid === leadingStepUid
            ? leadingWidthBeats
            : step.uid === trailingStepUid
              ? trailingWidthBeats
              : undefined;
        return width === undefined
          ? structuredClone(step)
          : {
              ...structuredClone(step),
              width_beats: roundStepFxWidthBeats(width),
            };
      }),
    });
  };

  /** Replaces one step width while allowing the authored cycle duration to change. */
  const replaceWaveformStepWidth = (
    stepUid: string,
    widthBeats: number,
  ): void => {
    const track = activeTrack();
    if (!track || !Number.isFinite(widthBeats)) return;
    replaceTrack({
      steps: track.steps.map((step) =>
        step.uid === stepUid
          ? {
              ...structuredClone(step),
              width_beats: roundStepFxWidthBeats(widthBeats),
            }
          : structuredClone(step),
      ),
    });
  };

  /** Moves the effective phase distribution to a dragged selected-index offset. */
  const replaceWaveformStartPosition = (selectionPhaseOffset: number): void => {
    if (!Number.isFinite(selectionPhaseOffset)) return;
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      const nextPhase = lane?.phase_override ?? next.phase;
      const currentOffset = stepFxPhaseOffset(
        nextPhase,
        phase.previewIndex(),
        phase.phaseMarkers().length,
      );
      const delta = selectionPhaseOffset - currentOffset;
      const shifted = {
        waypoints:
          nextPhase.waypoints.length > 0
            ? nextPhase.waypoints.map((waypoint) =>
                Number((waypoint + delta).toFixed(6)),
              )
            : [Number(selectionPhaseOffset.toFixed(6))],
      };
      if (lane?.phase_override) lane.phase_override = shifted;
      else next.phase = shifted;
    });
  };

  /** Changes phase spread around its first waypoint while preserving custom relative shape. */
  const replaceWaveformSpread = (spread: number): void => {
    if (!Number.isFinite(spread)) return;
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      const nextPhase = lane?.phase_override ?? next.phase;
      const start = nextPhase.waypoints[0] ?? 0;
      const currentSpread =
        nextPhase.waypoints.length > 1
          ? nextPhase.waypoints[nextPhase.waypoints.length - 1] - start
          : 0;
      const waypoints =
        nextPhase.waypoints.length <= 1
          ? [start, start + spread]
          : nextPhase.waypoints.map((waypoint, index) => {
              if (index === 0) return start;
              if (Math.abs(currentSpread) <= Number.EPSILON) {
                return (
                  start + (spread * index) / (nextPhase.waypoints.length - 1)
                );
              }
              return start + ((waypoint - start) * spread) / currentSpread;
            });
      const replacement = {
        waypoints: waypoints.map((waypoint) => Number(waypoint.toFixed(6))),
      };
      if (lane?.phase_override) lane.phase_override = replacement;
      else next.phase = replacement;
    });
  };

  /**
   * Applies Step Bar keyboard navigation and selection commands to the active
   * track. Arrow keys move the selection and keyboard focus together; past
   * either end they fall through to the Step bar toolbar's roving focus.
   */
  const handleStepBarKeyDown = (event: KeyboardEvent): void => {
    const track = activeTrack();
    if (!track || track.steps.length === 0) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelectedStepUids(new Set(track.steps.map((step) => step.uid)));
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSteps();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const selectedIndexes = track.steps
      .map((step, index) => (selectedStepUids().has(step.uid) ? index : -1))
      .filter((index) => index >= 0);
    const focusedSelector =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("[data-step-fx-step-selector]")
        : null;
    const focusedIndex = Number(focusedSelector?.dataset.stepIndex);
    // Arrows continue from the focused step so roving focus and selection agree.
    const anchor = Number.isInteger(focusedIndex)
      ? focusedIndex
      : (selectedIndexes[selectedIndexes.length - 1] ?? 0);
    const target = Math.max(
      0,
      Math.min(
        track.steps.length - 1,
        anchor + (event.key === "ArrowLeft" ? -1 : 1),
      ),
    );
    // At either end, leave the arrow to the Step bar toolbar so focus can
    // reach the paging buttons.
    if (
      target === anchor &&
      selectedStepUids().has(track.steps[anchor].uid) &&
      !event.shiftKey
    )
      return;
    event.preventDefault();
    if (!event.shiftKey) {
      setSelectedStepUids(new Set([track.steps[target].uid]));
    } else {
      const next = new Set(selectedStepUids());
      next.add(track.steps[target].uid);
      setSelectedStepUids(next);
    }
    if (event.target instanceof HTMLElement) {
      event.target
        .closest("[data-step-fx-step-pager-viewport]")
        ?.querySelector<HTMLElement>(`[data-step-index="${target}"]`)
        ?.focus();
    }
  };

  /** Handles panel-level step clipboard shortcuts without overriding native fields. */
  const handleEditorClipboardKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches("input, textarea, select, [contenteditable='true']")
    )
      return;
    const key = event.key.toLowerCase();
    if (key === "c" && selectedStepUids().size > 0) {
      event.preventDefault();
      void copySteps();
    } else if (key === "v" && activeTrack()) {
      event.preventDefault();
      void pasteSteps();
    }
  };

  return {
    renameStepFx,
    setSpatialSelection,
    setDirection,
    setTiming,
    setCycleScale,
    setPhase,
    replaceLane,
    replaceTrack,
    editSteps,
    syncAttributeLanes,
    selectLane,
    removeLane,
    addTrack,
    removeTrack,
    insertStep,
    duplicateSteps,
    distributeWidthsEvenly,
    deleteSteps,
    handleDeleteStepsShortcut,
    moveSteps,
    selectStep,
    replaceWaveformControlPoint,
    replaceWaveformStepBoundary,
    replaceWaveformStepWidth,
    replaceWaveformStartPosition,
    replaceWaveformSpread,
    handleStepBarKeyDown,
    handleEditorClipboardKeyDown,
  };
}
