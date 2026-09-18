// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect } from "solid-js";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { timelineDefinitionsLoaded, timelines } from "../../../state/appStores";
import { TimelineController } from "../controllers/timeline-controller";

interface TimelineProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialTimelineUid: string;
}

export default function TimelineEditor(props: TimelineProps) {
  const $timelineDefinitionsLoaded = useStore(timelineDefinitionsLoaded);
  const $timelines = useShallowStore(timelines);
  let closedMissingTimelinePanel = false;

  /** Closes timeline editor panels once their backing timeline is deleted. */
  createEffect(() => {
    if (!$timelineDefinitionsLoaded()) return;
    if ($timelines()[props.initialTimelineUid]) return;
    if (closedMissingTimelinePanel) return;
    closedMissingTimelinePanel = true;
    props.panelApi?.close();
  });

  return (
    <div class="flex h-full min-h-0 w-full bg-[#1a1a1a] text-white">
      <div class="min-h-0 w-full">
        <TimelineController
          initialTimelineUid={props.initialTimelineUid}
          initialPanelId={props.initialPanelId}
        />
      </div>
    </div>
  );
}
