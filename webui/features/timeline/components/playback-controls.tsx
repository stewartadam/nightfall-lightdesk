// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PauseIcon } from "@squidlab/phosphor-solid/pause";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { RecordIcon } from "@squidlab/phosphor-solid/record";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { Dynamic } from "solid-js/web";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import { browserDemoAudioHost } from "../../../lib/browser-demo-audio";
import { connectionStatus } from "../../../lib/engine-runtime";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";
import { createActionMappingTarget } from "../../action-mapping";
import { useTimelineContext } from "../context/timeline-context";

/** Controls timeline playback and recording with shared toolbar actions. */
export const InstanceControls = () => {
  const ctx = useTimelineContext();
  const playbackMapping = createActionMappingTarget(() => ({
    action: {
      id: "timeline.toggle-playback",
      arguments: { timeline_uid: ctx.timelineUid },
    },
    label: "Start / pause timeline",
  }));

  /** Serialize browser-media priming before asking the embedded runtime to play. */
  const togglePaused = async () => {
    if (ctx.paused()) {
      const audioUrl = ctx.audioPath();
      if (isEmbeddedDemoRuntime() && audioUrl) {
        await browserDemoAudioHost
          .prime(ctx.timelineUid, audioUrl)
          .catch(() => undefined);
      }
      ctx.playback.play();
    } else {
      ctx.playback.pause();
    }
  };

  /** Reuses a valid recording target or creates a track for recorded actions. */
  const ensureRecordTargetTrack = () => {
    const currentTarget = ctx.recordTargetTrackId();
    if (
      currentTarget &&
      ctx.tracks().some((track) => track.id === currentTarget)
    ) {
      return currentTarget;
    }

    const trackId = ctx.track.addTrack("Recorded Actions");
    if (trackId) {
      ctx.setRecordTargetTrackId(trackId);
    }
    return trackId;
  };

  /** Changes recording state after ensuring a target track exists. */
  const toggleRecording = () => {
    if (ctx.recordingEnabled()) {
      ctx.setRecordingEnabled(false);
      return;
    }

    if (ensureRecordTargetTrack()) {
      ctx.setRecordingEnabled(true);
    }
  };

  return (
    <div class="flex items-center gap-1">
      <ToolbarButton
        ref={playbackMapping}
        ariaPressed={!ctx.paused()}
        onClick={() => void togglePaused()}
        disabled={connectionStatus() !== "connected"}
        label={ctx.paused() ? "Play timeline" : "Pause timeline"}
      >
        <Dynamic
          component={ctx.paused() ? PlayIcon : PauseIcon}
          class="size-4"
          aria-hidden
        />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => ctx.playback.stop()}
        disabled={connectionStatus() !== "connected"}
        label="Stop timeline"
      >
        <StopIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        ariaPressed={ctx.recordingEnabled()}
        variant="danger"
        onClick={toggleRecording}
        disabled={connectionStatus() !== "connected"}
        label={
          ctx.recordingEnabled()
            ? "Disable timeline recording"
            : "Enable timeline recording"
        }
      >
        <RecordIcon class="size-4" aria-hidden />
      </ToolbarButton>
    </div>
  );
};
