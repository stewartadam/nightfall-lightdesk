// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import type { DockviewApi } from "dockview";
import { createMemo } from "solid-js";
import { sortBoardsById } from "../../../features/boards";
import { activateStoredLayout } from "../../../lib/layout-activation";
import { layoutStorageStore } from "../../../lib/layoutStorage";
import { boards, pushToast } from "../../../state/appStores";
import {
  activeBoardWorkspace,
  busyLayoutIds,
} from "../../../state/layout-switcher";
import { hasOpenDialog } from "../../ui/modal/dialog-stack";

/**
 * Tracks the layouts and boards the layout switcher offers, for every surface that lists them.
 *
 * Layouts appear in their saved switcher order, followed by boards shown in the switcher in ID
 * order. The board filling the workspace keeps its entry even if another device hides it.
 */
export function useSwitcherEntries() {
  const storage = useStore(layoutStorageStore);
  const $boards = useStore(boards);
  const shownBoard = useStore(activeBoardWorkspace);
  /** Selects visible layouts in saved switcher order. */
  const layouts = createMemo(() =>
    storage().layouts.filter((layout) => layout.shownInSwitcher),
  );
  /** Selects boards shown in the switcher, plus the one filling the workspace. */
  const switcherBoards = createMemo(() =>
    sortBoardsById($boards()).filter(
      (board) =>
        board.shown_in_switcher || shownBoard() === board.identifiers.uid,
    ),
  );
  return { layouts, boards: switcherBoards };
}

/**
 * Activates a stored layout's retained working arrangement in place of any board workspace.
 *
 * User-initiated switches are ignored while a dialog is open, so the workspace behind it never
 * changes underneath the user, and while the layout is still being saved or loaded.
 */
export async function recallSwitcherLayout(
  api: DockviewApi | undefined,
  layoutId: string,
): Promise<void> {
  if (!api || hasOpenDialog() || busyLayoutIds.get().includes(layoutId)) return;
  activeBoardWorkspace.set(null);
  if (!(await activateStoredLayout(api, layoutId)))
    pushToast("error", "Could not load layout.");
}

/** Fills the workspace with a board, unless a dialog is open over it. */
export function showSwitcherBoard(boardUid: string): void {
  if (!hasOpenDialog()) activeBoardWorkspace.set(boardUid);
}
