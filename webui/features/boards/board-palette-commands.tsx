// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { useUiAction } from "../../components/providers/command-registry";
import { panelOpenPlacementFromExecutionContext } from "../../lib/panel-open-command";
import { createBoardInPanel } from "./services/board-panels";

/**
 * Registers the command palette's New Board command. Existing boards open from the object
 * palette instead.
 */
export default function BoardPaletteCommands() {
  useUiAction({
    id: "board.new",
    name: "New Board",
    description: "Create an empty board and open it in a new panel",
    category: "Boards",
    icon: PlusIcon,
    execute: (context) =>
      createBoardInPanel(panelOpenPlacementFromExecutionContext(context)),
  });
  return null;
}
