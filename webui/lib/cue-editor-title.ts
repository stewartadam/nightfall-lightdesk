// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface CueEditorTitleOptions {
  /** Cue ID to show in the editor title, when known. */
  cueId?: number;
  /** Sequence ID containing the cue, when known. */
  sequenceId?: number;
  /** Cue part ID for part-specific editor panels. */
  partId?: number;
  /** Whether the cue has additional parts, including when part 0 should be explicit. */
  hasAdditionalParts?: boolean;
  /** Whether the title describes a sequence setup cue. */
  isSetupCue?: boolean;
  /** Whether the title describes a sequence release cue. */
  isReleaseCue?: boolean;
}

/** Formats the operator-facing cue editor title for a cue or cue part. */
export function formatCueEditorTitle(options: CueEditorTitleOptions): string {
  const partId = options.partId ?? 0;
  const partSuffix =
    partId === 0 && !options.hasAdditionalParts ? "" : `p${partId}`;
  const cueNumber =
    options.sequenceId !== undefined && options.cueId !== undefined
      ? `${options.sequenceId}.${options.cueId}`
      : (options.cueId?.toString() ?? "");

  if (options.isSetupCue) {
    if (cueNumber) {
      return `Cue ${cueNumber}${partSuffix} (Setup)`;
    }
    return partSuffix ? `Setup Cue ${partSuffix}` : "Setup Cue";
  }
  if (options.isReleaseCue) {
    if (cueNumber) {
      return `Cue ${cueNumber}${partSuffix} (Release)`;
    }
    return partSuffix ? `Release Cue ${partSuffix}` : "Release Cue";
  }

  return `Cue ${cueNumber}${partSuffix}`;
}
