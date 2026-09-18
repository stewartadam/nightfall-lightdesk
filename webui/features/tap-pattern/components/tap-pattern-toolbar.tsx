// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { EraserIcon } from "@squidlab/phosphor-solid/eraser";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { QueueIcon } from "@squidlab/phosphor-solid/queue";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { Dynamic } from "solid-js/web";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";

interface TapPatternToolbarProps {
  canCreateSequence: boolean;
  hasTaps: boolean;
  isCaptureArmed: boolean;
  onClear: () => void;
  onCreateSequence: () => void;
  onDeleteLast: () => void;
  onToggleCapture: () => void;
}

/** Presents tap capture and sequence-generation actions from supplied state. */
export function TapPatternToolbar(props: TapPatternToolbarProps) {
  return (
    <PanelToolbar
      left={
        <div
          aria-label="Tap capture controls"
          class="flex items-center gap-0.5"
          data-tap-control="true"
          role="toolbar"
        >
          <ToggleToolbarButton
            label={props.isCaptureArmed ? "Disarm" : "Arm"}
            pressed={props.isCaptureArmed}
            onClick={props.onToggleCapture}
          >
            <Dynamic
              component={props.isCaptureArmed ? StopIcon : PlayIcon}
              class="size-4"
              aria-hidden
            />
          </ToggleToolbarButton>
          <ToolbarButton
            label="Delete last"
            disabled={!props.hasTaps}
            onClick={props.onDeleteLast}
          >
            <EraserIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label="Restart"
            disabled={!props.hasTaps}
            onClick={props.onClear}
          >
            <ArrowsClockwiseIcon class="size-4" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label="Create Sequence"
            disabled={!props.canCreateSequence}
            onClick={props.onCreateSequence}
          >
            <QueueIcon class="size-4" aria-hidden />
          </ToolbarButton>
        </div>
      }
    />
  );
}
