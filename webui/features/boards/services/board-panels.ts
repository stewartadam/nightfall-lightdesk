// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  findPanelDefinitionById,
  type PanelComponentName,
  panelDefinitionByName,
} from "../../../lib/panel-definitions";
import {
  openOrFocusPanel,
  openPanelInstance,
  type PanelOpenPlacement,
} from "../../../lib/panel-open-command";
import { boards, dockApi } from "../../../state/appStores";
import { pushToast } from "../../../state/notifications";
import {
  buildStoreBoardCommand,
  createEmptyBoard,
  nextAvailableBoardId,
} from "../model/board-model";
import { sendBoardCommandAndAwait } from "./board-commands";

/** Component name every Board panel instance is registered under. */
const BOARD_PANEL_COMPONENT: PanelComponentName = "BoardPanel";

/** Boards created from a command whose panel has not picked them up yet. */
const newBoardUids = new Set<string>();

/**
 * Returns whether `boardUid` was just created by {@link createBoardInPanel}, forgetting it so
 * only the panel that opens it starts in edit mode with its settings open.
 */
export function takeNewBoard(boardUid: string | undefined): boolean {
  return !!boardUid && newBoardUids.delete(boardUid);
}

/**
 * Focuses the Board panel already showing `boardUid`, or opens a new Board panel for it at
 * `placement`. Does nothing while the docked workspace is unavailable.
 */
export function openBoardPanel(
  boardUid: string,
  placement: PanelOpenPlacement = "default",
): void {
  const api = dockApi.get();
  if (!api) return;
  const existing = api.panels.find(
    (panel) =>
      findPanelDefinitionById(panel.id)?.componentName ===
        BOARD_PANEL_COMPONENT &&
      (panel.params as { boardId?: string } | undefined)?.boardId === boardUid,
  );
  if (existing) {
    openOrFocusPanel(
      api,
      existing.id,
      BOARD_PANEL_COMPONENT,
      existing.title ?? "Board",
    );
    return;
  }
  openPanelInstance(
    api,
    panelDefinitionByName(BOARD_PANEL_COMPONENT),
    { boardId: boardUid },
    placement,
  );
}

/** IDs of boards sent to the engine that it has not stored yet, so none is handed out twice. */
const pendingBoardIds = new Set<number>();

/**
 * Creates an empty board with the next free ID and resolves with its UID once the engine has
 * stored it, or with `undefined` (after telling the operator) when the engine refused it.
 */
export async function createBoard(): Promise<string | undefined> {
  const taken = [
    ...Object.values(boards.get()).map((board) => board.identifiers.id),
    ...pendingBoardIds,
  ];
  const created = createEmptyBoard(nextAvailableBoardId(taken));
  const { id, uid } = created.identifiers;
  pendingBoardIds.add(id);
  const stored = await sendBoardCommandAndAwait(
    buildStoreBoardCommand(created),
  );
  pendingBoardIds.delete(id);
  if (!stored) pushToast("error", "Could not create the board.");
  return stored ? uid : undefined;
}

/**
 * Creates an empty board and, once the engine has stored it, opens it in a new Board panel
 * where it starts in edit mode with its settings open so it can be named straight away.
 */
export async function createBoardInPanel(
  placement: PanelOpenPlacement = "default",
): Promise<void> {
  const uid = await createBoard();
  if (!uid) return;
  newBoardUids.add(uid);
  openBoardPanel(uid, placement);
}
