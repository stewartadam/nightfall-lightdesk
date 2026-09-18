// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Returns whether the disconnected overlay should intercept a keyboard event. */
export function shouldBlockDisconnectedOverlayKey(
  event: KeyboardEvent,
  hasMatchingAppShortcut: (event: KeyboardEvent) => boolean = () => false,
): boolean {
  if (/^F\d{1,2}$/.test(event.key)) {
    return false;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) {
    return hasMatchingAppShortcut(event);
  }

  return true;
}
