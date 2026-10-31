// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowSquareOutIcon } from "@squidlab/phosphor-solid/arrow-square-out";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import { createCrudListState } from "../../../components/widgets/crud/model/crud-list-state";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { boards } from "../../../state/appStores";
import { pushToast } from "../../../state/notifications";
import type { Board } from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import {
  buildDeleteBoardCommand,
  buildRenameBoardCommand,
  buildSetBoardLabelCommand,
  sortBoardsById,
} from "../model/board-model";
import { sendBoardCommand } from "../services/board-commands";
import { createBoardInPanel, openBoardPanel } from "../services/board-panels";

/** Storage key for the Boards list's grid or list presentation. */
const VIEW_MODE_KEY = "board-list";

export interface BoardListControllerOptions {
  /** Dockview ID of the Boards list panel. */
  panelId: string;
}

/**
 * Owns the Boards list panel: search, grid and list selection, and the commands that create,
 * open, renumber, rename and delete boards. Opening a board shows it in its own Board panel.
 */
export function createBoardListController(options: BoardListControllerOptions) {
  const $boards = useShallowStore(boards);
  const panelId = options.panelId;
  const crud = createCrudListState<Board>({
    panelId,
    searchLabel: "Search boards",
    viewModeKey: VIEW_MODE_KEY,
    orderedUids: (): readonly string[] => boardUids(),
    otherDialogOpen: () => isEditModalOpen(),
  });
  const {
    search,
    selectionMode,
    viewMode,
    setViewMode,
    setSelectionModeEnabled,
    selectedCount,
    select: selectBoards,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    dialogOpen,
    labelEditRequest,
    listSelectionRequest,
    setListSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    handleToggleSelectionMode,
    handleEscape,
    gridDragSelection,
    gridClickSelection,
  } = crud;
  const selectedBoardUids = crud.selectedUids;
  const selectedBoardUidSet = crud.selectedUidSet;
  const [isEditModalOpen, setIsEditModalOpen] = createSignal(false);
  const [editingBoardUid, setEditingBoardUid] = createSignal<string | null>(
    null,
  );

  /** Lists every board in ID order before the search filter. */
  const allBoardList = createMemo(() => sortBoardsById($boards()));

  /** Lists the boards matching the toolbar search by ID or label. */
  const boardList = createMemo(() =>
    allBoardList().filter((board) =>
      search.matches([board.identifiers.id, board.identifiers.label]),
    ),
  );

  /** UIDs of the boards currently shown, in display order, for range selection. */
  const boardUids = createMemo(() =>
    boardList().map((board) => board.identifiers.uid),
  );
  /** Resolves the first selected board, which the editor dialog and Properties act on. */
  const selectedBoard = createMemo(() => {
    const [uid] = selectedBoardUids();
    return uid ? $boards()[uid] : undefined;
  });

  /** Renames a board, ignoring unchanged labels. */
  const updateBoardLabel = (board: Board, label: string) => {
    if (label === board.identifiers.label) return;
    sendBoardCommand(buildSetBoardLabelCommand(board.identifiers.id, label));
  };

  usePropertiesInspector(
    panelId,
    "Board",
    () => (
      <CrudLabelProperties
        entry={selectedCount() === 1 ? selectedBoard() : null}
        entityName="Board"
        getId={(board) => board.identifiers.id}
        getLabel={(board) => board.identifiers.label}
        onLabelCommit={updateBoardLabel}
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Selects a board requested by the object palette, clearing a search that hides it. */
  useRevealObjectCapability(
    panelId,
    (request) => {
      const board = $boards()[request.uid];
      if (!board) return;
      /** Selects the requested board once any search reset has settled. */
      const reveal = () => {
        setViewMode("list");
        setSelectionModeEnabled(false);
        selectBoards([board.identifiers.uid]);
        setListSelectionRequest({ row: board, requestId: request.requestId });
      };
      if (!boardList().includes(board) && search.isFiltering()) {
        search.clear();
        setTimeout(reveal, 0);
      } else {
        reveal();
      }
    },
    { accepts: (payload) => payload.type === "board" },
  );

  /** Shows `board` in its own Board panel, focusing the one already showing it. */
  const openBoard = (board: Board) => openBoardPanel(board.identifiers.uid);

  /** Starts inline label editing for `board` in the current presentation. */
  const requestBoardLabelEdit = (board: Board) =>
    crud.requestLabelEdit(board, board.identifiers.uid);

  /** Opens the row actions for `board`, selecting it first unless it is already selected. */
  const openBoardContextMenu = (board: Board, x: number, y: number) => {
    if (!selectedBoardUidSet().has(board.identifiers.uid))
      selectBoards([board.identifiers.uid]);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "open-board",
          label: "Open Board",
          icon: ArrowSquareOutIcon,
          shortcut: "Enter",
          onSelect: () => openBoard(board),
        },
        {
          id: "rename-board",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestBoardLabelEdit(board),
        },
        { id: "board-menu-separator", type: "separator" },
        {
          id: "delete-board",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Boards`
              : "Delete Board",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  /** Selects a card in selection mode, otherwise opens its board. */
  const handleBoardClick = (board: Board, event: MouseEvent) => {
    if (dialogOpen()) return;
    if (gridClickSelection.handleCardClick(board.identifiers.uid, event))
      return;
    openBoard(board);
  };

  /** Opens the one selected board and leaves selection mode. */
  const handleOpenSelected = () => {
    const board = selectedBoard();
    if (selectedCount() !== 1 || dialogOpen() || !board) return;
    openBoard(board);
    setSelectionModeEnabled(false);
  };

  /** Creates an empty board and opens it in a Board panel, ready to fill and name. */
  const handleCreate = () => {
    if (dialogOpen()) return;
    void createBoardInPanel();
  };

  /** Opens the ID and label editor for the one selected board. */
  const handleEditSelected = () => {
    const board = selectedBoard();
    if (selectedCount() !== 1 || dialogOpen() || !board) return;
    setEditingBoardUid(board.identifiers.uid);
    setIsEditModalOpen(true);
    setSelectionModeEnabled(false);
  };

  /** Board being edited in the ID and label dialog, if it still exists. */
  const editingBoard = createMemo(() => {
    const uid = editingBoardUid();
    return uid ? $boards()[uid] : undefined;
  });

  /** Closes the editor dialog and forgets which board it was editing. */
  const closeEditor = () => {
    setIsEditModalOpen(false);
    setEditingBoardUid(null);
  };

  /**
   * Applies a new ID and label from the editor dialog. A taken ID is refused up front, and the
   * label is set under the board's current ID before renumbering, so a refused renumber can
   * never relabel another board.
   */
  const handleEditSubmit = (payload: { id: number; label: string }) => {
    const board = editingBoard();
    if (!board) {
      closeEditor();
      return;
    }
    const idTaken = allBoardList().some(
      (other) =>
        other.identifiers.id === payload.id &&
        other.identifiers.uid !== board.identifiers.uid,
    );
    if (idTaken) {
      pushToast("warning", `Board ${payload.id} already exists.`);
      return;
    }
    if (payload.label !== board.identifiers.label)
      sendBoardCommand(
        buildSetBoardLabelCommand(board.identifiers.id, payload.label),
      );
    if (payload.id !== board.identifiers.id)
      sendBoardCommand(
        buildRenameBoardCommand(board.identifiers.id, payload.id),
      );
    closeEditor();
  };

  /** Asks to confirm deleting the selected boards. */
  const handleDeleteSelected = () => {
    if (dialogOpen() || selectedCount() === 0) return;
    setIsDeleteModalOpen(true);
  };

  /** Deletes every selected board after confirmation; their open Board panels show the chooser. */
  const confirmDeleteSelected = () => {
    for (const uid of selectedBoardUids()) {
      const board = $boards()[uid];
      if (board)
        sendBoardCommand(buildDeleteBoardCommand(board.identifiers.id));
    }
    setSelectionModeEnabled(false);
    setIsDeleteModalOpen(false);
  };

  for (const [key, handler, description] of [
    ["n", handleCreate, "Create board"],
    ["v", handleToggleSelectionMode, "Toggle selection mode"],
    ["Enter", handleOpenSelected, "Open selected board"],
    ["e", handleEditSelected, "Edit selected board"],
    ["Delete", handleDeleteSelected, "Delete selected boards"],
    ["Backspace", handleDeleteSelected, "Delete selected boards"],
  ] as const) {
    useKeyboardShortcut({ key, handler, description, componentId: panelId });
  }
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Clear selected boards",
    componentId: panelId,
  });

  return {
    panelId,
    search,
    selectionMode,
    viewMode,
    setViewMode,
    isEditModalOpen,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    dialogOpen,
    editingBoard,
    closeEditor,
    labelEditRequest,
    listSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    allBoardList,
    boardList,
    selectedCount,
    selectedBoardUidSet,
    selectBoards,
    updateBoardLabel,
    openBoard,
    openBoardContextMenu,
    handleBoardClick,
    handleOpenSelected,
    handleCreate,
    handleEditSelected,
    handleEditSubmit,
    handleDeleteSelected,
    confirmDeleteSelected,
    handleToggleSelectionMode,
    gridDragSelection,
    gridClickSelection,
  };
}

export type BoardListController = ReturnType<typeof createBoardListController>;
