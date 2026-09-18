// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type AvailableShowfile,
  hasSavedShowfileRevision,
  modifiedTimeMs,
} from "../features/showfile/model/showfile-discovery";
import { normalizedShowfileName } from "./showfile-loading";

export type StartupDraftRecovery = {
  showfileName: string;
  hasSavedSnapshot: boolean;
  hasDraft: boolean;
  modifiedMs?: number | null;
  savedModifiedMs?: number | null;
};

/** Selects the last-used showfile when a saved snapshot or recoverable draft exists. */
export function selectStartupDraftRecovery(
  showfiles: AvailableShowfile[],
  expectedShowfileName: string,
): StartupDraftRecovery | null {
  const showfile = showfiles.find(
    (showfile) =>
      normalizedShowfileName(showfile.name) === expectedShowfileName,
  );
  if (!showfile) return null;

  const hasSavedSnapshot = hasSavedShowfileRevision(showfile);
  const hasDraft = showfile.draft != null;
  if (!hasSavedSnapshot && !hasDraft) return null;

  return {
    showfileName: showfile.name,
    hasSavedSnapshot,
    hasDraft,
    modifiedMs: showfile.draft ? modifiedTimeMs(showfile.draft) : null,
    savedModifiedMs: modifiedTimeMs(showfile),
  };
}
