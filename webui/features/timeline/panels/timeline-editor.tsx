// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { createEffect } from "../../../lib/solid-compat";
import { useStore } from "../../../lib/use-nanostore";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { timelineDefinitionsLoaded, timelines } from "../../../state/appStores";
import { TimelineController } from "../controllers/timeline-controller";

interface TimelineProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialTimelineUid: string;
}

/** Keeps a timeline editor's tab and contents aligned with its backing timeline. */
export default function TimelineEditor(props: TimelineProps) {
  const $timelineDefinitionsLoaded = useStore(timelineDefinitionsLoaded);
  const $timelines = useShallowStore(timelines);
  let closedMissingTimelinePanel = false;

  /** Refreshes the tab title when the timeline name or display ID changes. */
  createEffect(
    () => {
      const timeline = $timelines()[props.initialTimelineUid];
      if (!timeline) return undefined;
      const label = timeline.identifiers.label.trim();
      return label
        ? `Timeline ${timeline.identifiers.id}: ${label}`
        : `Timeline ${timeline.identifiers.id}`;
    },
    (title) => {
      if (title) props.panelApi?.setTitle(title);
    },
  );

  /** Closes timeline editor panels once their backing timeline is deleted. */
  createEffect(
    () =>
      $timelineDefinitionsLoaded() && !$timelines()[props.initialTimelineUid],
    (missing) => {
      if (!missing || closedMissingTimelinePanel) return;
      closedMissingTimelinePanel = true;
      props.panelApi?.close();
    },
  );

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
