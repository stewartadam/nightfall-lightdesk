// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PencilIcon } from "@squidlab/phosphor-solid/pencil";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createSignal, For, Show } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { Input } from "../../../components/ui/form-controls";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import { Button } from "../../../components/ui/visual-language/button";
import { getLogger } from "../../../lib/logger";
import type * as types from "../../../types";
import {
  type TrackReorderPlacement,
  useTimelineContext,
} from "../context/timeline-context";

const log = getLogger(import.meta.url);

/** Connects track header actions and recording selection to the active timeline. */
export const ConnectedTrackHeaders = () => {
  log.trace("mounting");
  const ctx = useTimelineContext();
  return (
    <TrackHeaders
      tracks={ctx.displayTracks()}
      onAddTrack={ctx.track.addTrack}
      onRemoveTrack={ctx.track.removeTrack}
      onRenameTrack={ctx.track.renameTrack}
      onReorderTrack={ctx.track.reorderTrack}
      onToggleExpand={ctx.track.toggleTrackExpanded}
      onToggleMuted={ctx.track.toggleMute}
      onToggleSolo={ctx.track.toggleSolo}
      recordTargetTrackId={ctx.recordTargetTrackId()}
      onSetRecordTarget={ctx.setRecordTargetTrackId}
    />
  );
};

type TrackHeadersProps = {
  onAddTrack?: () => void;
  onRemoveTrack?: (trackId: string) => void;
  onRenameTrack?: (trackId: string, label: string) => void;
  onReorderTrack?: (
    trackId: string,
    targetTrackId: string,
    placement: TrackReorderPlacement,
  ) => void;
  onToggleExpand?: (trackId: string) => void;
  onToggleMuted?: (trackId: string) => void;
  onToggleSolo?: (trackId: string) => void;
  onSetRecordTarget?: (trackId: string) => void;
  recordTargetTrackId?: string;
  tracks: types.Track[];
};

/** Renders draggable track headers with inline naming and mute, solo, and lane controls. */
const TrackHeaders = (props: TrackHeadersProps) => {
  log.trace("mounting");
  const [draggedTrackId, setDraggedTrackId] = createSignal<string | undefined>(
    undefined,
  );
  const [dropTarget, setDropTarget] = createSignal<
    { trackId: string; placement: TrackReorderPlacement } | undefined
  >(undefined);
  const [editingTrackId, setEditingTrackId] = createSignal<string | undefined>(
    undefined,
  );
  const [draftTrackLabel, setDraftTrackLabel] = createSignal("");
  let suppressNextRenameBlur = false;

  /** Focuses the inline rename input after Solid mounts it. */
  const focusRenameInput = (element: HTMLInputElement) => {
    window.queueMicrotask(() => {
      element.focus();
      element.select();
    });
  };

  /** Starts inline rename editing for the given track. */
  const startRenamingTrack = (track: types.Track) => {
    setEditingTrackId(track.id);
    setDraftTrackLabel(track.label);
  };

  /** Cancels inline track rename editing without persisting a change. */
  const cancelRenamingTrack = () => {
    setEditingTrackId(undefined);
    setDraftTrackLabel("");
  };

  /** Submits the inline track rename if the draft label is non-empty. */
  const commitTrackRename = (track: types.Track) => {
    const nextLabel = draftTrackLabel().trim();
    if (nextLabel.length > 0 && nextLabel !== track.label) {
      props.onRenameTrack?.(track.id, nextLabel);
    }
    cancelRenamingTrack();
  };

  /** Handles blur by submitting unless Escape already cancelled the edit. */
  const handleRenameBlur = (track: types.Track) => {
    if (suppressNextRenameBlur) {
      suppressNextRenameBlur = false;
      return;
    }
    commitTrackRename(track);
  };

  const clearDragState = () => {
    setDraggedTrackId(undefined);
    setDropTarget(undefined);
  };

  const resolveDropTarget = (
    trackId: string,
    event: DragEvent & { currentTarget: HTMLDivElement; target: Element },
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const placement: TrackReorderPlacement =
      event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const nextTarget = { trackId, placement };
    setDropTarget(nextTarget);
    return nextTarget;
  };

  const openTrackContextMenu = (track: types.Track, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: "mute-track",
          label: "Mute Track",
          shortcut: "M",
          checked: track.muted,
          onSelect: () => props.onToggleMuted?.(track.id),
        },
        {
          id: "solo-track",
          label: "Solo Track",
          shortcut: "S",
          checked: track.solo,
          onSelect: () => props.onToggleSolo?.(track.id),
        },
        {
          id: "rename-track",
          label: "Rename Track",
          icon: PencilIcon,
          onSelect: () => startRenamingTrack(track),
        },
        { id: "track-header-menu-separator", type: "separator" },
        {
          id: "remove-track",
          label: "Remove Track",
          icon: TrashIcon,
          danger: true,
          onSelect: () => props.onRemoveTrack?.(track.id),
        },
      ],
    });
  };

  return (
    <div
      class="flex flex-col sticky left-0 z-10 select-none"
      onMouseDown={(event) => {
        if (event.shiftKey) {
          event.preventDefault();
        }
      }}
    >
      <For each={props.tracks}>
        {(track) => (
          <div
            data-timeline-track-header="true"
            data-track-id={track.id}
            data-record-target={
              props.recordTargetTrackId === track.id ? "true" : undefined
            }
            class={`relative flex flex-col border-b text-xs text-white transition-colors ${
              props.recordTargetTrackId === track.id
                ? "border-gray-800 bg-blue-500/10"
                : "border-gray-800 bg-[#252525]"
            } ${
              dropTarget()?.trackId === track.id &&
              dropTarget()?.placement === "before"
                ? "border-t-2 border-t-blue-500"
                : ""
            } ${
              dropTarget()?.trackId === track.id &&
              dropTarget()?.placement === "after"
                ? "border-b-2 border-b-blue-500"
                : ""
            }`}
          >
            <Show when={props.recordTargetTrackId === track.id}>
              <div class="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-blue-500" />
              <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-px bg-blue-500" />
            </Show>
            {/* Main track header */}
            <div
              class={`h-12 flex items-center px-2 cursor-grab active:cursor-grabbing ${
                draggedTrackId() === track.id ? "opacity-60" : ""
              }`}
              data-track-header-handle={track.id}
              draggable={editingTrackId() !== track.id}
              onContextMenu={(event) => openTrackContextMenu(track, event)}
              onDragOver={(event) => {
                if (!draggedTrackId() || draggedTrackId() === track.id) {
                  return;
                }
                event.preventDefault();
                if (event.dataTransfer) {
                  event.dataTransfer.dropEffect = "move";
                }
                resolveDropTarget(track.id, event);
              }}
              onDrop={(event) => {
                const draggedId = draggedTrackId();
                if (!draggedId || draggedId === track.id) {
                  clearDragState();
                  return;
                }

                event.preventDefault();
                const target = resolveDropTarget(track.id, event);
                props.onReorderTrack?.(
                  draggedId,
                  target.trackId,
                  target.placement,
                );
                clearDragState();
              }}
              onDragStart={(event) => {
                setDraggedTrackId(track.id);
                event.dataTransfer?.setData("text/plain", track.id);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                }
              }}
              onDragEnd={() => clearDragState()}
            >
              {/* Expand/collapse button */}
              <Show
                when={
                  track.automation_lanes && track.automation_lanes.length > 0
                }
              >
                <ToolbarButton
                  class="mr-1"
                  style={{ width: "20px" }}
                  label={
                    track.expanded
                      ? "Collapse automation lanes"
                      : "Expand automation lanes"
                  }
                  aria-expanded={track.expanded}
                  draggable={false}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleExpand?.(track.id);
                  }}
                  title={
                    track.expanded
                      ? "Collapse automation lanes"
                      : "Expand automation lanes"
                  }
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    class="w-4 h-4 transition-transform duration-200"
                    style={{
                      transform: track.expanded
                        ? "rotate(90deg)"
                        : "rotate(0deg)",
                    }}
                  >
                    <path d="M6 6L14 10L6 14V6Z" />
                  </svg>
                </ToolbarButton>
              </Show>

              <div class="flex flex-1 justify-between items-center gap-2 min-w-0">
                <Show
                  when={editingTrackId() === track.id}
                  fallback={
                    <Button
                      size="compact"
                      variant="subtle"
                      class="flex-1 min-w-0"
                      style={{ "justify-content": "flex-start" }}
                      draggable={false}
                      onClick={() => props.onSetRecordTarget?.(track.id)}
                      onDblClick={(event) => {
                        event.stopPropagation();
                        startRenamingTrack(track);
                      }}
                    >
                      <span class="truncate">{track.label}</span>
                    </Button>
                  }
                >
                  <Input
                    density="compact"
                    ref={focusRenameInput}
                    type="text"
                    aria-label={`Rename track ${track.label}`}
                    class="min-w-0 flex-1 select-text"
                    value={draftTrackLabel()}
                    draggable={false}
                    onInput={(event) =>
                      setDraftTrackLabel(event.currentTarget.value)
                    }
                    onClick={(event) => event.stopPropagation()}
                    onDblClick={(event) => event.stopPropagation()}
                    onBlur={() => handleRenameBlur(track)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitTrackRename(track);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        suppressNextRenameBlur = true;
                        cancelRenamingTrack();
                      }
                    }}
                  />
                </Show>
                <div class="flex gap-1 shrink-0">
                  <ToggleToolbarButton
                    pressed={track.muted}
                    label={track.muted ? "Unmute" : "Mute"}
                    style={{ width: "24px", height: "24px" }}
                    draggable={false}
                    title={track.muted ? "Unmute" : "Mute"}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onToggleMuted?.(track.id);
                    }}
                  >
                    M
                  </ToggleToolbarButton>
                  <ToggleToolbarButton
                    pressed={track.solo}
                    label={track.solo ? "Unsolo" : "Solo"}
                    style={{ width: "24px", height: "24px" }}
                    draggable={false}
                    title={track.solo ? "Unsolo" : "Solo"}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onToggleSolo?.(track.id);
                    }}
                  >
                    S
                  </ToggleToolbarButton>
                </div>
              </div>
            </div>

            {/* Automation lane headers when expanded */}
            <Show when={track.expanded && track.automation_lanes}>
              <div class="pl-6">
                <For each={track.automation_lanes}>
                  {(param) => (
                    <div class="h-[60px] flex items-center px-2 text-gray-300 text-xs">
                      <div
                        class="flex items-center"
                        style={{ color: param.color }}
                      >
                        <span class="truncate">{param.name}</span>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>

      {/* Add Track button */}
      <div class="h-12 w-full border-b border-gray-800 bg-[#252525] p-2">
        <Button
          size="compact"
          class="w-full"
          onClick={() => props.onAddTrack?.()}
        >
          + Add Track
        </Button>
      </div>
    </div>
  );
};
