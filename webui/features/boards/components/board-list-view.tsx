// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowSquareOutIcon } from "@squidlab/phosphor-solid/arrow-square-out";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { For, Show } from "solid-js";
import { InlineRenameField } from "../../../components/ui/inline-rename-field";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import CrudListDataGrid from "../../../components/widgets/crud/crud-list-data-grid";
import CrudPanelSearch from "../../../components/widgets/crud/crud-panel-search";
import {
  CRUD_CARD_CLASS,
  CRUD_GRID_DRAG_BOX_CLASS,
} from "../../../components/widgets/crud/crud-panel-styles";
import CrudScrollArea from "../../../components/widgets/crud/crud-scroll-area";
import CrudViewModeToggle from "../../../components/widgets/crud/crud-view-mode-toggle";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import EntityEditorModal from "../../../components/widgets/entity-editor-dialog";
import type { Board } from "../../../types";
import type { BoardListController } from "../controllers/board-list-controller";
import { boardDisplayName } from "../model/board-model";

interface BoardListViewProps {
  controller: BoardListController;
}

/** Describes how many elements a board holds, for cards and rows. */
function elementCountLabel(board: Board): string {
  const count = board.elements?.length ?? 0;
  return `${count} element${count === 1 ? "" : "s"}`;
}

/** Describes whether the layout switcher lists a board. */
function switcherLabel(board: Board): string {
  return board.shown_in_switcher ? "In switcher" : "Hidden from switcher";
}

/** Renders one board card with its inline label editor; clicking it opens the board. */
function BoardCard(props: BoardListViewProps & { board: Board }) {
  const controller = props.controller;
  const uid = () => props.board.identifiers.uid;
  /** Whether selection mode currently includes this card. */
  const isSelected = () =>
    controller.crud.selectionMode() &&
    controller.crud.selectedUidSet().has(uid());

  return (
    <button
      type="button"
      aria-label={`Board ${props.board.identifiers.id}: ${boardDisplayName(props.board)}, ${elementCountLabel(props.board)}`}
      data-crud-select-id={uid()}
      onClick={(event) => controller.handleBoardClick(props.board, event)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.openBoardContextMenu(
          props.board,
          event.clientX,
          event.clientY,
        );
      }}
      class={CRUD_CARD_CLASS}
      data-selectable-surface
      data-selected={isSelected()}
      aria-pressed={isSelected()}
    >
      <div
        class="nf-crud-card-title flex min-w-0 items-center"
        title={props.board.identifiers.label}
      >
        <Show
          when={controller.crud.editingCardLabelUid() === uid()}
          fallback={
            <span class="min-w-0 truncate">
              {boardDisplayName(props.board)}
            </span>
          }
        >
          <InlineRenameField
            ariaLabel="Board card label"
            allowEmpty
            value={props.board.identifiers.label}
            onClose={() => controller.crud.finishCardLabelEdit()}
            onCommit={(label) =>
              controller.updateBoardLabel(props.board, label)
            }
          />
        </Show>
      </div>
      <div class="nf-crud-card-detail truncate">
        {switcherLabel(props.board)}
      </div>
      <div class="nf-crud-card-meta flex items-center justify-between gap-2 whitespace-nowrap">
        <span class="min-w-0 truncate">Board {props.board.identifiers.id}</span>
        <span class="shrink-0">{elementCountLabel(props.board)}</span>
      </div>
    </button>
  );
}

/** Renders boards in the editable row grid; Alt+click or Enter opens a board. */
function BoardRowList(props: BoardListViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rows={controller.boardList()}
        rowKey={(board) => board.identifiers.uid}
        editRequest={controller.crud.labelEditRequest()}
        selectionRequest={controller.crud.listSelectionRequest()}
        columns={[
          {
            id: "id",
            title: "ID",
            width: 70,
            value: (board) => board.identifiers.id,
          },
          {
            id: "label",
            title: "Label",
            width: 260,
            minWidth: 160,
            value: (board) => board.identifiers.label,
            onEdit: controller.updateBoardLabel,
          },
          {
            id: "elements",
            title: "Elements",
            width: 100,
            value: (board) => board.elements?.length ?? 0,
          },
          {
            id: "switcher",
            title: "Switcher",
            width: 110,
            value: (board) => (board.shown_in_switcher ? "Shown" : "Hidden"),
          },
        ]}
        isRowSelected={(board) =>
          controller.crud.selectedUidSet().has(board.identifiers.uid)
        }
        onSelectionChange={(rows) =>
          controller.crud.select(rows.map((board) => board.identifiers.uid))
        }
        onDeleteRequested={controller.crud.requestDelete}
        multiSelectOnPlainClick={controller.crud.selectionMode()}
        onRowClick={(board, modifiers) => {
          if (controller.crud.dialogOpen() || !modifiers.altKey) return;
          controller.openBoard(board);
        }}
        onRowContextMenu={(board, _modifiers, position) => {
          if (controller.crud.dialogOpen()) return;
          controller.openBoardContextMenu(board, position.x, position.y);
        }}
      />
    </div>
  );
}

/** Presents the Boards list: the standard toolbar, dialogs, and grid or list of boards. */
export function BoardListView(props: BoardListViewProps) {
  const controller = props.controller;
  return (
    <div
      class="flex h-full min-h-0 flex-col"
      data-panel-kind="board-list"
      data-panel-id={controller.panelId}
    >
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip="Add board (N)"
              type="button"
              onClick={controller.handleCreate}
              label="Add board"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip="Open selected board (Enter)"
              type="button"
              onClick={controller.handleOpenSelected}
              disabled={controller.crud.selectedCount() !== 1}
              label="Open selected board"
            >
              <ArrowSquareOutIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip="Edit selected board (E)"
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.crud.selectedCount() !== 1}
              label="Edit selected board"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              count={controller.crud.selectedCount()}
              tooltip={
                controller.crud.selectedCount() > 0
                  ? `Delete selected boards (${controller.crud.selectedCount()})`
                  : "Delete selected boards (Delete/Backspace)"
              }
              type="button"
              onClick={controller.crud.requestDelete}
              disabled={controller.crud.selectedCount() === 0}
              label="Delete selected boards"
            >
              <TrashIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <Show when={controller.crud.viewMode() === "grid"}>
              <ToolbarSeparator />
              <ToggleToolbarButton
                tooltip={`${controller.crud.selectionMode() ? "Exit" : "Enter"} selection mode (V)`}
                type="button"
                onClick={controller.crud.handleToggleSelectionMode}
                pressed={controller.crud.selectionMode()}
                label="Toggle selection mode"
              >
                <SelectionIcon class="size-4" aria-hidden />
              </ToggleToolbarButton>
            </Show>
          </>
        }
        right={
          <>
            <CrudPanelSearch
              search={controller.crud.search}
              placeholder="Search boards"
            />
            <CrudViewModeToggle
              viewMode={controller.crud.viewMode()}
              onViewModeChange={controller.crud.setViewMode}
            />
          </>
        }
      />

      <EntityEditorModal
        isOpen={controller.isEditModalOpen()}
        title="Edit board"
        submitLabel="Save"
        initialId={controller.editingBoard()?.identifiers.id ?? 1}
        initialLabel={controller.editingBoard()?.identifiers.label ?? ""}
        idLabel="Board ID"
        labelLabel="Board label"
        onCancel={controller.closeEditor}
        onSubmit={controller.handleEditSubmit}
      />
      <DeleteConfirmModal
        isOpen={controller.crud.isDeleteModalOpen()}
        title="Delete selected boards"
        message={`Delete ${controller.crud.selectedCount()} selected board(s)? Open Board panels showing them close their board.`}
        confirmLabel="Delete"
        onCancel={() => controller.crud.closeDeleteConfirm()}
        onConfirm={controller.confirmDeleteSelected}
      />

      <CrudScrollArea
        viewMode={controller.crud.viewMode()}
        aria-label="Boards scroll area"
      >
        <div
          class="min-h-0 min-h-full"
          classList={{
            "h-full": controller.crud.viewMode() !== "grid",
            "p-4": controller.crud.viewMode() === "grid",
            relative: controller.crud.viewMode() === "grid",
            "select-none":
              controller.crud.selectionMode() &&
              controller.crud.viewMode() === "grid",
          }}
          onPointerDown={controller.crud.gridDragSelection.onPointerDown}
          onPointerMove={controller.crud.gridDragSelection.onPointerMove}
          onPointerUp={controller.crud.gridDragSelection.onPointerUp}
          onPointerCancel={controller.crud.gridDragSelection.onPointerCancel}
          onClick={(event) => {
            if (controller.crud.gridDragSelection.consumeSuppressedClick()) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            controller.crud.gridClickSelection.handleBackgroundClick(event);
          }}
          onKeyDown={(event) => {
            // Background clicks only clear selection; keyboard users use Escape (a panel shortcut).
            if (event.key === "Escape") return;
          }}
        >
          <Show
            when={controller.boardList().length > 0}
            fallback={
              <div class="p-4 text-neutral-500">
                {controller.allBoardList().length > 0
                  ? "No matching boards"
                  : "No boards yet. Add one with the + button."}
              </div>
            }
          >
            <Show
              when={controller.crud.viewMode() === "grid"}
              fallback={<BoardRowList controller={controller} />}
            >
              <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
                <For each={controller.boardList()}>
                  {(board) => (
                    <BoardCard controller={controller} board={board} />
                  )}
                </For>
              </div>
            </Show>
          </Show>
          <Show
            when={
              controller.crud.viewMode() === "grid" &&
              controller.crud.gridDragSelection.dragBox()
            }
          >
            <div
              class={CRUD_GRID_DRAG_BOX_CLASS}
              data-crud-drag-box=""
              style={{
                left: `${controller.crud.gridDragSelection.dragBox()?.left}px`,
                top: `${controller.crud.gridDragSelection.dragBox()?.top}px`,
                width: `${controller.crud.gridDragSelection.dragBox()?.width}px`,
                height: `${controller.crud.gridDragSelection.dragBox()?.height}px`,
              }}
            />
          </Show>
        </div>
      </CrudScrollArea>
    </div>
  );
}
