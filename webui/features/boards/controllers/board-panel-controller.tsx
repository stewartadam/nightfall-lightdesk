// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import type { DockviewPanelApi } from "dockview";
import { createEffect, createMemo, createSignal } from "solid-js";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import {
  blueprints,
  boardStates,
  boards,
  clips,
  groups,
  masters,
} from "../../../state/appStores";
import { pushToast } from "../../../state/notifications";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import { BoardProperties } from "../components/board-properties";
import {
  type BoardObjectCatalog,
  type BoardTargetType,
  BUTTON_SPAN,
  boardDisplayName,
  buildDeleteBoardCommand,
  buildDeleteElementCommand,
  buildSetBoardLabelCommand,
  buildStoreElementCommand,
  createCollectionElement,
  createDecorationElement,
  createTargetElement,
  defaultElementSize,
  FALLBACK_SEARCH_COLUMNS,
  firstObjectOfType,
  sortBoardsById,
} from "../model/board-model";
import {
  canPlaceElement,
  findFreeCell,
  pasteElement,
} from "../model/board-placement";
import {
  pressBoardButton,
  sendBoardCommand,
  sendBoardCommandAndAwait,
} from "../services/board-commands";
import {
  createBoard as createBoardCommand,
  takeNewBoard,
} from "../services/board-panels";

/** Element last copied or cut from any Board panel, ready to paste onto any board. */
const [boardClipboard, setBoardClipboard] = createSignal<types.BoardElement>();

export interface BoardPanelControllerOptions {
  /** Dockview ID of this panel instance. */
  panelId: string;
  /** Dockview API used to persist the shown board and title the tab. */
  panelApi?: DockviewPanelApi;
  /** Board this instance showed when the layout was saved. */
  initialBoardUid?: string;
  /** Closes a board shown outside a Dockview panel once its board has been deleted. */
  onClose?: () => void;
}

export type BoardPanelController = ReturnType<
  typeof createBoardPanelController
>;

/** Kinds of element the edit toolbar can add. */
export type BoardAddRequest =
  | { type: "Target"; targetType: BoardTargetType }
  | { type: "Collection"; targetType: BoardTargetType }
  | { type: "Frame" }
  | { type: "Label" }
  | { type: "Tempo" };

/**
 * Owns one Board panel instance: which board it shows, edit mode and element selection, and
 * every board edit and press it sends. Each instance keeps its own board so several boards can
 * be open side by side.
 */
export function createBoardPanelController(
  options: BoardPanelControllerOptions,
) {
  const $boards = useStore(boards);
  const $boardStates = useStore(boardStates);
  const $clips = useStore(clips);
  const $groups = useStore(groups);
  const $blueprints = useStore(blueprints);
  const $masters = useStore(masters);

  const [boardUid, setBoardUid] = createSignal(options.initialBoardUid);
  /** Whether this panel opened a board just created from a command, to fill and name it. */
  const openedNewBoard = takeNewBoard(options.initialBoardUid);
  const [editing, setEditing] = createSignal(openedNewBoard);
  const [selectedElementUid, setSelectedElementUid] = createSignal<
    string | null
  >(null);
  /** Element whose settings pop-out is open, if any. */
  const [settingsElementUid, setSettingsElementUid] = createSignal<
    string | null
  >(null);
  const [boardSettingsOpen, setBoardSettingsOpen] =
    createSignal(openedNewBoard);
  /** Empty cell the operator last clicked, where pasted elements land. */
  const [pasteAnchor, setPasteAnchor] = createSignal<{
    x: number;
    y: number;
  }>();

  /** Lists every board in ID order, offered when this panel has no board to show. */
  const boardList = createMemo(() => sortBoardsById($boards()));

  /** Resolves the board this panel shows, once the engine has it. */
  const board = createMemo<types.Board | undefined>(() => {
    const uid = boardUid();
    return uid ? $boards()[uid] : undefined;
  });

  /** Whether this panel is waiting for the engine to store a board it just created. */
  const [awaitingNewBoard, setAwaitingNewBoard] = createSignal(openedNewBoard);

  /** Stops waiting once the new board arrives. */
  createEffect(() => {
    if (board()) setAwaitingNewBoard(false);
  });

  /** Returns an element of the shown board by UID, if it still exists. */
  const elementByUid = (uid: string) =>
    board()?.elements?.find((element) => element.uid === uid);

  /** Resolves the element selected for editing, if it still exists. */
  const selectedElement = createMemo(() => {
    const uid = selectedElementUid();
    return uid ? elementByUid(uid) : undefined;
  });

  /** UIDs of the shown board's elements in paint order, stable across board updates. */
  const elementUids = createMemo(
    () => board()?.elements?.map((element) => element.uid) ?? [],
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((uid, index) => uid === next[index]),
    },
  );

  /** Whole grid columns visible in the panel, where new and pasted elements look for room. */
  const [visibleColumns, setVisibleColumns] = createSignal(
    FALLBACK_SEARCH_COLUMNS,
  );

  /** Indexes every pinnable object by type for the target pickers. */
  const catalog = createMemo<BoardObjectCatalog>(() => ({
    Clip: Object.values($clips()).map(([clip]) => clip.identifiers),
    Group: Object.values($groups()).map((group) => group.identifiers),
    Blueprint: Object.values($blueprints()).map(
      (blueprint) => blueprint.identifiers,
    ),
    Master: Object.values($masters()).map((master) => master.identifiers),
  }));

  /** Returns the resolved buttons of one element on the shown board. */
  const itemsFor = (elementUid: string): types.BoardItem[] => {
    const current = board();
    if (!current) return [];
    return $boardStates()[current.identifiers.uid]?.[elementUid] ?? [];
  };

  /** Board UID last written to this panel's saved parameters. */
  let savedBoardUid = options.initialBoardUid;

  /** Persists the shown board in the saved layout and names the tab after it. */
  createEffect(() => {
    const current = board();
    options.panelApi?.setTitle(current ? boardDisplayName(current) : "Board");
    if (current && current.identifiers.uid !== savedBoardUid) {
      savedBoardUid = current.identifiers.uid;
      options.panelApi?.updateParameters({ boardId: savedBoardUid });
    }
  });

  /** Drops the element selection, pop-outs and paste spot when edit mode ends. */
  createEffect(() => {
    if (editing()) return;
    setSelectedElementUid(null);
    setSettingsElementUid(null);
    setPasteAnchor(undefined);
  });

  /** Shows `uid` in this panel, which has no board of its own yet. */
  const selectBoard = (uid: string | undefined) => {
    setBoardUid(uid);
  };

  /**
   * Creates an empty board, shows it here, switches to edit mode to fill it, and opens its
   * settings so the operator can name it straight away.
   */
  const createBoard = async () => {
    setAwaitingNewBoard(true);
    const uid = await createBoardCommand();
    if (!uid) {
      setAwaitingNewBoard(false);
      return;
    }
    selectBoard(uid);
    setEditing(true);
    setBoardSettingsOpen(true);
  };

  /**
   * Deletes the shown board and closes this panel (or the board workspace showing it) once the
   * engine confirms it. Other panels showing the board fall back to the board chooser.
   */
  const deleteBoard = async () => {
    const current = board();
    if (!current) return;
    setBoardSettingsOpen(false);
    if (
      await sendBoardCommandAndAwait(
        buildDeleteBoardCommand(current.identifiers.id),
      )
    ) {
      options.panelApi?.close();
      options.onClose?.();
    }
  };

  /** Renames the shown board. */
  const setBoardLabel = (label: string) => {
    const current = board();
    if (!current || label === current.identifiers.label) return;
    sendBoardCommand(buildSetBoardLabelCommand(current.identifiers.id, label));
  };

  /**
   * Stores an element after checking the engine's placement rules locally, so an invalid move
   * snaps back with a message instead of round-tripping an error.
   */
  const storeElement = (element: types.BoardElement): boolean => {
    const current = board();
    if (!current) return false;
    if (
      !canPlaceElement(current, element.cell, element.kind.type, element.uid)
    ) {
      pushToast("warning", "That spot is taken or outside the board.");
      return false;
    }
    sendBoardCommand(buildStoreElementCommand(current.identifiers.id, element));
    return true;
  };

  /** Moves or resizes an element to `cell`; returns whether a change was sent to the engine. */
  const placeElement = (
    element: types.BoardElement,
    cell: types.BoardCell,
  ): boolean => {
    if (
      cell.x === element.cell.x &&
      cell.y === element.cell.y &&
      cell.width === element.cell.width &&
      cell.height === element.cell.height
    ) {
      return false;
    }
    return storeElement({ ...element, cell });
  };

  /**
   * Adds an element of the requested kind and selects it. It fills `area` when one is given
   * (a rectangle dragged out on the grid), else takes its default size at the first free spot.
   */
  const addElement = (request: BoardAddRequest, area?: types.BoardCell) => {
    const current = board();
    if (!current) return;
    const size = defaultElementSize(request.type);
    const cell =
      area ??
      findFreeCell(
        current,
        size.width,
        size.height,
        request.type,
        visibleColumns(),
      );
    if (!cell) {
      pushToast("warning", "There is no free space left on this board.");
      return;
    }
    let element: types.BoardElement;
    switch (request.type) {
      case "Target": {
        const target = firstObjectOfType(catalog(), request.targetType);
        if (!target) {
          pushToast("warning", "There is nothing of that type to pin yet.");
          return;
        }
        element = createTargetElement(target, cell);
        break;
      }
      case "Collection":
        element = createCollectionElement(request.targetType, cell);
        break;
      case "Frame":
      case "Label":
      case "Tempo":
        element = createDecorationElement(request.type, cell);
        break;
    }
    if (storeElement(element)) setSelectedElementUid(element.uid);
  };

  /** Pins an object dragged in from another panel at the dropped cell, in either mode. */
  const dropTarget = (
    target: types.ObjectIdentity,
    position: { x: number; y: number },
  ) => {
    const current = board();
    if (!current) return;
    const element = createTargetElement(target, {
      ...position,
      ...BUTTON_SPAN,
    });
    if (storeElement(element) && editing()) setSelectedElementUid(element.uid);
  };

  /** Removes an element from the shown board. */
  const deleteElement = (elementUid: string) => {
    const current = board();
    if (!current) return;
    sendBoardCommand(
      buildDeleteElementCommand(current.identifiers.id, elementUid),
    );
    if (selectedElementUid() === elementUid) setSelectedElementUid(null);
    if (settingsElementUid() === elementUid) setSettingsElementUid(null);
  };

  /** Copies the selected element to the board clipboard shared by every Board panel. */
  const copySelected = (): boolean => {
    const element = selectedElement();
    if (!editing() || !element) return false;
    // Store values are reactive proxies that structuredClone rejects; a JSON copy detaches it.
    setBoardClipboard(
      JSON.parse(JSON.stringify(element)) as types.BoardElement,
    );
    return true;
  };

  /** Copies the selected element to the board clipboard, then removes it. */
  const cutSelected = (): boolean => {
    const element = selectedElement();
    if (!element || !copySelected()) return false;
    deleteElement(element.uid);
    return true;
  };

  /**
   * Pastes the clipboard element onto the shown board at `anchor`, else at the last clicked
   * empty cell, falling back to its original spot or the first free one.
   */
  const paste = (anchor?: { x: number; y: number }): boolean => {
    const current = board();
    const copied = boardClipboard();
    if (!editing() || !current || !copied) return false;
    const element = pasteElement(
      current,
      copied,
      anchor ?? pasteAnchor(),
      visibleColumns(),
    );
    if (!element) {
      pushToast("warning", "There is no room on this board to paste that.");
      return true;
    }
    if (storeElement(element)) setSelectedElementUid(element.uid);
    return true;
  };

  /** Removes the selected element while editing; returns whether there was one to remove. */
  const deleteSelected = (): boolean => {
    const element = selectedElement();
    if (!editing() || !element) return false;
    deleteElement(element.uid);
    return true;
  };

  /** Opens the settings pop-out of an element, selecting it. */
  const openElementSettings = (elementUid: string) => {
    setSelectedElementUid(elementUid);
    setSettingsElementUid(elementUid);
  };

  /** Runs a button's default action, or selects the element while editing. */
  const press = (element: types.BoardElement, item: types.BoardItem) => {
    if (editing()) {
      setSelectedElementUid(element.uid);
      return;
    }
    const current = board();
    if (!current) return;
    pressBoardButton(current.identifiers.uid, element.uid, item.target);
  };

  const controller = {
    panelId: options.panelId,
    boardList,
    board,
    awaitingNewBoard,
    boardSettingsOpen,
    setBoardSettingsOpen,
    settingsElementUid,
    setSettingsElementUid,
    openElementSettings,
    pasteAnchor,
    setPasteAnchor,
    clipboard: boardClipboard,
    copySelected,
    cutSelected,
    paste,
    deleteSelected,
    elementByUid,
    elementUids,
    setVisibleColumns,
    catalog,
    itemsFor,
    editing,
    setEditing,
    selectedElement,
    selectElement: setSelectedElementUid,
    selectBoard,
    createBoard,
    deleteBoard,
    setBoardLabel,
    storeElement,
    placeElement,
    addElement,
    dropTarget,
    deleteElement,
    press,
  };

  for (const [key, handler, description] of [
    ["Delete", deleteSelected, "Remove the selected board element"],
    ["Backspace", deleteSelected, "Remove the selected board element"],
    ["$mod+c", copySelected, "Copy the selected board element"],
    ["$mod+x", cutSelected, "Cut the selected board element"],
    ["$mod+v", () => paste(), "Paste a board element"],
  ] as const) {
    useKeyboardShortcut({
      key,
      // Returning false lets the key fall through when there is nothing to act on.
      handler: () => handler(),
      description,
      componentId: options.panelId,
      group: "Board",
    });
  }

  usePropertiesInspector(
    options.panelId,
    () => (selectedElement() ? "Board element" : "Board"),
    () => <BoardProperties controller={controller} />,
    { priority: 10, autoActivate: true },
  );

  return controller;
}
