// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor } from "solid-js";
import type * as types from "../../../types";

export type SequenceEditorLoadingState =
  | { status: "loading" }
  | { status: "loaded"; sequence: types.Sequence }
  | { status: "not_found"; sequenceUid: string };

export interface SequenceCueRow {
  index: number;
  cueUid: string;
  cue?: types.Cue;
  isMissing: boolean;
  isSetupCue?: boolean;
  isReleaseCue?: boolean;
}

export interface SequenceEditorContextType {
  sequenceUid: string;
  loadingState: Accessor<SequenceEditorLoadingState>;
  sequence: Accessor<types.Sequence | undefined>;
  cueRows: Accessor<SequenceCueRow[]>;
  selectedCueUid: Accessor<string | undefined>;
  selectedCue: Accessor<types.Cue | undefined>;
  selectCue: (cueUid: string | undefined) => void;
  activePreviewCueUid: Accessor<string | undefined>;
  activePreviewPlayback: Accessor<types.InstanceInfo | undefined>;
  label: Accessor<string>;
  previewEnabled: Accessor<boolean>;
  setPreviewEnabled: (enabled: boolean) => void;
  previewApplyTransitions: Accessor<boolean>;
  setPreviewApplyTransitions: (enabled: boolean) => void;
  previewTrackValues: Accessor<boolean>;
  setPreviewTrackValues: (enabled: boolean) => void;
  previewStartedAtMs: Accessor<number | undefined>;
  previewGo: () => void;
  previewBack: () => void;
  previewReplayActiveCue: () => void;
  previewTerminateTransitions: () => void;
  previewJumpToSelectedCue: () => void;
  updateCue: (cue: types.Cue, batchId?: string) => void;
  updateSelectedCue: (updater: (cue: types.Cue) => types.Cue) => void;
  updateSequence: (sequence: types.Sequence, batchId?: string) => void;
  reorderCues: (fromIndex: number, toIndex: number) => void;
  reorderCueRows: (rowIndices: number[], offset: -1 | 1) => void;
  duplicateSelectedCue: () => void;
  deleteSelectedCue: () => void;
  deleteCueRows: (rowIndices: number[]) => void;
}
