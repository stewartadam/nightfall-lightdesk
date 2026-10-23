// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, onCleanup } from "solid-js";
import { registerComponentFocus } from "../../../lib/componentFocusContext";
import { boards } from "../../../state/appStores";
import { activeBoardWorkspace } from "../../../state/layout-switcher";
import { createBoardPanelController } from "../controllers/board-panel-controller";
import { BoardPanelView } from "./board-panel-view";

/** Returns to the layout underneath the board workspace. */
function closeBoardWorkspace(): void {
  activeBoardWorkspace.set(null);
}

/**
 * Shows one board filling the workspace, picked from the layout switcher. It behaves like a
 * Board panel without a Dockview tab, and closes when its board is deleted. Opening a panel
 * puts it away too (see `openOrFocusPanel`) so the panel is never hidden behind the board.
 */
export function BoardWorkspace(props: { boardUid: string }) {
  const $boards = useStore(boards);
  const panelId = `board-workspace:${props.boardUid}`;
  const controller = createBoardPanelController({
    panelId,
    initialBoardUid: props.boardUid,
    onClose: closeBoardWorkspace,
  });

  /** Closes the workspace when its board disappears, such as on a showfile change. */
  createEffect(() => {
    if (!$boards()[props.boardUid]) closeBoardWorkspace();
  });

  return (
    <div
      ref={(element) => onCleanup(registerComponentFocus(panelId, element))}
      class="nf-board-workspace h-full w-full"
      data-board-workspace={props.boardUid}
    >
      <BoardPanelView controller={controller} />
    </div>
  );
}
