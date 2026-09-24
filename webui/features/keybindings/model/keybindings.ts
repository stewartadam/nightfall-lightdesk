// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import {
  executeUiAction,
  UI_ACTION_PREFIX,
  type UiActionExecutionContext,
} from "../../../components/providers/command-registry";
import { bestEffortPersistentAtom } from "../../../lib/best-effort-persistent-atom";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import type * as types from "../../../types";

const log = getLogger(import.meta.url);

/** One user keybinding: a key combination that invokes a UI or backend action. */
export interface Keybinding {
  /** Stable identity used to edit and remove the binding. */
  id: string;
  /** Key combination in keyboard shortcut syntax, such as `Control+Shift+KeyG`. */
  key: string;
  /** Action invoked when the combination is pressed. */
  action: types.ActionReference;
}

/** Parses stored keybindings, dropping malformed entries. */
function decodeKeybindings(value: string): Keybinding[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Keybinding =>
        typeof entry?.id === "string" &&
        typeof entry?.key === "string" &&
        typeof entry?.action?.id === "string",
    );
  } catch {
    return [];
  }
}

/** User keybindings persisted in this browser. */
export const $keybindings = bestEffortPersistentAtom<Keybinding[]>(
  "nightfall.keybindings",
  [],
  {
    decode: decodeKeybindings,
    encode: JSON.stringify,
    onSetError: (error) => log.warn("Could not persist keybindings", error),
  },
);

/**
 * Whether this client runs `ui.*` actions invoked by MIDI or OSC mappings.
 *
 * Each client decides locally so a secondary screen can ignore controller panel switching.
 */
export const $respondToControllerUiActions = bestEffortPersistentAtom<boolean>(
  "nightfall.respondToControllerUiActions",
  true,
  {
    decode: (value) => value !== "false",
    encode: String,
    onSetError: (error) =>
      log.warn("Could not persist controller UI action preference", error),
  },
);

/** Whether the settings UI is capturing a key combination, which suspends user keybindings. */
export const $recordingKeybinding = atom(false);

/** Modifier keys that cannot form a binding on their own. */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * Converts a key press into keyboard shortcut syntax, or undefined for a lone modifier.
 *
 * Letter and digit keys use their physical codes so bindings survive keyboard layouts
 * where the modifiers change the produced character.
 */
export function keyFromEvent(event: KeyboardEvent): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  const modifiers = [
    event.ctrlKey ? "Control" : undefined,
    event.altKey ? "Alt" : undefined,
    event.shiftKey ? "Shift" : undefined,
    event.metaKey ? "Meta" : undefined,
  ].filter((modifier): modifier is string => modifier !== undefined);
  const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code)
    ? event.code
    : event.key === " "
      ? "Space"
      : event.key;
  return [...modifiers, key].join("+");
}

/** Formats a stored key combination for display. */
export function formatKey(key: string): string {
  return key
    .split("+")
    .map((part) => part.replace(/^Key/, "").replace(/^Digit/, ""))
    .join(" + ");
}

/** Adds or replaces a keybinding; any other binding for the same key is removed. */
export function saveKeybinding(binding: Keybinding): void {
  $keybindings.set([
    ...$keybindings
      .get()
      .filter(
        (existing) =>
          existing.id !== binding.id && existing.key !== binding.key,
      ),
    binding,
  ]);
}

/** Removes a keybinding by ID. */
export function removeKeybinding(id: string): void {
  $keybindings.set($keybindings.get().filter((binding) => binding.id !== id));
}

/**
 * Invokes a bound action: `ui.*` actions run in this client, others in the backend.
 */
export function invokeBoundAction(
  action: types.ActionReference,
  context: UiActionExecutionContext,
): void {
  if (action.id.startsWith(UI_ACTION_PREFIX)) {
    executeUiAction(action.id, context);
    return;
  }
  engineRuntime.sendCommand({
    module: "ActionCommand",
    command: {
      type: "Invoke",
      data: {
        action: JSON.parse(JSON.stringify(action)),
        surface: "keyboard",
      },
    },
  });
}
