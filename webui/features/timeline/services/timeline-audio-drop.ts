// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { getBackendUrl } from "../../../lib/api";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";
import {
  isSupportedTimelineAudioFile,
  resolveTimelineAudioUrl,
  uploadTimelineAudio,
} from "../../../lib/timeline-audio";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { pushToast, timelines } from "../../../state/appStores";
import type * as types from "../../../types";
import type { TimelineContextType } from "../context/timeline-context-contract";

const log = getLogger(import.meta.url);

/** Owns timeline audio drag depth, upload state, and persistence behavior. */
export function createTimelineAudioDropController(ctx: TimelineContextType) {
  const $timelines = useShallowStore(timelines);
  const [audioDragDepth, setAudioDragDepth] = createSignal(0);
  const [isUploadingAudio, setIsUploadingAudio] = createSignal(false);

  /** Returns whether the drag payload contains browser file entries. */
  const containsFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  /** Projects the current editor state into a timeline with an updated audio path. */
  const buildTimelineForAudioPath = (
    audioPath: string,
  ): types.Timeline | undefined => {
    const timeline = $timelines()[ctx.timelineUid];
    if (!timeline) return undefined;
    return {
      ...timeline,
      audio_path: audioPath,
      tracks: ctx.tracks(),
      bpm: ctx.bpm(),
      beats_per_bar: ctx.beatsPerBar(),
      use_beat_grid: ctx.useBeatgrid(),
      scroll_mode: ctx.scrollMode() as types.TimelineScrollMode,
    };
  };

  /** Persists an uploaded audio path through the timeline command channel. */
  const persistTimelineAudioPath = (audioPath: string) => {
    const timeline = buildTimelineForAudioPath(audioPath);
    if (!timeline) {
      throw new Error("Timeline state was unavailable while updating audio");
    }
    const command: types.TimelineCommand = {
      type: "StoreTimeline",
      data: timeline,
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });
  };

  /** Uploads the first supported dropped audio file and updates timeline state. */
  const handleAudioDrop = async (event: DragEvent) => {
    if (!containsFiles(event)) return;
    event.preventDefault();
    setAudioDragDepth(0);
    if (isEmbeddedDemoRuntime()) {
      pushToast("info", "The browser demo uses its bundled sample audio.");
      return;
    }

    const file = Array.from(event.dataTransfer?.files ?? [])[0];
    if (!file) return;
    if (!isSupportedTimelineAudioFile(file)) {
      pushToast("error", "Timeline audio must be .mp3, .wav, .m4a, or .mp4.");
      return;
    }

    setIsUploadingAudio(true);
    try {
      const { audioPath } = await uploadTimelineAudio(ctx.timelineUid, file);
      persistTimelineAudioPath(audioPath);
      ctx.setAudioPath(resolveTimelineAudioUrl(audioPath, Date.now()));
      pushToast("success", `Updated timeline audio to ${file.name}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to upload audio";
      log.error("Failed to upload timeline audio:", {
        error,
        backendUrl: getBackendUrl(),
      });
      pushToast("error", message);
    } finally {
      setIsUploadingAudio(false);
    }
  };

  /** Tracks a supported file drag entering the timeline surface. */
  const onDragEnter = (event: DragEvent) => {
    if (isEmbeddedDemoRuntime()) return;
    if (!containsFiles(event)) return;
    event.preventDefault();
    setAudioDragDepth((depth) => depth + 1);
  };

  /** Allows supported file drops and advertises copy semantics. */
  const onDragOver = (event: DragEvent) => {
    if (isEmbeddedDemoRuntime()) return;
    if (!containsFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  /** Decrements nested drag depth when a file drag leaves the surface. */
  const onDragLeave = (event: DragEvent) => {
    if (isEmbeddedDemoRuntime()) return;
    if (!containsFiles(event)) return;
    event.preventDefault();
    setAudioDragDepth((depth) => Math.max(0, depth - 1));
  };

  /** Starts asynchronous processing for a supported file drop. */
  const onDrop = (event: DragEvent) => {
    void handleAudioDrop(event);
  };

  return {
    isAudioDragActive: () => audioDragDepth() > 0,
    isUploadingAudio,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  };
}
