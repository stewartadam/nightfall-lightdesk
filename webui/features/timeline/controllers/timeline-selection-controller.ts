// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal, type Setter } from "solid-js";
import { getLogger } from "../../../lib/logger";
import type { MoveTimelineActionOptions } from "../../../lib/timeline-actions";
import { durationToMs, msToDuration } from "../../../lib/utils";
import type * as types from "../../../types";
import type {
  NudgeSelectionEvent,
  SelectActionEvent,
  SelectActionOptions,
  SelectedAction,
  SelectedMarker,
  SelectMarkerOptions,
} from "../context/timeline-context-contract";

const log = getLogger(import.meta.url);

interface TimelineSelectionControllerOptions {
  tracks: Accessor<types.Track[]>;
  setTracks: Setter<types.Track[]>;
  markers: Accessor<types.TimelineMarker[]>;
  setMarkers: Setter<types.TimelineMarker[]>;
  regions: Accessor<types.TimelineRegion[]>;
  setRegions: Setter<types.TimelineRegion[]>;
}

/** Returns whether two selected action identities refer to the same action. */
const sameSelectedAction = (left: SelectedAction, right: SelectedAction) =>
  left.trackId === right.trackId && left.actionId === right.actionId;

/** Produces a stable key for a selected action. */
const selectedActionKey = (selection: SelectedAction) =>
  JSON.stringify([selection.trackId, selection.actionId]);

/** Converts the UI action identity into the backend timeline selection shape. */
const toTimelineActionSelection = (
  selection: SelectedAction,
): types.TimelineSelection => ({
  type: "Action",
  data: { track_id: selection.trackId, action_id: selection.actionId },
});

/** Owns timeline object selection, multi-selection repair, and nudge mutations. */
export const createTimelineSelectionController = (
  options: TimelineSelectionControllerOptions,
) => {
  const [selection, setSelection] = createSignal<
    types.TimelineSelection | undefined
  >(undefined);
  const [selectedActions, setSelectedActions] = createSignal<SelectedAction[]>(
    [],
  );
  const [selectedMarkers, setSelectedMarkers] = createSignal<SelectedMarker[]>(
    [],
  );
  const [selectActionEvent, setSelectActionEvent] = createSignal<
    SelectActionEvent | undefined
  >(undefined);
  const [nudgeSelectionEvent, setNudgeSelectionEvent] = createSignal<
    NudgeSelectionEvent | undefined
  >(undefined);

  /** Clears active and multi-object selections when timeline identity changes. */
  const clear = () => {
    setSelection(undefined);
    setSelectedActions([]);
    setSelectedMarkers([]);
  };

  /** Removes selections that belonged to a deleted track. */
  const removeTrack = (trackId: string) => {
    setSelectedActions((current) =>
      current.filter((entry) => entry.trackId !== trackId),
    );
    const currentSelection = selection();
    if (
      currentSelection?.type === "Action" &&
      currentSelection.data.track_id === trackId
    ) {
      setSelection(undefined);
    }
  };

  /** Repairs selected track identities after one action moves between tracks. */
  const repositionAction = (
    trackId: string,
    actionId: string,
    targetTrackId: string,
  ) => {
    if (targetTrackId === trackId) return;
    const movedSelection = { trackId: targetTrackId, actionId };
    setSelectedActions((current) =>
      current.map((entry) =>
        sameSelectedAction(entry, { trackId, actionId })
          ? movedSelection
          : entry,
      ),
    );
    const currentSelection = selection();
    if (
      currentSelection?.type === "Action" &&
      currentSelection.data.track_id === trackId &&
      currentSelection.data.action_id === actionId
    ) {
      setSelection(toTimelineActionSelection(movedSelection));
    }
  };

  /** Repairs selected track identities after a multi-action move. */
  const repositionActions = (actions: MoveTimelineActionOptions[]) => {
    const movedSelections = new Map(
      actions.map((action) => [
        selectedActionKey({
          trackId: action.trackId,
          actionId: action.actionId,
        }),
        {
          trackId: action.newTrackId ?? action.trackId,
          actionId: action.actionId,
        },
      ]),
    );
    setSelectedActions((current) =>
      current.map(
        (entry) => movedSelections.get(selectedActionKey(entry)) ?? entry,
      ),
    );
    const currentSelection = selection();
    if (currentSelection?.type !== "Action") return;
    const movedSelection = movedSelections.get(
      selectedActionKey({
        trackId: currentSelection.data.track_id,
        actionId: currentSelection.data.action_id,
      }),
    );
    if (movedSelection) {
      setSelection(toTimelineActionSelection(movedSelection));
    }
  };

  /** Selects an action with optional toggle or contiguous-range behavior. */
  const selectAction = (
    trackId: string,
    actionId: string,
    selectionOptions?: SelectActionOptions,
  ) => {
    log.debug(`selecting action ${actionId} on track ${trackId}`);
    const nextSelection = { trackId, actionId };
    const activeSelection = selection();
    const currentSelectedActions = selectedActions();
    let nextSelectedActions: SelectedAction[] = [nextSelection];
    let activeAction: SelectedAction | undefined = nextSelection;

    if (selectionOptions?.toggle) {
      const currentlySelected = currentSelectedActions.some((entry) =>
        sameSelectedAction(entry, nextSelection),
      );
      nextSelectedActions = currentlySelected
        ? currentSelectedActions.filter(
            (entry) => !sameSelectedAction(entry, nextSelection),
          )
        : [...currentSelectedActions, nextSelection];
      activeAction = currentlySelected
        ? nextSelectedActions[nextSelectedActions.length - 1]
        : nextSelection;
    } else if (selectionOptions?.range) {
      let lastSelectedItemOnTrack: string | undefined;
      for (const entry of currentSelectedActions) {
        if (entry.trackId === trackId) lastSelectedItemOnTrack = entry.actionId;
      }
      const anchorActionId =
        activeSelection?.type === "Action" &&
        activeSelection.data.track_id === trackId
          ? activeSelection.data.action_id
          : lastSelectedItemOnTrack;
      if (anchorActionId) {
        const track = options.tracks().find((entry) => entry.id === trackId);
        const orderedActions =
          track?.actions
            .map((action, index) => ({
              id: action.id,
              index,
              position: durationToMs(action.position),
            }))
            .sort(
              (left, right) =>
                left.position - right.position || left.index - right.index,
            ) ?? [];
        const anchorIndex = orderedActions.findIndex(
          (entry) => entry.id === anchorActionId,
        );
        const clickedIndex = orderedActions.findIndex(
          (entry) => entry.id === actionId,
        );
        if (anchorIndex !== -1 && clickedIndex !== -1) {
          const rangeItems = orderedActions
            .slice(
              Math.min(anchorIndex, clickedIndex),
              Math.max(anchorIndex, clickedIndex) + 1,
            )
            .map((entry) => ({ trackId, actionId: entry.id }));
          const selectedKeys = new Set(
            currentSelectedActions.map(selectedActionKey),
          );
          nextSelectedActions = [...currentSelectedActions];
          for (const rangeItem of rangeItems) {
            const key = selectedActionKey(rangeItem);
            if (selectedKeys.has(key)) continue;
            selectedKeys.add(key);
            nextSelectedActions.push(rangeItem);
          }
        }
      }
    }

    setSelectedMarkers([]);
    setSelectedActions(nextSelectedActions);
    setSelection(
      activeAction ? toTimelineActionSelection(activeAction) : undefined,
    );
    setSelectActionEvent({ type: "select-action", trackId, actionId });
  };

  /** Removes a deleted action from the selection and promotes the latest sibling. */
  const deleteAction = (trackId: string, actionId: string) => {
    const nextSelectedActions = selectedActions().filter(
      (entry) => entry.trackId !== trackId || entry.actionId !== actionId,
    );
    setSelectedActions(nextSelectedActions);
    const currentSelection = selection();
    if (
      currentSelection?.type === "Action" &&
      currentSelection.data.track_id === trackId &&
      currentSelection.data.action_id === actionId
    ) {
      const fallbackSelection =
        nextSelectedActions[nextSelectedActions.length - 1];
      setSelection(
        fallbackSelection
          ? toTimelineActionSelection(fallbackSelection)
          : undefined,
      );
    }
  };

  /** Selects a marker with optional toggle or contiguous-range behavior. */
  const selectMarker = (
    markerUid: string,
    selectionOptions?: SelectMarkerOptions,
  ) => {
    log.debug(`selecting marker ${markerUid}`);
    const nextMarker = { markerUid };
    const currentSelectedMarkers = selectedMarkers();
    let nextSelectedMarkers: SelectedMarker[] = [nextMarker];
    let activeMarker: SelectedMarker | undefined = nextMarker;

    if (selectionOptions?.toggle) {
      const currentlySelected = currentSelectedMarkers.some(
        (marker) => marker.markerUid === markerUid,
      );
      nextSelectedMarkers = currentlySelected
        ? currentSelectedMarkers.filter(
            (marker) => marker.markerUid !== markerUid,
          )
        : [...currentSelectedMarkers, nextMarker];
      activeMarker = currentlySelected
        ? nextSelectedMarkers[nextSelectedMarkers.length - 1]
        : nextMarker;
    } else if (selectionOptions?.range) {
      const activeSelection = selection();
      const anchorMarkerUid =
        activeSelection?.type === "Marker"
          ? activeSelection.data.marker_uid
          : currentSelectedMarkers[currentSelectedMarkers.length - 1]
              ?.markerUid;
      if (anchorMarkerUid) {
        const orderedMarkers = options
          .markers()
          .map((marker, index) => ({
            uid: marker.uid,
            index,
            position: durationToMs(marker.time),
          }))
          .sort(
            (left, right) =>
              left.position - right.position || left.index - right.index,
          );
        const anchorIndex = orderedMarkers.findIndex(
          (marker) => marker.uid === anchorMarkerUid,
        );
        const clickedIndex = orderedMarkers.findIndex(
          (marker) => marker.uid === markerUid,
        );
        if (anchorIndex !== -1 && clickedIndex !== -1) {
          const rangeMarkers = orderedMarkers
            .slice(
              Math.min(anchorIndex, clickedIndex),
              Math.max(anchorIndex, clickedIndex) + 1,
            )
            .map((marker) => ({ markerUid: marker.uid }));
          const selectedUids = new Set(
            currentSelectedMarkers.map((marker) => marker.markerUid),
          );
          nextSelectedMarkers = [...currentSelectedMarkers];
          for (const rangeMarker of rangeMarkers) {
            if (selectedUids.has(rangeMarker.markerUid)) continue;
            selectedUids.add(rangeMarker.markerUid);
            nextSelectedMarkers.push(rangeMarker);
          }
        }
      }
    }

    setSelectedActions([]);
    setSelectedMarkers(nextSelectedMarkers);
    setSelection(
      activeMarker
        ? { type: "Marker", data: { marker_uid: activeMarker.markerUid } }
        : undefined,
    );
  };

  /** Removes deleted marker identities from selection state. */
  const deleteMarkers = (markerUids: Set<string>) => {
    setSelectedMarkers((current) =>
      current.filter((marker) => !markerUids.has(marker.markerUid)),
    );
    const currentSelection = selection();
    if (
      currentSelection?.type === "Marker" &&
      markerUids.has(currentSelection.data.marker_uid)
    ) {
      setSelection(undefined);
    }
  };

  /** Clears the active selection when its region is deleted. */
  const deleteRegion = (regionUid: string) => {
    const currentSelection = selection();
    if (
      (currentSelection?.type === "RegionBody" ||
        currentSelection?.type === "RegionStart" ||
        currentSelection?.type === "RegionEnd") &&
      currentSelection.data.region_uid === regionUid
    ) {
      setSelection(undefined);
    }
  };

  /** Replaces selection state while maintaining compatible multi-selections. */
  const selectTimelineObject = (
    nextSelection: types.TimelineSelection | undefined,
  ) => {
    setSelectedActions(
      nextSelection?.type === "Action"
        ? [
            {
              trackId: nextSelection.data.track_id,
              actionId: nextSelection.data.action_id,
            },
          ]
        : [],
    );
    setSelectedMarkers(
      nextSelection?.type === "Marker"
        ? [{ markerUid: nextSelection.data.marker_uid }]
        : [],
    );
    setSelection(nextSelection);
  };

  /** Moves the current timeline selection by the requested millisecond delta. */
  const nudgeSelection = (deltaMs: number) => {
    const currentSelection = selection();
    if (!currentSelection || deltaMs === 0) return;

    /** Applies the nudge while clamping timeline positions at zero. */
    const applyDelta = (value: types.Duration) =>
      msToDuration(Math.max(0, durationToMs(value) + deltaMs));
    const selectedTimelineObjects =
      currentSelection.type === "Action" && selectedActions().length > 0
        ? selectedActions().map(toTimelineActionSelection)
        : currentSelection.type === "Marker" && selectedMarkers().length > 0
          ? selectedMarkers().map(
              (marker): types.TimelineSelection => ({
                type: "Marker",
                data: { marker_uid: marker.markerUid },
              }),
            )
          : [currentSelection];

    if (currentSelection.type === "Marker") {
      const selectedMarkerUids = new Set(
        (selectedMarkers().length > 0
          ? selectedMarkers()
          : [{ markerUid: currentSelection.data.marker_uid }]
        ).map((marker) => marker.markerUid),
      );
      options.setMarkers((current) =>
        current.map((marker) =>
          selectedMarkerUids.has(marker.uid)
            ? { ...marker, time: applyDelta(marker.time) }
            : marker,
        ),
      );
    } else if (currentSelection.type === "Action") {
      const selectedItemKeys = new Set(
        selectedTimelineObjects
          .filter((entry) => entry.type === "Action")
          .map((entry) =>
            selectedActionKey({
              trackId: entry.data.track_id,
              actionId: entry.data.action_id,
            }),
          ),
      );
      options.setTracks((current) =>
        current.map((track) => ({
          ...track,
          actions: track.actions.map((action) =>
            selectedItemKeys.has(
              selectedActionKey({ trackId: track.id, actionId: action.id }),
            )
              ? { ...action, position: applyDelta(action.position) }
              : action,
          ),
        })),
      );
    } else if (currentSelection.type === "RegionBody") {
      options.setRegions((current) =>
        current.map((region) => {
          if (region.uid !== currentSelection.data.region_uid) return region;
          const startMs = durationToMs(region.start);
          const endMs = durationToMs(region.end);
          const durationMs = Math.max(0, endMs - startMs);
          const nextStartMs = Math.max(0, startMs + deltaMs);
          return {
            ...region,
            start: msToDuration(nextStartMs),
            end: msToDuration(nextStartMs + durationMs),
          };
        }),
      );
    } else if (currentSelection.type === "RegionStart") {
      options.setRegions((current) =>
        current.map((region) =>
          region.uid === currentSelection.data.region_uid
            ? {
                ...region,
                start: msToDuration(
                  Math.min(
                    durationToMs(region.end),
                    Math.max(0, durationToMs(region.start) + deltaMs),
                  ),
                ),
              }
            : region,
        ),
      );
    } else if (currentSelection.type === "RegionEnd") {
      options.setRegions((current) =>
        current.map((region) =>
          region.uid === currentSelection.data.region_uid
            ? {
                ...region,
                end: msToDuration(
                  Math.max(
                    durationToMs(region.start),
                    Math.max(0, durationToMs(region.end) + deltaMs),
                  ),
                ),
              }
            : region,
        ),
      );
    }

    setNudgeSelectionEvent({
      type: "nudge-selection",
      selection: selectedTimelineObjects,
      deltaMs,
    });
  };

  return {
    selection,
    selectedActions,
    selectedMarkers,
    selectActionEvent,
    nudgeSelectionEvent,
    clear,
    removeTrack,
    repositionAction,
    repositionActions,
    selectAction,
    deleteAction,
    selectMarker,
    deleteMarkers,
    deleteRegion,
    selectTimelineObject,
    nudgeSelection,
  };
};
