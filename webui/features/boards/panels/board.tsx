// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Match, Switch } from "solid-js";
import { createAsyncValueOnce } from "../../../lib/async-value";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { BoardPanelView } from "../components/board-panel-view";
import { createBoardPanelController } from "../controllers/board-panel-controller";
import { loadBoardPlacement } from "../model/board-placement";

export interface BoardPanelProps extends BasePanelComponentProps {
  /** UID of the board this panel instance showed when the layout was saved. */
  boardId?: string;
}

/** Connects one loaded Board panel instance to its controller and view. */
function LoadedBoardPanel(props: BoardPanelProps) {
  const controller = createBoardPanelController({
    panelId: props.id,
    panelApi: props.panelApi,
    initialBoardUid: props.boardId,
  });
  return <BoardPanelView controller={controller} />;
}

/**
 * Shows a registered Board panel instance once the board placement rules have loaded, since
 * every edit the panel offers is checked against them.
 */
export default function BoardPanel(props: BoardPanelProps) {
  const placement = createAsyncValueOnce(loadBoardPlacement);
  return (
    <Switch>
      <Match when={placement.ready()}>
        <LoadedBoardPanel {...props} />
      </Match>
      <Match when={placement.error() !== undefined}>
        <div class="p-4 text-neutral-500">
          This board could not load. Reload the page to try again.
        </div>
      </Match>
    </Switch>
  );
}
