// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useKeyboardShortcut } from "../../../../lib/keyboardShortcuts";
import {
  OPEN_COMMAND_PALETTE_SHORTCUT,
  useCommandPalette,
} from "../../../providers/command-registry";

/** Registers global shortcuts that open the command palette from app surfaces. */
function OpenCommandPalette() {
  const { showPalette } = useCommandPalette();

  for (const shortcut of [OPEN_COMMAND_PALETTE_SHORTCUT]) {
    useKeyboardShortcut(
      {
        key: shortcut,
        handler: (e?: KeyboardEvent) => {
          if (e) e.preventDefault();
          showPalette();
        },
        description: "Open command palette",
      },
      { global: true, allowInEditable: true, capture: true },
    );
  }

  // This component doesn't render anything
  return null;
}

export default OpenCommandPalette;
