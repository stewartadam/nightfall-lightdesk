// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { commandClient } from "../../../lib/engine-commands";
import { getLogger } from "../../../lib/logger";
import { useStore } from "../../../lib/use-nanostore";
import { timelines } from "../../../state/appStores";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";
import { createTimelineEventEffect } from "./timeline-event-effect";

const log = getLogger(import.meta.url);

/**
 * Mounts the reactive persistence bridge between timeline UI state and backend commands.
 */
export const TimelineEventListener = () => {
  log.trace("mounting");
  const ctx = useTimelineContext();

  const $timelines = useStore(timelines);
  /** Returns this panel's timeline from the store, or undefined before it arrives. */
  const currentTimeline = () => $timelines()[ctx.timelineUid];

  // Send marker store commands individually so batched marker pastes share a batch ID.
  createTimelineEventEffect(
    ctx.markersActions.onStoreMarker,
    currentTimeline,
    (event, timeline) => {
      for (const marker of event.markers) {
        const command: types.TimelineCommand = {
          type: "StoreTimelineMarker",
          data: {
            timeline_id: timeline.identifiers.id,
            marker,
          },
        };
        commandClient.emit("TimelineCommand", command, {
          undoId: event.batchId,
        });
      }
    },
  );

  // Send marker deletion commands for markers removed from the timeline.
  createTimelineEventEffect(
    ctx.markersActions.onDeleteMarker,
    currentTimeline,
    (event, timeline) => {
      for (const markerUid of event.markerUids) {
        const command: types.TimelineCommand = {
          type: "DeleteTimelineMarker",
          data: {
            timeline_id: timeline.identifiers.id,
            marker_uid: markerUid,
          },
        };
        commandClient.emit("TimelineCommand", command);
      }
    },
  );

  // Send region store commands when timeline regions are created or edited.
  createTimelineEventEffect(
    ctx.regionsActions.onStoreRegion,
    currentTimeline,
    (event, timeline) => {
      const command: types.TimelineCommand = {
        type: "StoreTimelineRegion",
        data: {
          timeline_id: timeline.identifiers.id,
          region: event.region,
        },
      };
      commandClient.emit("TimelineCommand", command);
    },
  );

  // Send region deletion commands for regions removed from the timeline.
  createTimelineEventEffect(
    ctx.regionsActions.onDeleteRegion,
    currentTimeline,
    (event, timeline) => {
      const command: types.TimelineCommand = {
        type: "DeleteTimelineRegion",
        data: {
          timeline_id: timeline.identifiers.id,
          region_uid: event.regionUid,
        },
      };
      commandClient.emit("TimelineCommand", command);
    },
  );

  // Send loop-range commands separately from full timeline snapshot persistence.
  createTimelineEventEffect(
    ctx.loopActions.onSetLoopRange,
    currentTimeline,
    (event, timeline) => {
      const command: types.TimelineCommand = {
        type: "SetTimelineLoopRange",
        data: {
          timeline_id: timeline.identifiers.id,
          loop_range: event.loopRange,
        },
      };
      commandClient.emit("TimelineCommand", command);
    },
  );

  // Send nudge-selection commands so undo groups retain the selection delta.
  createTimelineEventEffect(
    ctx.onNudgeSelection,
    currentTimeline,
    (event, timeline) => {
      const command: types.TimelineCommand = {
        type: "NudgeTimelineSelection",
        data: {
          timeline_id: timeline.identifiers.id,
          selection: event.selection,
          delta_ms: event.deltaMs,
        },
      };
      commandClient.emit("TimelineCommand", command);
    },
  );

  return null;
};
