// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import { setStoreAction } from "../lib/nanostore-action";
import { isTauriRuntime } from "../lib/tauri";
import type * as types from "../types";
import { pushToast } from "./notifications";

/** Whether the backend's most recent save of the open show's draft failed. */
export const $draftSaveStatus = atom<types.DraftSaveStatus>({});

/** Closes the warning shown while draft saves fail, when one is up. */
let closeDraftSaveWarning: (() => void) | null = null;

/**
 * Applies the backend's draft save status. While saves fail, a warning stays up until the
 * operator dismisses it or a save works again. It is raised when saves start failing, including
 * for a client that connects while they already fail, and replaced when the reason changes.
 */
export function applyDraftSaveStatusSnapshot(
  status: types.DraftSaveStatus,
): void {
  const previousError = $draftSaveStatus.get().error ?? null;
  setStoreAction($draftSaveStatus, "Receive DraftSaveStatus", status);
  if (status.error != null && status.error !== previousError) {
    closeDraftSaveWarning?.();
    closeDraftSaveWarning = pushToast(
      "error",
      `Recent edits are not backed up: ${status.error}`,
      -1,
      [],
      { title: "Couldn't save the show's draft" },
    );
  } else if (status.error == null && closeDraftSaveWarning) {
    closeDraftSaveWarning();
    closeDraftSaveWarning = null;
  }
}

/**
 * Asks the browser to confirm leaving the page while the last draft save failed, since the
 * edits made since the last good save exist only in the running backend.
 */
function confirmLeavingWithUnsavedDraft(event: BeforeUnloadEvent): void {
  if ($draftSaveStatus.get().error == null) return;
  event.preventDefault();
  // Older browsers only show the prompt when a return value is set.
  event.returnValue = "";
}

/**
 * Installs the leave-page confirmation for failed draft saves once for the page. The desktop
 * app confirms natively before quitting instead, since closing its window stops the backend.
 */
export function installDraftSaveCloseGuard(): void {
  if (isTauriRuntime()) return;
  window.addEventListener("beforeunload", confirmLeavingWithUnsavedDraft);
}
