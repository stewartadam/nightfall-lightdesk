// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { previewSequence, stopPreviewInstance } from "../../../lib/cue-service";
import { getLogger } from "../../../lib/logger";
import { buildSequencePreviewPayload } from "../../../lib/sequence-preview-cue";
import { activeInstances } from "../../../state/appStores";
import type * as types from "../../../types";
import { activeCueUidFromPreviewInstance } from "../../cue-sequences";
import type { SequenceCueRow } from "../context/sequence-editor-context-contract";
import type { SequenceEditorSourceController } from "./sequence-editor-source-controller";

const log = getLogger(import.meta.url);

/** Coordinates the backend preview instance owned by one sequence editor. */
export function createSequenceEditorPreviewController(
  source: SequenceEditorSourceController,
) {
  const activeInstancesStore = useStore(activeInstances);
  const [previewEnabled, setPreviewEnabledSignal] = createSignal(false);
  const [previewApplyTransitions, setPreviewApplyTransitions] =
    createSignal(true);
  const [previewTrackValues, setPreviewTrackValues] = createSignal(true);
  const [previewSessionActive, setPreviewSessionActive] = createSignal(false);
  const [previewPending, setPreviewPending] = createSignal(false);
  const [previewPlaybackSeen, setPreviewPlaybackSeen] = createSignal(false);
  const [activePreviewInstanceId, setActivePreviewInstanceId] =
    createSignal<types.InstanceId>();
  const [previewStartedAtMs, setPreviewStartedAtMs] = createSignal<number>();
  const [activePreviewCueUid, setActivePreviewCueUid] = createSignal<string>();
  let previewLifecycleToken = 0;
  let previewStartInFlight = false;
  let queuedPreviewPayload: types.SequencePreview | undefined;

  /** Normalizes cue identifiers for comparisons with backend playback data. */
  const normalizePreviewCueUid = (cueUid: string | undefined) =>
    cueUid ? normalizeFixtureUid(cueUid).toLowerCase() : undefined;

  /** Clears all local sequence-preview state owned by this editor instance. */
  const clearPreviewState = () => {
    setPreviewPending(false);
    setPreviewPlaybackSeen(false);
    setPreviewSessionActive(false);
    setActivePreviewInstanceId(undefined);
    setPreviewStartedAtMs(undefined);
    setActivePreviewCueUid(undefined);
  };

  /** Stops the backend sequence preview and clears local preview state. */
  const stopPreviewSession = () => {
    previewLifecycleToken += 1;
    previewStartInFlight = false;
    queuedPreviewPayload = undefined;
    const instanceId = activePreviewInstanceId();
    if (instanceId) void stopPreviewInstance(instanceId);
    clearPreviewState();
  };

  const activePreviewCue = createMemo(() => {
    const cueUid = activePreviewCueUid();
    return cueUid ? source.cueMap()[cueUid] : undefined;
  });

  const activePreviewPlayback = createMemo(() => {
    const instanceId = activePreviewInstanceId();
    if (!instanceId) return undefined;
    const normalizedInstanceId = normalizeFixtureUid(instanceId).toLowerCase();
    return Object.values(activeInstancesStore()).find(
      (playback) =>
        normalizeFixtureUid(playback.instance_id).toLowerCase() ===
        normalizedInstanceId,
    );
  });

  /** Reconciles local preview state with backend playback lifecycle updates. */
  createEffect(() => {
    const playback = activePreviewPlayback();
    const pending = previewPending();
    if (playback) {
      const activeCueUid = activeCueUidFromPreviewInstance(playback);
      if (
        pending &&
        activeCueUid !== normalizePreviewCueUid(activePreviewCueUid())
      ) {
        return;
      }
      setPreviewPlaybackSeen(true);
      if (pending) setPreviewPending(false);
      if (activeCueUid) setActivePreviewCueUid(activeCueUid);
      return;
    }
    if (!previewSessionActive()) return;
    if (pending && !previewPlaybackSeen()) return;
    setPreviewEnabledSignal(false);
    clearPreviewState();
  });

  /** Builds the configured backend preview payload for one cue. */
  const toPreviewPayload = (
    cue: types.Cue,
    applyTransitions = previewApplyTransitions(),
  ) => {
    const sequence = source.sequence();
    if (!sequence) return undefined;
    return buildSequencePreviewPayload(sequence, source.cueMap(), cue, {
      applyTransitions,
      trackValues: previewTrackValues(),
    });
  };

  /** Sends or queues a preview payload while preserving one instance session. */
  const publishPayload = (
    cue: types.Cue,
    payload: types.SequencePreview,
    startedAtMs: number | undefined,
  ) => {
    setActivePreviewCueUid(cue.identifiers.uid);
    setPreviewPlaybackSeen(false);
    setPreviewPending(true);
    setPreviewStartedAtMs(startedAtMs);
    setPreviewSessionActive(true);
    const instanceId = activePreviewInstanceId();
    if (!instanceId && previewStartInFlight) {
      queuedPreviewPayload = payload;
      return;
    }

    const token = previewLifecycleToken;
    previewStartInFlight = instanceId ? previewStartInFlight : true;
    previewSequence(payload, instanceId)
      .then((returnedInstanceId) => {
        if (!instanceId) previewStartInFlight = false;
        if (token !== previewLifecycleToken) {
          void stopPreviewInstance(returnedInstanceId);
          return;
        }
        setActivePreviewInstanceId(returnedInstanceId);
        const queuedPayload = queuedPreviewPayload;
        queuedPreviewPayload = undefined;
        if (queuedPayload) {
          previewSequence(queuedPayload, returnedInstanceId).catch((error) => {
            log.error("Failed to update queued sequence preview", error);
          });
        }
      })
      .catch((error) => {
        if (!instanceId) previewStartInFlight = false;
        if (token !== previewLifecycleToken) return;
        log.error("Failed to update sequence preview", error);
        clearPreviewState();
        setPreviewEnabledSignal(false);
      });
  };

  /** Publishes a cue using the editor's transition preview preference. */
  const publishPreviewCue = (cue: types.Cue) => {
    const payload = toPreviewPayload(cue);
    if (payload) publishPayload(cue, payload, performance.now());
  };

  /** Publishes a cue with transitions terminated immediately. */
  const publishImmediatePreviewCue = (cue: types.Cue) => {
    const payload = toPreviewPayload(cue, false);
    if (payload) publishPayload(cue, payload, undefined);
  };

  /** Returns previewable rows, excluding setup and release cues. */
  const previewRows = () =>
    source
      .cueRows()
      .filter((row) => row.cue && !row.isSetupCue && !row.isReleaseCue);

  /** Selects and publishes one previewable cue row. */
  const publishPreviewRow = (row: SequenceCueRow | undefined) => {
    if (!row?.cue) return;
    setPreviewEnabledSignal(true);
    source.setSelectedCueUid(row.cueUid);
    publishPreviewCue(row.cue);
  };

  /** Returns the active or selected cue's index among preview rows. */
  const selectedPreviewRowIndex = () => {
    const cueUid = activePreviewCueUid() ?? source.selectedCueUid();
    return cueUid
      ? previewRows().findIndex((row) => row.cueUid === cueUid)
      : -1;
  };

  /** Advances preview to the next cue, respecting sequence wrap. */
  const previewGo = () => {
    const rows = previewRows();
    if (rows.length === 0) return;
    const currentIndex = selectedPreviewRowIndex();
    if (currentIndex < 0) return publishPreviewRow(rows[0]);
    const nextIndex = currentIndex + 1;
    publishPreviewRow(
      nextIndex < rows.length
        ? rows[nextIndex]
        : source.sequence()?.wrap
          ? rows[0]
          : rows[currentIndex],
    );
  };

  /** Moves preview to the previous cue, respecting sequence wrap. */
  const previewBack = () => {
    const rows = previewRows();
    if (rows.length === 0) return;
    const currentIndex = selectedPreviewRowIndex();
    if (currentIndex < 0) return publishPreviewRow(rows[0]);
    const previousIndex = currentIndex - 1;
    publishPreviewRow(
      previousIndex >= 0
        ? rows[previousIndex]
        : source.sequence()?.wrap
          ? rows[rows.length - 1]
          : rows[0],
    );
  };

  /** Replays the active, selected, or first available preview cue. */
  const previewReplayActiveCue = () => {
    const selectedCue = previewRows().find(
      (row) => row.cueUid === source.selectedCueUid(),
    )?.cue;
    const cue = activePreviewCue() ?? selectedCue ?? previewRows()[0]?.cue;
    if (!cue) return;
    setPreviewEnabledSignal(true);
    source.setSelectedCueUid(cue.identifiers.uid);
    publishPreviewCue(cue);
  };

  /** Republishes the active cue without transition durations. */
  const previewTerminateTransitions = () => {
    const cue = previewEnabled() ? activePreviewCue() : undefined;
    if (cue) publishImmediatePreviewCue(cue);
  };

  /** Jumps preview to the selected or first available cue. */
  const previewJumpToSelectedCue = () => {
    const cue =
      previewRows().find((row) => row.cueUid === source.selectedCueUid())
        ?.cue ?? previewRows()[0]?.cue;
    if (!cue) return;
    setPreviewEnabledSignal(true);
    source.setSelectedCueUid(cue.identifiers.uid);
    publishPreviewCue(cue);
  };

  /** Enables preview or stops the active session when disabled. */
  const setPreviewEnabled = (enabled: boolean) => {
    setPreviewEnabledSignal(enabled);
    if (!enabled) stopPreviewSession();
  };

  /** Republishes preview when cue or preview preferences change. */
  createEffect(() => {
    const enabled = previewEnabled();
    const cue =
      activePreviewCue() ??
      previewRows().find((row) => row.cueUid === source.selectedCueUid())
        ?.cue ??
      previewRows()[0]?.cue;
    previewApplyTransitions();
    previewTrackValues();
    if (!enabled || !cue) {
      if (
        previewSessionActive() ||
        previewPending() ||
        activePreviewCueUid() !== undefined
      ) {
        stopPreviewSession();
      }
      return;
    }
    publishPreviewCue(cue);
  });

  onCleanup(stopPreviewSession);

  return {
    previewEnabled,
    setPreviewEnabled,
    previewApplyTransitions,
    setPreviewApplyTransitions,
    previewTrackValues,
    setPreviewTrackValues,
    previewStartedAtMs,
    activePreviewCueUid,
    activePreviewPlayback,
    publishPreviewCue,
    stopPreviewSession,
    previewGo,
    previewBack,
    previewReplayActiveCue,
    previewTerminateTransitions,
    previewJumpToSelectedCue,
  };
}

export type SequenceEditorPreviewController = ReturnType<
  typeof createSequenceEditorPreviewController
>;
