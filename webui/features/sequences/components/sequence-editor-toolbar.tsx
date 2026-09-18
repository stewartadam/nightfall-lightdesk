// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowCircleRightIcon } from "@squidlab/phosphor-solid/arrow-circle-right";
import { ArrowDownIcon } from "@squidlab/phosphor-solid/arrow-down";
import { ArrowSquareOutIcon } from "@squidlab/phosphor-solid/arrow-square-out";
import { ArrowUpIcon } from "@squidlab/phosphor-solid/arrow-up";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { FastForwardIcon } from "@squidlab/phosphor-solid/fast-forward";
import { LightningIcon } from "@squidlab/phosphor-solid/lightning";
import { LightningSlashIcon } from "@squidlab/phosphor-solid/lightning-slash";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { RewindIcon } from "@squidlab/phosphor-solid/rewind";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { Dynamic } from "solid-js/web";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";

interface SequenceEditorToolbarProps {
  canOpenCue: () => boolean;
  canDuplicateCue: () => boolean;
  canDeleteRow: () => boolean;
  deleteLabel: () => string;
  canMoveUp: () => boolean;
  canMoveDown: () => boolean;
  hasPreviewableCue: () => boolean;
  canJumpPreview: () => boolean;
  previewEnabled: () => boolean;
  previewApplyTransitions: () => boolean;
  previewTrackValues: () => boolean;
  openCue: () => void;
  duplicateCue: () => void;
  deleteRow: () => void;
  moveUp: () => void;
  moveDown: () => void;
  previewBack: () => void;
  previewGo: () => void;
  previewJump: () => void;
  togglePreview: () => void;
  togglePreviewTransitions: () => void;
  togglePreviewTracking: () => void;
}

/** Renders sequence row actions and preview transport controls. */
export function SequenceEditorToolbar(props: SequenceEditorToolbarProps) {
  return (
    <PanelToolbar
      class="sticky top-0 z-50"
      data-sequence-editor-toolbar="true"
      left={
        <>
          <ToolbarButton
            tooltip="Open Cue Editor"
            label="Open cue part editor"
            disabled={!props.canOpenCue()}
            onClick={props.openCue}
          >
            <ArrowSquareOutIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            tooltip="Duplicate Cue (Cmd/Ctrl+D)"
            label="Duplicate cue"
            disabled={!props.canDuplicateCue()}
            onClick={props.duplicateCue}
          >
            <CopySimpleIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            tooltip={props.deleteLabel()}
            label={props.deleteLabel()}
            disabled={!props.canDeleteRow()}
            onClick={props.deleteRow}
            variant="danger"
          >
            <TrashIcon class="size-4" aria-hidden />
          </ToolbarButton>

          <ToolbarSeparator />

          <ToolbarButton
            tooltip="Move Cue Up (Alt+Up)"
            label="Move cue up"
            disabled={!props.canMoveUp()}
            onClick={props.moveUp}
          >
            <ArrowUpIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            tooltip="Move Cue Down (Alt+Down)"
            label="Move cue down"
            disabled={!props.canMoveDown()}
            onClick={props.moveDown}
          >
            <ArrowDownIcon class="size-4" aria-hidden />
          </ToolbarButton>
        </>
      }
      right={
        <>
          <ToolbarButton
            tooltip="Preview Back"
            label="Preview back"
            disabled={!props.hasPreviewableCue()}
            onClick={props.previewBack}
          >
            <RewindIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            tooltip="Preview Go"
            label="Preview go"
            disabled={!props.hasPreviewableCue()}
            onClick={props.previewGo}
          >
            <FastForwardIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            tooltip="Jump Preview to Selected Cue"
            label="Jump preview to selected cue"
            disabled={!props.canJumpPreview()}
            onClick={props.previewJump}
          >
            <ArrowCircleRightIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarSeparator />

          <ToggleToolbarButton
            tooltip={props.previewEnabled() ? "Stop Preview" : "Start Preview"}
            label={props.previewEnabled() ? "Stop preview" : "Start preview"}
            pressed={props.previewEnabled()}
            onClick={props.togglePreview}
          >
            <Dynamic
              component={props.previewEnabled() ? StopIcon : PlayIcon}
              class="size-4"
              aria-hidden
            />
          </ToggleToolbarButton>
          <ToggleToolbarButton
            tooltip={
              props.previewApplyTransitions()
                ? "Disable Preview Transitions"
                : "Enable Preview Transitions"
            }
            disabled={!props.previewEnabled()}
            label="Toggle preview transitions"
            pressed={props.previewApplyTransitions()}
            onClick={props.togglePreviewTransitions}
          >
            <Dynamic
              component={
                props.previewApplyTransitions()
                  ? LightningIcon
                  : LightningSlashIcon
              }
              class="size-4"
              aria-hidden
            />
          </ToggleToolbarButton>
          <ToggleToolbarButton
            tooltip={
              props.previewTrackValues()
                ? "Disable Preview Tracking"
                : "Enable Preview Tracking"
            }
            disabled={!props.previewEnabled()}
            label="Toggle preview tracking"
            pressed={props.previewTrackValues()}
            onClick={props.togglePreviewTracking}
          >
            <Dynamic
              component={
                props.previewTrackValues() ? ArrowsClockwiseIcon : StopIcon
              }
              class="size-4"
              aria-hidden
            />
          </ToggleToolbarButton>
        </>
      }
    />
  );
}
