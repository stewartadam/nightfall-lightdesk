// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { sendCueUpdate, sendSequenceUpdate } from "../../../lib/cue-service";
import type * as types from "../../../types";
import { SequenceReorderRenumberPolicy } from "../../../types";
import {
  moveSequenceStepsByRows,
  reorderSequenceSteps,
} from "../model/sequence-step-reorder";
import type { SequenceEditorPreviewController } from "./sequence-editor-preview-controller";
import type { SequenceEditorSourceController } from "./sequence-editor-source-controller";

/** Coordinates cue and sequence mutations initiated by one sequence editor. */
export function createSequenceEditorMutationController(
  source: SequenceEditorSourceController,
  preview: SequenceEditorPreviewController,
) {
  /** Sends an updated sequence with optional undo-batch identity. */
  const updateSequence = (sequence: types.Sequence, batchId?: string) => {
    sendSequenceUpdate(sequence, batchId);
  };

  /** Sends a cue update, routing setup and release cues through the sequence. */
  const updateCue = (cue: types.Cue, batchId?: string) => {
    const sequence = source.sequence();
    if (sequence?.setup_cue.identifiers.uid === cue.identifiers.uid) {
      updateSequence({ ...sequence, setup_cue: cue }, batchId);
      return;
    }
    if (sequence?.release_cue.identifiers.uid === cue.identifiers.uid) {
      updateSequence({ ...sequence, release_cue: cue }, batchId);
      return;
    }
    sendCueUpdate(cue, batchId);
    if (
      preview.previewEnabled() &&
      preview.activePreviewCueUid() === cue.identifiers.uid
    ) {
      preview.publishPreviewCue(cue);
    }
  };

  /** Clones and updates the currently selected cue. */
  const updateSelectedCue = (updater: (cue: types.Cue) => types.Cue) => {
    const cue = source.selectedCue();
    if (!cue) return;
    updateCue(updater(JSON.parse(JSON.stringify(cue))));
  };

  /** Resolves whether the configured reorder policy requires cue renumbering. */
  const shouldRenumberAfterReorder = (
    policy: types.SequenceReorderRenumberPolicy,
  ) => {
    if (policy === "AutoRenumber") return true;
    if (policy !== "Prompt") return false;
    return (
      globalThis.confirm?.("Renumber cue IDs to match the new row order?") ??
      false
    );
  };

  /** Persists a changed step order and applies the configured renumber policy. */
  const applyReorderedSteps = (nextSteps: string[]) => {
    const sequence = source.sequence();
    if (!sequence) return;
    if (
      nextSteps.length === sequence.steps.length &&
      nextSteps.every((cueUid, index) => cueUid === sequence.steps[index])
    ) {
      return;
    }
    const updatedSequence = { ...sequence, steps: nextSteps };
    const policy =
      source.settings().sequence_reorder_renumber_policy ??
      SequenceReorderRenumberPolicy.Preserve;
    if (shouldRenumberAfterReorder(policy)) {
      for (const [index, cueUid] of nextSteps.entries()) {
        const cue = source.cueMap()[cueUid];
        const nextCueId = index + 1;
        if (!cue || cue.identifiers.id === nextCueId) continue;
        sendCueUpdate({
          ...cue,
          identifiers: { ...cue.identifiers, id: nextCueId },
        });
      }
    }
    updateSequence(updatedSequence);
  };

  /** Moves one cue to another row. */
  const reorderCues = (fromIndex: number, toIndex: number) => {
    const sequence = source.sequence();
    if (sequence) {
      applyReorderedSteps(
        reorderSequenceSteps(sequence.steps, fromIndex, toIndex),
      );
    }
  };

  /** Moves selected cue rows one position up or down. */
  const reorderCueRows = (rowIndices: number[], offset: -1 | 1) => {
    const sequence = source.sequence();
    if (sequence) {
      applyReorderedSteps(
        moveSequenceStepsByRows(sequence.steps, rowIndices, offset),
      );
    }
  };

  /** Duplicates the selected step cue and inserts the copy after its source. */
  const duplicateSelectedCue = () => {
    const cue = source.selectedCue();
    const sequence = source.sequence();
    if (!cue || !sequence) return;
    const currentIndex = sequence.steps.indexOf(cue.identifiers.uid);
    if (currentIndex < 0) return;
    const maxCueId = Object.values(source.cueMap()).reduce(
      (max, current) => Math.max(max, current.identifiers.id),
      0,
    );
    const nextCueId = maxCueId + 1;
    const copiedCue: types.Cue = JSON.parse(JSON.stringify(cue));
    const copiedCueUid = crypto.randomUUID().replace(/-/g, "");
    copiedCue.identifiers = {
      ...copiedCue.identifiers,
      id: nextCueId,
      uid: copiedCueUid,
      label: copiedCue.identifiers.label
        ? `${copiedCue.identifiers.label} Copy`
        : `Cue ${nextCueId}`,
    };
    sendCueUpdate(copiedCue);
    const nextSteps = [...sequence.steps];
    nextSteps.splice(currentIndex + 1, 0, copiedCueUid);
    updateSequence({ ...sequence, steps: nextSteps });
    source.setSelectedCueUid(copiedCueUid);
  };

  /** Deletes step rows, updates selection, and advances an active preview. */
  const deleteCueRows = (rowIndices: number[]) => {
    const sequence = source.sequence();
    if (!sequence) return;
    const deleteIndices = new Set(
      rowIndices.filter(
        (rowIndex) => rowIndex >= 0 && rowIndex < sequence.steps.length,
      ),
    );
    if (deleteIndices.size === 0) return;
    const firstDeletedIndex = Math.min(...deleteIndices);
    const deletedCueUids = new Set(
      [...deleteIndices]
        .map((rowIndex) => sequence.steps[rowIndex])
        .filter((cueUid): cueUid is string => cueUid !== undefined),
    );
    if (deletedCueUids.size === 0) return;
    const activePreviewCueUid = preview.activePreviewCueUid();
    const deletingActivePreviewCue =
      activePreviewCueUid !== undefined &&
      deletedCueUids.has(activePreviewCueUid);
    const nextSteps = sequence.steps.filter(
      (_, rowIndex) => !deleteIndices.has(rowIndex),
    );
    updateSequence({ ...sequence, steps: nextSteps });
    const nextSelectedUid =
      nextSteps[firstDeletedIndex] ??
      nextSteps[Math.max(0, firstDeletedIndex - 1)];
    source.setSelectedCueUid(nextSelectedUid);
    if (!preview.previewEnabled() || !deletingActivePreviewCue) return;
    if (!nextSelectedUid) {
      preview.stopPreviewSession();
      return;
    }
    const nextCue = source.cueMap()[nextSelectedUid];
    if (nextCue) preview.publishPreviewCue(nextCue);
  };

  /** Deletes the currently selected step cue. */
  const deleteSelectedCue = () => {
    const cue = source.selectedCue();
    const sequence = source.sequence();
    if (!cue || !sequence) return;
    const currentIndex = sequence.steps.indexOf(cue.identifiers.uid);
    if (currentIndex >= 0) deleteCueRows([currentIndex]);
  };

  return {
    updateCue,
    updateSelectedCue,
    updateSequence,
    reorderCues,
    reorderCueRows,
    duplicateSelectedCue,
    deleteSelectedCue,
    deleteCueRows,
  };
}
