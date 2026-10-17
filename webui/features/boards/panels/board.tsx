// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { BoardPanelView } from "../components/board-panel-view";
import { createBoardPanelController } from "../controllers/board-panel-controller";

export interface BoardPanelProps extends BasePanelComponentProps {
  /** UID of the board this panel instance showed when the layout was saved. */
  boardId?: string;
}

/** Connects one registered Board panel instance to its controller and view. */
export default function BoardPanel(props: BoardPanelProps) {
  const controller = createBoardPanelController({
    panelId: props.id,
    panelApi: props.panelApi,
    initialBoardUid: props.boardId,
  });
  return <BoardPanelView controller={controller} />;
}
