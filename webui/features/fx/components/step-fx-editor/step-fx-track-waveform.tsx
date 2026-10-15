// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToSeconds } from "../../../../lib/duration";
import type * as types from "../../../../types";
import type { StepFxEditorViewController } from "../../controllers/step-fx-editor-view-controller";
import { StepFxWaveform } from "../step-fx-waveform";
import { StepFxPhasePreview } from "./step-fx-phase-preview";

/** Renders the active track's live waveform with its phase-preview title controls. */
export function StepFxTrackWaveform(props: {
  editor: StepFxEditorViewController;
  stepFx: types.StepFx;
  lane: types.FxLane;
  track: types.FxTrack;
}) {
  const { session, selection, phase, edit } = props.editor;

  return (
    <StepFxWaveform
      track={props.track}
      direction={props.stepFx.direction}
      previewActive={session.previewActive()}
      previewStatus={session.previewStatus()}
      beatDurationSeconds={durationToSeconds(
        (props.lane.timing_override ?? props.stepFx.timing).beat_duration,
      )}
      attribute={props.lane.attribute}
      trackKind={selection.trackKind()}
      selectionPhaseOffset={phase.previewPhaseOffset()}
      selectionPhaseOffsets={phase.previewPhaseOffsets()}
      selectionSpread={phase.phaseSpread()}
      selectionPhaseWrapsCycle={phase.previewPhaseWrapsCycle()}
      selectionLabels={phase.phaseMarkers().map((marker) => marker.members)}
      previewIndex={phase.previewIndex()}
      showAllPlayheads={phase.effectiveShowAllPlayheads()}
      centerSelectedFixture={phase.centerSelectedFixture()}
      positionUnit={props.editor.positionUnit()}
      cycleScale={props.stepFx.cycle_scale}
      selectedStepUids={selection.selectedStepUids()}
      titleControls={(samplingWarning) => (
        <StepFxPhasePreview
          markers={phase.phaseMarkers()}
          phase={phase.effectivePhase() ?? props.stepFx.phase}
          issues={phase.phaseIssues()}
          selectedIndex={phase.previewIndex()}
          onSelectIndex={phase.setPreviewIndex}
          showAllPlayheads={phase.effectiveShowAllPlayheads()}
          showAllPlayheadsLocked={phase.spreadEditing()}
          showAllPlayheadsDisabledReason={
            phase.phaseHasSpread()
              ? undefined
              : "Show all is unavailable in Together mode because all fixtures overlap and behave as one."
          }
          onShowAllPlayheadsChange={phase.setShowAllPlayheads}
          centerSelectedFixture={phase.centerSelectedFixture()}
          onCenterSelectedFixtureChange={phase.setCenterSelectedFixture}
          samplingWarning={samplingWarning}
        />
      )}
      onLiveStepChange={props.editor.setLiveStepUid}
      onStepSelect={edit.selectStep}
      onDragTargetChange={props.editor.setWaveformDragTarget}
      onStepControlPointChange={edit.replaceWaveformControlPoint}
      onStepWidthChange={edit.replaceWaveformStepWidth}
      onStepBoundaryChange={edit.replaceWaveformStepBoundary}
      onStartPositionChange={edit.replaceWaveformStartPosition}
      onSpreadChange={edit.replaceWaveformSpread}
    />
  );
}
