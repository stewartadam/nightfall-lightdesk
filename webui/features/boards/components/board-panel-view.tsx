// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { FrameCornersIcon } from "@squidlab/phosphor-solid/frame-corners";
import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import { HandTapIcon } from "@squidlab/phosphor-solid/hand-tap";
import { PencilSimpleIcon } from "@squidlab/phosphor-solid/pencil-simple";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { StackIcon } from "@squidlab/phosphor-solid/stack";
import { TextTIcon } from "@squidlab/phosphor-solid/text-t";
import { createUniqueId, For, Show } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../../components/ui/dropdown-menu";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { SegmentedTabs } from "../../../components/ui/segmented-tabs";
import { TOOLBAR_BUTTON_CLASS } from "../../../components/ui/toolbar-button";
import Tooltip from "../../../components/ui/tooltip";
import { Button } from "../../../components/ui/visual-language/button";
import type { BoardPanelController } from "../controllers/board-panel-controller";
import {
  BOARD_TARGET_TYPE_LABELS,
  BOARD_TARGET_TYPES,
  boardDisplayName,
} from "../model/board-model";
import { BoardGrid } from "./board-grid";
import { BoardSettings } from "./board-properties";

interface BoardPanelViewProps {
  controller: BoardPanelController;
}

/** Menu of elements the operator can add to the shown board while editing. */
function AddElementMenu(props: BoardPanelViewProps) {
  const controller = props.controller;
  return (
    <DropdownMenu
      align="start"
      placement="below"
      triggerLabel="Add to board"
      triggerClass={TOOLBAR_BUTTON_CLASS}
      trigger={
        <Tooltip content={() => "Add to board"}>
          <span class="inline-flex items-center gap-1">
            <PlusIcon class="size-4" aria-hidden />
            <CaretDownIcon class="size-3" aria-hidden />
          </span>
        </Tooltip>
      }
    >
      <For each={BOARD_TARGET_TYPES}>
        {(targetType) => (
          <DropdownMenuItem
            icon={SquaresFourIcon}
            disabled={controller.catalog()[targetType].length === 0}
            onClick={() =>
              controller.addElement({ type: "Target", targetType })
            }
          >
            {BOARD_TARGET_TYPE_LABELS[targetType].one} button
          </DropdownMenuItem>
        )}
      </For>
      <DropdownMenuSeparator />
      <For each={BOARD_TARGET_TYPES}>
        {(targetType) => (
          <DropdownMenuItem
            icon={StackIcon}
            onClick={() =>
              controller.addElement({ type: "Collection", targetType })
            }
          >
            All {BOARD_TARGET_TYPE_LABELS[targetType].many.toLowerCase()}
          </DropdownMenuItem>
        )}
      </For>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        icon={FrameCornersIcon}
        onClick={() => controller.addElement({ type: "Frame" })}
      >
        Frame
      </DropdownMenuItem>
      <DropdownMenuItem
        icon={TextTIcon}
        onClick={() => controller.addElement({ type: "Label" })}
      >
        Label
      </DropdownMenuItem>
    </DropdownMenu>
  );
}

/**
 * Offers a panel with no board of its own the existing boards to show, or a new one. Shown
 * when the panel was opened without a board or its saved board no longer exists.
 */
function BoardChooser(props: BoardPanelViewProps) {
  const controller = props.controller;
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-neutral-400">
      <p>
        Boards hold buttons for clips, groups, blueprints and masters, arranged
        the way you want them.
      </p>
      <Show when={controller.boardList().length > 0}>
        <div
          class="flex max-w-full flex-wrap justify-center gap-2"
          role="group"
          aria-label="Boards"
        >
          <For each={controller.boardList()}>
            {(board) => (
              <Button
                variant="subtle"
                onClick={() => controller.selectBoard(board.identifiers.uid)}
              >
                {boardDisplayName(board)}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Button variant="primary" onClick={() => controller.createBoard()}>
        New board
      </Button>
    </div>
  );
}

/** Renders a Board panel: the mode switcher, edit tools and settings above the board's grid. */
export function BoardPanelView(props: BoardPanelViewProps) {
  const controller = props.controller;
  const contentId = `board-${createUniqueId()}`;
  /** Operate and Edit choices of the board mode switcher. */
  const modes = [
    {
      key: "operate",
      label: (
        <span class="inline-flex items-center gap-1">
          <HandTapIcon class="size-3.5" aria-hidden />
          Operate
        </span>
      ),
    },
    {
      key: "edit",
      label: (
        <span class="inline-flex items-center gap-1">
          <PencilSimpleIcon class="size-3.5" aria-hidden />
          Edit
        </span>
      ),
    },
  ] as const;
  return (
    <div class="flex h-full min-h-0 flex-col" data-panel-kind="boards">
      <Show when={controller.board()}>
        {(board) => (
          <PanelToolbar
            left={
              <Show when={controller.editing()}>
                <AddElementMenu controller={controller} />
              </Show>
            }
            right={
              <>
                <SegmentedTabs
                  id={`${contentId}-mode`}
                  density="compact"
                  label="Board mode"
                  contentId={contentId}
                  options={modes}
                  value={controller.editing() ? "edit" : "operate"}
                  onChange={(mode) => controller.setEditing(mode === "edit")}
                />
                <DropdownMenu
                  align="end"
                  placement="below"
                  triggerLabel="Board settings"
                  triggerClass={TOOLBAR_BUTTON_CLASS}
                  contentLabel="Board settings"
                  open={controller.boardSettingsOpen()}
                  onOpenChange={controller.setBoardSettingsOpen}
                  trigger={
                    <Tooltip content={() => "Board settings"}>
                      <GearSixIcon class="size-4" aria-hidden />
                    </Tooltip>
                  }
                >
                  <div class="w-72">
                    <BoardSettings controller={controller} board={board()} />
                  </div>
                </DropdownMenu>
              </>
            }
          />
        )}
      </Show>
      <div
        id={contentId}
        role="tabpanel"
        class="relative min-h-0 flex-1 overflow-auto"
      >
        <Show
          when={controller.board()}
          fallback={
            <Show when={!controller.awaitingNewBoard()}>
              <BoardChooser controller={controller} />
            </Show>
          }
        >
          {(board) => (
            <>
              <BoardGrid controller={controller} board={board()} />
              <Show
                when={
                  !controller.editing() && (board().elements ?? []).length === 0
                }
              >
                <p class="pointer-events-none absolute inset-x-0 top-0 p-4 text-sm text-neutral-500">
                  This board is empty. Switch to Edit to add buttons, or drag
                  clips, groups, blueprints or masters onto it from their
                  panels.
                </p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
