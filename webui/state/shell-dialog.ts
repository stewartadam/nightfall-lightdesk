// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";

/** Shares mutually exclusive shell dialogs across startup and interactive roots. */
export const activeShellDialog = atom<
  "settings" | "about" | "shortcuts" | "diagnostics" | null
>(null);

/** Opens diagnostics even when the interactive shell cannot initialize. */
export const openDiagnostics = () => activeShellDialog.set("diagnostics");

/** Closes diagnostics without dismissing another active shell dialog. */
export const closeDiagnostics = () => {
  if (activeShellDialog.get() === "diagnostics") activeShellDialog.set(null);
};
