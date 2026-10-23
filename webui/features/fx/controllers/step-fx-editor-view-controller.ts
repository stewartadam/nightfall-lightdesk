// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createSignal } from "solid-js";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import {
  formatStepFxBeatCount,
  type StepFxPositionUnit,
  type StepFxSpeedUnit,
  stepFxCycleBeats,
} from "../model/step-fx-editor-model";
import type { StepFxEditorViewportState } from "../model/step-fx-editor-viewport";
import type { StepFxWaveformDragTarget } from "../model/step-fx-waveform-types";
import { createStepFxContributionSlideController } from "./step-fx-contribution-slide-controller";
import type { createStepFxEditorController } from "./step-fx-editor-controller";
import { createStepFxEditorEditController } from "./step-fx-editor-edit-controller";
import { createStepFxEditorPhaseController } from "./step-fx-editor-phase-controller";
import { createStepFxEditorPopoverController } from "./step-fx-editor-popover-controller";
import { createStepFxEditorSelectionController } from "./step-fx-editor-selection-controller";
import { createStepFxEditorViewportController } from "./step-fx-editor-viewport-controller";

/** Persistence and preview session returned by the Step FX editor controller. */
export type StepFxEditorSession = ReturnType<
  typeof createStepFxEditorController
>;

interface StepFxEditorViewControllerOptions {
  panelId: string;
  initialUid: string;
  initialViewport: StepFxEditorViewportState;
  session: StepFxEditorSession;
}

/**
 * Composes the Step FX editor's selection, phase projection, viewport
 * persistence, popovers, contribution animation, and edit commands around one
 * persistence session, and registers the editor's keyboard shortcuts.
 */
export function createStepFxEditorViewController(
  options: StepFxEditorViewControllerOptions,
) {
  const { session, initialViewport } = options;
  const selection = createStepFxEditorSelectionController({
    draft: session.draft,
    initialTrackKind: initialViewport.trackKind,
  });
  const phase = createStepFxEditorPhaseController({
    draft: session.draft,
    activeLane: selection.activeLane,
    initialViewport,
  });
  createStepFxEditorViewportController({
    initialUid: options.initialUid,
    initialViewport,
    draft: session.draft,
    previewActive: session.previewActive,
    selection,
    phase,
  });
  const popovers = createStepFxEditorPopoverController();
  const slide = createStepFxContributionSlideController(selection);
  const edit = createStepFxEditorEditController({
    draft: session.draft,
    mutate: session.mutate,
    selection,
    phase,
  });
  const [liveStepUid, setLiveStepUid] = createSignal<string>();
  const [waveformDragTarget, setWaveformDragTarget] =
    createSignal<StepFxWaveformDragTarget>();
  const [speedUnit, setSpeedUnit] = createSignal<StepFxSpeedUnit>("BPM");
  const [positionUnit, setPositionUnit] =
    createSignal<StepFxPositionUnit>("percent");

  /** Indexes errors by field path so controls can expose localized feedback. */
  const issuesByPath = createMemo(() => {
    const byPath = new Map<string, string[]>();
    for (const issue of session.issues()) {
      const current = byPath.get(issue.path) ?? [];
      current.push(issue.message);
      byPath.set(issue.path, current);
    }
    return byPath;
  });

  /** Formats the active track's effective cycle after optional fixed scaling. */
  const activeCycleBeatText = createMemo(() => {
    const current = session.draft();
    const beats = current
      ? stepFxCycleBeats(current, selection.activeTrack())
      : null;
    return beats === null ? null : formatStepFxBeatCount(beats);
  });

  /** Returns the validation path prefix of one step in the active track. */
  const stepIssuePath = (index: number): string =>
    `lanes.${selection.selectedLane()}.${selection.trackKind()}.steps.${index}`;

  /** Reports whether any localized issue belongs to the active track's step at one index. */
  const stepHasIssues = (index: number): boolean => {
    const prefix = stepIssuePath(index);
    return Array.from(issuesByPath().keys()).some((path) =>
      path.startsWith(prefix),
    );
  };

  const editor = {
    session,
    selection,
    phase,
    popovers,
    slide,
    edit,
    liveStepUid,
    setLiveStepUid,
    waveformDragTarget,
    setWaveformDragTarget,
    speedUnit,
    setSpeedUnit,
    positionUnit,
    setPositionUnit,
    issuesByPath,
    activeCycleBeatText,
    stepIssuePath,
    stepHasIssues,
  };
  useStepFxEditorShortcuts(options.panelId, editor);
  return editor;
}

/** Editor UI state and commands shared by the Step FX editor's components. */
export type StepFxEditorViewController = ReturnType<
  typeof createStepFxEditorViewController
>;

/** Registers the Step FX editor's panel-scoped keyboard shortcuts. */
function useStepFxEditorShortcuts(
  panelId: string,
  editor: Pick<
    StepFxEditorViewController,
    "session" | "phase" | "popovers" | "edit"
  >,
): void {
  const { session, phase, popovers, edit } = editor;
  useKeyboardShortcut({
    key: "b",
    handler: () => popovers.setOpenPopover("timing"),
    description: "Open BPM editor",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "s",
    handler: () => popovers.setOpenPopover("start-position"),
    description: "Open spread editor",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "a",
    handler: () => {
      if (phase.phaseHasSpread()) phase.setShowAllPlayheads((shown) => !shown);
    },
    description: "Toggle all waveform playheads",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "n",
    handler: popovers.focusAttributeSearch,
    description: "Add a new attribute",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "p",
    handler: session.togglePreview,
    description: "Play or pause preview",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "o",
    handler: () => popovers.setOpenPopover("overrides"),
    description: "Open overrides",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Shift+s",
    handler: popovers.focusAdvancedPhaseExpression,
    description: "Edit advanced spread expression",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: popovers.dismissEditorPopovers,
    description: "Close editor popovers",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Delete",
    handler: edit.handleDeleteStepsShortcut,
    description: "Delete selected steps",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: edit.handleDeleteStepsShortcut,
    description: "Delete selected steps",
    componentId: panelId,
    group: "Step FX Editor",
  });
}
