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
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import CrudInlineLabelEditor from "../../../components/widgets/crud/crud-inline-label-editor";
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
    controller.selectionMode() && controller.selectedBoardUidSet().has(uid());

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
        <CrudInlineLabelEditor
          ariaLabel="Board card label"
          class="min-w-0 truncate"
          editing={controller.editingCardLabelUid() === uid()}
          label={props.board.identifiers.label}
          onCancel={() => controller.setEditingCardLabelUid(null)}
          onCommit={(label) => controller.updateBoardLabel(props.board, label)}
        >
          {boardDisplayName(props.board)}
        </CrudInlineLabelEditor>
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
        editRequest={controller.labelEditRequest()}
        selectionRequest={controller.listSelectionRequest()}
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
          controller.selectedBoardUidSet().has(board.identifiers.uid)
        }
        onSelectionChange={(rows) =>
          controller.selectBoards(rows.map((board) => board.identifiers.uid))
        }
        onDeleteRequested={controller.handleDeleteSelected}
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={(board, modifiers) => {
          if (controller.dialogOpen() || !modifiers.altKey) return;
          controller.openBoard(board);
        }}
        onRowContextMenu={(board, _modifiers, position) => {
          if (controller.dialogOpen()) return;
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
              disabled={controller.selectedCount() !== 1}
              label="Open selected board"
            >
              <ArrowSquareOutIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip="Edit selected board (E)"
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.selectedCount() !== 1}
              label="Edit selected board"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              count={controller.selectedCount()}
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected boards (${controller.selectedCount()})`
                  : "Delete selected boards (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={controller.selectedCount() === 0}
              label="Delete selected boards"
            >
              <TrashIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <Show when={controller.viewMode() === "grid"}>
              <ToolbarSeparator />
              <ToggleToolbarButton
                tooltip={`${controller.selectionMode() ? "Exit" : "Enter"} selection mode (V)`}
                type="button"
                onClick={controller.handleToggleSelectionMode}
                pressed={controller.selectionMode()}
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
              search={controller.search}
              placeholder="Search boards"
            />
            <CrudViewModeToggle
              viewMode={controller.viewMode()}
              onViewModeChange={controller.setViewMode}
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
        isOpen={controller.isDeleteModalOpen()}
        title="Delete selected boards"
        message={`Delete ${controller.selectedCount()} selected board(s)? Open Board panels showing them close their board.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />

      <CrudScrollArea
        viewMode={controller.viewMode()}
        aria-label="Boards scroll area"
      >
        <div
          class="min-h-0 min-h-full"
          classList={{
            "h-full": controller.viewMode() !== "grid",
            "p-4": controller.viewMode() === "grid",
            relative: controller.viewMode() === "grid",
            "select-none":
              controller.selectionMode() && controller.viewMode() === "grid",
          }}
          onPointerDown={controller.gridDragSelection.onPointerDown}
          onPointerMove={controller.gridDragSelection.onPointerMove}
          onPointerUp={controller.gridDragSelection.onPointerUp}
          onPointerCancel={controller.gridDragSelection.onPointerCancel}
          onClick={(event) => {
            if (controller.gridDragSelection.consumeSuppressedClick()) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            controller.gridClickSelection.handleBackgroundClick(event);
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
              when={controller.viewMode() === "grid"}
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
              controller.viewMode() === "grid" &&
              controller.gridDragSelection.dragBox()
            }
          >
            <div
              class={CRUD_GRID_DRAG_BOX_CLASS}
              data-crud-drag-box=""
              style={{
                left: `${controller.gridDragSelection.dragBox()?.left}px`,
                top: `${controller.gridDragSelection.dragBox()?.top}px`,
                width: `${controller.gridDragSelection.dragBox()?.width}px`,
                height: `${controller.gridDragSelection.dragBox()?.height}px`,
              }}
            />
          </Show>
        </div>
      </CrudScrollArea>
    </div>
  );
}
