// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { ToolbarSeparator } from "../../ui/panel-toolbar";
import { ToolbarButton } from "../../ui/toolbar-button";

interface CrudRunStopButtonsProps {
  /** Plural noun the buttons act on, such as "clips" or "macros". */
  noun: string;
  /** Whether any selected object is stopped and can run. */
  canRun: boolean;
  /** Whether any selected object is running and can stop. */
  canStop: boolean;
  /** Runs the selected objects that are stopped. */
  onRun: () => void;
  /** Stops the selected objects that are running. */
  onStop: () => void;
}

/**
 * Renders a CRUD panel's Run and Stop toolbar buttons side by side, after a divider that
 * separates them from the add, edit and delete buttons.
 */
export function CrudRunStopButtons(props: CrudRunStopButtonsProps) {
  return (
    <>
      <ToolbarSeparator />
      <ToolbarButton
        tooltip={`Run selected ${props.noun}`}
        type="button"
        onClick={props.onRun}
        disabled={!props.canRun}
        label={`Run selected ${props.noun}`}
      >
        <PlayIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        tooltip={`Stop selected ${props.noun}`}
        type="button"
        onClick={props.onStop}
        disabled={!props.canStop}
        label={`Stop selected ${props.noun}`}
      >
        <StopIcon class="size-4" aria-hidden />
      </ToolbarButton>
    </>
  );
}
