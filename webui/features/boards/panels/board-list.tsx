// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { BoardListView } from "../components/board-list-view";
import { createBoardListController } from "../controllers/board-list-controller";

/** Connects the registered Boards list panel to its controller and view. */
export default function BoardListPanel(props: BasePanelComponentProps) {
  const controller = createBoardListController({ panelId: props.id });
  return <BoardListView controller={controller} />;
}
