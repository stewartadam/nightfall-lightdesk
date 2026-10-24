// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { type Accessor, createMemo } from "solid-js";
import { formatShortcutHint } from "../../ui/kbd-keys";
import { $uiActionCatalog } from "./ui-action-registry";

/**
 * Tracks the menu hint for a UI action's primary shortcut, such as `⇧?` on macOS.
 *
 * Menus that offer an action also bound to a key read the hint from the action's own
 * registration, so the label always shows the key that actually runs it. Resolves to
 * undefined while the action is unregistered or has no shortcut.
 */
export function useUiActionShortcutHint(
  actionId: string,
): Accessor<string | undefined> {
  const catalog = useStore($uiActionCatalog);
  /** Formats the shortcut of the catalog entry for `actionId`, if any. */
  return createMemo(() => {
    const shortcut = catalog().find(
      (descriptor) => descriptor.id === actionId,
    )?.shortcut;
    return shortcut ? formatShortcutHint(shortcut) : undefined;
  });
}
