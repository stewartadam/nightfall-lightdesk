// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  pushToast,
  showTempo,
  timecodes,
  timelineActionKey,
  timelineBeatgridDetectionStatus,
  timelineBeatgridPreview,
  timelineBeatgridProposals,
  timelineDefinitionsLoaded,
  timelineLookaheadActionStatuses,
  timelinePlannedCuesByAction,
  timelineRecordingPreviews,
  timelineRecordingStates,
  timelineStopEvent,
  timelines,
} from "../../state/appStores";
import type * as types from "../../types";
import { browserDemoAudioHost } from "../browser-demo-audio";
import { getLogger } from "../logger";
import { setStoreAction, setStoreKeyAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Groups per-action timeline records by timeline UID, then by {@link timelineActionKey}. */
function groupByTimelineAction<
  T extends { timeline_uid: string; track_id: string; action_id: string },
>(records: T[]): Record<string, Record<string, T>> {
  const grouped: Record<string, Record<string, T>> = {};
  for (const record of records) {
    grouped[record.timeline_uid] ??= {};
    grouped[record.timeline_uid][
      timelineActionKey(record.track_id, record.action_id)
    ] = record;
  }
  return grouped;
}

/** Registers timeline, recording, beatgrid, tempo, and timecode handlers. */
export function registerTimelineHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("TempoState", (message) => {
    setStoreAction(showTempo, "Receive TempoState", {
      snapshot: message.data,
      receivedAtMs: performance.now(),
    });
  });

  registry.register("TimecodeDefinitions", (message) => {
    const timecodeMap: Record<string, [types.Timecode, types.TimecodeState]> =
      {};
    for (const { timecode, state } of message.data) {
      timecodeMap[timecode.identifiers.uid] = [timecode, state];
    }
    setStoreAction(timecodes, "Receive TimecodeDefinitions", timecodeMap);
  });

  registry.register("TimelineDefinitions", (message) => {
    setStoreAction(
      timelines,
      "Receive TimelineDefinitions",
      arrayToUidMap(message.data),
    );
    setStoreAction(
      timelineDefinitionsLoaded,
      "Receive TimelineDefinitions",
      true,
    );
  });

  registry.register("TimelineAudioDirective", (message) => {
    const session = browserDemoAudioHost.currentSession();
    void browserDemoAudioHost
      .applyDirective(message.data as types.TimelineAudioDirective, session)
      .catch((error: unknown) => {
        log.error("Unable to apply browser demo timeline audio", error);
        pushToast(
          "error",
          "Browser audio could not start. Select Play again to retry.",
        );
      });
  });

  registry.register("TimelineRecordingStates", (message) => {
    const recordingStateMap: Record<string, types.TimelineRecordingState> = {};
    for (const state of message.data as types.TimelineRecordingState[]) {
      recordingStateMap[String(state.timeline_id)] = state;
    }
    setStoreAction(
      timelineRecordingStates,
      "Receive TimelineRecordingStates",
      recordingStateMap,
    );
  });

  registry.register("TimelineRecordingPreviews", (message) => {
    const recordingPreviewMap: Record<string, types.TimelineRecordingPreview> =
      {};
    for (const preview of message.data as types.TimelineRecordingPreview[]) {
      recordingPreviewMap[String(preview.timeline_id)] = preview;
    }
    setStoreAction(
      timelineRecordingPreviews,
      "Receive TimelineRecordingPreviews",
      recordingPreviewMap,
    );
  });

  registry.register("TimelineLookaheadActionStatuses", (message) => {
    setStoreAction(
      timelineLookaheadActionStatuses,
      "Receive TimelineLookaheadActionStatuses",
      groupByTimelineAction(
        message.data as types.TimelineLookaheadActionStatus[],
      ),
    );
  });

  registry.register("TimelinePlannedCuesByAction", (message) => {
    setStoreAction(
      timelinePlannedCuesByAction,
      "Receive TimelinePlannedCuesByAction",
      groupByTimelineAction(message.data as types.TimelinePlannedCue[]),
    );
  });

  registry.register("BeatgridDetectionStarted", (message) => {
    const started = message.data as types.BeatgridDetectionStarted;
    setStoreKeyAction(
      timelineBeatgridDetectionStatus,
      "Receive BeatgridDetectionStarted",
      started.timeline_uid,
      {
        phase: "detecting",
        requestId: started.request_id,
      },
    );
    clearBeatgridDetectionPreview(started.timeline_uid);
  });

  registry.register("BeatgridDetectionReady", (message) => {
    const ready = message.data as types.BeatgridDetectionReady;
    setStoreKeyAction(
      timelineBeatgridProposals,
      "Receive BeatgridDetectionReady",
      ready.timeline_uid,
      ready.proposal,
    );
    setStoreKeyAction(
      timelineBeatgridDetectionStatus,
      "Receive BeatgridDetectionReady",
      ready.timeline_uid,
      {
        phase: "ready",
        requestId: ready.proposal.request_id,
      },
    );
  });

  registry.register("BeatgridDetectionFailed", (message) => {
    const failed = message.data as types.BeatgridDetectionFailed;
    setStoreKeyAction(
      timelineBeatgridDetectionStatus,
      "Receive BeatgridDetectionFailed",
      failed.timeline_uid,
      {
        phase: "failed",
        requestId: failed.request_id,
        error: failed.error,
      },
    );
    clearBeatgridDetectionPreview(failed.timeline_uid);
    pushToast("warning", `Beatgrid detection failed: ${failed.error}`);
  });

  registry.register("TimelineCommand", (message) => {
    handleTimelineCommand(message.data as unknown as types.TimelineCommand);
  });
}

/** Drops the stale beatgrid preview of a timeline whose detection restarted or failed. */
function clearBeatgridDetectionPreview(timelineUid: string): void {
  const nextPreview = { ...timelineBeatgridPreview.get() };
  delete nextPreview[timelineUid];
  setStoreAction(
    timelineBeatgridPreview,
    "Clear Beatgrid Detection Preview",
    nextPreview,
  );
}

/**
 * Publishes timeline stop echoes so open editors can reset playback UI, while
 * ignoring CRUD echoes in favor of backend TimelineDefinitions snapshots.
 */
function handleTimelineCommand(command: types.TimelineCommand) {
  log.trace("Handling TimelineCommand:", command);

  // CRUD commands (StoreTimeline, RenameTimeline, DeleteTimeline) are not processed here.
  // Instead, we receive full TimelineDefinitions when the backend components change.
  // This prevents optimistic updates that show stale data when commands fail.
  switch (command.type) {
    case "StopTimeline": {
      const previous = timelineStopEvent.get();
      setStoreAction(timelineStopEvent, "Receive StopTimeline", {
        timelineId: command.data,
        revision: (previous?.revision ?? 0) + 1,
      });
      break;
    }
    default:
      log.trace(
        "Ignoring TimelineCommand (handled via TimelineDefinitions):",
        command.type,
      );
  }
}
