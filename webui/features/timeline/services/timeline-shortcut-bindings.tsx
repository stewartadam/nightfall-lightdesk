// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import {
  getFocusedComponentId,
  useKeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import {
  copySelectedTimelineActions,
  copySelectedTimelineMarkers,
  pasteTimelineClipboardEntries,
  type TimelineClipboardEntry,
} from "../../../lib/timeline-clipboard";
import { timelinePlacementPosition } from "../../../lib/timeline-placement";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { pushToast } from "../../../state/appStores";
import { $settings } from "../../../state/settings";
import {
  buildMarkerAt,
  seekAdjacentMarker,
} from "../components/timeline-operator-overlays";
import { zoomTimelineIn, zoomTimelineOut } from "../components/zoom-controls";
import {
  type TimelineNudgeUnit,
  useTimelineContext,
} from "../context/timeline-context";
import {
  quantizeSeekPositionMs,
  seekPositionByBars,
} from "../model/grid-utils";
import { deleteLoopRange, toggleLoopRange } from "../model/timeline-loop";

const NUDGE_UNITS: readonly TimelineNudgeUnit[] = [
  "bar",
  "beat",
  "half",
  "quarter",
  "eighth",
];

/** Creates a client-side identifier for duplicated timeline objects. */
const createTimelineObjectId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `timeline-copy-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
};

/**
 * Registers keyboard shortcuts that mutate timeline playback, markers, and clipboard state.
 */
export const TimelineShortcutBindings = (props: { componentId: string }) => {
  const workspaceActive = useWorkspaceActivity();
  const ctx = useTimelineContext();
  const settings = useStore($settings);
  const [clipboardEntries, setClipboardEntries] = createSignal<
    TimelineClipboardEntry[]
  >([]);

  /** Converts the selected nudge unit into a millisecond offset at the current tempo. */
  const nudgeDeltaMs = () => {
    if (!ctx.snapEnabled()) {
      return 25;
    }
    const beatMs = 60_000 / Math.max(1, ctx.bpm());
    switch (ctx.nudgeUnit()) {
      case "bar":
        return Math.round(beatMs * Math.max(1, ctx.beatsPerBar()));
      case "half":
        return Math.round(beatMs * 2);
      case "eighth":
        return Math.round(beatMs / 2);
      case "beat":
      case "quarter":
        return Math.round(beatMs);
    }
  };

  /** Drops a marker at the requested position and starts inline label editing. */
  const dropMarker = (position: number) => {
    const marker = buildMarkerAt(ctx.markers(), position);
    ctx.markersActions.storeMarker(marker);
    ctx.markersActions.selectMarker(marker.uid);
    ctx.markerLabelEditing.startEditing(marker.uid, marker.label);
  };

  /** Copies the active marker or action selection into the timeline clipboard. */
  const copySelection = () => {
    const activeSelection = ctx.selection();
    const entries =
      activeSelection?.type === "Marker"
        ? copySelectedTimelineMarkers(
            ctx.markers(),
            ctx.markersActions
              .selectedMarkers()
              .map((marker) => marker.markerUid),
          )
        : activeSelection?.type === "Action"
          ? copySelectedTimelineActions(
              ctx.tracks(),
              ctx.actions.selectedActions(),
            )
          : [];

    if (entries.length === 0) {
      return false;
    }

    setClipboardEntries(entries);
    pushToast(
      "success",
      `Copied ${entries.length} timeline ${entries.length === 1 ? "action" : "actions"}.`,
    );
    return true;
  };

  /** Pastes the timeline clipboard at the configured playhead or cursor position. */
  const pasteSelection = () => {
    const entries = clipboardEntries();
    if (entries.length === 0) {
      return false;
    }

    const placementMs = timelinePlacementPosition({
      preference: settings().timeline_placement_preference,
      playheadMs: ctx.position(),
      cursorMs: ctx.cursorPosition(),
    });
    const pasted = pasteTimelineClipboardEntries(
      entries,
      placementMs,
      createTimelineObjectId,
    );
    const batchId = crypto.randomUUID().replace(/-/g, "");

    if (pasted.markers.length > 0) {
      ctx.markersActions.storeMarkers(pasted.markers, { batchId });
      pasted.markers.forEach((marker, index) => {
        ctx.markersActions.selectMarker(marker.uid, { toggle: index > 0 });
      });
    }

    if (pasted.actions.length > 0) {
      pasted.actions.forEach(({ trackId, action }, index) => {
        ctx.actions.insertAction(trackId, action, { batchId });
        ctx.actions.selectAction(trackId, action.id, {
          toggle: index > 0,
        });
      });
    }

    pushToast(
      "success",
      `Pasted ${entries.length} timeline ${entries.length === 1 ? "action" : "actions"}.`,
    );
    return true;
  };

  /** Moves the playhead to the adjacent marker in the requested direction. */
  const seekMarker = (direction: "previous" | "next") => {
    const markerPosition = seekAdjacentMarker(
      ctx.markers(),
      ctx.position(),
      direction,
    );
    if (markerPosition !== undefined) {
      ctx.playback.seek(markerPosition);
    }
  };

  /** Seeks the playhead by a signed number of whole bars. */
  const seekByBars = (direction: -1 | 1, bars: number) => {
    const nextPosition = seekPositionByBars(ctx.position(), direction, bars, {
      snapEnabled: ctx.snapEnabled(),
      useBeatgrid: ctx.useBeatgrid(),
      bpm: ctx.bpm(),
      beatsPerBar: ctx.beatsPerBar(),
      markers: ctx.beatgrid()?.markers,
    });
    ctx.playback.seek(nextPosition);
  };

  /** Resolves the bar jump multiplier from comma/period modifiers. */
  const barJumpSizeForEvent = (event: KeyboardEvent) => {
    if (event.altKey || event.metaKey) return undefined;
    if (event.ctrlKey && event.shiftKey) return 8;
    if (!event.ctrlKey && event.shiftKey) return 4;
    if (!event.ctrlKey && !event.shiftKey) return 1;
    return undefined;
  };

  /** Returns whether a key event originated from a text-editing control. */
  const isEditableKeyboardTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    const editableTarget = target.closest<HTMLElement>(
      "input, textarea, select, [contenteditable]",
    );
    if (!editableTarget) return false;

    return (
      editableTarget instanceof HTMLInputElement ||
      editableTarget instanceof HTMLTextAreaElement ||
      editableTarget instanceof HTMLSelectElement ||
      editableTarget.isContentEditable
    );
  };

  const zoomIn = () => ctx.setZoom(zoomTimelineIn(ctx.zoom()));

  const zoomOut = () => ctx.setZoom(zoomTimelineOut(ctx.zoom()));

  const stepNudgeUnit = (direction: -1 | 1) => {
    const currentIndex = Math.max(0, NUDGE_UNITS.indexOf(ctx.nudgeUnit()));
    const nextIndex = Math.min(
      NUDGE_UNITS.length - 1,
      Math.max(0, currentIndex + direction),
    );
    ctx.setNudgeUnit(NUDGE_UNITS[nextIndex] ?? "quarter");
  };

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!workspaceActive() || isEditableKeyboardTarget(event.target)) return;

      if (event.code === "Comma" || event.code === "Period") {
        const bars = barJumpSizeForEvent(event);
        if (bars === undefined) return;

        if (getFocusedComponentId() !== props.componentId) {
          return;
        }

        event.preventDefault();
        seekByBars(event.code === "Comma" ? -1 : 1, bars);
        return;
      }

      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const key = event.key;
      if (key !== "+" && key !== "=" && key !== "-" && key !== "_") {
        return;
      }

      event.preventDefault();
      if (getFocusedComponentId() !== props.componentId) {
        return;
      }

      if (key === "+" || key === "=") {
        zoomIn();
        return;
      }
      zoomOut();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    });
  });

  useKeyboardShortcut({
    key: "End",
    handler: ctx.playback.stop,
    description: "Go to end (and stop) of timeline",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Home",
    handler: () => ctx.playback.seek(0),
    description: "Go to start of timeline",
    componentId: props.componentId,
  });

  // Space - Toggle play/pause
  useKeyboardShortcut({
    key: "Space",
    handler: () => {
      // toggle play / pause
      if (ctx.paused()) {
        ctx.playback.play();
      } else {
        ctx.playback.pause();
      }
    },
    description: "Play/Pause timeline",
    componentId: props.componentId,
  });

  // Shift++ - Zoom in
  useKeyboardShortcut({
    key: "Shift++",
    handler: zoomIn,
    description: "Zoom in",
    componentId: props.componentId,
  });

  // Shift+_ - Zoom out
  useKeyboardShortcut({
    key: "Shift+_",
    handler: zoomOut,
    description: "Zoom out",
    componentId: props.componentId,
  });

  // b - Toggle beatgrid
  useKeyboardShortcut({
    key: "b",
    handler: () => {
      // toggle beatgrid mode
      ctx.setUseBeatgrid(!ctx.useBeatgrid());
    },
    description: "Toggle beatgrid mode",
    componentId: props.componentId,
  });

  // Shift+Up - Increase BPM
  useKeyboardShortcut({
    key: "Shift+ArrowUp",
    handler: () => {
      // Increase BPM by 1
      if (ctx.useBeatgrid()) {
        const newBpm = Math.min(ctx.bpm() + 1, 240);
        ctx.setBpm(newBpm);
      }
    },
    description: "Increase BPM by 1",
    componentId: props.componentId,
  });

  // Shift+Down - Decrease BPM
  useKeyboardShortcut({
    key: "Shift+ArrowDown",
    handler: () => {
      // Decrease BPM by 1
      if (ctx.useBeatgrid()) {
        const newBpm = Math.max(ctx.bpm() - 1, 60);
        ctx.setBpm(newBpm);
      }
    },
    description: "Decrease BPM by 1",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Alt+ArrowUp",
    handler: () => stepNudgeUnit(-1),
    description: "Select coarser nudge unit",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Alt+ArrowDown",
    handler: () => stepNudgeUnit(1),
    description: "Select finer nudge unit",
    componentId: props.componentId,
  });

  // s - Toggle grid snapping
  useKeyboardShortcut({
    key: "s",
    handler: () => {
      // Toggle grid snapping
      ctx.setSnapEnabled(!ctx.snapEnabled());
    },
    description: "Toggle grid snapping",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "m",
    handler: () => {
      const position = quantizeSeekPositionMs(ctx.position(), {
        snapEnabled: ctx.snapEnabled(),
        useBeatgrid: ctx.useBeatgrid(),
        bpm: ctx.bpm(),
        markers: ctx.beatgrid()?.markers,
      });
      dropMarker(position);
    },
    description: "Drop marker at playhead",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Shift+m",
    handler: () => dropMarker(ctx.cursorPosition() ?? ctx.position()),
    description: "Drop marker at cursor",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "[",
    handler: () => seekMarker("previous"),
    description: "Seek previous marker",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "]",
    handler: () => seekMarker("next"),
    description: "Seek next marker",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Alt+ArrowLeft",
    handler: () => ctx.nudgeSelection(-nudgeDeltaMs()),
    description: "Nudge selection earlier",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Alt+ArrowRight",
    handler: () => ctx.nudgeSelection(nudgeDeltaMs()),
    description: "Nudge selection later",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "l",
    handler: () => toggleLoopRange(ctx),
    description: "Toggle loop range",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Shift+l",
    handler: () => deleteLoopRange(ctx),
    description: "Delete loop range",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "$mod+c",
    handler: (event) => {
      if (isEditableKeyboardTarget(event?.target ?? null)) return false;
      return copySelection();
    },
    description: "Copy selected timeline markers or actions",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "$mod+v",
    handler: (event) => {
      if (isEditableKeyboardTarget(event?.target ?? null)) return false;
      return pasteSelection();
    },
    description: "Paste selected timeline markers or actions",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "d",
    handler: () => ctx.setShowDurationTrails(!ctx.showDurationTrails()),
    description: "Toggle action duration trails",
    componentId: props.componentId,
  });

  return null;
};
