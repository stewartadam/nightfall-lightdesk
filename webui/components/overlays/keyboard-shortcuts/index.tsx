// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createMemo,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  allShortcuts,
  type KeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { useAppShell } from "../../providers/app-shell";
import { ScrollArea } from "../../ui/scroll-area";

const log = getLogger(import.meta.url);

// Detect if running on macOS
const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/** Base CSS classes for kbd elements following Preline styling */
const kbdClasses =
  "min-h-7 min-w-7 inline-flex justify-center items-center py-1 px-1.5 bg-neutral-800 border border-neutral-600 font-mono text-sm text-neutral-200 rounded-md";

/** SVG icon classes */
const iconClasses = "shrink-0 size-3";

/** Command key icon (⌘) */
function CommandIcon() {
  return (
    <svg
      class={iconClasses}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
    </svg>
  );
}

/** Option/Alt key icon (⌥) */
function OptionIcon() {
  return (
    <svg
      class={iconClasses}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 3h6l6 18h6" />
      <path d="M14 3h7" />
    </svg>
  );
}

/** Shift key icon (⇧) */
function ShiftIcon() {
  return (
    <svg
      class={`${iconClasses} size-4`}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9 18v-6H5l7-7 7 7h-4v6H9z" />
    </svg>
  );
}

/** Control key icon (^) */
function ControlIcon() {
  return (
    <svg
      class={`${iconClasses} size-4`}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

/**
 * Renders a single keyboard key with appropriate styling.
 * Modifier keys are rendered as icons, regular keys as text.
 */
function KeyboardKey(props: { keyName: string }) {
  return (
    <Switch fallback={<kbd class={kbdClasses}>{props.keyName}</kbd>}>
      <Match when={props.keyName === "$mod"}>
        <kbd class={kbdClasses} title={isMac ? "Command" : "Ctrl"}>
          {isMac ? <CommandIcon /> : <ControlIcon />}
        </kbd>
      </Match>
      <Match when={props.keyName === "Shift"}>
        <kbd class={kbdClasses} title="Shift">
          <ShiftIcon />
        </kbd>
      </Match>
      <Match when={props.keyName === "Alt"}>
        <kbd class={kbdClasses} title={isMac ? "Option" : "Alt"}>
          {isMac ? <OptionIcon /> : <span>Alt</span>}
        </kbd>
      </Match>
      <Match when={props.keyName === "Control"}>
        <kbd class={kbdClasses} title="Control">
          <ControlIcon />
        </kbd>
      </Match>
    </Switch>
  );
}

/**
 * Parses a shortcut key string and renders it as styled kbd elements.
 * Handles modifiers like $mod, Shift, Alt, Control and displays them with icons.
 */
export function ShortcutKeys(props: { shortcut: string }) {
  const keys = () => props.shortcut.split("+");

  return (
    <span class="flex shrink-0 flex-nowrap items-center gap-x-1 whitespace-nowrap">
      <For each={keys()}>{(key) => <KeyboardKey keyName={key} />}</For>
    </span>
  );
}

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

  /**
   * Handle Escape key press to close the shortcuts popup
   *
   * This direct event handler only processes the Escape key when the popup is visible.
   * All other keyboard shortcuts are managed through the centralized shortcuts system.
   *
   * @param e - The keyboard event
   */
  const handleKeyDown = (e: KeyboardEvent) => {
    // Only handle escape key, let the keyboard shortcuts system handle others
    if (e.key === "Escape" && isShortcutsPopupVisible()) {
      e.preventDefault();
      e.stopPropagation();
      hideShortcutsPopup();
    }
  };

  /**
   * Direct DOM event handler for Escape key
   *
   * NOTE: This component uses a direct DOM event listener for the Escape key rather than
   * the keyboard shortcuts system for the following reasons:
   * 1. Escape is a high-priority key that should always close modal UI elements
   * 2. We need to ensure this takes precedence over other shortcuts
   *
   * For all other shortcuts (e.g., Shift+? to open), we use the centralized
   * keyboard shortcuts system.
   */
  onMount(() => {
    log.trace("mounting");

    // Register escape key handler with capture phase to ensure it runs before other handlers
    window.addEventListener("keydown", handleKeyDown, { capture: true });

    onCleanup(() => {
      log.trace("unmounting");
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    });
  });

  return (
    <Show when={isShortcutsPopupVisible()}>
      <Portal>
        {/** biome-ignore lint/a11y/useKeyWithClickEvents: this is a click-only interaction */}
        <div
          class="fixed inset-0 nightfall-top-layer bg-black bg-opacity-70 flex items-center justify-center"
          data-dialog-kind="shortcuts"
          onClick={hideShortcutsPopup}
        >
          <ScrollArea
            class="bg-[#252525] border border-gray-700 rounded-lg max-w-4xl max-h-[80vh]"
            viewportClass="p-6"
            viewportProps={{
              role: "region",
              "aria-label": "Keyboard shortcuts",
              tabIndex: 0,
              onClick: (event) => event.stopPropagation(),
            }}
          >
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-xl font-semibold text-white">
                Keyboard Shortcuts
              </h2>
              <button
                class="text-gray-400 hover:text-white"
                title="Close"
                onClick={hideShortcutsPopup}
              >
                ✕
              </button>
            </div>

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
              Press <kbd class={kbdClasses}>Esc</kbd> to close
            </div>
          </ScrollArea>
        </div>
      </Portal>
    </Show>
  );
}
