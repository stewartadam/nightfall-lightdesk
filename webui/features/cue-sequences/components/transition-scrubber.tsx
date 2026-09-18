// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowCounterClockwiseIcon } from "@squidlab/phosphor-solid/arrow-counter-clockwise";
import { CaretLeftIcon } from "@squidlab/phosphor-solid/caret-left";
import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { PauseIcon } from "@squidlab/phosphor-solid/pause";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import { seekPreviewInstance } from "../../../lib/cue-service";
import { calculateCueTransitionDurations } from "../../../lib/cue-timing-values";
import { getLogger } from "../../../lib/logger";
import type * as types from "../../../types";
import { playbackTransitionClock } from "../model/playback-transition-progress";

const log = getLogger(import.meta.url);

/** Controls an editor-owned preview clock to inspect intermediate transition output. */
export function TransitionScrubber(props: {
  playback: types.InstanceInfo | undefined;
  cue: types.Cue | undefined;
  enabled: boolean;
}) {
  const [now, setNow] = createSignal(Date.now());
  const [pendingPosition, setPendingPosition] = createSignal<number>();
  const [durations] = createResource(
    () => props.cue,
    calculateCueTransitionDurations,
  );
  let queued:
    | { instanceId: types.InstanceId; position: number; playing: boolean }
    | undefined;
  let sending = false;

  /** Resolves the complete transition span, including per-fixture and part timing. */
  const duration = createMemo(() => durations()?.totalDuration ?? 0);
  /** Follows authoritative preview time unless a newer drag position is pending. */
  const position = createMemo(() =>
    Math.min(
      duration(),
      pendingPosition() ??
        playbackTransitionClock(props.playback, now())?.elapsedSeconds ??
        0,
    ),
  );

  /** Offers replay once the complete transition span has been reached. */
  const atEnd = createMemo(() => duration() > 0 && position() >= duration());

  /** Updates interpolated progress while the preview is running. */
  createEffect(() => {
    if (!props.playback || props.playback.is_paused) return;
    const timer = setInterval(() => setNow(Date.now()), 30);
    onCleanup(() => clearInterval(timer));
  });

  /** Serializes drag requests and keeps only the newest queued position. */
  const flush = async () => {
    if (sending) return;
    sending = true;
    try {
      while (queued) {
        const request = queued;
        queued = undefined;
        await seekPreviewInstance(
          request.instanceId,
          request.position,
          request.playing,
        );
      }
    } catch (error) {
      log.error("Unable to seek transition preview", error);
    } finally {
      sending = false;
      setPendingPosition(undefined);
    }
  };

  /** Moves to a bounded transition time and optionally continues playback. */
  const seek = (seconds: number, playing = false) => {
    const playback = props.playback;
    if (!playback) return;
    const bounded = Math.max(0, Math.min(duration(), seconds));
    setPendingPosition(bounded);
    queued = { instanceId: playback.instance_id, position: bounded, playing };
    void flush();
  };

  /** Discards unsent drag input when this editor control unmounts. */
  onCleanup(() => {
    queued = undefined;
  });

  return (
    <Show when={props.enabled && props.playback && duration() > 0}>
      <div
        class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-700"
        data-testid="transition-scrubber"
      >
        <ToolbarButton
          label="Step transition backward"
          tooltip="Step backward 0.1 seconds"
          onClick={() => seek(position() - 0.1)}
        >
          <CaretLeftIcon class="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={
            atEnd()
              ? "Restart transition"
              : props.playback?.is_paused
                ? "Resume transition"
                : "Pause transition"
          }
          onClick={() =>
            atEnd()
              ? seek(0, true)
              : seek(position(), props.playback?.is_paused ?? false)
          }
        >
          <Dynamic
            component={
              atEnd()
                ? ArrowCounterClockwiseIcon
                : props.playback?.is_paused
                  ? PlayIcon
                  : PauseIcon
            }
            class="size-4"
            aria-hidden
          />
        </ToolbarButton>
        <input
          class="min-w-12 flex-1 accent-blue-500"
          type="range"
          aria-label="Transition progress"
          min="0"
          max={duration()}
          step="0.01"
          value={position()}
          onInput={(event) => seek(event.currentTarget.valueAsNumber)}
        />
        <span class="whitespace-nowrap tabular-nums">
          {position().toFixed(2)} / {duration().toFixed(2)}s
        </span>
        <ToolbarButton
          label="Step transition forward"
          tooltip="Step forward 0.1 seconds"
          onClick={() => seek(position() + 0.1)}
        >
          <CaretRightIcon class="size-4" aria-hidden />
        </ToolbarButton>
      </div>
    </Show>
  );
}
