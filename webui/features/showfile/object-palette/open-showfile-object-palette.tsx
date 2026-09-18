// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { useShowfileObjectPalette } from "./provider";

/** Registers the global shortcut that opens the showfile object palette. */
export default function OpenShowfileObjectPalette() {
  const { showPalette } = useShowfileObjectPalette();

  useKeyboardShortcut(
    {
      key: "$mod+p",
      handler: (event?: KeyboardEvent) => {
        event?.preventDefault();
        showPalette();
      },
      description: "Open showfile object palette",
    },
    { global: true, allowInEditable: true, capture: true },
  );

  return null;
}
