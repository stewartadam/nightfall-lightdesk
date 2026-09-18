// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Track component that only renders track content (no headers)
import { useStore } from "@nanostores/solid";
import { createMemo, For, Show } from "solid-js";
import { TIMELINE_INSERT_DRAG_MIME } from "../../../lib/timeline-insert-drag";
import { durationToMs } from "../../../lib/utils";
import { timelineLookaheadActionStatuses } from "../../../state/appStores";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";
import { resolveActionVisualDuration } from "../model/action-duration";
import type { ActionTargetIndex } from "../model/action-targets";
import { seekPositionFromTimelineX } from "../model/grid-utils";
import {
  Action,
  type ActionDragPreview,
  type ActionDragPreviewEntry,
} from "./action";
import { AutomationLane } from "./automation-lane";

export type TrackProps = {
  id: string;
  label: string;
  muted: boolean;
  solo: boolean;
  actions: types.Action[];
  allActions: types.Action[];
  actionTargetIndex: ActionTargetIndex;
  automationLanes?: types.AutomationLane[];
  expanded?: boolean;
  dragPreviewPositionPx?: number;
  actionDragPreviewEntries?: ActionDragPreviewEntry[];
  dragSourceActionKeys?: Set<string>;
  isActionDragTarget?: boolean;
  acceptsActionDrops?: boolean;
  onLanePointerMove?: (
    trackId: string,
    positionPx: number,
    clientX: number,
    clientY: number,
  ) => void;
  onLaneContextMenu?: (
    trackId: string,
    positionPx: number,
    clientX: number,
    clientY: number,
  ) => void;
  onLaneDragOver?: (
    trackId: string,
    positionPx: number,
    clientX: number,
    clientY: number,
  ) => void;
  onLaneDrop?: (
    trackId: string,
    positionPx: number,
    dragPayload: string | undefined,
    clientX: number,
    clientY: number,
  ) => void;
  onLaneDragLeave?: (trackId: string) => void;
  onActionDragPreview?: (preview: ActionDragPreview) => void;
  onActionDragPreviewClear?: () => void;
};

export const Track = (props: TrackProps) => {
  const ctx = useTimelineContext();
  const $lookaheadItemStatuses = useStore(timelineLookaheadActionStatuses);

  const getPositionPx = (
    event: MouseEvent | PointerEvent | DragEvent,
    element: HTMLDivElement,
  ) => {
    const rect = element.getBoundingClientRect();
    return Math.max(0, event.clientX - rect.left);
  };

  const hasTimelineInsertData = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes(TIMELINE_INSERT_DRAG_MIME);
  };

  const sortedActionsByPosition = createMemo(() =>
    [...props.actions].sort(
      (a, b) => durationToMs(a.position) - durationToMs(b.position),
    ),
  );

  const playheadActiveActionId = createMemo(() => {
    const playheadPositionMs = ctx.position();
    let currentActionId: string | undefined;

    for (const action of sortedActionsByPosition()) {
      const itemPositionMs = durationToMs(action.position);
      if (itemPositionMs <= playheadPositionMs) {
        currentActionId = action.id;
        continue;
      }
      break;
    }

    return currentActionId;
  });
  const isRecordTarget = createMemo(
    () => ctx.recordTargetTrackId() === props.id,
  );

  /** Builds the stable key used to identify a source action during preview drags. */
  const actionKey = (trackId: string, actionId: string) =>
    JSON.stringify([trackId, actionId]);

  /** Returns current lookahead status for an action in this track. */
  const lookaheadStatusForAction = (actionId: string) =>
    $lookaheadItemStatuses()[ctx.timelineUid]?.[actionKey(props.id, actionId)]
      ?.kind;

  /** Resolves an action's inferred visual duration from its action target. */
  const visualDurationForAction = (action: types.Action) => {
    if (!ctx.showDurationTrails()) return undefined;
    return resolveActionVisualDuration({
      action,
      actions: props.allActions,
      targetIndex: props.actionTargetIndex,
    });
  };

  /** Seeks the timeline using a client X coordinate relative to a track row or lane. */
  const seekTimelineAtClientX = (element: HTMLDivElement, clientX: number) => {
    const rect = element.getBoundingClientRect();
    const x = clientX - rect.left;
    const seekPosition = seekPositionFromTimelineX({
      x,
      start: ctx.start(),
      zoom: ctx.zoom(),
      useBeatgrid: ctx.useBeatgrid(),
      snapEnabled: ctx.snapEnabled(),
      bpm: ctx.bpm(),
      markers: ctx.beatgrid()?.markers,
    });
    ctx.playback.seek(seekPosition);
  };

  const handleMainTrackClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (event.target !== event.currentTarget) {
      return;
    }

    ctx.setRecordTargetTrackId(props.id);
    seekTimelineAtClientX(event.currentTarget as HTMLDivElement, event.clientX);
  };

  const handleTrackRowClick = (event: MouseEvent) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    ctx.setRecordTargetTrackId(props.id);
    seekTimelineAtClientX(event.currentTarget as HTMLDivElement, event.clientX);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard navigation not supported.
    <div
      data-timeline-track-row="true"
      data-track-id={props.id}
      data-record-target={isRecordTarget() ? "true" : undefined}
      class={`relative w-full border-b transition-colors ${
        isRecordTarget() ? "border-gray-800 bg-blue-500/10" : "border-gray-800"
      }`}
      onClick={handleTrackRowClick}
    >
      <Show when={isRecordTarget()}>
        <div class="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-blue-500" />
        <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-px bg-blue-500" />
      </Show>
      {/* Main track content - no x-padding to ensure correct position detection */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard navigation not supported. */}
      <div
        data-timeline-track-lane="true"
        data-track-id={props.id}
        data-action-drop-target={
          props.acceptsActionDrops === false ? undefined : "true"
        }
        data-action-drag-target={props.isActionDragTarget ? "true" : undefined}
        class={`relative w-full h-8 my-2 ${
          isRecordTarget()
            ? "bg-transparent"
            : props.isActionDragTarget
              ? "bg-blue-500/15 ring-1 ring-inset ring-blue-400/50"
              : "bg-[#1a1a1a]"
        }`}
        onClick={handleMainTrackClick}
        onPointerMove={(event) =>
          props.onLanePointerMove?.(
            props.id,
            getPositionPx(event, event.currentTarget),
            event.clientX,
            event.clientY,
          )
        }
        onContextMenu={(event) => {
          event.preventDefault();
          props.onLaneContextMenu?.(
            props.id,
            getPositionPx(event, event.currentTarget),
            event.clientX,
            event.clientY,
          );
        }}
        onDragOver={(event) => {
          if (!hasTimelineInsertData(event)) return;
          event.preventDefault();
          props.onLaneDragOver?.(
            props.id,
            getPositionPx(event, event.currentTarget),
            event.clientX,
            event.clientY,
          );
        }}
        onDragLeave={() => props.onLaneDragLeave?.(props.id)}
        onDrop={(event) => {
          if (!hasTimelineInsertData(event)) return;
          event.preventDefault();
          const dragPayload =
            event.dataTransfer?.getData(TIMELINE_INSERT_DRAG_MIME) || undefined;
          props.onLaneDrop?.(
            props.id,
            getPositionPx(event, event.currentTarget),
            dragPayload,
            event.clientX,
            event.clientY,
          );
        }}
      >
        <Show when={props.dragPreviewPositionPx !== undefined}>
          <div
            class="pointer-events-none absolute top-0 bottom-0 w-px bg-blue-400/90"
            style={{ left: `${props.dragPreviewPositionPx}px` }}
          />
        </Show>
        <For each={props.actions}>
          {(action) => (
            <Action
              id={action.id}
              label={action.label}
              position={durationToMs(action.position)}
              durationTrail={visualDurationForAction(action)}
              action={action.action}
              actionType={action.action.type}
              targetIndex={props.actionTargetIndex}
              showDurationTrail={ctx.showDurationTrails()}
              isPlayheadActive={playheadActiveActionId() === action.id}
              lookaheadStatus={lookaheadStatusForAction(action.id)}
              trackId={props.id}
              isDragSourceOriginal={props.dragSourceActionKeys?.has(
                actionKey(props.id, action.id),
              )}
              onDragPreview={props.onActionDragPreview}
              onDragPreviewClear={props.onActionDragPreviewClear}
            />
          )}
        </For>
        <For each={props.actionDragPreviewEntries ?? []}>
          {(previewItem) => (
            <Action
              id={previewItem.action.id}
              label={previewItem.action.label}
              position={previewItem.positionMs}
              durationTrail={visualDurationForAction(previewItem.action)}
              action={previewItem.action.action}
              actionType={previewItem.action.action.type}
              targetIndex={props.actionTargetIndex}
              showDurationTrail={ctx.showDurationTrails()}
              trackId={props.id}
              isDragPreview
              leftOverridePx={previewItem.positionPx}
            />
          )}
        </For>
      </div>

      {/* Automation lanes (shown when expanded) - no x-padding to ensure correct position detection */}
      <Show when={props.expanded && props.automationLanes}>
        <div class="flex flex-col">
          <For each={props.automationLanes}>
            {(automationLane) => (
              <AutomationLane
                trackId={props.id}
                automationLane={automationLane}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
