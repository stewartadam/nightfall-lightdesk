// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { Dynamic } from "solid-js/web";
import PanelToolbar from "../../../../components/ui/panel-toolbar";
import { ToggleToolbarButton } from "../../../../components/ui/toolbar-button";
import type * as types from "../../../../types";
import type { StepFxEditorViewController } from "../../controllers/step-fx-editor-view-controller";
import { stepFxAuthoredPassBeats } from "../../model/step-fx-editor-model";
import { StepFxDirectionControl } from "./step-fx-direction-control";
import { StepFxStartPositionControls } from "./step-fx-start-position-controls";
import { StepFxTimingControls } from "./step-fx-timing-controls";

/** Renders effect-wide direction, timing, start position, and preview controls. */
export function StepFxEditorToolbar(props: {
  editor: StepFxEditorViewController;
  stepFx: types.StepFx;
}) {
  const { session, selection, phase, popovers, edit } = props.editor;

  return (
    <PanelToolbar
      class="shrink-0"
      leftClass="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
      left={
        <>
          <StepFxDirectionControl
            direction={props.stepFx.direction}
            onChange={edit.setDirection}
          />
          <StepFxTimingControls
            stepFx={props.stepFx}
            open={popovers.openPopover() === "timing"}
            onOpenChange={(isOpen) =>
              popovers.setEditorPopoverOpen("timing", isOpen)
            }
            speedUnit={props.editor.speedUnit()}
            cycleBeatText={props.editor.activeCycleBeatText()}
            fixedScaleDefault={
              stepFxAuthoredPassBeats(selection.activeTrack()) ?? 1
            }
            trackKind={selection.trackKind()}
            speedError={
              props.editor.issuesByPath().get("timing.beat_duration")?.[0]
            }
            scaleError={
              props.editor.issuesByPath().get("cycle_scale.data")?.[0]
            }
            onSpeedUnitChange={props.editor.setSpeedUnit}
            onTimingChange={edit.setTiming}
            onCycleScaleChange={edit.setCycleScale}
          />
          <span
            class="h-6 w-px shrink-0 bg-neutral-700"
            data-step-fx-start-position-separator
            aria-hidden
          />
          <StepFxStartPositionControls
            phase={props.stepFx.phase}
            open={popovers.openPopover() === "start-position"}
            highlighted={
              props.editor.waveformDragTarget()?.kind === "start-position" ||
              props.editor.waveformDragTarget()?.kind === "spread"
            }
            advancedFocusRequest={popovers.advancedPhaseFocusRequest()}
            onOpenChange={(isOpen) =>
              popovers.setEditorPopoverOpen("start-position", isOpen)
            }
            selectionCount={phase.phaseMarkers().length}
            positionUnit={props.editor.positionUnit()}
            onPositionUnitChange={props.editor.setPositionUnit}
            onSpreadEditingChange={phase.setSpreadEditing}
            onChange={edit.setPhase}
          />
        </>
      }
      right={
        <ToggleToolbarButton
          label={session.previewActive() ? "Stop preview" : "Preview"}
          pressed={session.previewActive()}
          disabled={!session.canTogglePreview()}
          classList={{
            "cursor-not-allowed opacity-40": !session.canTogglePreview(),
          }}
          onClick={session.togglePreview}
        >
          <Dynamic
            component={session.previewActive() ? StopIcon : PlayIcon}
            class="size-4"
            aria-hidden
          />
        </ToggleToolbarButton>
      }
    />
  );
}
