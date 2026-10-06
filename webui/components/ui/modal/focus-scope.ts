// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Settles focus in a dialog the browser just showed. `showModal()` focuses
 * the first focusable control, which in our dialogs is usually the header
 * close button, so Enter would close the dialog instead of running its default
 * action. Focus goes instead to a field that focused itself while the dialog
 * rendered (`keep`), else an `autofocus` element, else the dialog itself.
 */
export function focusDialogOnOpen(
  dialog: HTMLDialogElement,
  keep: HTMLElement | undefined,
): void {
  const target =
    keep ?? dialog.querySelector<HTMLElement>("[autofocus]") ?? dialog;
  target.focus({ preventScroll: true });
}
