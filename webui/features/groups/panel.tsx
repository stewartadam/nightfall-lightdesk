// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../lib/panel-registry";
import { GroupsPanelView } from "./components/groups-panel-view";
import { createGroupsPanelController } from "./controllers/groups-panel-controller";

export interface GroupsPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Connects the registered Groups panel to its feature controller and view. */
export default function GroupsPanel(props: GroupsPanelProps) {
  const controller = createGroupsPanelController({
    id: props.id,
    initialPanelId: props.initialPanelId,
  });
  return <GroupsPanelView controller={controller} />;
}
