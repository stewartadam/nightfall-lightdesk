// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// TimelineRuler component
import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, For, Show } from "solid-js";
import { engineRuntime } from "../../../lib/engine-runtime";
import {
  setStoreAction,
  setStoreKeyAction,
} from "../../../lib/nanostore-action";
import { useShallowStore } from "../../../lib/use-shallow-store";
import {
  durationToMs,
  msToDuration,
  msToPixels,
  pixelsToMs,
} from "../../../lib/utils";
import { timelineBeatgridPreview, timelines } from "../../../state/appStores";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";
import {
  calculateBeatVisibility,
  msPerBeat,
  seekPositionFromTimelineX,
} from "../model/grid-utils";

export type TimelineRulerProps = {
  majorInterval?: number;
  minorInterval?: number;
  beatsPerBar?: number; // For BPM mode, number of beats per bar (default: 4)
};

type TickSet = {
  major: { time: number; label: string }[];
  minor: number[];
  bars: { time: number; barNumber: number }[];
};

type PointerIntent = "none" | "seek" | "shift";

const POINTER_DRAG_THRESHOLD_PX = 3;

export const TimelineRuler = (props: TimelineRulerProps) => {
  const shiftDragOwnerId = `timeline-ruler-${Math.random().toString(36).slice(2)}`;
  const SHIFT_OWNER_KEY = "__timelineBeatgridShiftOwner";
  const ctx = useTimelineContext();
  const $timelineBeatgridPreview = useStore(timelineBeatgridPreview);
  const $timelines = useShallowStore(timelines);
  const [majorTicks, setMajorTicks] = createSignal<
    { time: number; label: string }[]
  >([]);
  const [minorTicks, setMinorTicks] = createSignal<number[]>([]);
  const [barMarkers, setBarMarkers] = createSignal<
    { time: number; barNumber: number }[]
  >([]);
  const [previewMajorTicks, setPreviewMajorTicks] = createSignal<
    { time: number; label: string }[]
  >([]);
  const [previewMinorTicks, setPreviewMinorTicks] = createSignal<number[]>([]);
  const [previewBarMarkers, setPreviewBarMarkers] = createSignal<
    { time: number; barNumber: number }[]
  >([]);
  const [isShiftDragging, setIsShiftDragging] = createSignal(false);
  let activePointerId: number | undefined;
  let pointerIntent: PointerIntent = "none";
  let pointerStartClientX = 0;
  let pointerStartClientY = 0;
  let pointerDidMove = false;
  let shiftDragStartClientX = 0;
  let shiftDragDeltaPx = 0;
  let shiftDragStartMarkers: types.BeatMarker[] = [];

  const getActiveShiftOwner = () =>
    (window as Window & { [SHIFT_OWNER_KEY]?: string })[SHIFT_OWNER_KEY];

  const setActiveShiftOwner = (owner?: string) => {
    (window as Window & { [SHIFT_OWNER_KEY]?: string })[SHIFT_OWNER_KEY] =
      owner;
  };

  const previewBeatgrid = () => $timelineBeatgridPreview()[ctx.timelineUid];

  const shiftPreview = () => {
    const preview = previewBeatgrid();
    if (preview?.mode !== "shift") return undefined;
    return preview;
  };

  const isPreviewingShift = () => shiftPreview() !== undefined;

  const clearShiftPreview = () => {
    const preview = previewBeatgrid();
    if (preview?.mode !== "shift") return;
    const nextPreview = { ...timelineBeatgridPreview.get() };
    delete nextPreview[ctx.timelineUid];
    setStoreAction(
      timelineBeatgridPreview,
      "Clear Timeline Beatgrid Shift Preview",
      nextPreview,
    );
  };

  const getDownbeatOffset = (markers: types.BeatMarker[], beats: number) => {
    const clampedBeatsPerBar = Math.max(1, beats);
    const downbeatIndex = markers.findIndex((marker) => marker.is_downbeat);
    if (downbeatIndex < 0) return 0;
    return downbeatIndex % clampedBeatsPerBar;
  };

  const markersToTicks = (
    markers: types.BeatMarker[],
    start: number,
    end: number,
  ): TickSet => {
    const major: { time: number; label: string }[] = [];
    const minor: number[] = [];
    const bars: { time: number; barNumber: number }[] = [];

    let barNumber = 1;
    for (const marker of markers) {
      const markerTime = durationToMs(marker.time);
      if (marker.is_downbeat) {
        if (markerTime >= start && markerTime <= end) {
          major.push({ time: markerTime, label: "1" });
          bars.push({ time: markerTime, barNumber });
        }
        barNumber += 1;
      } else if (markerTime >= start && markerTime <= end) {
        minor.push(markerTime);
      }
    }

    return { major, minor, bars };
  };

  const buildAnchoredBpmTicks = (
    start: number,
    end: number,
    bpm: number,
    beats: number,
    anchorMarker?: types.BeatMarker,
  ): TickSet => {
    const major: { time: number; label: string }[] = [];
    const minor: number[] = [];
    const bars: { time: number; barNumber: number }[] = [];

    const beatDuration = msPerBeat(bpm);
    if (beatDuration <= 0) {
      return { major, minor, bars };
    }

    const beatsPerBarValue = Math.max(1, beats);
    const visibility = calculateBeatVisibility(ctx.zoom(), bpm);
    const anchorMs = anchorMarker ? durationToMs(anchorMarker.time) : 0;
    const anchorBeatIndex = anchorMarker?.beat_index ?? 0;
    const minBeatNumber = -anchorBeatIndex;
    const firstBeatNumber = Math.max(
      minBeatNumber,
      Math.ceil((start - anchorMs) / beatDuration),
    );

    for (
      let beatNumber = firstBeatNumber;
      anchorMs + beatNumber * beatDuration <= end;
      beatNumber++
    ) {
      const time = anchorMs + beatNumber * beatDuration;
      if (time < start) continue;

      const totalBeat = anchorBeatIndex + beatNumber;
      const beatInBar =
        ((totalBeat % beatsPerBarValue) + beatsPerBarValue) % beatsPerBarValue;

      if (beatInBar === 0) {
        if (visibility.showDownbeats) {
          const barNumber = Math.floor(totalBeat / beatsPerBarValue) + 1;
          major.push({ time, label: "1" });
          bars.push({ time, barNumber });
        }
      } else if (visibility.showBeats) {
        minor.push(time);
      }

      if (visibility.showSubdivisions) {
        const subdivisionDuration = beatDuration / visibility.subdivisionCount;
        for (let i = 1; i < visibility.subdivisionCount; i++) {
          const subdivisionTime = time + i * subdivisionDuration;
          if (subdivisionTime >= start && subdivisionTime <= end) {
            minor.push(subdivisionTime);
          }
        }
      }
    }

    return { major, minor, bars };
  };

  const buildDetectedBeatgridTicks = (
    markers: types.BeatMarker[],
    start: number,
    end: number,
    bpm: number,
    beats: number,
  ): TickSet => {
    if (markers.length <= 1) {
      return buildAnchoredBpmTicks(start, end, bpm, beats, markers[0]);
    }

    const explicitTicks = markersToTicks(markers, start, end);
    const lastMarker = markers[markers.length - 1];
    const lastMarkerMs = durationToMs(lastMarker.time);
    if (lastMarkerMs >= end) {
      return explicitTicks;
    }

    const extrapolatedTicks = buildAnchoredBpmTicks(
      Math.max(start, lastMarkerMs + 1),
      end,
      bpm,
      beats,
      markers[0],
    );

    return {
      major: [...explicitTicks.major, ...extrapolatedTicks.major],
      minor: [...explicitTicks.minor, ...extrapolatedTicks.minor],
      bars: [...explicitTicks.bars, ...extrapolatedTicks.bars],
    };
  };

  createEffect(() => {
    if (ctx.useBeatgrid() || isPreviewingShift()) {
      generateBpmTicks();
    } else {
      generateTimeTicks();
    }
  });

  createEffect(() => {
    const preview = shiftPreview();
    const start = ctx.start();
    const end = Math.max(ctx.end(), start + 60000);

    if (!preview || preview.markers.length === 0) {
      setPreviewMajorTicks([]);
      setPreviewMinorTicks([]);
      setPreviewBarMarkers([]);
      return;
    }

    const ticks = buildDetectedBeatgridTicks(
      preview.markers,
      start,
      end,
      ctx.bpm(),
      preview.beatsPerBar,
    );
    setPreviewMajorTicks(ticks.major);
    setPreviewMinorTicks(ticks.minor);
    setPreviewBarMarkers(ticks.bars);
  });

  const generateTimeTicks = () => {
    const major: { time: number; label: string }[] = [];
    const minor: number[] = [];

    const majorInterval = props.majorInterval || 5000;
    const minorInterval = props.minorInterval || 1000;

    const start = ctx.start();
    const end = Math.max(ctx.end(), start + 60000);

    for (
      let i = Math.floor(start / majorInterval) * majorInterval;
      i <= end;
      i += majorInterval
    ) {
      if (i >= start) {
        major.push({ time: i, label: formatTime(i) });
      }
    }

    for (
      let i = Math.floor(start / minorInterval) * minorInterval;
      i <= end;
      i += minorInterval
    ) {
      if (i >= start && !major.some((m) => m.time === i)) {
        minor.push(i);
      }
    }

    setMajorTicks(major);
    setMinorTicks(minor);
    setBarMarkers([]);
  };

  /** Generate BPM ticks. */
  const generateBpmTicks = () => {
    const start = ctx.start();
    const end = Math.max(ctx.end(), start + 60000);
    const beatgrid = ctx.beatgrid();

    if (beatgrid?.markers && beatgrid.markers.length > 1) {
      const ticks = buildDetectedBeatgridTicks(
        beatgrid.markers,
        start,
        end,
        ctx.bpm(),
        ctx.beatsPerBar(),
      );
      setMajorTicks(ticks.major);
      setMinorTicks(ticks.minor);
      setBarMarkers(ticks.bars);
      return;
    }

    const bpm = ctx.bpm();
    const anchorMarker = beatgrid?.markers?.[0];
    const ticks = buildAnchoredBpmTicks(
      start,
      end,
      bpm,
      ctx.beatsPerBar(),
      anchorMarker,
    );
    setMajorTicks(ticks.major);
    setMinorTicks(ticks.minor);
    setBarMarkers(ticks.bars);
  };

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
  };

  const seekAtClientX = (target: HTMLDivElement, clientX: number) => {
    const rect = target.getBoundingClientRect();
    const x = clientX - rect.left;
    const seekPosition = seekPositionFromTimelineX({
      x,
      start: ctx.start(),
      zoom: ctx.zoom(),
      snapEnabled: ctx.snapEnabled(),
      useBeatgrid: ctx.useBeatgrid() || isPreviewingShift(),
      bpm: ctx.bpm(),
      markers: shiftPreview()?.markers ?? ctx.beatgrid()?.markers,
    });
    ctx.playback.seek(seekPosition);
  };

  const resetPointerInteraction = () => {
    activePointerId = undefined;
    pointerIntent = "none";
    pointerDidMove = false;
    pointerStartClientX = 0;
    pointerStartClientY = 0;
    shiftDragStartClientX = 0;
    shiftDragDeltaPx = 0;
    shiftDragStartMarkers = [];
    setIsShiftDragging(false);
    setActiveShiftOwner(undefined);
  };

  const handlePointerDown = (e: PointerEvent) => {
    if (activePointerId !== undefined) return;

    activePointerId = e.pointerId;
    pointerStartClientX = e.clientX;
    pointerStartClientY = e.clientY;
    pointerDidMove = false;

    const beatgrid = ctx.beatgrid();
    const canShiftBeatgrid = ctx.useBeatgrid();

    pointerIntent = e.shiftKey && canShiftBeatgrid ? "shift" : "seek";
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);

    if (pointerIntent !== "shift") return;

    const startMarkers =
      beatgrid?.markers && beatgrid.markers.length > 0
        ? beatgrid.markers.map((marker) => ({
            ...marker,
            time: { ...marker.time },
          }))
        : [
            {
              time: msToDuration(0),
              beat_index: 0,
              is_downbeat: true,
              confidence: undefined,
            } satisfies types.BeatMarker,
          ];
    const previewSeedMarkers = startMarkers.map((marker) => ({
      ...marker,
      time: { ...marker.time },
    }));
    if (startMarkers.length === 0) return;

    shiftDragStartClientX = e.clientX;
    shiftDragDeltaPx = 0;
    shiftDragStartMarkers = startMarkers;
    setActiveShiftOwner(shiftDragOwnerId);
    setIsShiftDragging(true);
    setStoreKeyAction(
      timelineBeatgridPreview,
      "Start Timeline Beatgrid Shift",
      ctx.timelineUid,
      {
        mode: "shift",
        beatsPerBar: ctx.beatsPerBar(),
        downbeatOffset: getDownbeatOffset(startMarkers, ctx.beatsPerBar()),
        markers: previewSeedMarkers,
      },
    );
    e.preventDefault();
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (activePointerId !== e.pointerId) return;

    const totalDx = e.clientX - pointerStartClientX;
    const totalDy = e.clientY - pointerStartClientY;
    if (
      !pointerDidMove &&
      (Math.abs(totalDx) >= POINTER_DRAG_THRESHOLD_PX ||
        Math.abs(totalDy) >= POINTER_DRAG_THRESHOLD_PX)
    ) {
      pointerDidMove = true;
    }

    if (pointerIntent !== "shift" || !isShiftDragging()) return;
    if (getActiveShiftOwner() !== shiftDragOwnerId) return;
    if (shiftDragStartMarkers.length === 0) return;

    shiftDragDeltaPx = e.clientX - shiftDragStartClientX;

    const shiftedMarkers = shiftDragStartMarkers.map((marker) => {
      const markerMs = durationToMs(marker.time);
      const markerPx = msToPixels(markerMs - ctx.start(), ctx.zoom());
      const shiftedMs =
        ctx.start() +
        pixelsToMs(Math.trunc(markerPx + shiftDragDeltaPx), ctx.zoom());
      return {
        ...marker,
        time: msToDuration(Math.max(0, shiftedMs)),
      };
    });
    const downbeatOffset =
      shiftPreview()?.downbeatOffset ??
      getDownbeatOffset(shiftDragStartMarkers, ctx.beatsPerBar());
    setStoreKeyAction(
      timelineBeatgridPreview,
      "Update Timeline Beatgrid Shift",
      ctx.timelineUid,
      {
        mode: "shift",
        beatsPerBar: ctx.beatsPerBar(),
        downbeatOffset,
        markers: shiftedMarkers,
      },
    );
    e.preventDefault();
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (activePointerId !== e.pointerId) return;
    const target = e.currentTarget as HTMLDivElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }

    if (pointerIntent === "shift") {
      if (getActiveShiftOwner() === shiftDragOwnerId) {
        const preview = shiftPreview();
        const beatgrid = ctx.beatgrid();
        const timeline = $timelines()[ctx.timelineUid];
        const firstPreviewMarker = preview?.markers[0];
        const firstCurrentMarker = beatgrid?.markers?.[0];

        if (timeline && firstPreviewMarker) {
          const baselineTimeMs = firstCurrentMarker
            ? durationToMs(firstCurrentMarker.time)
            : 0;
          const shiftDeltaMs =
            durationToMs(firstPreviewMarker.time) - baselineTimeMs;
          if (shiftDeltaMs !== 0) {
            const command: types.TimelineCommand = {
              type: "SetBeatgridStart",
              data: {
                timeline_id: timeline.identifiers.id,
                audio_fingerprint: beatgrid?.audio_fingerprint ?? "",
                first_marker_time: firstPreviewMarker.time,
              },
            };
            engineRuntime.sendCommand({ module: "TimelineCommand", command });
          }
        }
      }
      clearShiftPreview();
      resetPointerInteraction();
      return;
    }

    if (pointerIntent === "seek" && !pointerDidMove) {
      seekAtClientX(target, e.clientX);
    }

    resetPointerInteraction();
  };

  const handlePointerCancel = (e: PointerEvent) => {
    if (activePointerId !== e.pointerId) return;
    const target = e.currentTarget as HTMLDivElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
    clearShiftPreview();
    resetPointerInteraction();
  };
  return (
    <div
      data-timeline-ruler="true"
      data-timeline-uid={ctx.timelineUid}
      data-seek-ignore="true"
      class={`relative h-8 border-b border-gray-800 select-none bg-[#252525] ${isShiftDragging() ? "cursor-grabbing" : "cursor-pointer"}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{ width: `${msToPixels(ctx.end() - ctx.start(), ctx.zoom())}px` }}
    >
      {/* Existing major ticks */}
      <For each={majorTicks()}>
        {(tick) => (
          <div
            class={`absolute h-full border-l flex items-end pb-1 ${isPreviewingShift() ? "border-gray-600/40" : "border-gray-600"}`}
            style={{
              left: `${msToPixels(tick.time - ctx.start(), ctx.zoom())}px`,
            }}
          >
            <Show when={!ctx.useBeatgrid()}>
              <span class="text-xs text-gray-400 ml-1 font-mono">
                {tick.label}
              </span>
            </Show>
          </div>
        )}
      </For>

      {/* Existing minor ticks */}
      <For each={minorTicks()}>
        {(tick) => (
          <div
            class={`absolute h-1/2 bottom-0 border-l ${isPreviewingShift() ? "border-gray-700/40" : "border-gray-700"}`}
            style={{ left: `${msToPixels(tick - ctx.start(), ctx.zoom())}px` }}
          />
        )}
      </For>

      {/* Existing bar markers */}
      <Show when={ctx.useBeatgrid() || isPreviewingShift()}>
        <For each={barMarkers()}>
          {(bar) => (
            <div
              class="absolute top-0 flex items-start justify-center h-full"
              style={{
                left: `${msToPixels(bar.time - ctx.start(), ctx.zoom())}px`,
              }}
            >
              <div
                class={`absolute top-0 left-0 h-full border-l-2 ${isPreviewingShift() ? "border-blue-500/35" : "border-blue-500"}`}
              />
              <span
                class={`text-xs font-mono px-1 rounded mt-0.5 relative relative left-1 ${isPreviewingShift() ? "text-blue-400/45" : "text-blue-400"}`}
              >
                {bar.barNumber}
              </span>
            </div>
          )}
        </For>
      </Show>

      {/* Shift preview (yellow) while dragging */}
      <Show when={isPreviewingShift()}>
        <For each={previewMajorTicks()}>
          {(tick) => (
            <div
              class="absolute h-full border-l border-amber-400/90 flex items-end pb-1"
              style={{
                left: `${msToPixels(tick.time - ctx.start(), ctx.zoom())}px`,
              }}
            />
          )}
        </For>

        <For each={previewMinorTicks()}>
          {(tick) => (
            <div
              class="absolute h-1/2 bottom-0 border-l border-amber-500/70"
              style={{
                left: `${msToPixels(tick - ctx.start(), ctx.zoom())}px`,
              }}
            />
          )}
        </For>

        <For each={previewBarMarkers()}>
          {(bar) => (
            <div
              class="absolute top-0 flex items-start justify-center h-full"
              style={{
                left: `${msToPixels(bar.time - ctx.start(), ctx.zoom())}px`,
              }}
            >
              <div class="absolute top-0 left-0 h-full border-l-2 border-amber-400" />
              <span class="text-xs font-mono px-1 rounded mt-0.5 relative left-1 text-amber-300">
                {bar.barNumber}
              </span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};
