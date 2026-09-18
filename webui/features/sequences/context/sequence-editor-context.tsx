// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createContext,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { getLogger } from "../../../lib/logger";
import { createSequenceEditorMutationController } from "../controllers/sequence-editor-mutation-controller";
import { createSequenceEditorPreviewController } from "../controllers/sequence-editor-preview-controller";
import { createSequenceEditorSourceController } from "../controllers/sequence-editor-source-controller";
import type { SequenceEditorContextType } from "./sequence-editor-context-contract";

export type { SequenceEditorContextType } from "./sequence-editor-context-contract";

const log = getLogger(import.meta.url);
const SequenceEditorContext = createContext<SequenceEditorContextType>();

/** Composes source, preview, and mutation controllers for one sequence editor. */
export function createSequenceEditorContextValue(
  sequenceUid: string,
): SequenceEditorContextType {
  log.trace("creating SequenceEditorContextValue", sequenceUid);
  const source = createSequenceEditorSourceController(sequenceUid);
  const preview = createSequenceEditorPreviewController(source);
  const mutations = createSequenceEditorMutationController(source, preview);

  return {
    sequenceUid,
    loadingState: source.loadingState,
    sequence: source.sequence,
    cueRows: source.cueRows,
    selectedCueUid: source.selectedCueUid,
    selectedCue: source.selectedCue,
    selectCue: source.selectCue,
    activePreviewCueUid: preview.activePreviewCueUid,
    activePreviewPlayback: preview.activePreviewPlayback,
    label: source.label,
    previewEnabled: preview.previewEnabled,
    setPreviewEnabled: preview.setPreviewEnabled,
    previewApplyTransitions: preview.previewApplyTransitions,
    setPreviewApplyTransitions: preview.setPreviewApplyTransitions,
    previewTrackValues: preview.previewTrackValues,
    setPreviewTrackValues: preview.setPreviewTrackValues,
    previewStartedAtMs: preview.previewStartedAtMs,
    previewGo: preview.previewGo,
    previewBack: preview.previewBack,
    previewReplayActiveCue: preview.previewReplayActiveCue,
    previewTerminateTransitions: preview.previewTerminateTransitions,
    previewJumpToSelectedCue: preview.previewJumpToSelectedCue,
    updateCue: mutations.updateCue,
    updateSelectedCue: mutations.updateSelectedCue,
    updateSequence: mutations.updateSequence,
    reorderCues: mutations.reorderCues,
    reorderCueRows: mutations.reorderCueRows,
    duplicateSelectedCue: mutations.duplicateSelectedCue,
    deleteSelectedCue: mutations.deleteSelectedCue,
    deleteCueRows: mutations.deleteCueRows,
  };
}

export type SequenceEditorContextProviderProps = ParentProps<
  { value: SequenceEditorContextType } | { sequenceUid: string }
>;

/** Provides either an injected or locally composed sequence editor context. */
export function SequenceEditorContextProvider(
  props: SequenceEditorContextProviderProps,
) {
  log.trace("mounting SequenceEditorContextProvider");
  onCleanup(() => log.trace("unmounting SequenceEditorContextProvider"));
  const contextValue =
    "value" in props
      ? props.value
      : createSequenceEditorContextValue(props.sequenceUid);
  return (
    <SequenceEditorContext.Provider value={contextValue}>
      {props.children}
    </SequenceEditorContext.Provider>
  );
}

/** Returns the sequence editor context scoped to the nearest provider. */
export function useSequenceEditorContext(): SequenceEditorContextType {
  const context = useContext(SequenceEditorContext);
  if (!context) {
    throw new Error(
      "useSequenceEditorContext must be used within SequenceEditorContextProvider",
    );
  }
  return context;
}
