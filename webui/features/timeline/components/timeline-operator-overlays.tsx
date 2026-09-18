// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createDraggable } from "@neodrag/solid";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Input } from "../../../components/ui/form-controls";
import { MenuItem, MenuSurface } from "../../../components/ui/menu";
import {
  durationToMs,
  msToDuration,
  msToPixels,
  pixelsToMs,
} from "../../../lib/utils";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";
import {
  quantizeSeekPositionMs,
  seekPositionFromTimelineX,
} from "../model/grid-utils";

const DEFAULT_REGION_MS = 10_000;

type RegionDragMode = "body" | "start" | "end";

type RegionDragState = {
  mode: RegionDragMode;
  region: types.TimelineRegion;
  pointerStartMs: number;
  regionStartMs: number;
  regionEndMs: number;
};

type RegionPreview = {
  uid: string;
  startMs: number;
  endMs: number;
};

type MarkerLabelEditorProps = {
  marker: types.TimelineMarker;
};

/** Renders the inline marker label editor and selects the default label. */
const MarkerLabelEditor = (props: MarkerLabelEditorProps) => {
  const ctx = useTimelineContext();
  let inputRef: HTMLInputElement | undefined;

  /** Returns the current draft label for this marker. */
  const label = () =>
    ctx.markerLabelEditing.draftLabel(props.marker.uid, props.marker.label);

  /** Returns a text-relative input width that grows with the edited label. */
  const inputWidth = () => `${Math.max(1, label().length)}ch`;

  /** Commits the current marker label and closes the inline editor. */
  const commit = () => {
    const nextLabel = label().trim() || props.marker.label;
    ctx.markersActions.storeMarker({ ...props.marker, label: nextLabel });
    ctx.markerLabelEditing.clearDraftLabel(props.marker.uid);
    ctx.markerLabelEditing.stopEditing();
  };

  /** Cancels marker label editing without changing the marker. */
  const cancel = () => {
    ctx.markerLabelEditing.clearDraftLabel(props.marker.uid);
    ctx.markerLabelEditing.stopEditing();
  };

  /** Accepts focus-out edits without treating server remounts as blur commits. */
  const handleBlur = (
    event: FocusEvent & { currentTarget: HTMLInputElement },
  ) => {
    const input = event.currentTarget;
    window.setTimeout(() => {
      if (!input.isConnected) return;
      if (ctx.markerLabelEditing.editingMarkerUid() !== props.marker.uid)
        return;
      commit();
    });
  };

  /** Focuses the inline editor and selects the default marker name. */
  onMount(() => {
    inputRef?.focus();
    inputRef?.select();
  });

  return (
    <Input
      density="compact"
      ref={inputRef}
      aria-label="Marker label"
      class="select-text"
      style={{
        width: `calc(${inputWidth()} + 16px)`,
        "max-width": "60ch",
        height: "20px",
      }}
      value={label()}
      onInput={(event) =>
        ctx.markerLabelEditing.setDraftLabel(
          props.marker.uid,
          event.currentTarget.value,
        )
      }
      onBlur={handleBlur}
      onClick={(event) => event.stopPropagation()}
      onDblClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

type LoopDragEdge = "start" | "end";

type LoopDragState = {
  edge: LoopDragEdge;
  loop: types.TimelineLoopRange;
  pointerStartMs: number;
  loopStartMs: number;
  loopEndMs: number;
};

type LoopPreview = {
  startMs: number;
  endMs: number;
};

const createUid = (prefix: string) => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, "");
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
};

const colorStyle = (color: string | undefined, fallback: string) =>
  color?.trim() || fallback;

const nextMarkerLabel = (markers: types.TimelineMarker[]) => {
  const existing = new Set(markers.map((marker) => marker.label));
  let index = markers.length + 1;
  let label = `Marker ${index}`;
  while (existing.has(label)) {
    index += 1;
    label = `Marker ${index}`;
  }
  return label;
};

export const buildMarkerAt = (
  markers: types.TimelineMarker[],
  positionMs: number,
): types.TimelineMarker => ({
  uid: createUid("timeline-marker"),
  label: nextMarkerLabel(markers),
  time: msToDuration(Math.max(0, Math.round(positionMs))),
  color: "#facc15",
});

const buildRegionAt = (positionMs: number): types.TimelineRegion => ({
  uid: createUid("timeline-region"),
  label: "Region",
  start: msToDuration(Math.max(0, Math.round(positionMs))),
  end: msToDuration(Math.max(0, Math.round(positionMs + DEFAULT_REGION_MS))),
  color: "#38bdf8",
});

const sortedMarkers = (markers: types.TimelineMarker[]) =>
  markers
    .map((marker, creationIndex) => ({ marker, creationIndex }))
    .sort((a, b) => {
      const diff = durationToMs(a.marker.time) - durationToMs(b.marker.time);
      return diff === 0 ? a.creationIndex - b.creationIndex : diff;
    });

export const seekAdjacentMarker = (
  markers: types.TimelineMarker[],
  currentPosition: number,
  direction: "previous" | "next",
) => {
  const ordered = sortedMarkers(markers);
  if (direction === "previous") {
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const marker = ordered[index]?.marker;
      if (marker && durationToMs(marker.time) < currentPosition) {
        return durationToMs(marker.time);
      }
    }
    const last = ordered[ordered.length - 1];
    return last ? durationToMs(last.marker.time) : undefined;
  }

  for (const { marker } of ordered) {
    if (durationToMs(marker.time) > currentPosition) {
      return durationToMs(marker.time);
    }
  }
  return ordered[0] ? durationToMs(ordered[0].marker.time) : undefined;
};

/**
 * Displays and resizes the active loop range over the timeline ruler.
 */
export const LoopRangeBackdrop = () => {
  const ctx = useTimelineContext();
  let rangeRef: HTMLDivElement | undefined;
  const [loopDrag, setLoopDrag] = createSignal<LoopDragState | undefined>(
    undefined,
  );
  const [loopPreview, setLoopPreview] = createSignal<LoopPreview | undefined>(
    undefined,
  );

  const quantizePosition = (positionMs: number) =>
    quantizeSeekPositionMs(positionMs, {
      snapEnabled: ctx.snapEnabled(),
      useBeatgrid: ctx.useBeatgrid(),
      bpm: ctx.bpm(),
      markers: ctx.beatgrid()?.markers,
    });

  const pointerPositionMs = (clientX: number) => {
    const scrollContainer = rangeRef?.parentElement;
    if (!scrollContainer) return ctx.start();
    const rect = scrollContainer.getBoundingClientRect();
    const positionPx = Math.max(
      0,
      clientX - rect.left + scrollContainer.scrollLeft,
    );
    return quantizePosition(ctx.start() + pixelsToMs(positionPx, ctx.zoom()));
  };

  const loopBounds = createMemo(() => {
    const loop = ctx.loopRange();
    if (!loop) return undefined;
    const preview = loopPreview();
    return {
      loop,
      startMs: preview?.startMs ?? durationToMs(loop.start),
      endMs: preview?.endMs ?? durationToMs(loop.end),
    };
  });

  const style = createMemo(() => {
    const bounds = loopBounds();
    if (!bounds) return undefined;
    return {
      left: `${msToPixels(bounds.startMs - ctx.start(), ctx.zoom())}px`,
      width: `${Math.max(1, msToPixels(bounds.endMs - bounds.startMs, ctx.zoom()))}px`,
    };
  });

  const nextLoopBounds = (drag: LoopDragState, clientX: number) => {
    const pointerMs = pointerPositionMs(clientX);
    const deltaMs = pointerMs - drag.pointerStartMs;

    if (drag.edge === "start") {
      return {
        startMs: Math.min(
          Math.max(0, drag.loopStartMs + deltaMs),
          drag.loopEndMs,
        ),
        endMs: drag.loopEndMs,
      };
    }

    return {
      startMs: drag.loopStartMs,
      endMs: Math.max(drag.loopStartMs, drag.loopEndMs + deltaMs),
    };
  };

  const handleLoopMouseMove = (event: MouseEvent) => {
    const drag = loopDrag();
    if (!drag) return;
    event.preventDefault();
    setLoopPreview(nextLoopBounds(drag, event.clientX));
  };

  const handleLoopMouseUp = (event: MouseEvent) => {
    window.removeEventListener("mousemove", handleLoopMouseMove);
    const drag = loopDrag();
    setLoopDrag(undefined);
    setLoopPreview(undefined);
    if (!drag) return;
    const next = nextLoopBounds(drag, event.clientX);
    ctx.loopActions.setLoopRange({
      ...drag.loop,
      start: msToDuration(next.startMs),
      end: msToDuration(next.endMs),
    });
  };

  const startLoopDrag = (event: MouseEvent, edge: LoopDragEdge) => {
    const loop = ctx.loopRange();
    if (!loop) return;
    event.preventDefault();
    event.stopPropagation();
    const drag: LoopDragState = {
      edge,
      loop,
      pointerStartMs: pointerPositionMs(event.clientX),
      loopStartMs: durationToMs(loop.start),
      loopEndMs: durationToMs(loop.end),
    };
    setLoopDrag(drag);
    setLoopPreview({ startMs: drag.loopStartMs, endMs: drag.loopEndMs });
    window.addEventListener("mousemove", handleLoopMouseMove);
    window.addEventListener("mouseup", handleLoopMouseUp, { once: true });
  };

  onCleanup(() => {
    window.removeEventListener("mousemove", handleLoopMouseMove);
    window.removeEventListener("mouseup", handleLoopMouseUp);
  });

  return (
    <Show when={style()}>
      {(rangeStyle) => (
        <>
          <div
            data-timeline-loop-overlay="true"
            class={`pointer-events-none absolute top-0 bottom-0 z-[1] border-x ${
              ctx.loopRange()?.enabled
                ? "border-emerald-300/70 bg-emerald-500/10"
                : "border-slate-400/60 bg-slate-400/5"
            }`}
            style={rangeStyle()}
          />
          <div
            ref={rangeRef}
            class="pointer-events-none absolute top-0 bottom-0 z-[20]"
            style={rangeStyle()}
          >
            <button
              type="button"
              aria-label="Resize loop range start"
              data-seek-ignore="true"
              class="pointer-events-auto absolute left-0 top-0 h-full w-3 cursor-ew-resize border-l border-emerald-200/90 bg-emerald-200/25"
              style={{ cursor: "ew-resize" }}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => startLoopDrag(event, "start")}
            />
            <button
              type="button"
              aria-label="Resize loop range end"
              data-seek-ignore="true"
              class="pointer-events-auto absolute right-0 top-0 h-full w-3 cursor-ew-resize border-r border-emerald-200/90 bg-emerald-200/25"
              style={{ cursor: "ew-resize" }}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => startLoopDrag(event, "end")}
            />
          </div>
        </>
      )}
    </Show>
  );
};

/**
 * Renders draggable timeline regions and markers in the operator lane.
 */
export const TimelineOperatorLane = () => {
  const ctx = useTimelineContext();
  let laneRef: HTMLDivElement | undefined;
  const [menuPosition, setMenuPosition] = createSignal<
    { x: number; y: number; positionMs: number } | undefined
  >(undefined);
  const [regionDrag, setRegionDrag] = createSignal<RegionDragState | undefined>(
    undefined,
  );
  const [regionPreview, setRegionPreview] = createSignal<
    RegionPreview | undefined
  >(undefined);
  const [draggingMarkerUid, setDraggingMarkerUid] = createSignal<
    string | undefined
  >(undefined);

  const { draggable } = createDraggable();
  void draggable;

  const quantizePosition = (positionMs: number) =>
    quantizeSeekPositionMs(positionMs, {
      snapEnabled: ctx.snapEnabled(),
      useBeatgrid: ctx.useBeatgrid(),
      bpm: ctx.bpm(),
      markers: ctx.beatgrid()?.markers,
    });

  const pointerPositionMs = (clientX: number) => {
    if (!laneRef) return ctx.start();
    const rect = laneRef.getBoundingClientRect();
    return quantizePosition(
      ctx.start() + pixelsToMs(clientX - rect.left, ctx.zoom()),
    );
  };

  const startRegionDrag = (
    event: MouseEvent,
    region: types.TimelineRegion,
    mode: RegionDragMode,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const drag: RegionDragState = {
      mode,
      region,
      pointerStartMs: pointerPositionMs(event.clientX),
      regionStartMs: durationToMs(region.start),
      regionEndMs: durationToMs(region.end),
    };
    setRegionDrag(drag);
    setRegionPreview({
      uid: region.uid,
      startMs: drag.regionStartMs,
      endMs: drag.regionEndMs,
    });
    ctx.selectTimelineObject({
      type:
        mode === "start"
          ? "RegionStart"
          : mode === "end"
            ? "RegionEnd"
            : "RegionBody",
      data: { region_uid: region.uid },
    });
    window.addEventListener("mousemove", handleRegionMouseMove);
    window.addEventListener("mouseup", handleRegionMouseUp, { once: true });
  };

  const nextRegionBounds = (drag: RegionDragState, clientX: number) => {
    const pointerMs = pointerPositionMs(clientX);
    const deltaMs = pointerMs - drag.pointerStartMs;
    const durationMs = Math.max(0, drag.regionEndMs - drag.regionStartMs);

    if (drag.mode === "body") {
      const startMs = Math.max(0, drag.regionStartMs + deltaMs);
      return { startMs, endMs: startMs + durationMs };
    }

    if (drag.mode === "start") {
      return {
        startMs: Math.min(
          Math.max(0, drag.regionStartMs + deltaMs),
          drag.regionEndMs,
        ),
        endMs: drag.regionEndMs,
      };
    }

    return {
      startMs: drag.regionStartMs,
      endMs: Math.max(drag.regionStartMs, drag.regionEndMs + deltaMs),
    };
  };

  const handleRegionMouseMove = (event: MouseEvent) => {
    const drag = regionDrag();
    if (!drag) return;
    event.preventDefault();
    const next = nextRegionBounds(drag, event.clientX);
    setRegionPreview({
      uid: drag.region.uid,
      ...next,
    });
  };

  const handleRegionMouseUp = (event: MouseEvent) => {
    window.removeEventListener("mousemove", handleRegionMouseMove);
    const drag = regionDrag();
    setRegionDrag(undefined);
    setRegionPreview(undefined);
    if (!drag) return;
    const next = nextRegionBounds(drag, event.clientX);
    ctx.regionsActions.storeRegion({
      ...drag.region,
      start: msToDuration(next.startMs),
      end: msToDuration(next.endMs),
    });
  };

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const currentTarget = event.currentTarget as HTMLElement | null;
    if (!currentTarget) return;
    const rect = currentTarget.getBoundingClientRect();
    const positionPx = event.clientX - rect.left;
    setMenuPosition({
      x: event.clientX,
      y: event.clientY,
      positionMs: quantizePosition(
        ctx.start() + pixelsToMs(positionPx, ctx.zoom()),
      ),
    });
  };

  const seekAtClientX = (clientX: number) => {
    if (!laneRef) return;
    const rect = laneRef.getBoundingClientRect();
    const seekPosition = seekPositionFromTimelineX({
      x: clientX - rect.left,
      start: ctx.start(),
      zoom: ctx.zoom(),
      snapEnabled: ctx.snapEnabled(),
      useBeatgrid: ctx.useBeatgrid(),
      bpm: ctx.bpm(),
      markers: ctx.beatgrid()?.markers,
    });
    ctx.playback.seek(seekPosition);
  };

  const handleLaneClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (event.defaultPrevented || event.target !== event.currentTarget) {
      return;
    }
    seekAtClientX(event.clientX);
  };

  const createMarker = (positionMs: number) => {
    const marker = buildMarkerAt(ctx.markers(), positionMs);
    ctx.markersActions.storeMarker(marker);
    ctx.selectTimelineObject({
      type: "Marker",
      data: { marker_uid: marker.uid },
    });
    ctx.markerLabelEditing.startEditing(marker.uid, marker.label);
    setMenuPosition(undefined);
  };

  const createRegion = (positionMs: number) => {
    const region = buildRegionAt(positionMs);
    ctx.regionsActions.storeRegion(region);
    ctx.selectTimelineObject({
      type: "RegionBody",
      data: { region_uid: region.uid },
    });
    setMenuPosition(undefined);
  };

  const setLoopFromRegion = (region: types.TimelineRegion) => {
    ctx.loopActions.setLoopRange({
      start: region.start,
      end: region.end,
      enabled: true,
    });
  };

  const playheadActiveMarkerUid = createMemo(() => {
    const playheadPositionMs = ctx.position();
    let currentMarkerUid: string | undefined;

    for (const { marker } of sortedMarkers(ctx.markers())) {
      const markerPositionMs = durationToMs(marker.time);
      if (markerPositionMs <= playheadPositionMs) {
        currentMarkerUid = marker.uid;
        continue;
      }
      break;
    }

    return currentMarkerUid;
  });

  const playheadActiveRegionUids = createMemo(() => {
    const playheadPositionMs = ctx.position();
    return new Set(
      ctx
        .regions()
        .filter((region) => {
          const startMs = durationToMs(region.start);
          const endMs = durationToMs(region.end);
          return startMs <= playheadPositionMs && playheadPositionMs <= endMs;
        })
        .map((region) => region.uid),
    );
  });

  const regionLayer = (regionUid: string) => {
    if (regionPreview()?.uid === regionUid) return 10;
    const selection = ctx.selection();
    if (
      (selection?.type === "RegionBody" ||
        selection?.type === "RegionStart" ||
        selection?.type === "RegionEnd") &&
      selection.data.region_uid === regionUid
    ) {
      return 8;
    }
    if (playheadActiveRegionUids().has(regionUid)) return 6;
    return 2;
  };

  const markerLayer = (markerUid: string) => {
    if (draggingMarkerUid() === markerUid) return 10;
    if (
      ctx.markersActions
        .selectedMarkers()
        .some((selection) => selection.markerUid === markerUid)
    ) {
      return 8;
    }
    if (playheadActiveMarkerUid() === markerUid) return 6;
    return 4;
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: The lane consumes clicks to prevent parent timeline seeking; keyboard actions are registered as timeline shortcuts.
    <div
      ref={laneRef}
      data-timeline-operator-lane="true"
      class="relative h-9 border-b border-gray-800 bg-[#1a1a1a]"
      style={{ width: `${msToPixels(ctx.end(), ctx.zoom())}px` }}
      onClick={handleLaneClick}
      onContextMenu={handleContextMenu}
    >
      <For each={ctx.regions()}>
        {(region) => {
          const preview = () =>
            regionPreview()?.uid === region.uid ? regionPreview() : undefined;

          /** Returns the preview start while dragging, otherwise the stored region start. */
          const startMs = () =>
            preview()?.startMs ?? durationToMs(region.start);

          /** Returns the preview end while dragging, otherwise the stored region end. */
          const endMs = () => preview()?.endMs ?? durationToMs(region.end);

          /** Converts the region start time to a lane-relative pixel offset. */
          const leftPx = () => msToPixels(startMs() - ctx.start(), ctx.zoom());

          /** Converts the region duration to a visible pixel width. */
          const widthPx = () =>
            Math.max(1, msToPixels(endMs() - startMs(), ctx.zoom()));

          /** Returns whether any part of this region is selected. */
          const selected = () =>
            (() => {
              const selection = ctx.selection();
              return (
                (selection?.type === "RegionBody" ||
                  selection?.type === "RegionStart" ||
                  selection?.type === "RegionEnd") &&
                selection.data.region_uid === region.uid
              );
            })();
          return (
            <div
              data-timeline-region="true"
              data-region-id={region.uid}
              role="button"
              tabIndex={0}
              class={`absolute top-1 h-7 cursor-grab overflow-hidden rounded border text-[11px] leading-7 shadow ${
                selected()
                  ? "border-white ring-1 ring-white"
                  : "border-sky-300/70"
              }`}
              style={{
                left: `${leftPx()}px`,
                width: `${widthPx()}px`,
                "background-color": `${colorStyle(region.color, "#38bdf8")}55`,
                color: "#f8fafc",
                "z-index": regionLayer(region.uid),
              }}
              onClick={(event) => {
                event.stopPropagation();
                ctx.selectTimelineObject({
                  type: "RegionBody",
                  data: { region_uid: region.uid },
                });
              }}
              onMouseDown={(event) => startRegionDrag(event, region, "body")}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                ctx.selectTimelineObject({
                  type: "RegionBody",
                  data: { region_uid: region.uid },
                });
              }}
              onDblClick={(event) => {
                event.stopPropagation();
                const label = window.prompt("Region label", region.label);
                if (label !== null) {
                  ctx.regionsActions.storeRegion({ ...region, label });
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setLoopFromRegion(region);
              }}
            >
              <button
                type="button"
                aria-label="Resize region start"
                class="absolute left-0 top-0 z-10 h-full w-3 cursor-ew-resize bg-white/25"
                style={{ cursor: "ew-resize" }}
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => startRegionDrag(event, region, "start")}
              />
              <span class="pointer-events-none block truncate px-3">
                {region.label}
              </span>
              <button
                type="button"
                aria-label="Resize region end"
                class="absolute right-0 top-0 z-10 h-full w-3 cursor-ew-resize bg-white/25"
                style={{ cursor: "ew-resize" }}
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => startRegionDrag(event, region, "end")}
              />
            </div>
          );
        }}
      </For>

      <For each={ctx.markers()}>
        {(marker) => {
          /** Returns the marker's position in milliseconds for lane layout and dragging. */
          const positionMs = () => durationToMs(marker.time);

          /** Converts the marker time to a lane-relative pixel offset. */
          const leftPx = () =>
            msToPixels(positionMs() - ctx.start(), ctx.zoom());

          /** Returns whether this marker is part of the current marker selection. */
          const selected = () =>
            ctx.markersActions
              .selectedMarkers()
              .some((selection) => selection.markerUid === marker.uid);

          /** Returns whether this marker is currently in inline label editing. */
          const editing = () =>
            ctx.markerLabelEditing.editingMarkerUid() === marker.uid;
          return (
            <div
              data-timeline-marker="true"
              data-marker-id={marker.uid}
              role="button"
              tabIndex={0}
              use:draggable={{
                axis: "x",
                grid: [1, 0],
                bounds: { left: 0 },
                onDragStart: () => {
                  setDraggingMarkerUid(marker.uid);
                  ctx.markersActions.selectMarker(marker.uid);
                },
                onDragEnd: ({ offsetX }) => {
                  setDraggingMarkerUid(undefined);
                  const nextPosition = quantizePosition(
                    ctx.start() + pixelsToMs(leftPx() + offsetX, ctx.zoom()),
                  );
                  ctx.markersActions.storeMarker({
                    ...marker,
                    time: msToDuration(nextPosition),
                  });
                },
              }}
              class="absolute top-0 h-9 w-px cursor-grab"
              style={{
                left: `${leftPx()}px`,
                "z-index": markerLayer(marker.uid),
              }}
              onClick={(event) => {
                event.stopPropagation();
                ctx.markersActions.selectMarker(marker.uid, {
                  range: event.shiftKey,
                  toggle: !event.shiftKey && (event.ctrlKey || event.metaKey),
                });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                ctx.markersActions.selectMarker(marker.uid);
                if (event.key === "Enter") {
                  ctx.markerLabelEditing.startEditing(marker.uid, marker.label);
                }
              }}
              onDblClick={(event) => {
                event.stopPropagation();
                ctx.markerLabelEditing.startEditing(marker.uid, marker.label);
              }}
            >
              <div
                class={`absolute left-0 top-0 bottom-0 w-px ${
                  selected() ? "bg-white" : "bg-amber-300"
                }`}
              />
              <div
                class={`absolute left-0 top-0 rounded-r-md rounded-l-none border px-2 py-[2px] text-[11px] leading-tight shadow-sm ${
                  editing() ? "" : "max-w-[160px] truncate"
                } ${
                  selected()
                    ? "border-white bg-amber-300 text-black"
                    : "border-amber-300 bg-amber-950 text-amber-100"
                }`}
              >
                <Show when={editing()} fallback={<span>{marker.label}</span>}>
                  <MarkerLabelEditor marker={marker} />
                </Show>
              </div>
            </div>
          );
        }}
      </For>

      <Show when={menuPosition()}>
        {(menu) => (
          <Portal>
            <div
              class="fixed inset-0 nightfall-top-layer"
              onPointerDown={() => setMenuPosition(undefined)}
            >
              <MenuSurface
                class="fixed min-w-[180px]"
                style={{
                  left: `${Math.max(12, Math.min(menu().x, window.innerWidth - 220))}px`,
                  top: `${Math.max(12, Math.min(menu().y, window.innerHeight - 140))}px`,
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <MenuItem onClick={() => createMarker(menu().positionMs)}>
                  Add marker
                </MenuItem>
                <MenuItem onClick={() => createRegion(menu().positionMs)}>
                  Add region
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    ctx.loopActions.setLoopRange({
                      start: msToDuration(menu().positionMs),
                      end: msToDuration(menu().positionMs + DEFAULT_REGION_MS),
                      enabled: true,
                    });
                    setMenuPosition(undefined);
                  }}
                >
                  Set loop range
                </MenuItem>
              </MenuSurface>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
};
