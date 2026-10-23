// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createEffect, createSignal } from "solid-js";
import type * as types from "../../../types";
import { stepFxAttributeName } from "../model/step-fx-editor-model";
import {
  type StepFxEditorViewportState,
  saveStepFxEditorViewportState,
} from "../model/step-fx-editor-viewport";
import type { StepFxEditorPhaseController } from "./step-fx-editor-phase-controller";
import type { StepFxEditorSelectionController } from "./step-fx-editor-selection-controller";

interface StepFxEditorViewportControllerOptions {
  initialUid: string;
  initialViewport: StepFxEditorViewportState;
  draft: Accessor<types.StepFx | undefined>;
  previewActive: Accessor<boolean>;
  selection: StepFxEditorSelectionController;
  phase: StepFxEditorPhaseController;
}

/**
 * Restores the stored lane and track once the draft is available, then
 * persists editor-only view controls for the Step FX after every change.
 */
export function createStepFxEditorViewportController(
  options: StepFxEditorViewportControllerOptions,
): void {
  const { initialUid, initialViewport, draft, selection, phase } = options;
  const [viewportHydrated, setViewportHydrated] = createSignal(false);

  /** Restores the selected attribute after the effect draft becomes available. */
  createEffect(() => {
    const current = draft();
    if (!current || viewportHydrated()) return;
    const laneIndex = initialViewport.selectedAttribute
      ? current.lanes.findIndex(
          (lane) =>
            stepFxAttributeName(lane.attribute) ===
            initialViewport.selectedAttribute,
        )
      : 0;
    selection.selectTrack(Math.max(0, laneIndex), initialViewport.trackKind);
    setViewportHydrated(true);
  });

  /** Persists editor-only controls independently for the active Step FX. */
  createEffect(() => {
    if (!viewportHydrated()) return;
    const lane = selection.activeLane();
    saveStepFxEditorViewportState(initialUid, {
      selectedAttribute: lane ? stepFxAttributeName(lane.attribute) : undefined,
      trackKind: selection.trackKind(),
      centerSelectedFixture: phase.centerSelectedFixture(),
      showAllPlayheads: phase.showAllPlayheads(),
      previewIndex: phase.persistedPreviewIndex(),
      previewActive: options.previewActive(),
    });
  });
}
