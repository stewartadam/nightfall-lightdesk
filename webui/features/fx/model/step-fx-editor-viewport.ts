// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "../../../lib/logger";
import type { StepFxTrackKind } from "./step-fx-editor-model";

const log = getLogger(import.meta.url);
const STORAGE_PREFIX = "nightfall.stepFxEditor.viewport";

export interface StepFxEditorViewportState {
  selectedAttribute?: string;
  trackKind: StepFxTrackKind;
  centerSelectedFixture: boolean;
  showAllPlayheads: boolean;
  previewIndex: number;
  previewActive: boolean;
}

export const DEFAULT_STEP_FX_EDITOR_VIEWPORT: StepFxEditorViewportState = {
  selectedAttribute: undefined,
  trackKind: "absolute",
  centerSelectedFixture: false,
  showAllPlayheads: false,
  previewIndex: 0,
  previewActive: true,
};

/** Builds the browser-storage key for one normalized Step FX identity. */
export function stepFxEditorViewportStorageKey(stepFxUid: string): string {
  return `${STORAGE_PREFIX}.${stepFxUid.replace(/-/g, "").toLowerCase()}`;
}

/** Converts unknown persisted input into a complete safe viewport state. */
export function sanitizeStepFxEditorViewportState(
  value: unknown,
): StepFxEditorViewportState {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_STEP_FX_EDITOR_VIEWPORT };
  }
  const candidate = value as Record<string, unknown>;
  const selectedAttribute =
    typeof candidate.selectedAttribute === "string" &&
    candidate.selectedAttribute.trim().length > 0
      ? candidate.selectedAttribute
      : undefined;
  const previewIndex =
    typeof candidate.previewIndex === "number" &&
    Number.isFinite(candidate.previewIndex)
      ? Math.max(0, Math.floor(candidate.previewIndex))
      : DEFAULT_STEP_FX_EDITOR_VIEWPORT.previewIndex;

  return {
    selectedAttribute,
    trackKind: candidate.trackKind === "relative" ? "relative" : "absolute",
    centerSelectedFixture:
      typeof candidate.centerSelectedFixture === "boolean"
        ? candidate.centerSelectedFixture
        : DEFAULT_STEP_FX_EDITOR_VIEWPORT.centerSelectedFixture,
    showAllPlayheads:
      typeof candidate.showAllPlayheads === "boolean"
        ? candidate.showAllPlayheads
        : DEFAULT_STEP_FX_EDITOR_VIEWPORT.showAllPlayheads,
    previewIndex,
    previewActive:
      typeof candidate.previewActive === "boolean"
        ? candidate.previewActive
        : DEFAULT_STEP_FX_EDITOR_VIEWPORT.previewActive,
  };
}

/** Reads one effect's viewport state, falling back safely outside a browser. */
export function loadStepFxEditorViewportState(
  stepFxUid: string,
): StepFxEditorViewportState {
  if (typeof window === "undefined" || stepFxUid.length === 0) {
    return { ...DEFAULT_STEP_FX_EDITOR_VIEWPORT };
  }
  try {
    const stored = window.localStorage.getItem(
      stepFxEditorViewportStorageKey(stepFxUid),
    );
    return stored === null
      ? { ...DEFAULT_STEP_FX_EDITOR_VIEWPORT }
      : sanitizeStepFxEditorViewportState(JSON.parse(stored));
  } catch (error) {
    log.debug("Could not load Step FX editor viewport", { error, stepFxUid });
    return { ...DEFAULT_STEP_FX_EDITOR_VIEWPORT };
  }
}

/** Persists one effect's complete viewport state for future editor sessions. */
export function saveStepFxEditorViewportState(
  stepFxUid: string,
  state: StepFxEditorViewportState,
): void {
  if (typeof window === "undefined" || stepFxUid.length === 0) return;
  try {
    window.localStorage.setItem(
      stepFxEditorViewportStorageKey(stepFxUid),
      JSON.stringify(sanitizeStepFxEditorViewportState(state)),
    );
  } catch (error) {
    log.debug("Could not save Step FX editor viewport", { error, stepFxUid });
  }
}
