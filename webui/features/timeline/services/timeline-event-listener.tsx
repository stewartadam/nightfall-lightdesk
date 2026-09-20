// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, untrack } from "solid-js";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { timelines } from "../../../state/appStores";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";

const log = getLogger(import.meta.url);

/**
 * Mounts the reactive persistence bridge between timeline UI state and backend commands.
 */
export const TimelineEventListener = () => {
  log.trace("mounting");
  const ctx = useTimelineContext();

  const $timelines = useStore(timelines);

  /** Persists lane creation and deletion through the timeline snapshot command. */
  createEffect(() => {
    if (ctx.track.onLanesChanged()) {
      untrack(() => sendTimelineUpdate());
    }
  });

  // Persist track additions, removals, and inline renames as a timeline snapshot.
  createEffect(() => {
    const addTrackEvent = ctx.track.onAddTrack();
    const removeTrackEvent = ctx.track.onRemoveTrack();
    const renameTrackEvent = ctx.track.onRenameTrack();
    if (addTrackEvent || removeTrackEvent || renameTrackEvent) {
      log.debug("Track list changed", {
        add: addTrackEvent,
        remove: removeTrackEvent,
        rename: renameTrackEvent,
      });
      untrack(() => sendTimelineUpdate());
    }
  });

  // Persist track order changes after drag reordering completes.
  createEffect(() => {
    const reorderTrackEvent = ctx.track.onReorderTrack();
    if (reorderTrackEvent) {
      log.debug("Track reordered", reorderTrackEvent);
      untrack(() => sendTimelineUpdate());
    }
  });

  // Persist automation point edits that change a track's automation data.
  createEffect(() => {
    const addPointEvent = ctx.track.onAddPoint();
    const updatePointEvent = ctx.track.onUpdatePoint();
    const removePointEvent = ctx.track.onRemovePoint();

    if (addPointEvent || updatePointEvent || removePointEvent) {
      log.debug("Track point changed", {
        add: addPointEvent,
        update: updatePointEvent,
        remove: removePointEvent,
      });
      untrack(() => sendTimelineUpdate());
    }
  });

  // Persist track mute and solo state changes.
  createEffect(() => {
    const muteEvent = ctx.track.onMute();
    const soloEvent = ctx.track.onSolo();
    if (muteEvent || soloEvent) {
      log.debug("Track state changed", {
        mute: muteEvent,
        solo: soloEvent,
      });
      untrack(() => sendTimelineUpdate());
    }
  });

  // Persist action moves after repositioning updates local state.
  createEffect(() => {
    const repositionEvent = ctx.actions.onReposition();
    if (repositionEvent) {
      log.debug("Action repositioned", repositionEvent);
      untrack(() => sendTimelineUpdate());
    }
  });

  // Persist action insertions, edits, and deletions, preserving insert batch IDs.
  createEffect(() => {
    const insertEvent = ctx.actions.onInsert();
    const updateEvent = ctx.actions.onUpdate();
    const deleteEvent = ctx.actions.onDelete();
    if (insertEvent || updateEvent || deleteEvent) {
      log.debug("Action changed", {
        insert: insertEvent,
        update: updateEvent,
        delete: deleteEvent,
      });
      untrack(() => sendTimelineUpdate(insertEvent?.batchId));
    }
  });

  // Send marker store commands individually so batched marker pastes share a batch ID.
  createEffect(() => {
    const event = ctx.markersActions.onStoreMarker();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    for (const marker of event.markers) {
      const command: types.TimelineCommand = {
        type: "StoreTimelineMarker",
        data: {
          timeline_id: timeline.identifiers.id,
          marker,
        },
      };
      engineRuntime.sendCommand({
        ...(event.batchId ? { undo_id: event.batchId } : {}),
        module: "TimelineCommand",
        command,
      });
    }
  });

  // Send marker deletion commands for markers removed from the timeline.
  createEffect(() => {
    const event = ctx.markersActions.onDeleteMarker();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    for (const markerUid of event.markerUids) {
      const command: types.TimelineCommand = {
        type: "DeleteTimelineMarker",
        data: {
          timeline_id: timeline.identifiers.id,
          marker_uid: markerUid,
        },
      };
      engineRuntime.sendCommand({ module: "TimelineCommand", command });
    }
  });

  // Send region store commands when timeline regions are created or edited.
  createEffect(() => {
    const event = ctx.regionsActions.onStoreRegion();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    const command: types.TimelineCommand = {
      type: "StoreTimelineRegion",
      data: {
        timeline_id: timeline.identifiers.id,
        region: event.region,
      },
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });
  });

  // Send region deletion commands for regions removed from the timeline.
  createEffect(() => {
    const event = ctx.regionsActions.onDeleteRegion();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    const command: types.TimelineCommand = {
      type: "DeleteTimelineRegion",
      data: {
        timeline_id: timeline.identifiers.id,
        region_uid: event.regionUid,
      },
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });
  });

  // Send loop-range commands separately from full timeline snapshot persistence.
  createEffect(() => {
    const event = ctx.loopActions.onSetLoopRange();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    const command: types.TimelineCommand = {
      type: "SetTimelineLoopRange",
      data: {
        timeline_id: timeline.identifiers.id,
        loop_range: event.loopRange,
      },
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });
  });

  // Send nudge-selection commands so undo groups retain the selection delta.
  createEffect(() => {
    const event = ctx.onNudgeSelection();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    const command: types.TimelineCommand = {
      type: "NudgeTimelineSelection",
      data: {
        timeline_id: timeline.identifiers.id,
        selection: event.selection,
        delta_ms: event.deltaMs,
      },
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });
  });

  // Persist explicit beat-grid setting changes initiated by timeline controls.
  createEffect(() => {
    const event = ctx.onBeatgridSettingsChange();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    if (
      timeline.use_beat_grid === event.useBeatgrid &&
      timeline.bpm === event.bpm &&
      timeline.beats_per_bar === event.beatsPerBar
    ) {
      return;
    }

    log.debug("Beatgrid settings changed", {
      useBeatgrid: event.useBeatgrid,
      bpm: event.bpm,
      beatsPerBar: event.beatsPerBar,
    });
    untrack(() => sendTimelineUpdate());
  });

  // Persist explicit scroll-mode changes initiated by timeline controls.
  createEffect(() => {
    const event = ctx.onScrollModeChange();
    if (!event) return;
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return;

    const currentScrollMode = (timeline.scroll_mode ??
      "free") as types.TimelineScrollMode;
    if (currentScrollMode === event.scrollMode) {
      return;
    }

    log.debug("Timeline scroll mode changed", {
      scrollMode: event.scrollMode,
    });
    untrack(() => sendTimelineUpdate());
  });
  /** Persists the current timeline snapshot after local edits settle. */
  const sendTimelineUpdate = (batchId?: string) => {
    try {
      // Create a deep copy of the tracks with positions converted to Duration
      if (!untrack(ctx.timelineHydrated)) {
        log.debug(
          "Skipping timeline update before timeline state is hydrated",
          {
            timelineUid: ctx.timelineUid,
          },
        );
        return;
      }
      const timelines = untrack($timelines);
      if (!(ctx.timelineUid in timelines)) return;
      const timeline = timelines[ctx.timelineUid];

      // Create the timeline data object
      const timelineData: types.Timeline = {
        ...timeline,
        tracks: untrack(ctx.tracks),
        bpm: untrack(ctx.bpm),
        beats_per_bar: untrack(ctx.beatsPerBar),
        use_beat_grid: untrack(ctx.useBeatgrid),
        scroll_mode: untrack(ctx.scrollMode) as types.TimelineScrollMode,
        markers: untrack(ctx.markers),
        regions: untrack(ctx.regions),
        loop_range: untrack(ctx.loopRange),
      };
      log.debug("Sending timeline update", timelineData);

      // Prepare the store command
      const command: types.TimelineCommand = {
        type: "StoreTimeline",
        data: timelineData,
      };

      engineRuntime.sendCommand({
        ...(batchId ? { undo_id: batchId } : {}),
        module: "TimelineCommand",
        command: command,
      });
    } catch (error) {
      log.error("Failed to send timeline update:", error);
    }
  };

  return null;
};
