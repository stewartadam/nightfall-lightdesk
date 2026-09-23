// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Match, Switch } from "solid-js";

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
