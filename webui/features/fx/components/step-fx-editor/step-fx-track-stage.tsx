// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import VerticalLayoutSplitter from "../../../../components/ui/vertical-layout-splitter";
import type * as types from "../../../../types";
import type { StepFxEditorViewController } from "../../controllers/step-fx-editor-view-controller";
import { STEP_FX_BUTTON_CLASS } from "./step-fx-editor-styles";
import { StepFxStepActionToolbar } from "./step-fx-step-action-toolbar";
import { StepFxStepNavigationToolbar } from "./step-fx-step-navigation-toolbar";
import { StepFxStepSheet } from "./step-fx-step-sheet";
import { StepFxTrackWaveform } from "./step-fx-track-waveform";

/**
 * Renders the selected lane's tab panel: step actions, the animated
 * contribution panel, and the resizable step sheet above its waveform.
 */
export function StepFxTrackStage(props: {
  editor: StepFxEditorViewController;
  stepFx: types.StepFx;
}) {
  const { session, selection, slide, edit } = props.editor;

  return (
    <section
      id={`step-fx-${session.previewSessionId}-track-panel`}
      role="tabpanel"
      aria-labelledby={
        props.stepFx.lanes.length > 0
          ? `step-fx-${session.previewSessionId}-attribute-tab-${selection.selectedLane()}`
          : undefined
      }
      aria-busy={slide.contributionSlidePhase() !== "idle"}
      class="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
      data-step-fx-contribution-stage
      data-contribution-slide-phase={slide.contributionSlidePhase()}
      data-contribution-slide-direction={slide.contributionSlideDirection()}
    >
      <Show
        when={selection.activeLane()}
        fallback={
          <div class="m-auto text-sm text-neutral-500">
            Add an attribute lane to begin.
          </div>
        }
      >
        {(lane) => (
          <>
            <StepFxStepActionToolbar
              editor={props.editor}
              stepFx={props.stepFx}
              lane={lane()}
              track={selection.activeTrack()}
            />
            <div
              ref={slide.setContributionPanelElement}
              class="flex min-h-0 min-w-0 flex-1 flex-col"
              data-step-fx-contribution-panel
              data-track-kind={selection.trackKind()}
            >
              <Show
                when={selection.activeTrack()}
                fallback={
                  <div
                    id={`step-fx-${session.previewSessionId}-steps-panel`}
                    role="tabpanel"
                    aria-labelledby={`step-fx-${session.previewSessionId}-${selection.trackKind()}-tab`}
                    class="flex min-h-0 flex-1 flex-col"
                  >
                    <div class="relative min-h-0 flex-1">
                      <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-neutral-500">
                        <span>No {selection.trackKind()} steps.</span>
                        <button
                          type="button"
                          class={STEP_FX_BUTTON_CLASS}
                          onClick={edit.addTrack}
                        >
                          Add {selection.trackKind()} step
                        </button>
                      </div>
                    </div>
                  </div>
                }
              >
                {(track) => (
                  <div
                    id={`step-fx-${session.previewSessionId}-steps-panel`}
                    role="tabpanel"
                    aria-labelledby={`step-fx-${session.previewSessionId}-${selection.trackKind()}-tab`}
                    class="flex min-h-0 flex-1 flex-col"
                  >
                    <VerticalLayoutSplitter
                      class="min-h-0 flex-1"
                      topSize={62}
                      topMinSize={48}
                      separatorLabel="Resize Step FX table and waveform"
                      top={
                        <div class="relative size-full min-h-0">
                          <div
                            class="size-full overflow-auto pb-12"
                            data-step-fx-sheet-container
                          >
                            <StepFxStepSheet
                              editor={props.editor}
                              track={track()}
                            />
                          </div>
                          <StepFxStepNavigationToolbar
                            editor={props.editor}
                            track={track()}
                          />
                        </div>
                      }
                      bottom={
                        <StepFxTrackWaveform
                          editor={props.editor}
                          stepFx={props.stepFx}
                          lane={lane()}
                          track={track()}
                        />
                      }
                    />
                  </div>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
