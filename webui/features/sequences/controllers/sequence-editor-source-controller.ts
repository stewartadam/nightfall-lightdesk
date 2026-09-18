// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal } from "solid-js";
import { useShallowStore } from "../../../lib/use-shallow-store";
import {
  cues,
  sequenceDefinitionsLoaded,
  sequences,
} from "../../../state/appStores";
import { $settings } from "../../../state/settings";
import type * as types from "../../../types";
import type {
  SequenceCueRow,
  SequenceEditorLoadingState,
} from "../context/sequence-editor-context-contract";

/** Projects sequence, cue-row, label, and selection state for one editor. */
export function createSequenceEditorSourceController(sequenceUid: string) {
  const cueMap = useShallowStore(cues);
  const sequenceMap = useShallowStore(sequences);
  const definitionsLoaded = useStore(sequenceDefinitionsLoaded);
  const settings = useStore($settings);
  const [selectedCueUid, setSelectedCueUid] = createSignal<string>();

  const loadingState = createMemo((): SequenceEditorLoadingState => {
    if (!definitionsLoaded()) return { status: "loading" };
    const sequence = sequenceMap()[sequenceUid];
    return sequence
      ? { status: "loaded", sequence }
      : { status: "not_found", sequenceUid };
  });

  const sequence = createMemo(() => {
    const state = loadingState();
    return state.status === "loaded" ? state.sequence : undefined;
  });

  const cueRows = createMemo(() => {
    const currentSequence = sequence();
    if (!currentSequence) return [];
    const stepRows: SequenceCueRow[] = currentSequence.steps.map(
      (cueUid, index) => {
        const cue = cueMap()[cueUid];
        return {
          index,
          cueUid,
          cue,
          isMissing: cue === undefined,
        } satisfies SequenceCueRow;
      },
    );
    return [
      {
        index: -1,
        cueUid: currentSequence.setup_cue.identifiers.uid,
        cue: currentSequence.setup_cue,
        isMissing: false,
        isSetupCue: true,
      } satisfies SequenceCueRow,
      ...stepRows,
      {
        index: currentSequence.steps.length,
        cueUid: currentSequence.release_cue.identifiers.uid,
        cue: currentSequence.release_cue,
        isMissing: false,
        isReleaseCue: true,
      } satisfies SequenceCueRow,
    ];
  });

  const selectedCue = createMemo<types.Cue | undefined>(() => {
    const cueUid = selectedCueUid();
    if (!cueUid) return undefined;
    const currentSequence = sequence();
    if (currentSequence?.setup_cue.identifiers.uid === cueUid) {
      return currentSequence.setup_cue;
    }
    if (currentSequence?.release_cue.identifiers.uid === cueUid) {
      return currentSequence.release_cue;
    }
    return cueMap()[cueUid];
  });

  const label = createMemo(() => {
    const state = loadingState();
    if (state.status === "loading") return "Sequence Loading...";
    if (state.status === "not_found") return "Sequence Not Found";
    const sequenceLabel = state.sequence.identifiers.label.trim();
    return sequenceLabel
      ? `Sequence ${state.sequence.identifiers.id}: ${sequenceLabel}`
      : `Sequence ${state.sequence.identifiers.id}`;
  });

  /** Selects a cue or clears the editor selection. */
  const selectCue = (cueUid: string | undefined) => setSelectedCueUid(cueUid);

  /** Keeps selection on the first available cue after source changes. */
  createEffect(() => {
    const rows = cueRows();
    const current = selectedCueUid();
    if (
      current &&
      rows.some((row) => row.cueUid === current && !row.isMissing)
    ) {
      return;
    }
    const firstUsableRow =
      rows.find(
        (row) => !row.isMissing && !row.isSetupCue && !row.isReleaseCue,
      ) ?? rows.find((row) => !row.isMissing);
    setSelectedCueUid(firstUsableRow?.cueUid);
  });

  return {
    sequenceUid,
    cueMap,
    settings,
    loadingState,
    sequence,
    cueRows,
    selectedCueUid,
    setSelectedCueUid,
    selectedCue,
    selectCue,
    label,
  };
}

export type SequenceEditorSourceController = ReturnType<
  typeof createSequenceEditorSourceController
>;
