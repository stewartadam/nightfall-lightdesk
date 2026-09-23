// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, For, type JSX } from "solid-js";
import {
  allShortcuts,
  type KeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { useAppShell } from "../../providers/app-shell";
import { Dialog, DialogBody } from "../../ui/dialog";
import { ShortcutKeys } from "../../ui/shortcut-keys";

export { ShortcutKeys } from "../../ui/shortcut-keys";

/**
 * Component that displays all registered keyboard shortcuts in a popup
 * with multiple columns
 */
export default function ShortcutsPopup() {
  const { dockviewApi, isShortcutsPopupVisible, hideShortcutsPopup } =
    useAppShell();

  /** Memoize organized shortcuts to avoid recalculations on each render */
  const organizedShortcuts = createMemo(() => {
    const currentShortcuts = allShortcuts();
    const groups: Record<string, KeyboardShortcut[]> = {};

    for (const shortcut of currentShortcuts) {
      const groupKey = shortcut.group || shortcut.componentId || "Global";
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(shortcut);
    }

    // Sort each group by key
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) =>
        a.key.localeCompare(b.key, undefined, { numeric: true }),
      );
    }

    // Ensure Global comes first
    const orderedGroups: [string, KeyboardShortcut[]][] = [];

    if (groups.Global) {
      orderedGroups.push(["Global", groups.Global]);
    }

    // Add other panels in alphabetical order
    for (const entry of Object.entries(groups)
      .filter(([key]) => key !== "Global")
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))) {
      orderedGroups.push(entry);
    }

    return orderedGroups;
  });

  /** Resolve a human-friendly display name for a group key (panel id or component id) */
  const getDisplayName = (groupKey: string): string => {
    if (groupKey === "Global") return "Global";

    // Try to resolve via the dockview API (panels store titles there)
    try {
      const panel = dockviewApi()?.getPanel(groupKey as any);
      if (panel?.title) return panel.title as string;
    } catch (_e) {
      // ignore - getPanel may throw if id is not a panel id
    }

    // Final fallback to the raw group key
    return groupKey;
  };

  return (
    <Dialog
      kind="info"
      isOpen={isShortcutsPopupVisible()}
      title="Keyboard Shortcuts"
      onDismiss={hideShortcutsPopup}
      class="max-w-4xl"
      style={{ "max-height": "80vh" }}
      backdropProps={
        {
          "data-dialog-kind": "shortcuts",
        } as JSX.DialogHtmlAttributes<HTMLDialogElement>
      }
    >
      <DialogBody role="region" aria-label="Keyboard shortcuts">
        <div class="columns-1 md:columns-2 lg:columns-3 gap-8">
          <For each={organizedShortcuts()}>
            {([panelName, panelShortcuts]) => (
              <div class="mb-8 break-inside-avoid">
                <h3 class="text-sm font-semibold text-white mb-2 pb-1 border-b border-gray-600">
                  {getDisplayName(panelName)}
                </h3>
                <div class="space-y-2">
                  <For each={panelShortcuts}>
                    {(shortcut) => (
                      <div class="flex items-center text-sm gap-2">
                        <ShortcutKeys shortcut={shortcut.key} />
                        <span class="text-gray-300">
                          {shortcut.description}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="mt-4 text-xs text-gray-500 text-center flex items-center justify-center gap-1">
          Press <ShortcutKeys shortcut="Esc" /> to close
        </div>
      </DialogBody>
    </Dialog>
  );
}
