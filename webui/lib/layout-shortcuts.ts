// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isLayoutShortcutSlot } from "./layoutStorage";
import { isTauriRuntime } from "./tauri";

/** Selects desktop number keys or browser function keys for a layout slot. */
export function layoutSlotShortcut(
  slot: number | undefined,
): string | undefined {
  if (!isLayoutShortcutSlot(slot)) return undefined;
  return isTauriRuntime() ? `$mod+${slot % 10}` : `F${slot}`;
}
