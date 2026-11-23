// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, batch, createMemo, createSignal } from "solid-js";
import { createEffect, createProjection } from "../../../lib/solid-compat";
import type * as types from "../../../types";
import {
  type StepFxTrackKind,
  stepFxStepSelectionIdentity,
  stepFxTrack,
  stringSetsEqual,
} from "../model/step-fx-editor-model";

interface StepFxEditorSelectionControllerOptions {
  draft: Accessor<types.StepFx | undefined>;
  initialTrackKind: StepFxTrackKind;
}

/** Owns the active lane, contribution track, and per-track step row selection. */
export function createStepFxEditorSelectionController(
  options: StepFxEditorSelectionControllerOptions,
) {
  const { draft } = options;
  const [selectedLane, setSelectedLane] = createSignal(0);
  const [trackKind, setTrackKind] = createSignal<StepFxTrackKind>(
    options.initialTrackKind,
  );
  const [selectedStepUids, setSelectedStepUidsSignal] = createSignal<
    Set<string>
  >(new Set());
  const [selectionMode, setSelectionMode] = createSignal(false);
  const trackSelections = new Map<string, Set<string>>();

  /** Returns the stable editor-local selection key for one lane contribution track. */
  const trackSelectionKey = (
    lane = selectedLane(),
    kind = trackKind(),
  ): string => `${lane}:${kind}`;

  /** Updates the active selection and remembers it independently for this track. */
  const setSelectedStepUids = (
    update: Set<string> | ((current: Set<string>) => Set<string>),
  ): void => {
    const next =
      typeof update === "function" ? update(selectedStepUids()) : update;
    const stored = new Set(next);
    trackSelections.set(trackSelectionKey(), stored);
    setSelectedStepUidsSignal(stored);
  };

  /** Toggles the explicit row-selection controls without discarding the active edit selection. */
  const toggleSelectionMode = (): void => {
    setSelectionMode((enabled) => !enabled);
  };

  /** Switches tracks while restoring that track's most recent row selection. */
  const selectTrack = (lane: number, kind: StepFxTrackKind): void => {
    batch(() => {
      setSelectedLane(lane);
      setTrackKind(kind);
      setSelectedStepUidsSignal(
        new Set(trackSelections.get(trackSelectionKey(lane, kind)) ?? []),
      );
    });
  };

  /** Forgets remembered per-track selections after lane indexes shift. */
  const clearTrackSelections = (): void => {
    trackSelections.clear();
  };

  /** Returns the currently selected lane after clamping structural edits. */
  const activeLane = createMemo(() => {
    const lanes = draft()?.lanes ?? [];
    return lanes[Math.min(selectedLane(), Math.max(lanes.length - 1, 0))];
  });

  /** Returns the absolute or relative track selected in the sheet. */
  const activeTrack = createMemo(() => {
    const lane = activeLane();
    return lane ? stepFxTrack(lane, trackKind()) : undefined;
  });

  /**
   * Mirrors the active track's steps into a uid-keyed store. Every edit clones
   * the draft, so rendering the cloned objects directly would remount each
   * sheet row and drop keyboard focus from its controls after every change.
   */
  const stepRows = createProjection<types.FxStep[]>(
    // Cloned so reconcile never mutates step objects owned by earlier drafts.
    () => structuredClone(activeTrack()?.steps ?? []),
    [],
    { key: "uid" },
  );

  /** Keeps step selection valid when lanes, tracks, or rows change. */
  createEffect(
    () => {
      const selected = selectedStepUids();
      const selectedIdentities = new Set(
        Array.from(selected, stepFxStepSelectionIdentity),
      );
      const retained = new Set(
        activeTrack()
          ?.steps.filter((step) =>
            selectedIdentities.has(stepFxStepSelectionIdentity(step.uid)),
          )
          .map((step) => step.uid) ?? [],
      );
      return { selected, retained };
    },
    ({ selected, retained }) => {
      if (!stringSetsEqual(retained, selected)) setSelectedStepUids(retained);
    },
  );

  /** Returns the row selection affected by a cell edit. */
  const editSelectionFor = (uid: string): Set<string> => {
    return selectedStepUids().has(uid) ? selectedStepUids() : new Set([uid]);
  };

  return {
    selectedLane,
    trackKind,
    selectedStepUids,
    setSelectedStepUids,
    selectionMode,
    toggleSelectionMode,
    selectTrack,
    clearTrackSelections,
    activeLane,
    activeTrack,
    stepRows,
    editSelectionFor,
  };
}

/** Lane, track, and step row selection state for one Step FX editor. */
export type StepFxEditorSelectionController = ReturnType<
  typeof createStepFxEditorSelectionController
>;
