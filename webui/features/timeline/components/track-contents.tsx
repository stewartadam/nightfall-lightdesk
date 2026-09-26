// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useCommand } from "../../../components/providers/command-registry";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { parseTimelineInsertDragPayload } from "../../../lib/timeline-insert-drag";
import {
  timelinePlacementPosition,
  timelinePlacementPreference,
} from "../../../lib/timeline-placement";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { msToDuration, msToPixels, pixelsToMs } from "../../../lib/utils";
import {
  clips,
  cueDurationProfiles,
  cues,
  flows,
  fx,
  fxModules,
  sequences,
  stepFx,
} from "../../../state/appStores";
import { $settings } from "../../../state/settings";
import type * as types from "../../../types";
import { TimelinePlacementPreference } from "../../../types";
import { useTimelineContext } from "../context/timeline-context";
import { buildActionTargetIndex } from "../model/action-targets";
import { msPerBeat, type SnapConfig, snapToGrid } from "../model/grid-utils";
import {
  type ActionTargets,
  buildActionKind,
  DEFAULT_ACTION_DURATION_MS,
  getDefaultTargetForAction,
  getTargetsForAction,
  INSERTABLE_ACTIONS,
  type InsertableActionType,
} from "../model/insertion/action-catalog";
import type { ActionDragPreview } from "./action";
import { InsertActionPicker } from "./insertion/insert-action-picker";
import { Track } from "./track";

const log = getLogger(import.meta.url);

interface ConnectedTrackListProps {
  onToggleExpand?: (trackId: string) => void;
  componentId?: string;
}

export const ConnectedTracksContents = (props: {
  onToggleExpand?: (trackId: string) => void;
}) => {
  const ctx = useTimelineContext();
  return (
    <TrackContents
      tracks={ctx.displayTracks()}
      componentId={ctx.componentId}
      {...props}
    />
  );
};

interface TrackListProps extends ConnectedTrackListProps {
  tracks: types.Track[];
}

type InsertionIntent = {
  trackId: string;
  positionMs: number;
  positionPx: number;
  x: number;
  y: number;
  source: "context-menu" | "drag" | "keyboard" | "pointer";
};

type DragInsertDefaults = {
  targetUid?: string;
  targetLabel?: string;
  cueIndex?: number;
  rate?: number;
};

const TrackContents = (props: TrackListProps) => {
  const ctx = useTimelineContext();
  const $cues = useShallowStore(cues);
  const $cueDurationProfiles = useStore(cueDurationProfiles);
  const $clips = useStore(clips);
  const $flows = useStore(flows);
  const $fx = useStore(fx);
  const $fxModules = useStore(fxModules);
  const $sequences = useShallowStore(sequences);
  const $stepFx = useStore(stepFx);
  const settings = useStore($settings);

  const [pickerIntent, setPickerIntent] = createSignal<
    InsertionIntent | undefined
  >(undefined);
  const [dragPreview, setDragPreview] = createSignal<
    { trackId: string; positionPx: number } | undefined
  >(undefined);
  const [actionDragPreview, setActionDragPreview] = createSignal<
    ActionDragPreview | undefined
  >(undefined);
  const [lastPointerIntent, setLastPointerIntent] = createSignal<
    InsertionIntent | undefined
  >(undefined);

  const actionTargets = createMemo<ActionTargets>(() => {
    const cueRefsByUid = new Map<
      string,
      Array<{ sequenceId: number; cueIndex: number }>
    >();
    for (const sequence of Object.values($sequences())) {
      const sequenceId = sequence.identifiers.id;
      sequence.steps.forEach((cueUid, stepIndex) => {
        const refs = cueRefsByUid.get(cueUid) ?? [];
        refs.push({ sequenceId, cueIndex: stepIndex + 1 });
        cueRefsByUid.set(cueUid, refs);
      });
    }

    const cueTargets = Object.entries($cues()).map(([uid, cue]) => {
      const cueRefs = cueRefsByUid.get(uid) ?? [];
      const cueId = cue.identifiers.id;
      const cueLabel = cue.identifiers.label.trim() || `Cue ${cueId}`;
      const aliasIds = cueRefs.map((ref) => `${ref.sequenceId}.${cueId}`);
      const description =
        aliasIds.length === 0
          ? `Cue ${cueId}`
          : aliasIds.length === 1
            ? `Sequence ${cueRefs[0]!.sequenceId}, Cue ${cueId} (${aliasIds[0]})`
            : `Sequence cues: ${aliasIds.join(", ")}`;

      return {
        uid,
        label: cueLabel,
        description,
        searchText: [cueLabel, String(cueId), description, ...aliasIds].join(
          " ",
        ),
      };
    });
    const clipTargets = Object.entries($clips()).map(([uid, [clip]]) => ({
      uid,
      label: `Exec ${clip.identifiers.id}: ${clip.identifiers.label}`,
      description: `Clip ${clip.identifiers.id}`,
      searchText: `${clip.identifiers.id} ${clip.identifiers.label}`,
    }));
    const sequenceCueTargets = Object.entries($clips()).flatMap(
      ([clipUid, [clip]]) => {
        const source = clip.source;
        if (source?.type !== "Sequence") return [];

        const sequence = $sequences()[source.data];
        if (!sequence) return [];

        const clipLabel =
          clip.identifiers.label.trim() || `Clip ${clip.identifiers.id}`;
        const sequenceLabel =
          sequence.identifiers.label.trim() ||
          `Sequence ${sequence.identifiers.id}`;

        return sequence.steps.map((cueUid, stepIndex) => {
          const cue = $cues()[cueUid];
          const cueId = cue?.identifiers.id ?? stepIndex + 1;
          const cueLabel = cue?.identifiers.label.trim() || `Cue ${cueId}`;
          const cueIndex = stepIndex + 1;
          const sequenceCueId = `${sequence.identifiers.id}.${cueId}`;
          const stepPositionId = `${sequence.identifiers.id}.${cueIndex}`;
          const label = `Seq ${sequenceCueId}: ${cueLabel} via Exec ${clip.identifiers.id}`;
          const description = `${sequenceLabel}, cue ${cueId} at position ${cueIndex} on ${clipLabel}`;

          return {
            uid: clipUid,
            label,
            description,
            cueIndex,
            searchText: [
              label,
              description,
              sequenceCueId,
              stepPositionId,
              String(sequence.identifiers.id),
              String(cueId),
              String(cueIndex),
              cueLabel,
              sequenceLabel,
              clipLabel,
              String(clip.identifiers.id),
            ].join(" "),
          };
        });
      },
    );
    return { cueTargets, clipTargets, sequenceCueTargets };
  });

  /** Tracks source actions whose originals should stay visible under drag previews. */
  const dragSourceActionKeys = createMemo(() => {
    const preview = actionDragPreview();
    if (!preview) return undefined;
    return new Set(
      preview.actions.map((action) =>
        JSON.stringify([action.sourceTrackId, action.actionId]),
      ),
    );
  });

  /** Shares timeline action target lookups across all rendered actions. */
  const actionTargetIndex = createMemo(() =>
    buildActionTargetIndex({
      cues: $cues(),
      cueDurationProfiles: $cueDurationProfiles(),
      sequences: $sequences(),
      clips: $clips(),
      flows: $flows(),
      fx: $fx(),
      stepFx: $stepFx(),
      fxModules: $fxModules(),
    }),
  );
  /** Flattens timeline actions so clip stop actions can live on any track. */
  const allActions = createMemo(() =>
    props.tracks.flatMap((track) => track.actions),
  );

  const getSnapConfig = (): SnapConfig => {
    if (ctx.useBeatgrid()) {
      return {
        enabled: ctx.snapEnabled(),
        interval: msPerBeat(ctx.bpm()),
        threshold: 15,
        isBeat: true,
        beatsPerBar: ctx.beatsPerBar(),
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

  const buildInsertionIntent = (
    trackId: string,
    rawPositionPx: number,
    x: number,
    y: number,
    source: InsertionIntent["source"],
  ): InsertionIntent => {
    const snappedPx = snapToGrid(
      rawPositionPx,
      ctx.zoom(),
      ctx.start(),
      getSnapConfig(),
    );
    const positionMs = Math.max(
      0,
      Math.floor(ctx.start() + pixelsToMs(snappedPx, ctx.zoom())),
    );
    return {
      trackId,
      positionMs,
      positionPx: snappedPx,
      x,
      y,
      source,
    };
  };

  const isInsertableActionType = (
    value: string | undefined,
  ): value is InsertableActionType => {
    if (!value) return false;
    return INSERTABLE_ACTIONS.some((action) => action.type === value);
  };

  const createActionId = () => {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return `timeline-action-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  };

  const openActionPicker = (intent: InsertionIntent) => {
    setPickerIntent(intent);
  };

  /** Returns the track that should receive keyboard insert actions. */
  const keyboardInsertTrackId = () => {
    const currentTracks = ctx.tracks();
    const selectedActions = ctx.actions.selectedActions();
    const selectedActionTrackId =
      selectedActions[selectedActions.length - 1]?.trackId;
    if (
      selectedActionTrackId &&
      currentTracks.some((track) => track.id === selectedActionTrackId)
    ) {
      return selectedActionTrackId;
    }

    const recordTargetTrackId = ctx.recordTargetTrackId();
    if (
      recordTargetTrackId &&
      currentTracks.some((track) => track.id === recordTargetTrackId)
    ) {
      return recordTargetTrackId;
    }

    return currentTracks[0]?.id;
  };

  /** Builds a keyboard insert intent at the supplied timeline position. */
  const buildKeyboardIntentAtPosition = (
    trackId: string,
    positionMs: number,
  ): InsertionIntent => {
    const positionPx = msToPixels(positionMs - ctx.start(), ctx.zoom());
    return {
      trackId,
      positionMs,
      positionPx,
      x: Math.round(window.innerWidth / 2),
      y: 120,
      source: "keyboard",
    };
  };

  const insertActionForAction = (
    actionType: InsertableActionType,
    intent: InsertionIntent,
    defaults?: DragInsertDefaults,
  ) => {
    const targets = actionTargets();
    const fallbackTarget = getDefaultTargetForAction(actionType, targets);
    const familyTargets = getTargetsForAction(actionType, targets);
    const preferredTarget =
      defaults?.targetUid &&
      familyTargets.find(
        (target) =>
          target.uid === defaults.targetUid &&
          (defaults.cueIndex === undefined ||
            target.cueIndex === defaults.cueIndex),
      );
    const selectedTarget =
      preferredTarget ??
      (defaults?.targetUid && defaults?.targetLabel
        ? {
            uid: defaults.targetUid,
            label: defaults.targetLabel,
          }
        : undefined) ??
      fallbackTarget;

    if (!selectedTarget) {
      log.warn("No available targets for action", { actionType });
      return;
    }

    const track = ctx.tracks().find((entry) => entry.id === intent.trackId);
    if (!track) return;

    const actionId = createActionId();
    const action: types.Action = {
      id: actionId,
      label: selectedTarget.label,
      position: msToDuration(intent.positionMs),
      duration: msToDuration(DEFAULT_ACTION_DURATION_MS),
      action: buildActionKind(
        actionType,
        selectedTarget.uid,
        defaults?.cueIndex ?? selectedTarget.cueIndex ?? 1,
        defaults?.rate,
      ),
    };

    ctx.actions.insertAction(intent.trackId, action);
  };

  const deleteSelectedAction = () => {
    if (pickerIntent()) {
      return;
    }
    const selection = ctx.selection();
    if (selection?.type === "Marker") {
      ctx.markersActions.deleteMarker(selection.data.marker_uid);
      return;
    }
    if (
      selection?.type === "RegionBody" ||
      selection?.type === "RegionStart" ||
      selection?.type === "RegionEnd"
    ) {
      ctx.regionsActions.deleteRegion(selection.data.region_uid);
      return;
    }
    if (selection?.type !== "Action") return;
    const selectedActions = ctx.actions.selectedActions();
    const targets =
      selectedActions.length > 0
        ? selectedActions
        : [
            {
              trackId: selection.data.track_id,
              actionId: selection.data.action_id,
            },
          ];
    for (const target of targets) {
      ctx.actions.deleteAction(target.trackId, target.actionId);
    }
  };

  /** Handle track expansion toggle using the context function */
  const handleToggleExpand = (trackId: string) => {
    ctx.track.toggleTrackExpanded(trackId);
  };

  useKeyboardShortcut({
    key: "e",
    handler: () => {
      // Toggle expansion of the first selected track, or the first track if none selected
      const currentTracks = ctx.tracks();
      const selectedActions = ctx.actions.selectedActions();
      const selectedTrackId =
        selectedActions[selectedActions.length - 1]?.trackId ??
        currentTracks[0]?.id;

      if (selectedTrackId) {
        handleToggleExpand(selectedTrackId);
      }
    },
    description: "Toggle track expansion",
    componentId: props.componentId,
  });

  const openKeyboardInsert = () => {
    const preference = timelinePlacementPreference(
      settings().timeline_placement_preference,
    );
    const pointerIntent = lastPointerIntent();
    if (preference === TimelinePlacementPreference.Cursor && pointerIntent) {
      openActionPicker({ ...pointerIntent, source: "keyboard" });
      return;
    }

    const trackId = keyboardInsertTrackId();
    if (!trackId) return;

    const playheadMs = Math.max(
      Math.ceil(ctx.start()),
      Math.floor(ctx.position()),
    );
    const placementMs = timelinePlacementPosition({
      preference,
      playheadMs,
      cursorMs: ctx.cursorPosition(),
    });
    openActionPicker(buildKeyboardIntentAtPosition(trackId, placementMs));
  };

  useKeyboardShortcut({
    key: "i",
    handler: () => openKeyboardInsert(),
    description: "Insert timeline action",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Backspace",
    handler: () => deleteSelectedAction(),
    description: "Delete selected timeline action",
    componentId: props.componentId,
  });

  useKeyboardShortcut({
    key: "Delete",
    handler: () => deleteSelectedAction(),
    description: "Delete selected timeline action",
    componentId: props.componentId,
  });

  useCommand({
    id: `timeline.insert-action.${props.componentId || "global"}`,
    name: "Insert Timeline Action",
    description: "Insert a timeline action at cursor or playhead",
    category: "Timeline",
    execute: () => openKeyboardInsert(),
  });

  return (
    <div
      class="relative bg-[#1a1a1a]"
      style={{
        width: `${msToPixels(ctx.end(), ctx.zoom())}px`,
      }}
    >
      <div class="flex flex-col w-full overflow-hidden">
        <For each={props.tracks}>
          {(track) => (
            <Track
              id={track.id}
              label={track.label}
              muted={track.muted}
              solo={track.solo}
              actions={track.actions}
              allActions={allActions()}
              actionTargetIndex={actionTargetIndex()}
              automationLanes={track.automation_lanes}
              expanded={track.expanded}
              dragPreviewPositionPx={
                dragPreview()?.trackId === track.id
                  ? dragPreview()?.positionPx
                  : undefined
              }
              actionDragPreviewEntries={actionDragPreview()?.actions.filter(
                (action) => action.trackId === track.id,
              )}
              dragSourceActionKeys={dragSourceActionKeys()}
              isActionDragTarget={
                dragPreview()?.trackId === track.id ||
                actionDragPreview()?.targetTrackId === track.id
              }
              onLanePointerMove={(trackId, positionPx, x, y) => {
                setLastPointerIntent(
                  buildInsertionIntent(trackId, positionPx, x, y, "pointer"),
                );
              }}
              onLaneContextMenu={(trackId, positionPx, x, y) => {
                const intent = buildInsertionIntent(
                  trackId,
                  positionPx,
                  x,
                  y,
                  "context-menu",
                );
                setLastPointerIntent(intent);
                openContextMenu({
                  x,
                  y,
                  items: [
                    {
                      id: "insert-timeline-action",
                      label: "Insert Action...",
                      shortcut: "I",
                      onSelect: () => openActionPicker(intent),
                    },
                  ],
                });
              }}
              onLaneDragOver={(trackId, positionPx, x, y) => {
                const intent = buildInsertionIntent(
                  trackId,
                  positionPx,
                  x,
                  y,
                  "drag",
                );
                setDragPreview({
                  trackId,
                  positionPx: intent.positionPx,
                });
                setLastPointerIntent(intent);
              }}
              onLaneDragLeave={(trackId) => {
                const preview = dragPreview();
                if (preview?.trackId === trackId) {
                  setDragPreview(undefined);
                }
              }}
              onLaneDrop={(trackId, positionPx, dragPayload, x, y) => {
                setDragPreview(undefined);
                const payload = parseTimelineInsertDragPayload(dragPayload);
                if (!payload || !isInsertableActionType(payload.actionType)) {
                  return;
                }
                const intent = buildInsertionIntent(
                  trackId,
                  positionPx,
                  x,
                  y,
                  "drag",
                );
                setLastPointerIntent(intent);
                insertActionForAction(payload.actionType, intent, {
                  targetUid: payload.targetUid,
                  targetLabel: payload.targetLabel,
                  cueIndex: payload.cueIndex,
                });
              }}
              onActionDragPreview={(preview) => {
                setDragPreview(undefined);
                setActionDragPreview(preview);
              }}
              onActionDragPreviewClear={() => {
                setDragPreview(undefined);
                setActionDragPreview(undefined);
              }}
            />
          )}
        </For>

        <Track
          id="add-track-placeholder"
          label="add track"
          muted={false}
          solo={false}
          actions={[]}
          allActions={allActions()}
          actionTargetIndex={actionTargetIndex()}
          acceptsActionDrops={false}
        />
      </div>

      <Show when={pickerIntent()}>
        {(intent) => (
          <Portal>
            <InsertActionPicker
              x={intent().x}
              y={intent().y}
              targets={actionTargets()}
              onClose={() => setPickerIntent(undefined)}
              onRegisteredInsert={(option) => {
                ctx.actions.insertAction(intent().trackId, {
                  id: createActionId(),
                  label: option.label,
                  position: msToDuration(intent().positionMs),
                  duration: msToDuration(DEFAULT_ACTION_DURATION_MS),
                  action: { type: "RegisteredAction", data: option.action },
                });
                setPickerIntent(undefined);
              }}
              onInsert={({
                actionType,
                targetUid,
                targetLabel,
                cueIndex,
                rate,
              }) => {
                insertActionForAction(actionType, intent(), {
                  targetUid,
                  targetLabel,
                  cueIndex,
                  rate,
                });
                setPickerIntent(undefined);
              }}
            />
          </Portal>
        )}
      </Show>
    </div>
  );
};
