// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createDraggable } from "@neodrag/solid";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { usePanelCapabilityRegistry } from "../../../components/providers/panel-capabilities/context-core";
import { focusTrackedComponent } from "../../../lib/componentFocusContext";
import { getLogger } from "../../../lib/logger";
import { REVEAL_OBJECT_CAPABILITY } from "../../../lib/panel-capabilities";
import { openOrFocusPanel } from "../../../lib/panel-open-command";
import { durationToMs, pixelsToMs } from "../../../lib/utils";
import { dockApi } from "../../../state/appStores";
import * as types from "../../../types";
import {
  createActionBindingChoices,
  resolveActionBindingOption,
} from "../../action-mapping";
import { useTimelineContext } from "../context/timeline-context";
import {
  type ActionDragPosition,
  actionDragPositionFromPointer,
} from "../model/action-drag";
import {
  type ActionVisualDuration,
  actionDurationTrailLoopMarkers,
  actionDurationTrailWidth,
} from "../model/action-duration";
import {
  type ActionTargetIndex,
  resolveActionClipPropertiesTarget,
  resolveActionDisplayLabel,
  resolveActionEditorTarget,
} from "../model/action-targets";
import { msPerBeat, type SnapConfig } from "../model/grid-utils";

const log = getLogger(import.meta.url);

export type ActionProps = {
  id: string;
  label: string;
  position: number;
  durationTrail?: ActionVisualDuration;
  action: types.ActionKind;
  actionType: types.ActionKind["type"];
  targetIndex: ActionTargetIndex;
  showDurationTrail?: boolean;
  isPlayheadActive?: boolean;
  lookaheadStatus?: types.TimelineLookaheadActionStatusKind;
  isDragPreview?: boolean;
  isDragSourceOriginal?: boolean;
  leftOverridePx?: number;
  onDragPreview?: (preview: ActionDragPreview) => void;
  onDragPreviewClear?: () => void;
};

export type ActionDragPreviewEntry = {
  sourceTrackId: string;
  actionId: string;
  trackId: string;
  positionPx: number;
  positionMs: number;
  action: types.Action;
};

export type ActionDragPreview = {
  targetTrackId: string;
  actions: ActionDragPreviewEntry[];
};

type MarkerStyle = {
  chip: string;
  stem: string;
};

type DragSessionAction = {
  sourceTrackId: string;
  actionId: string;
  originalTrackIndex: number;
  originalPositionPx: number;
  action: types.Action;
};

type DragSession = {
  anchorOriginalTrackIndex: number;
  anchorPositionPx: number;
  actions: DragSessionAction[];
  canceled: boolean;
};

export const getMarkerStyle = (
  actionType: types.ActionKind["type"],
): MarkerStyle => {
  switch (actionType) {
    case "FireCue":
      return {
        chip: "border-blue-500 bg-blue-950 text-blue-100",
        stem: "bg-blue-400/90",
      };
    case "StartClip":
      return {
        chip: "border-emerald-500 bg-emerald-950 text-emerald-100",
        stem: "bg-emerald-400/90",
      };
    case "StopClip":
      return {
        chip: "border-red-500 bg-red-950 text-red-100",
        stem: "bg-red-400/90",
      };
    case "AdvanceSequence":
      return {
        chip: "border-amber-400 bg-amber-950 text-amber-100",
        stem: "bg-amber-400/90",
      };
    case "BackSequence":
      return {
        chip: "border-orange-700 bg-orange-950 text-orange-100",
        stem: "bg-orange-600/90",
      };
    case "SetClipRate":
      return {
        chip: "border-cyan-500 bg-cyan-950 text-cyan-100",
        stem: "bg-cyan-400/90",
      };
    case "JumpToCue":
      return {
        chip: "border-violet-500 bg-violet-950 text-violet-100",
        stem: "bg-violet-400/90",
      };
    case "DeskEval":
      return {
        chip: "border-slate-400 bg-slate-950 text-slate-100",
        stem: "bg-slate-300/90",
      };
    case "RegisteredAction":
      return {
        chip: "border-teal-500 bg-teal-950 text-teal-100",
        stem: "bg-teal-400/90",
      };
  }
};

export const Action = (props: ActionProps & { trackId: string }) => {
  log.trace("mounting");
  const ctx = useTimelineContext();
  const bindingChoices = createActionBindingChoices();
  /** Uses domain-provided display metadata while leaving the stored action reference intact. */
  const presentationAction = createMemo(() =>
    props.action.type === "RegisteredAction"
      ? (resolveActionBindingOption(bindingChoices(), props.action.data)
          ?.timelinePresentation ?? props.action)
      : props.action,
  );
  const $dockApi = useStore(dockApi);
  const { invokePanelCapability } = usePanelCapabilityRegistry();
  const [left, setLeft] = createSignal(0);
  const [isDragging, setIsDragging] = createSignal(false);
  const [isSelected, setIsSelected] = createSignal(false);

  let elementRef: HTMLDivElement | undefined;
  let pendingDragSession: DragSession | undefined;
  let dragSession: DragSession | undefined;
  let lastDragPreview: ActionDragPreview | undefined;
  let removeEscapeDragListener: (() => void) | undefined;

  /** Returns the visible lane under the drag pointer. */
  const dragTargetFromPointer = (
    event: PointerEvent,
  ): { trackId: string; lane: HTMLElement } | undefined => {
    for (const lane of document.querySelectorAll<HTMLElement>(
      "[data-action-drop-target='true']",
    )) {
      const rect = lane.getBoundingClientRect();
      const trackId = lane.dataset.trackId;
      if (
        trackId &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        return { trackId, lane };
      }
    }

    for (const element of document.elementsFromPoint(
      event.clientX,
      event.clientY,
    )) {
      if (!(element instanceof HTMLElement)) continue;
      if (elementRef?.contains(element)) continue;
      if (element.closest("[data-timeline-action='true']") === elementRef) {
        continue;
      }

      const lane = element.closest<HTMLElement>(
        "[data-action-drop-target='true']",
      );
      const trackId = lane?.dataset.trackId;
      if (lane && trackId) return { trackId, lane };
    }

    const lane = elementRef?.parentElement;
    const trackId = lane?.dataset.trackId ?? props.trackId;
    return lane ? { trackId, lane } : undefined;
  };

  const getSnapConfig = (): SnapConfig => {
    if (ctx.useBeatgrid()) {
      const beatgridMarkerTimes =
        ctx.beatgrid()?.markers.map((marker) => durationToMs(marker.time)) ??
        [];
      const beatgridMarkers =
        beatgridMarkerTimes.length > 1 ? beatgridMarkerTimes : undefined;
      const anchorMs = beatgridMarkerTimes[0] ?? 0;

      // When using BPM, set interval to the beat duration
      const beatDuration = msPerBeat(ctx.bpm());
      return {
        enabled: ctx.snapEnabled(),
        interval: beatDuration,
        threshold: 15,
        isBeat: true,
        beatsPerBar: ctx.beatsPerBar(), // Provide beats per bar for alignment
        markers: beatgridMarkers,
        anchorMs,
      };
    }

    return {
      enabled: ctx.snapEnabled(),
      interval: 1000,
      threshold: 10,
      isBeat: false,
      beatsPerBar: 4,
    };
  };

  createEffect(() => {
    const offsetPx =
      props.leftOverridePx ??
      (props.position - ctx.start()) * (ctx.zoom() / 1000);
    setLeft(offsetPx);
  });

  createEffect(() => {
    const selectedActions = ctx.actions.selectedActions();
    setIsSelected(
      selectedActions.some(
        (selection) =>
          selection.trackId === props.trackId &&
          selection.actionId === props.id,
      ),
    );
  });

  const { draggable } = createDraggable();
  void draggable;

  /** Returns the flag start position for the current drag pointer. */
  const dragPositionFromPointer = (
    event: PointerEvent,
  ): (ActionDragPosition & { trackId: string }) | undefined => {
    const target = dragTargetFromPointer(event);
    if (!target) return undefined;

    const position = actionDragPositionFromPointer({
      clientX: event.clientX,
      laneLeft: target.lane.getBoundingClientRect().left,
      initialPositionPx: dragSession?.anchorPositionPx ?? left(),
      originalSnapPositionsPx:
        dragSession?.anchorPositionPx !== undefined
          ? [dragSession.anchorPositionPx]
          : undefined,
      timelineStartMs: ctx.start(),
      zoom: ctx.zoom(),
      snapConfig: getSnapConfig(),
    });
    return { ...position, trackId: target.trackId };
  };

  /** Clamps a track index to the available track list. */
  const clampTrackIndex = (trackIndex: number, tracks: types.Track[]) =>
    Math.max(0, Math.min(tracks.length - 1, trackIndex));

  /** Converts milliseconds into the current timeline lane pixel coordinate. */
  const positionMsToPx = (positionMs: number) =>
    (positionMs - ctx.start()) * (ctx.zoom() / 1000);

  /** Builds the source action set that should move with the active drag. */
  const createDragSession = (): DragSession | undefined => {
    const tracks = ctx.tracks();
    const currentSelection = { trackId: props.trackId, actionId: props.id };
    const selectedActions = ctx.actions.selectedActions();
    const dragSelections = selectedActions.some(
      (selection) =>
        selection.trackId === currentSelection.trackId &&
        selection.actionId === currentSelection.actionId,
    )
      ? selectedActions
      : [currentSelection];

    const actions = dragSelections.flatMap((selection): DragSessionAction[] => {
      const originalTrackIndex = tracks.findIndex(
        (track) => track.id === selection.trackId,
      );
      const action = tracks[originalTrackIndex]?.actions.find(
        (candidate) => candidate.id === selection.actionId,
      );
      if (originalTrackIndex === -1 || !action) return [];
      return [
        {
          sourceTrackId: selection.trackId,
          actionId: action.id,
          originalTrackIndex,
          originalPositionPx: positionMsToPx(durationToMs(action.position)),
          action,
        },
      ];
    });
    const anchorItem =
      actions.find(
        (action) =>
          action.sourceTrackId === props.trackId &&
          action.actionId === props.id,
      ) ?? actions[0];
    if (!anchorItem) return undefined;

    return {
      anchorOriginalTrackIndex: anchorItem.originalTrackIndex,
      anchorPositionPx: anchorItem.originalPositionPx,
      actions,
      canceled: false,
    };
  };

  /** Builds transparent action copies for the current pointer location. */
  const dragPreviewFromPointer = (
    event: PointerEvent,
  ): ActionDragPreview | undefined => {
    const session = dragSession;
    if (!session) return undefined;

    const anchorPosition = dragPositionFromPointer(event);
    if (!anchorPosition) return undefined;

    const tracks = ctx.tracks();
    const targetTrackIndex = tracks.findIndex(
      (track) => track.id === anchorPosition.trackId,
    );
    if (targetTrackIndex === -1) return undefined;

    const trackOffset = targetTrackIndex - session.anchorOriginalTrackIndex;
    const positionOffsetPx =
      anchorPosition.positionPx - session.anchorPositionPx;

    return {
      targetTrackId: anchorPosition.trackId,
      actions: session.actions.map((action) => {
        const trackIndex = clampTrackIndex(
          action.originalTrackIndex + trackOffset,
          tracks,
        );
        const positionPx = Math.max(
          0,
          action.originalPositionPx + positionOffsetPx,
        );
        return {
          sourceTrackId: action.sourceTrackId,
          actionId: action.actionId,
          trackId: tracks[trackIndex]?.id ?? anchorPosition.trackId,
          positionPx,
          positionMs: ctx.start() + pixelsToMs(positionPx, ctx.zoom()),
          action: action.action,
        };
      }),
    };
  };

  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    ctx.setRecordTargetTrackId(props.trackId);
    ctx.actions.selectAction(props.trackId, props.id, {
      range: event.shiftKey,
      toggle: !event.shiftKey && (event.ctrlKey || event.metaKey),
    });
  };

  const handleDoubleClick = (event: MouseEvent) => {
    event.stopPropagation();
  };

  /** Captures drag pointer events after the pointer leaves the source row. */
  const handlePointerDown = (event: PointerEvent) => {
    if (event.shiftKey) {
      ctx.setRecordTargetTrackId(props.trackId);
      ctx.actions.selectAction(props.trackId, props.id, {
        range: true,
      });
    }
    pendingDragSession = createDragSession();
    elementRef?.setPointerCapture(event.pointerId);
  };

  /** Releases captured drag pointer events after the interaction ends. */
  const releasePointerCapture = (event: PointerEvent) => {
    if (!isDragging()) {
      pendingDragSession = undefined;
    }
    if (elementRef?.hasPointerCapture(event.pointerId)) {
      elementRef.releasePointerCapture(event.pointerId);
    }
  };

  /** Restores timeline ownership for panel-scoped shortcuts after action drags. */
  const finishDragInteraction = (event: PointerEvent) => {
    releasePointerCapture(event);
    elementRef?.focus({ preventScroll: true });
    focusTrackedComponent(ctx.componentId);
  };

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    ctx.actions.selectAction(props.trackId, props.id);
    const editorTarget = resolveEditorTarget();
    const clipPropertiesTarget = resolveClipPropertiesTarget();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        ...(clipPropertiesTarget
          ? [
              {
                id: "open-action-clip-properties",
                label: clipPropertiesTarget.label,
                icon: PencilSimpleLineIcon,
                onSelect: openClipPropertiesTarget,
              },
              {
                type: "separator" as const,
                id: "action-clip-properties-separator",
              },
            ]
          : []),
        {
          id: "open-action-target-editor",
          label: editorTarget?.label ?? "No Target Editor",
          icon: PencilSimpleLineIcon,
          disabled: !editorTarget,
          onSelect: openEditorTarget,
        },
        { type: "separator", id: "action-target-editor-separator" },
        {
          id: "delete-action",
          label: "Delete Timeline Action",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: () => ctx.actions.deleteAction(props.trackId, props.id),
        },
      ],
    });
  };

  const markerStyle = () => getMarkerStyle(presentationAction().type);

  const markerLayer = () => {
    if (isDragging()) return 10;
    if (isSelected()) return 4;
    if (props.isPlayheadActive) return 3;
    return 1;
  };

  /** Returns status indicator styling for timeline lookahead eligibility. */
  const lookaheadIndicator = () => {
    switch (props.lookaheadStatus) {
      case types.TimelineLookaheadActionStatusKind.Ready:
        return {
          class: "bg-teal-300 ring-teal-950",
          title: "Lookahead ready",
        };
      case types.TimelineLookaheadActionStatusKind.Asserted:
        return {
          class: "bg-emerald-300 ring-emerald-950",
          title: "Lookahead asserted",
        };
      case types.TimelineLookaheadActionStatusKind
        .BlockedByInterveningFixtureAssertions:
        return {
          class: "bg-amber-300 ring-amber-950",
          title: "Lookahead blocked by intervening fixture assertions",
        };
      default:
        return undefined;
    }
  };

  /** Resolves the editor panel that best matches the current timeline action target. */
  const resolveEditorTarget = () =>
    resolveActionEditorTarget(
      presentationAction(),
      props.label,
      props.targetIndex,
    );

  /** Resolves the clip properties target directly controlled by this action. */
  const resolveClipPropertiesTarget = () =>
    resolveActionClipPropertiesTarget(presentationAction(), props.targetIndex);

  /** Opens or focuses the editor panel for the resolved timeline action target. */
  const openEditorTarget = () => {
    const api = $dockApi();
    const target = resolveEditorTarget();
    if (!api || !target) return;
    const panel = api.getPanel(target.panelId);
    if (panel) {
      panel.focus();
      return;
    }
    api.addPanel({
      id: target.panelId,
      component: target.component,
      title: target.title,
      params: target.params,
    });
  };

  /** Reveals the clip in ClipList and opens the global Properties panel. */
  const openClipPropertiesTarget = () => {
    const target = resolveClipPropertiesTarget();
    if (!target) return;

    openOrFocusPanel($dockApi(), "panel-ClipList", "ClipList", "Clips");
    invokePanelCapability("panel-ClipList", REVEAL_OBJECT_CAPABILITY, {
      type: "clip",
      uid: target.clipUid,
      intent: "properties",
    });
  };

  const displayLabel = createMemo(() =>
    resolveActionDisplayLabel(
      presentationAction(),
      props.label,
      props.targetIndex,
    ),
  );

  /** Converts the action duration into a renderable trail width. */
  const durationTrailWidthPx = createMemo(() =>
    props.showDurationTrail
      ? actionDurationTrailWidth(props.durationTrail?.durationMs, ctx.zoom())
      : undefined,
  );
  /** Converts loop intervals into positioned marker ticks inside the duration trail. */
  const durationTrailLoopMarkersModel = createMemo(() =>
    props.showDurationTrail
      ? actionDurationTrailLoopMarkers(
          props.durationTrail?.durationMs,
          props.durationTrail?.loopIntervalMs,
          ctx.zoom(),
        )
      : {
          markers: [],
          rawMarkerCount: 0,
          sampleStride: 1,
          sampled: false,
        },
  );

  /** Starts listening for Escape so keyboard cancellation works during pointer capture. */
  const startEscapeDragListener = () => {
    removeEscapeDragListener?.();
    /** Cancels the active action drag before it commits on pointer release. */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (dragSession) {
        dragSession.canceled = true;
      }
      setIsDragging(false);
      props.onDragPreviewClear?.();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    removeEscapeDragListener = () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      removeEscapeDragListener = undefined;
    };
  };

  onCleanup(() => {
    removeEscapeDragListener?.();
  });

  return (
    <>
      {/** biome-ignore lint/a11y/useKeyWithClickEvents: TODO: keyboard movement not supported yet */}
      <div
        ref={elementRef}
        data-component="Action"
        data-timeline-action="true"
        data-track-id={props.trackId}
        data-action-id={props.id}
        data-action-type={props.actionType}
        data-drag-preview={props.isDragPreview ? "true" : undefined}
        data-selected={isSelected() ? "true" : "false"}
        tabIndex={-1}
        use:draggable={{
          disabled: props.isDragPreview === true,
          axis: "both",
          grid: [1, 1],
          bounds: { left: 0 },
          transform: () => "translate3d(0px, 0px, 0px)",
          onDragStart: () => {
            if (props.isDragPreview) return;
            dragSession = pendingDragSession ?? createDragSession();
            pendingDragSession = undefined;
            lastDragPreview = undefined;
            setIsDragging(true);
            startEscapeDragListener();
          },
          onDrag: ({ event }) => {
            if (!dragSession || dragSession.canceled) return;
            const preview = dragPreviewFromPointer(event);
            if (preview) {
              lastDragPreview = preview;
              props.onDragPreview?.(preview);
            }
          },
          onDragEnd: (data) => {
            const session = dragSession;
            const preview =
              session && !session.canceled
                ? (dragPreviewFromPointer(data.event) ?? lastDragPreview)
                : undefined;
            setIsDragging(false);
            finishDragInteraction(data.event);
            props.onDragPreviewClear?.();
            removeEscapeDragListener?.();
            pendingDragSession = undefined;
            dragSession = undefined;
            lastDragPreview = undefined;

            if (!session || session.canceled) {
              return;
            }

            if (!preview) return;

            ctx.actions.repositionActions(
              preview.actions.map((action) => ({
                trackId: action.sourceTrackId,
                actionId: action.actionId,
                newPosition: action.positionMs,
                newTrackId: action.trackId,
              })),
            );
          },
        }}
        class={`absolute top-0 bottom-0 select-none outline-none focus:outline-none focus-visible:outline-none ${
          props.isDragPreview
            ? "pointer-events-none opacity-65"
            : isDragging() || props.isDragSourceOriginal
              ? "opacity-45"
              : ""
        }`}
        style={{
          left: `${left()}px`,
          width: "fit-content",
          cursor: props.isDragPreview
            ? "default"
            : isDragging()
              ? "grabbing"
              : "grab",
          "z-index": props.isDragPreview ? 12 : markerLayer(),
        }}
        onClick={handleClick}
        onDblClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={releasePointerCapture}
        onPointerCancel={releasePointerCapture}
        onContextMenu={handleContextMenu}
      >
        <div
          data-slot="marker"
          class={`pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-px ${markerStyle().stem}`}
        />
        <Show when={durationTrailWidthPx()}>
          {(trailWidthPx) => (
            <div
              data-slot="duration-trail"
              data-timeline-action-duration-trail="true"
              data-selected={isSelected() ? "true" : "false"}
              class="pointer-events-none absolute bottom-0 left-0 top-0 z-0"
              style={{ width: `${trailWidthPx()}px` }}
            >
              <div
                data-timeline-action-duration-line="true"
                class={`absolute left-0 right-0 top-1/2 border-t border-dotted ${
                  isSelected()
                    ? "border-sky-100 shadow-[0_0_6px_rgba(125,211,252,0.8)]"
                    : "border-sky-300/70"
                }`}
              />
              <For each={durationTrailLoopMarkersModel().markers}>
                {(marker) =>
                  marker.kind === "ellipsis" ? (
                    <span
                      data-timeline-action-duration-loop-sampling="true"
                      data-raw-marker-count={marker.rawMarkerCount}
                      data-sample-stride={marker.sampleStride}
                      data-skipped-marker-count={marker.skippedMarkerCount}
                      title={`Showing every ${marker.sampleStride}th loop marker (${marker.rawMarkerCount} total)`}
                      class="pointer-events-auto absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded bg-neutral-950/90 px-1 font-semibold text-[9px] leading-none text-sky-100 shadow-[0_0_0_1px_rgba(15,23,42,0.85),0_0_5px_rgba(125,211,252,0.45)]"
                      style={{ left: `${marker.offsetPx}px` }}
                    >
                      ...
                    </span>
                  ) : (
                    <span
                      data-timeline-action-duration-loop-marker="true"
                      data-loop-index={marker.loopIndex}
                      data-sampled={marker.sampled ? "true" : undefined}
                      aria-hidden="true"
                      class={`absolute top-1/2 w-px -translate-y-1/2 ${
                        marker.sampled ? "h-2 opacity-70" : "h-3"
                      } ${
                        isSelected()
                          ? "bg-sky-50 shadow-[0_0_0_1px_rgba(15,23,42,0.8),0_0_6px_rgba(125,211,252,0.8)]"
                          : "bg-sky-200/80 shadow-[0_0_0_1px_rgba(15,23,42,0.7)]"
                      }`}
                      style={{ left: `${marker.offsetPx}px` }}
                    />
                  )
                }
              </For>
              <span
                data-timeline-action-duration-fin-dash="true"
                aria-hidden="true"
                class={`absolute right-0 top-1/2 h-px w-2 -translate-y-1/2 ${
                  isSelected()
                    ? "bg-sky-50 shadow-[0_0_0_1px_rgba(15,23,42,0.8),0_0_6px_rgba(125,211,252,0.8)]"
                    : "bg-sky-200/90 shadow-[0_0_0_1px_rgba(15,23,42,0.7)]"
                }`}
              />
              <span
                data-timeline-action-duration-fin-bar="true"
                aria-hidden="true"
                class={`absolute bottom-0 right-0 top-0 w-px ${
                  isSelected()
                    ? "bg-sky-50 shadow-[0_0_0_1px_rgba(15,23,42,0.8),0_0_6px_rgba(125,211,252,0.8)]"
                    : "bg-sky-200/90 shadow-[0_0_0_1px_rgba(15,23,42,0.7)]"
                }`}
              />
            </div>
          )}
        </Show>
        <Show when={lookaheadIndicator()}>
          {(indicator) => (
            <span
              data-timeline-lookahead-status={props.lookaheadStatus}
              aria-hidden="true"
              title={indicator().title}
              class={`pointer-events-auto absolute -left-1 -top-1 z-10 h-2 w-2 rounded-full ring-1 ${indicator().class}`}
            />
          )}
        </Show>
        <div
          data-slot="chip"
          data-timeline-action-chip="true"
          class={`relative z-10 block max-w-[220px] truncate rounded-r-md rounded-l-none border px-2 py-[2px] text-[11px] leading-tight shadow-sm ${markerStyle().chip} ${
            isSelected() && !props.isDragPreview
              ? "ring-2 ring-blue-400 ring-offset-0"
              : ""
          }`}
        >
          {displayLabel()}
        </div>
      </div>
    </>
  );
};
