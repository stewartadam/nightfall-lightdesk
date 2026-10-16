// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import type * as types from "../../../../types";
import {
  type StepFxTrackKind,
  stepFxAttributeName,
} from "../../model/step-fx-editor-model";
import { STEP_FX_TAB_BUTTON_CLASS } from "./step-fx-editor-styles";

/** Renders absolute and relative contribution tabs beside the active step controls. */
export function StepFxContributionTabs(props: {
  lane: types.FxLane;
  trackKind: StepFxTrackKind;
  previewSessionId: string;
  onSelectTrack: (kind: StepFxTrackKind) => void;
  onRemoveTrack: (kind: StepFxTrackKind) => void;
}) {
  return (
    <div
      class="inline-flex shrink-0 rounded bg-gray-800 p-0.5"
      role="tablist"
      aria-label={`${stepFxAttributeName(props.lane.attribute)} contribution`}
    >
      <div
        role="presentation"
        class="flex items-center rounded transition-colors"
        classList={{
          "bg-blue-600 text-white": props.trackKind === "absolute",
          "text-gray-400 hover:text-gray-200": props.trackKind !== "absolute",
        }}
      >
        <button
          type="button"
          id={`step-fx-${props.previewSessionId}-absolute-tab`}
          role="tab"
          aria-selected={props.trackKind === "absolute"}
          aria-controls={`step-fx-${props.previewSessionId}-steps-panel`}
          class={STEP_FX_TAB_BUTTON_CLASS}
          onClick={() => props.onSelectTrack("absolute")}
        >
          Absolute{" "}
          {props.lane.absolute ? `(${props.lane.absolute.steps.length})` : ""}
        </button>
        <Show when={props.lane.absolute}>
          <button
            type="button"
            aria-label="Remove absolute steps"
            class="self-stretch rounded px-1.5 text-current/70 hover:bg-black/15 hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={() => props.onRemoveTrack("absolute")}
          >
            ×
          </button>
        </Show>
      </div>
      <div
        role="presentation"
        class="flex items-center rounded transition-colors"
        classList={{
          "bg-blue-600 text-white": props.trackKind === "relative",
          "text-gray-400 hover:text-gray-200": props.trackKind !== "relative",
        }}
      >
        <button
          type="button"
          id={`step-fx-${props.previewSessionId}-relative-tab`}
          role="tab"
          aria-selected={props.trackKind === "relative"}
          aria-controls={`step-fx-${props.previewSessionId}-steps-panel`}
          class={STEP_FX_TAB_BUTTON_CLASS}
          onClick={() => props.onSelectTrack("relative")}
        >
          Relative{" "}
          {props.lane.relative ? `(${props.lane.relative.steps.length})` : ""}
        </button>
        <Show when={props.lane.relative}>
          <button
            type="button"
            aria-label="Remove relative steps"
            class="self-stretch rounded px-1.5 text-current/70 hover:bg-black/15 hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={() => props.onRemoveTrack("relative")}
          >
            ×
          </button>
        </Show>
      </div>
    </div>
  );
}
