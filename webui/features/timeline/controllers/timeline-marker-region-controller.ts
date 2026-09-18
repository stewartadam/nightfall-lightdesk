// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { getLogger } from "../../../lib/logger";
import { durationToMs } from "../../../lib/utils";
import type * as types from "../../../types";
import type {
  DeleteMarkerEvent,
  DeleteRegionEvent,
  SetLoopRangeEvent,
  StoreMarkerEvent,
  StoreRegionEvent,
  TimelineMutationOptions,
} from "../context/timeline-context-contract";
import type { createTimelineSelectionController } from "./timeline-selection-controller";
import type { TimelineState } from "./timeline-state-controller";

const log = getLogger(import.meta.url);

type TimelineSelectionController = ReturnType<
  typeof createTimelineSelectionController
>;

/** Coordinates marker, region, loop, and marker-label mutations with persistence events. */
export function createTimelineMarkerRegionController(
  state: TimelineState,
  selection: TimelineSelectionController,
) {
  const [storeMarkerEvent, setStoreMarkerEvent] =
    createSignal<StoreMarkerEvent>();
  const [deleteMarkerEvent, setDeleteMarkerEvent] =
    createSignal<DeleteMarkerEvent>();
  const [storeRegionEvent, setStoreRegionEvent] =
    createSignal<StoreRegionEvent>();
  const [deleteRegionEvent, setDeleteRegionEvent] =
    createSignal<DeleteRegionEvent>();
  const [setLoopRangeEvent, setSetLoopRangeEvent] =
    createSignal<SetLoopRangeEvent>();

  /** Stores one or more markers and emits a batch persistence event. */
  const storeMarkers = (
    nextMarkers: types.TimelineMarker[],
    options?: TimelineMutationOptions,
  ) => {
    if (nextMarkers.length === 0) return;
    log.debug("storing markers", {
      markerUids: nextMarkers.map((marker) => marker.uid),
    });
    state.setMarkers((current) => {
      const next = [...current];
      for (const marker of nextMarkers) {
        const index = next.findIndex((entry) => entry.uid === marker.uid);
        if (index === -1) next.push(marker);
        else next[index] = marker;
      }
      return next;
    });
    setStoreMarkerEvent({
      type: "store-marker",
      markers: nextMarkers,
      batchId: options?.batchId,
    });
  };

  /** Stores a single marker through the batch marker path. */
  const storeMarker = (marker: types.TimelineMarker) => storeMarkers([marker]);

  /** Returns the current marker-label draft or its persisted fallback. */
  const markerLabelDraft = (markerUid: string, fallback: string) =>
    state.markerLabelDrafts()[markerUid] ?? fallback;

  /** Updates one marker-label draft without persisting the marker. */
  const setMarkerLabelDraft = (markerUid: string, label: string) => {
    state.setMarkerLabelDrafts((current) => ({
      ...current,
      [markerUid]: label,
    }));
  };

  /** Removes one marker-label draft from local state. */
  const clearMarkerLabelDraft = (markerUid: string) => {
    state.setMarkerLabelDrafts((current) => {
      if (!(markerUid in current)) return current;
      const next = { ...current };
      delete next[markerUid];
      return next;
    });
  };

  /** Starts editing a marker while preserving an existing draft. */
  const startMarkerLabelEditing = (markerUid: string, label: string) => {
    state.setMarkerLabelDrafts((current) =>
      markerUid in current ? current : { ...current, [markerUid]: label },
    );
    state.setEditingMarkerLabelUid(markerUid);
  };

  /** Deletes the requested marker and any selected marker siblings. */
  const deleteMarker = (markerUid: string) => {
    const selectedMarkerUids = selection
      .selectedMarkers()
      .map((marker) => marker.markerUid);
    const markerUids = selectedMarkerUids.includes(markerUid)
      ? selectedMarkerUids
      : [markerUid];
    const markerUidSet = new Set(markerUids);
    state.setMarkers((current) =>
      current.filter((marker) => !markerUidSet.has(marker.uid)),
    );
    for (const deletedMarkerUid of markerUids) {
      clearMarkerLabelDraft(deletedMarkerUid);
    }
    const editingUid = state.editingMarkerLabelUid();
    if (editingUid && markerUidSet.has(editingUid)) {
      state.setEditingMarkerLabelUid(undefined);
    }
    selection.deleteMarkers(markerUidSet);
    setDeleteMarkerEvent({ type: "delete-marker", markerUids });
  };

  /** Stores a valid timeline region and emits its persistence event. */
  const storeRegion = (region: types.TimelineRegion) => {
    if (durationToMs(region.end) < durationToMs(region.start)) return;
    state.setRegions((current) => {
      const index = current.findIndex((entry) => entry.uid === region.uid);
      if (index === -1) return [...current, region];
      const next = [...current];
      next[index] = region;
      return next;
    });
    setStoreRegionEvent({ type: "store-region", region });
  };

  /** Deletes a timeline region, clears its selection, and emits persistence. */
  const deleteRegion = (regionUid: string) => {
    state.setRegions((current) =>
      current.filter((region) => region.uid !== regionUid),
    );
    selection.deleteRegion(regionUid);
    setDeleteRegionEvent({ type: "delete-region", regionUid });
  };

  /** Stores a valid loop range and emits its persistence event. */
  const setPersistedLoopRange = (
    loopRange: types.TimelineLoopRange | undefined,
  ) => {
    if (
      loopRange &&
      durationToMs(loopRange.end) < durationToMs(loopRange.start)
    ) {
      return;
    }
    state.setLoopRange(loopRange);
    setSetLoopRangeEvent({ type: "set-loop-range", loopRange });
  };

  return {
    storeMarkers,
    storeMarker,
    deleteMarker,
    markerLabelDraft,
    setMarkerLabelDraft,
    clearMarkerLabelDraft,
    startMarkerLabelEditing,
    storeRegion,
    deleteRegion,
    setPersistedLoopRange,
    storeMarkerEvent,
    deleteMarkerEvent,
    storeRegionEvent,
    deleteRegionEvent,
    setLoopRangeEvent,
  };
}
