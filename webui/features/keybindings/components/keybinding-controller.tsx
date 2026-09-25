// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, onCleanup } from "solid-js";
import { executeUiAction } from "../../../components/providers/command-registry";
import { isInputField } from "../../../lib/keyboard-shortcut-targets";
import {
  addShortcutPreemptor,
  setDisabledShortcuts,
} from "../../../lib/keyboardShortcuts";
import { clientActionInvocation } from "../../../state/appStores";
import {
  $disabledBuiltInShortcuts,
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
 * removing a binding restores the built-in behavior immediately. The settings UI asks for
 * confirmation before creating such a binding. Returns true when a binding claimed the press;
 * held-key repeats of a bound key are claimed without invoking the action again.
 */
function handleKeybinding(event: KeyboardEvent): boolean {
  if (event.isComposing || $recordingKeybinding.get()) return false;
  if (typesIntoInput(event)) return false;
  const key = keyFromEvent(event);
  if (!key) return false;
  const binding = $keybindings.get().find((binding) => binding.key === key);
  if (!binding) return false;
  event.preventDefault();
  if (!event.repeat) {
    invokeBoundAction(binding.action, { source: "keybinding", event });
  }
  return true;
}

/**
 * Applies user keybindings and runs UI actions that MIDI or OSC mappings forward here.
 *
 * Mounted once by the application shell.
 */
export function KeybindingController() {
  onCleanup(addShortcutPreemptor(handleKeybinding));

  /** Keeps the shortcut dispatcher's disabled list in step with the persisted one. */
  createEffect(() => {
    const unsubscribe =
      $disabledBuiltInShortcuts.subscribe(setDisabledShortcuts);
    onCleanup(() => {
      unsubscribe();
      setDisabledShortcuts([]);
    });
  });

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
