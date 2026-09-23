// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { RepeatIcon } from "@squidlab/phosphor-solid/repeat";
import { SkipBackIcon } from "@squidlab/phosphor-solid/skip-back";
import { SkipForwardIcon } from "@squidlab/phosphor-solid/skip-forward";
import { TagIcon } from "@squidlab/phosphor-solid/tag";
import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import {
  useConditionalShallowStore,
  useShallowStore,
} from "../../../lib/use-shallow-store";
import { durationToMs, msToDuration, msToPixels } from "../../../lib/utils";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { timecodes, timelines } from "../../../state/appStores";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import { BeatDisplay } from "../components/beat-display";
import { BeatgridControls } from "../components/beatgrid-controls";
import { DurationTrailControl } from "../components/duration-trail-control";
import { InstanceControls } from "../components/playback-controls";
import { GhostPlayhead, Playhead } from "../components/playhead";
import {
  ScrollMode,
  ScrollModeControls,
} from "../components/scroll-mode-controls";
import { ConnectedSMPTEFrameDisplay } from "../components/smpte-frame-display";
import { SnapControl } from "../components/snap-control";
import { TimelineActionEdgeHints } from "../components/timeline-action-edge-hints";
import TimelineActionProperties from "../components/timeline-action-properties";
import { TimelineGotoPopout } from "../components/timeline-goto-popout";
import {
  buildMarkerAt,
  LoopRangeBackdrop,
  seekAdjacentMarker,
  TimelineOperatorLane,
} from "../components/timeline-operator-overlays";
import TimelineProperties from "../components/timeline-properties";
import { TimelineRuler } from "../components/timeline-ruler";
import { ConnectedTracksContents } from "../components/track-contents";
import { ConnectedTrackHeaders } from "../components/track-headers";
import { ConnectedWaveform } from "../components/waveform";
import {
  ZoomControls,
  zoomTimelineIn,
  zoomTimelineOut,
} from "../components/zoom-controls";
import {
  TimelineContextProvider,
  type TimelineNudgeUnit,
  useTimelineContext,
} from "../context/timeline-context";
import { deleteLoopRange, toggleLoopRange } from "../model/timeline-loop";
import { createTimelineAudioDropController } from "../services/timeline-audio-drop";
import { TimelineEventListener } from "../services/timeline-event-listener";
import { refocusTimelinePanel } from "../services/timeline-panel-focus";
import { createTimelinePointerController } from "../services/timeline-pointer";
import { TimelineShortcutBindings } from "../services/timeline-shortcut-bindings";

const log = getLogger(import.meta.url);
const TIMELINE_VIEWPORT_STORAGE_PREFIX = "nightfall.timeline.viewport";
const TRACK_HEADER_WIDTH_PX = 192;
const TIMELINE_CHROME_HEIGHT_PX = 136;

export type TimelineControllerProps = {
  initialPanelId: string;
  initialTimelineUid: string;
};

/** Registers Timeline-owned content for the global Properties inspector. */
const TimelinePropertiesProvider = (props: { componentId: string }) => {
  const ctx = useTimelineContext();

  /** Resolves the single selected action, if the timeline has exactly one. */
  const selectedAction = createMemo(() => {
    const selectedActions = ctx.actions.selectedActions();
    return selectedActions.length === 1 ? selectedActions[0] : undefined;
  });

  usePropertiesInspector(
    props.componentId,
    "Timeline",
    () => (
      <Show
        when={selectedAction()}
        fallback={<TimelineProperties timelineUid={ctx.timelineUid} />}
      >
        <TimelineActionProperties
          timelineUid={ctx.timelineUid}
          selectedItem={selectedAction}
          tracks={ctx.tracks}
          updateAction={ctx.actions.updateAction}
        />
      </Show>
    ),
    { priority: 10, autoActivate: true },
  );

  return null;
};

/**
 * Renders the snap and nudge granularity select beside the snap toggle.
 */
const NudgeUnitSelect = () => {
  const ctx = useTimelineContext();

  return (
    <div class="w-20 shrink-0">
      <NativeSelect
        density="compact"
        aria-label="Nudge unit"
        value={ctx.nudgeUnit()}
        onChange={(event) => {
          ctx.setNudgeUnit(event.currentTarget.value as TimelineNudgeUnit);
          refocusTimelinePanel(event.currentTarget, ctx.componentId);
        }}
        title="Nudge unit"
      >
        <option value="bar">Bar</option>
        <option value="beat">Beat</option>
        <option value="half">1/2</option>
        <option value="quarter">1/4</option>
        <option value="eighth">1/8</option>
      </NativeSelect>
    </div>
  );
};

/**
 * Renders compact marker and loop controls for timeline operators.
 */
const TimelineOperatorControls = () => {
  const ctx = useTimelineContext();

  return (
    <div class="flex items-center gap-1">
      <ToolbarButton
        type="button"
        onClick={() => {
          const markerPosition = seekAdjacentMarker(
            ctx.markers(),
            ctx.position(),
            "previous",
          );
          if (markerPosition !== undefined) ctx.playback.seek(markerPosition);
        }}
        label="Previous marker"
        tooltip="Previous marker"
      >
        <SkipBackIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        type="button"
        onClick={() => {
          const marker = buildMarkerAt(ctx.markers(), ctx.position());
          ctx.markersActions.storeMarker(marker);
          ctx.markersActions.selectMarker(marker.uid);
        }}
        label="Drop marker"
        tooltip="Drop marker"
      >
        <TagIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        type="button"
        onClick={() => {
          const markerPosition = seekAdjacentMarker(
            ctx.markers(),
            ctx.position(),
            "next",
          );
          if (markerPosition !== undefined) ctx.playback.seek(markerPosition);
        }}
        label="Next marker"
        tooltip="Next marker"
      >
        <SkipForwardIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarSeparator />
      <ToolbarButton
        type="button"
        ariaPressed={ctx.loopRange()?.enabled ?? false}
        label="Toggle loop range"
        onClick={(event) => {
          if (event.shiftKey) {
            deleteLoopRange(ctx);
            return;
          }
          toggleLoopRange(ctx);
        }}
        tooltip="Toggle loop range (Shift-click deletes loop)"
      >
        <RepeatIcon class="size-4" aria-hidden />
      </ToolbarButton>
    </div>
  );
};

/**
 * Coordinates timeline playback, editing gestures, and nested timeline controls.
 */
export const TimelineController = (props: TimelineControllerProps) => {
  log.trace("mounting");
  let scrollContainerRef: HTMLDivElement | undefined;
  let timelinePlaneRef: HTMLDivElement | undefined;
  const $timelines = useShallowStore(timelines);
  const $timecodes = useConditionalShallowStore(
    timecodes,
    useWorkspaceActivity(),
  );
  const pointer = createTimelinePointerController({
    scrollContainer: () => scrollContainerRef,
    timelinePlane: () => timelinePlaneRef,
    trackHeaderWidth: TRACK_HEADER_WIDTH_PX,
  });

  const COMPONENT_ID = props.initialPanelId;

  const sendSetRecordingCommand = (request: {
    enabled: boolean;
    targetTrackId?: string;
  }) => {
    const timeline = $timelines()[props.initialTimelineUid];
    if (!timeline) {
      return;
    }

    const command: types.TimelineCommand = {
      type: "SetTimelineRecording",
      data: {
        timeline_id: timeline.identifiers.id,
        enabled: request.enabled,
        target_track_id: request.targetTrackId,
      },
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });
  };

  const sendTimecodeCommand = (
    commandForTimecode: (timecodeId: number) => types.TimecodeCommand,
  ) => {
    const timeline = $timelines()[props.initialTimelineUid];
    if (!timeline) {
      return;
    }

    const timecode = $timecodes()[timeline.timecode_uid]?.[0];
    if (!timecode) {
      log.warn("Timeline playback skipped because linked timecode is missing", {
        timelineUid: timeline.identifiers.uid,
        timecodeUid: timeline.timecode_uid,
      });
      return;
    }

    engineRuntime.sendCommand({
      module: "TimecodeCommand",
      command: commandForTimecode(timecode.identifiers.id),
    });
  };

  const sendTimelineCommand = (
    commandForTimeline: (timelineId: number) => types.TimelineCommand,
  ) => {
    const timeline = $timelines()[props.initialTimelineUid];
    if (!timeline) {
      return;
    }

    engineRuntime.sendCommand({
      module: "TimelineCommand",
      command: commandForTimeline(timeline.identifiers.id),
    });
  };

  const isManualTriggerMode = () =>
    $timelines()[props.initialTimelineUid]?.trigger_mode === "Manual";

  const playbackCommands = {
    onPlay: () => {
      engineRuntime.sendCommand({
        module: "TimelineTransportCommand",
        command: {
          type: "SetPlaying",
          data: { timeline_uid: props.initialTimelineUid, playing: true },
        },
      });
    },
    onPause: () => {
      engineRuntime.sendCommand({
        module: "TimelineTransportCommand",
        command: {
          type: "SetPlaying",
          data: { timeline_uid: props.initialTimelineUid, playing: false },
        },
      });
    },
    onSeek: (position: number) =>
      sendTimecodeCommand((timecodeId) => ({
        type: "SeekTimecode",
        data: {
          id: timecodeId,
          position: msToDuration(position),
        },
      })),
    onStop: () => {
      if (isManualTriggerMode()) {
        sendTimelineCommand((timelineId) => ({
          type: "StopTimeline",
          data: timelineId,
        }));
      }
      sendTimecodeCommand((timecodeId) => ({
        type: "StopTimecode",
        data: timecodeId,
      }));
    },
  };

  /** Renders tracks, overlays, and audio-drop behavior for the timeline viewport. */
  const TimelineSurface = () => {
    const ctx = useTimelineContext();
    let surfaceRef: HTMLDivElement | undefined;
    const audioDrop = createTimelineAudioDropController(ctx);

    onMount(() => {
      const handleWheel = (event: WheelEvent) => {
        if (!event.ctrlKey || event.deltaY === 0) {
          return;
        }

        event.preventDefault();
        if (!surfaceRef?.contains(event.target as Node | null)) {
          return;
        }

        const currentZoom = ctx.zoom();
        const nextZoom =
          event.deltaY < 0
            ? zoomTimelineIn(currentZoom)
            : zoomTimelineOut(currentZoom);
        if (nextZoom === currentZoom) {
          return;
        }

        ctx.setZoom(nextZoom);
      };

      window.addEventListener("wheel", handleWheel, {
        capture: true,
        passive: false,
      });
      onCleanup(() => {
        window.removeEventListener("wheel", handleWheel, { capture: true });
      });
    });

    return (
      <div
        ref={surfaceRef}
        data-timeline-surface="true"
        data-timeline-uid={ctx.timelineUid}
        class="flex flex-col w-full h-full border border-gray-800 bg-[#1e1e1e] rounded-md overflow-hidden"
        onDragEnter={audioDrop.onDragEnter}
        onDragOver={audioDrop.onDragOver}
        onDragLeave={audioDrop.onDragLeave}
        onDrop={audioDrop.onDrop}
      >
        <PanelToolbar
          data-timeline-toolbar="true"
          left={
            <>
              <InstanceControls />
              <ToolbarSeparator />
              <div class="flex items-center gap-1">
                <SnapControl />
                <NudgeUnitSelect />
              </div>
              <ToolbarSeparator />
              <DurationTrailControl />
              <ToolbarSeparator />
              <TimelineOperatorControls />
            </>
          }
          right={<BeatgridControls />}
        />

        {/* Track list container */}
        <div class="relative flex min-h-0 flex-1 flex-row overflow-hidden">
          {/* Track list body - fixed timeline chrome and natively scrolling track rows */}
          <TimelineContentArea />

          {(audioDrop.isAudioDragActive() || audioDrop.isUploadingAudio()) && (
            <div
              data-timeline-audio-drop-overlay="true"
              class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            >
              <div class="rounded-lg border border-sky-400/60 bg-[#111827]/90 px-6 py-4 text-center shadow-xl">
                <div class="text-sm font-semibold uppercase tracking-wide text-sky-200">
                  {audioDrop.isUploadingAudio()
                    ? "Importing audio..."
                    : "Drop audio to replace track"}
                </div>
                <div class="mt-2 text-xs text-slate-300">
                  Supports .mp3, .wav, .m4a, and .mp4
                </div>
              </div>
            </div>
          )}
        </div>

        <PanelToolbar
          position="footer"
          class="timeline-footer"
          data-timeline-footer-toolbar="true"
          left={
            <>
              <ZoomControls />
              <ScrollModeControls />
            </>
          }
          right={
            <>
              <BeatDisplay showWhenDisabled={true} />
              <ConnectedSMPTEFrameDisplay />
            </>
          }
        />
      </div>
    );
  };

  /** Keeps the scroll container aligned with playhead movement. */
  const ScrollWatcher = () => {
    const workspaceActive = useWorkspaceActivity();
    const ctx = useTimelineContext();

    /** Builds the persistent viewport key for the active timeline panel. */
    const viewportStorageKey = () =>
      `${TIMELINE_VIEWPORT_STORAGE_PREFIX}.${ctx.timelineUid}`;

    /** Reads the last persisted horizontal viewport offset for this timeline. */
    const storedScrollLeft = () => {
      try {
        const value = window.localStorage.getItem(viewportStorageKey());
        if (value === null) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
      } catch (error) {
        log.debug("Could not read timeline viewport position", { error });
        return undefined;
      }
    };

    /** Persists the horizontal viewport offset so refreshes and snapshots keep position. */
    const saveScrollLeft = () => {
      if (!scrollContainerRef) return;
      try {
        window.localStorage.setItem(
          viewportStorageKey(),
          String(scrollContainerRef.scrollLeft),
        );
      } catch (error) {
        log.debug("Could not store timeline viewport position", { error });
      }
    };

    /** Restores the saved viewport if one exists for the active timeline. */
    const restoreStoredViewport = () => {
      if (!scrollContainerRef) return false;
      const scrollLeft = storedScrollLeft();
      if (scrollLeft === undefined) return false;
      const maxScrollLeft = Math.max(
        0,
        scrollContainerRef.scrollWidth - scrollContainerRef.clientWidth,
      );
      scrollContainerRef.scrollLeft = Math.min(scrollLeft, maxScrollLeft);
      return true;
    };

    // Recompute scroll when playhead position, scroll mode, zoom, or timeline end changes.
    createEffect(() => {
      if (!workspaceActive()) return;
      const position = ctx.position();
      const scrollMode = ctx.scrollMode();
      const zoom = ctx.zoom();
      // Track end for reactive updates
      void ctx.end();

      // Update scroll position when position, scroll mode, or zoom changes
      updateScrollForPlayhead(position, scrollMode, zoom);
    });

    // Handle infinite scroll
    onMount(() => {
      if (!scrollContainerRef) return;

      // Handle scroll events to resize if necessary
      scrollContainerRef.addEventListener("scroll", handleScroll);
      requestAnimationFrame(() => {
        if (!restoreStoredViewport()) {
          updateScrollForPlayhead(
            ctx.position(),
            ScrollMode.CENTER_LOCK,
            ctx.zoom(),
          );
        }
      });
    });

    onCleanup(() => {
      if (!scrollContainerRef) return;
      scrollContainerRef.removeEventListener("scroll", handleScroll);
    });

    /** Update scroll position based on playhead position, scroll mode and zoom level */
    const updateScrollForPlayhead = (
      position: number,
      scrollMode: ScrollMode,
      zoom: number,
    ) => {
      if (!scrollContainerRef) return;

      const pixelPosition = msToPixels(position - (ctx.start() || 0), zoom);
      const { scrollLeft, clientWidth } = scrollContainerRef;
      const timelineClientWidth = Math.max(
        0,
        clientWidth - TRACK_HEADER_WIDTH_PX,
      );
      const scrollRight = scrollLeft + timelineClientWidth;

      const margin = 64; // pixels of margin when using "follow" mode

      switch (scrollMode) {
        case ScrollMode.CENTER_LOCK:
          // Center the playhead in the viewport
          scrollContainerRef.scrollLeft =
            pixelPosition - timelineClientWidth / 2;
          break;

        case ScrollMode.FOLLOW:
          // If playhead is about to exit viewport, scroll to keep it visible
          if (pixelPosition < scrollLeft + margin) {
            // Playhead is near left edge - scroll left to keep it visible with margin
            scrollContainerRef.scrollLeft = Math.max(0, pixelPosition - margin);
          } else if (pixelPosition > scrollRight - margin) {
            // Playhead is near right edge - keep a small leading gutter instead of
            // snapping it to x=0 in the viewport.
            scrollContainerRef.scrollLeft = Math.max(0, pixelPosition - margin);
          }
          break;

        default: // and ScrollMode.FREE
          // Free mode - don't scroll automatically after initial load
          break;
      }
    };

    const handleScroll = () => {
      if (!scrollContainerRef) return;

      const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef;
      const timelineClientWidth = Math.max(
        0,
        clientWidth - TRACK_HEADER_WIDTH_PX,
      );
      const timelineScrollWidth = Math.max(
        1,
        scrollWidth - TRACK_HEADER_WIDTH_PX,
      );
      const scrollRight = scrollLeft + timelineClientWidth;
      const scrollPercentage = scrollRight / timelineScrollWidth;

      // If we're near the edge, extend the timeline
      if (scrollPercentage > 0.8) {
        // Extend the timeline by 20%
        const newEnd = ctx.end() * 1.2;
        ctx.setEnd(newEnd);
      }

      // If we've scrolled back and are not using much of the timeline, shrink it
      if (scrollPercentage < 0.5 && scrollLeft < timelineScrollWidth * 0.2) {
        // Don't shrink below the original end or the last action
        let maxActionEnd = 0;
        for (const track of ctx.tracks()) {
          for (const action of track.actions) {
            const itemEnd =
              durationToMs(action.position) + durationToMs(action.duration);
            if (itemEnd > maxActionEnd) {
              maxActionEnd = itemEnd;
            }
          }
        }

        const minEnd = Math.max(ctx.end() || 0, maxActionEnd, 60000);

        const newEnd = Math.max(minEnd, ctx.end() * 0.8);
        if (newEnd < ctx.end()) {
          ctx.setEnd(newEnd);
        }
      }

      pointer.refresh();
      saveScrollLeft();
    };

    return null;
  };

  /** Renders the scrollable track area and translates pointer movement into timeline position. */
  const TimelineContentArea = () => {
    const ctx = useTimelineContext();

    /** Supplies current timeline coordinates to the pointer interaction service. */
    const cursorProjection = () => ({
      start: ctx.start(),
      zoom: ctx.zoom(),
      setPosition: ctx.setCursorPosition,
    });

    const timelineWidth = () => msToPixels(ctx.end(), ctx.zoom());

    return (
      <div
        ref={scrollContainerRef}
        data-timeline-scroll-container="true"
        data-timeline-track-contents-scroll-container="true"
        data-timeline-uid={ctx.timelineUid}
        class="relative min-w-0 flex-1 select-none overflow-auto overscroll-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
        onMouseDown={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
          }
        }}
        onPointerEnter={(event) => {
          pointer.move(event, cursorProjection());
        }}
        onPointerMove={(event) => {
          pointer.move(event, cursorProjection());
        }}
        onPointerLeave={() => {
          pointer.clear(cursorProjection());
        }}
      >
        <div
          class="relative flex min-h-full flex-col"
          style={{
            width: `${TRACK_HEADER_WIDTH_PX + timelineWidth()}px`,
          }}
        >
          <div
            data-timeline-overlay-layer="true"
            class="pointer-events-none absolute inset-y-0 right-0 z-[80] overflow-hidden"
            style={{
              left: `${TRACK_HEADER_WIDTH_PX}px`,
            }}
          >
            {pointer.ghostPlayheadPosition() !== undefined ? (
              <GhostPlayhead left={pointer.ghostPlayheadPosition() as number} />
            ) : null}
            <LoopRangeBackdrop />
            <Playhead />
          </div>

          <TimelineActionEdgeHints
            scrollContainer={() => scrollContainerRef}
            timelinePlane={() => timelinePlaneRef}
            timelineWidth={timelineWidth}
            trackHeaderWidth={TRACK_HEADER_WIDTH_PX}
            timelineChromeHeight={TIMELINE_CHROME_HEIGHT_PX}
          />

          <div
            data-timeline-chrome-gutter="true"
            class="sticky top-0 left-0 z-[100] h-0 bg-[#1e1e1e]"
            style={{ width: `${TRACK_HEADER_WIDTH_PX}px` }}
          >
            <div class="h-[136px] bg-[#1e1e1e]" />
          </div>

          <div class="sticky top-0 z-[70] shrink-0 bg-[#1e1e1e]">
            <div
              style={{
                "margin-left": `${TRACK_HEADER_WIDTH_PX}px`,
                width: `${timelineWidth()}px`,
              }}
            >
              <div
                data-timeline-chrome-lane="ruler"
                class="relative z-[70] h-8 bg-[#1e1e1e]"
              >
                <TimelineRuler />
              </div>

              <div
                data-timeline-chrome-lane="waveform"
                data-timeline-waveform-content="true"
                data-timeline-waveform-row="true"
                class="relative z-[70] my-1 h-[60px] bg-[#1a1a1a]"
              >
                <ConnectedWaveform />
              </div>

              <div
                data-timeline-chrome-lane="operator"
                class="relative z-[70] h-9 bg-[#1a1a1a]"
              >
                <TimelineOperatorLane />
              </div>
            </div>
          </div>

          <div class="flex">
            <div
              data-timeline-track-label-column="true"
              class="sticky left-0 z-[90] shrink-0 bg-[#1e1e1e]"
              style={{ width: `${TRACK_HEADER_WIDTH_PX}px` }}
            >
              <ConnectedTrackHeaders />
            </div>

            <div
              ref={timelinePlaneRef}
              class="relative shrink-0"
              style={{ width: `${timelineWidth()}px` }}
            >
              <ConnectedTracksContents />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <TimelineContextProvider
      initialTimelineUid={props.initialTimelineUid}
      initialPanelId={props.initialPanelId}
      onSetRecording={sendSetRecordingCommand}
      playbackCommands={playbackCommands}
    >
      <TimelineSurface />
      <TimelinePropertiesProvider componentId={COMPONENT_ID} />
      <TimelineShortcutBindings componentId={COMPONENT_ID} />
      <TimelineGotoPopout />
      <ScrollWatcher />
      <TimelineEventListener />
    </TimelineContextProvider>
  );
};
