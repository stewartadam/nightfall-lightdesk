// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowDownIcon } from "@squidlab/phosphor-solid/arrow-down";
import { ArrowUpIcon } from "@squidlab/phosphor-solid/arrow-up";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { DivideIcon } from "@squidlab/phosphor-solid/divide";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { ToolbarSeparator } from "../../../../components/ui/panel-toolbar";
import { Toolbar } from "../../../../components/ui/toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../../components/ui/toolbar-button";
import type * as types from "../../../../types";
import type { StepFxEditorViewController } from "../../controllers/step-fx-editor-view-controller";
import { StepFxContributionTabs } from "./step-fx-contribution-tabs";
import { StepFxOverridesControl } from "./step-fx-overrides-control";

/** Renders step mutations first and track-level controls against the far edge. */
export function StepFxStepActionToolbar(props: {
  editor: StepFxEditorViewController;
  stepFx: types.StepFx;
  lane: types.FxLane;
  track: types.FxTrack | undefined;
}) {
  const { session, selection, popovers, slide, edit } = props.editor;
  /** Reports whether no step rows are selected for the selection-scoped actions. */
  const selectionEmpty = () => selection.selectedStepUids().size === 0;

  return (
    <Toolbar
      class="flex h-12 min-w-0 shrink-0 items-center gap-0.5 border-b border-neutral-700 bg-neutral-900 px-2"
      data-step-fx-step-actions-toolbar
      label="Step edit actions"
    >
      <ToolbarButton
        label="Add step"
        onClick={() => (props.track ? edit.insertStep() : edit.addTrack())}
      >
        <PlusIcon class="size-4" weight="bold" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Move selected steps up"
        onClick={() => edit.moveSteps(-1)}
        disabled={selectionEmpty()}
        classList={{
          "cursor-not-allowed opacity-40": selectionEmpty(),
        }}
      >
        <ArrowUpIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Move selected steps down"
        onClick={() => edit.moveSteps(1)}
        disabled={selectionEmpty()}
        classList={{
          "cursor-not-allowed opacity-40": selectionEmpty(),
        }}
      >
        <ArrowDownIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Duplicate selected steps"
        onClick={edit.duplicateSteps}
        disabled={selectionEmpty()}
        classList={{
          "cursor-not-allowed opacity-40": selectionEmpty(),
        }}
      >
        <CopySimpleIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Divide step widths evenly"
        onClick={edit.distributeWidthsEvenly}
        disabled={(props.track?.steps.length ?? 0) < 2}
        classList={{
          "cursor-not-allowed opacity-40": (props.track?.steps.length ?? 0) < 2,
        }}
      >
        <DivideIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Delete selected steps"
        onClick={edit.deleteSteps}
        disabled={selectionEmpty()}
        classList={{
          "bg-red-500/20 text-red-100 hover:bg-red-500/30": !selectionEmpty(),
          "cursor-not-allowed opacity-40": selectionEmpty(),
        }}
      >
        <TrashIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarSeparator data-step-fx-selection-mode-separator />
      <ToggleToolbarButton
        label="Toggle selection mode"
        pressed={selection.selectionMode()}
        onClick={selection.toggleSelectionMode}
      >
        <SelectionIcon class="size-4" aria-hidden />
      </ToggleToolbarButton>
      <div class="ml-auto flex min-w-0 shrink-0 items-center gap-1">
        <StepFxContributionTabs
          lane={props.lane}
          trackKind={slide.pendingContributionTrack() ?? selection.trackKind()}
          previewSessionId={session.previewSessionId}
          onSelectTrack={slide.selectContributionTrack}
          onRemoveTrack={edit.removeTrack}
        />
        <ToolbarSeparator data-step-fx-overrides-separator />
        <StepFxOverridesControl
          lane={props.lane}
          overall={props.stepFx}
          open={popovers.openPopover() === "overrides"}
          onOpenChange={(isOpen) =>
            popovers.setEditorPopoverOpen("overrides", isOpen)
          }
          onLaneChange={edit.replaceLane}
        />
      </div>
    </Toolbar>
  );
}
