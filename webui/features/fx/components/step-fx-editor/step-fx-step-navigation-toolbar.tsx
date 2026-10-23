// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For } from "solid-js";
import { Toolbar } from "../../../../components/ui/toolbar";
import type * as types from "../../../../types";
import type { StepFxEditorViewController } from "../../controllers/step-fx-editor-view-controller";
import { StepFxStepPager } from "./step-fx-step-pager";

/** Renders paged step navigation in a persistent overlay at the table pane's foot. */
export function StepFxStepNavigationToolbar(props: {
  editor: StepFxEditorViewController;
  track: types.FxTrack;
}) {
  const { selection, edit } = props.editor;

  return (
    <Toolbar
      class="absolute inset-x-0 bottom-0 z-20 flex h-12 min-w-0 items-center gap-1 border-t border-neutral-700 bg-neutral-900/95 px-2 shadow-lg backdrop-blur"
      data-step-fx-step-toolbar
      label="Step bar"
    >
      <StepFxStepPager onKeyDown={edit.handleStepBarKeyDown}>
        <For each={props.track.steps}>
          {(step, index) => (
            <button
              type="button"
              class={`size-7 shrink-0 rounded border text-xs ${selection.selectedStepUids().has(step.uid) ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-neutral-700 bg-neutral-800 text-neutral-300"}`}
              classList={{
                "ring-1 ring-inset ring-amber-300/80":
                  props.editor.liveStepUid() === step.uid,
                "border-red-500 text-red-200": props.editor.stepHasIssues(
                  index(),
                ),
              }}
              onClick={(event) =>
                edit.selectStep(step.uid, {
                  extend: event.shiftKey,
                  toggle: event.metaKey || event.ctrlKey,
                })
              }
              aria-current={
                props.editor.liveStepUid() === step.uid ? "step" : undefined
              }
              data-step-fx-step-selector
              data-step-index={index()}
              data-live={
                props.editor.liveStepUid() === step.uid ? "true" : undefined
              }
            >
              {index() + 1}
            </button>
          )}
        </For>
      </StepFxStepPager>
    </Toolbar>
  );
}
