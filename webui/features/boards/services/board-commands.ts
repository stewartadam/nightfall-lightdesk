// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { commandClient } from "../../../lib/engine-commands";
import type * as types from "../../../types";
import {
  buildBoardPressInvocation,
  buildSetBoardShownInSwitcherCommand,
} from "../model/board-model";

/** Sends one board edit to the engine, which validates it and records it for undo. */
export function sendBoardCommand(command: types.BoardCommand): void {
  commandClient.emit("BoardCommand", command);
}

/**
 * Sends one board edit and resolves with whether the engine accepted it. Resolves false when
 * the engine rejects it or the connection is down.
 */
export async function sendBoardCommandAndAwait(
  command: types.BoardCommand,
): Promise<boolean> {
  try {
    const result = await commandClient.invoke("BoardCommand", command);
    return result.outcome.type === "Succeeded";
  } catch {
    return false;
  }
}

/** Asks the engine to run the default action of one button on a board. */
export function pressBoardButton(
  boardUid: string,
  elementUid: string,
  target: types.ObjectIdentity,
): void {
  commandClient.emit(
    "ActionCommand",
    buildBoardPressInvocation(boardUid, elementUid, target),
  );
}

/** Lists the board with numeric ID `boardId` in the layout switcher, or hides it from there. */
export function setBoardShownInSwitcher(boardId: number, shown: boolean): void {
  sendBoardCommand(buildSetBoardShownInSwitcherCommand(boardId, shown));
}
