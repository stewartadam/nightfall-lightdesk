// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { TimelineListView } from "../components/timeline-list-view";
import { createTimelineListController } from "../controllers/timeline-list-controller";

interface TimelineListPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Connects the registered timeline-list panel to its controller and view. */
export default function TimelineListPanel(props: TimelineListPanelProps) {
  const controller = createTimelineListController({
    id: props.id,
    initialPanelId: props.initialPanelId,
  });
  return <TimelineListView controller={controller} />;
}
