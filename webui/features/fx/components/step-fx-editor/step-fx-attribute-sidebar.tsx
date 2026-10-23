// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For } from "solid-js";
import type * as types from "../../../../types";
import type { StepFxEditorViewController } from "../../controllers/step-fx-editor-view-controller";
import { stepFxAttributeName } from "../../model/step-fx-editor-model";
import { FxAttributePicker } from "../fx-attribute-picker";

/** Renders the attribute picker and the vertical attribute-lane tab list. */
export function StepFxAttributeSidebar(props: {
  editor: StepFxEditorViewController;
  stepFx: types.StepFx;
}) {
  const { session, selection, phase, popovers, edit } = props.editor;

  return (
    <aside class="min-h-0 overflow-y-auto border-r border-neutral-700 bg-neutral-900/60 p-2">
      <FxAttributePicker
        selectedAttributes={props.stepFx.lanes.map((lane) =>
          stepFxAttributeName(lane.attribute),
        )}
        showSelectedAttributes={false}
        showLabel={false}
        availableAttributes={phase.availableAttributes()}
        focusSearchRequest={popovers.attributeSearchFocusRequest()}
        dismissRequest={popovers.attributePickerDismissRequest()}
        onChange={edit.syncAttributeLanes}
      />
      <div
        class="mt-3 flex flex-col gap-1"
        role="tablist"
        aria-label="Step FX attributes"
        aria-orientation="vertical"
      >
        <For each={props.stepFx.lanes}>
          {(lane, index) => (
            <div
              role="presentation"
              class="group flex items-center rounded p-0.5 transition-colors"
              classList={{
                "bg-blue-600 text-white": selection.selectedLane() === index(),
                "bg-gray-800 text-gray-400":
                  selection.selectedLane() !== index(),
              }}
            >
              <button
                type="button"
                id={`step-fx-${session.previewSessionId}-attribute-tab-${index()}`}
                role="tab"
                aria-selected={selection.selectedLane() === index()}
                aria-controls={`step-fx-${session.previewSessionId}-track-panel`}
                class="min-w-0 flex-1 rounded px-2 py-1.5 text-left text-gray-200 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                onClick={() => edit.selectLane(index(), lane)}
              >
                <div class="truncate text-sm">
                  {stepFxAttributeName(lane.attribute)}
                </div>
                <div class="text-[11px] text-neutral-500">
                  {lane.absolute ? `A ${lane.absolute.steps.length}` : ""}
                  {lane.absolute && lane.relative ? " · " : ""}
                  {lane.relative ? `R ${lane.relative.steps.length}` : ""}
                </div>
              </button>
              <button
                type="button"
                aria-label={`Remove ${stepFxAttributeName(lane.attribute)} lane`}
                class="self-stretch rounded px-2 text-gray-300 hover:bg-black/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                onClick={() => edit.removeLane(index())}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
    </aside>
  );
}
