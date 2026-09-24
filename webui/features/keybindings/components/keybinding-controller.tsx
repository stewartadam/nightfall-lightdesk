// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, onCleanup } from "solid-js";
import { executeUiAction } from "../../../components/providers/command-registry";
import { isInputField } from "../../../lib/keyboard-shortcut-targets";
import { clientActionInvocation } from "../../../state/appStores";
import {
  $keybindings,
  $recordingKeybinding,
  $respondToControllerUiActions,
  invokeBoundAction,
  keyFromEvent,
} from "../model/keybindings";

/**
 * Returns whether a key press should be left to the focused text field.
 *
 * Unmodified keys type into inputs; combinations with Control, Alt, or Meta still bind.
 */
function typesIntoInput(event: KeyboardEvent): boolean {
  const target =
    event.target instanceof HTMLElement ? event.target : document.activeElement;
  return (
    target instanceof HTMLElement &&
    isInputField(target) &&
    !(event.ctrlKey || event.altKey || event.metaKey)
  );
}

/**
 * Runs the user keybinding matching a key press ahead of built-in shortcuts.
 *
 * User bindings shadow built-in shortcuts on the same key without unregistering them, so
 * removing a binding restores the built-in behavior immediately.
 */
function handleKeybinding(event: KeyboardEvent): void {
  if (event.repeat || event.isComposing || $recordingKeybinding.get()) return;
  if (typesIntoInput(event)) return;
  const key = keyFromEvent(event);
  if (!key) return;
  const binding = $keybindings.get().find((binding) => binding.key === key);
  if (!binding) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  invokeBoundAction(binding.action, { source: "keybinding", event });
}

/**
 * Applies user keybindings and runs UI actions that MIDI or OSC mappings forward here.
 *
 * Mounted once by the application shell.
 */
export function KeybindingController() {
  window.addEventListener("keydown", handleKeybinding, { capture: true });
  onCleanup(() =>
    window.removeEventListener("keydown", handleKeybinding, { capture: true }),
  );

  /** Runs forwarded `ui.*` actions when this client opted in to controller UI actions. */
  createEffect(() => {
    const unsubscribe = clientActionInvocation.listen((invocation) => {
      if (!invocation || !$respondToControllerUiActions.get()) return;
      executeUiAction(invocation.action.id, {
        source: invocation.surface === "osc" ? "osc" : "midi",
      });
    });
    onCleanup(unsubscribe);
  });

  return null;
}
