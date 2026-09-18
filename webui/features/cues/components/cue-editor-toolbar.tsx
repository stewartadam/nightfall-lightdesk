// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { EyeIcon } from "@squidlab/phosphor-solid/eye";
import { EyeSlashIcon } from "@squidlab/phosphor-solid/eye-slash";
import { FastForwardIcon } from "@squidlab/phosphor-solid/fast-forward";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { Dynamic } from "solid-js/web";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import { ToggleToolbarButton } from "../../../components/ui/toolbar-button";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import type { GridColumn } from "../../../lib/data-grid-types";
import type { DisplayMode } from "../model/cue-editor-model";

interface CueEditorToolbarProps {
  panelId: string;
  columns: () => readonly GridColumn[];
  displayMode: () => DisplayMode;
  isReleaseCue: boolean;
  showTrackedValues: () => boolean;
  previewActive: () => boolean;
  previewApplyTransitions: () => boolean;
  setDisplayMode: (mode: DisplayMode) => void;
  toggleTrackedValues: () => void;
  togglePreview: () => void;
  togglePreviewTransitions: () => void;
}

/** Renders cue display-mode, visibility, and preview controls. */
export function CueEditorToolbar(props: CueEditorToolbarProps) {
  return (
    <PanelToolbar
      data-cue-editor-toolbar="true"
      left={
        <>
          <ToggleToolbarButton
            tooltip="Display values"
            disabled={props.isReleaseCue}
            label="Switch to values display mode"
            pressed={props.displayMode() === "values"}
            size="labeled"
            onClick={() => props.setDisplayMode("values")}
          >
            Values
          </ToggleToolbarButton>
          <ToggleToolbarButton
            tooltip="Display timings"
            label="Switch to timings display mode"
            pressed={props.displayMode() === "timings"}
            size="labeled"
            onClick={() => props.setDisplayMode("timings")}
          >
            Timings
          </ToggleToolbarButton>
        </>
      }
      right={
        <>
          <ToggleToolbarButton
            tooltip={
              props.showTrackedValues()
                ? "Hide tracked values"
                : "Show tracked values"
            }
            disabled={props.isReleaseCue}
            label="Toggle tracked values"
            pressed={props.showTrackedValues()}
            onClick={props.toggleTrackedValues}
          >
            <Dynamic
              component={props.showTrackedValues() ? EyeIcon : EyeSlashIcon}
              class="size-4"
              aria-hidden
            />
          </ToggleToolbarButton>
          <ToolbarSeparator />
          <ToggleToolbarButton
            tooltip={props.previewActive() ? "Stop preview" : "Start preview"}
            label="Toggle cue preview"
            pressed={props.previewActive()}
            onClick={props.togglePreview}
          >
            <Dynamic
              component={props.previewActive() ? StopIcon : PlayIcon}
              class="size-4"
              aria-hidden
            />
          </ToggleToolbarButton>
          <ToggleToolbarButton
            tooltip={
              props.previewApplyTransitions()
                ? "Skip preview transitions"
                : "Apply preview transitions"
            }
            label="Toggle preview transitions"
            pressed={!props.previewApplyTransitions()}
            onClick={props.togglePreviewTransitions}
          >
            <FastForwardIcon class="size-4" aria-hidden />
          </ToggleToolbarButton>
          <ToolbarSeparator />
          <ColumnVisibilityMenu
            scope={props.panelId}
            columns={props.columns()}
          />
        </>
      }
    />
  );
}
