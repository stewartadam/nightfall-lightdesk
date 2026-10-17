// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Alert } from "../../../components/ui/alert";
import { Collapsible } from "../../../components/ui/collapsible";
import { Checkbox } from "../../../components/ui/form-controls";
import { formatShortcutLabel, KbdShortcut } from "../../../components/ui/kbd";
import { Button } from "../../../components/ui/visual-language/button";
import {
  addShortcutPreemptor,
  allShortcuts,
} from "../../../lib/keyboardShortcuts";
import * as types from "../../../types";
import {
  ActionPicker,
  formatActionReference,
  useActionTargetNames,
  useBindableActionCatalog,
} from "../../actions";
import {
  $disabledBuiltInShortcuts,
  $keybindings,
  $recordingKeybinding,
  $respondToControllerUiActions,
  disableBuiltInShortcut,
  enableBuiltInShortcut,
  keyFromEvent,
  removeKeybinding,
  saveKeybinding,
} from "../model/keybindings";
import {
  type BuiltInShortcutInfo,
  findKeybindingConflicts,
  isBuiltInShortcutDisabled,
  type KeybindingConflict,
  uniqueBuiltInShortcuts,
} from "../model/shortcut-conflicts";

/** Returns where a built-in shortcut applies, for listing it beside its description. */
function builtInScope(shortcut: BuiltInShortcutInfo): string {
  return shortcut.group ?? shortcut.componentId ?? "Global";
}

/** Settings tab for user keybindings and controller-driven UI actions on this client. */
export function KeybindingsSettings() {
  const $bindings = useStore($keybindings);
  const $disabled = useStore($disabledBuiltInShortcuts);
  const $respond = useStore($respondToControllerUiActions);
  const $catalog = useBindableActionCatalog();
  const targetNames = useActionTargetNames();
  const recording = useStore($recordingKeybinding);
  /** Starts or stops capturing the next key combination. */
  const setRecording = (value: boolean) => $recordingKeybinding.set(value);
  onCleanup(() => setRecording(false));
  const [pendingKey, setPendingKey] = createSignal<string>();
  const [pendingAction, setPendingAction] = createSignal<
    types.ActionReference | undefined
  >();
  const [confirmingReplace, setConfirmingReplace] = createSignal(false);

  /** Registered built-in shortcuts, once each, for conflict checks and the disable list. */
  const builtIns = createMemo(() => uniqueBuiltInShortcuts(allShortcuts()));

  /** Built-in shortcuts and keybindings the recorded key would shadow or replace. */
  const conflicts = createMemo(() => {
    const key = pendingKey();
    if (!key) return [];
    return findKeybindingConflicts(key, builtIns(), $bindings(), $disabled());
  });

  /**
   * Captures the next key combination while recording, before any shortcut runs.
   *
   * Lone modifier presses are claimed too, so holding a modifier cannot trigger a shortcut
   * mid-recording.
   */
  const captureKey = (event: KeyboardEvent): boolean => {
    if (!recording()) return false;
    event.preventDefault();
    const key = keyFromEvent(event);
    if (!key) return true;
    setPendingKey(key);
    setConfirmingReplace(false);
    setRecording(false);
    return true;
  };
  onCleanup(addShortcutPreemptor(captureKey));

  /** Saves the recorded key and chosen action as a keybinding. */
  const saveBinding = () => {
    const key = pendingKey();
    const action = pendingAction();
    if (!key || !action) return;
    saveKeybinding({ id: crypto.randomUUID(), key, action });
    setPendingKey(undefined);
    setConfirmingReplace(false);
  };

  /** Saves the binding, or asks for confirmation first when it conflicts with another. */
  const addBinding = () => {
    if (conflicts().length > 0) {
      setConfirmingReplace(true);
      return;
    }
    saveBinding();
  };

  /** Discards the recorded key after the user declines to replace its conflicts. */
  const cancelReplace = () => {
    setConfirmingReplace(false);
    setPendingKey(undefined);
  };

  /** Describes one conflict in the inline warning. */
  const describeConflict = (conflict: KeybindingConflict) =>
    conflict.kind === "built-in"
      ? `Built-in shortcut: ${conflict.shortcut.description} (${builtInScope(conflict.shortcut)})`
      : `Keybinding: ${formatActionReference(conflict.binding.action, $catalog(), targetNames)}`;

  return (
    <div class="space-y-5" data-keybindings-settings>
      <label class="flex items-center gap-2 text-sm">
        <Checkbox
          checked={$respond()}
          onChange={(event) =>
            $respondToControllerUiActions.set(event.currentTarget.checked)
          }
        />
        <span>
          Run UI actions triggered by MIDI and OSC mappings on this screen
        </span>
      </label>

      <section class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Keybindings
        </h3>
        <Show
          when={$bindings().length > 0}
          fallback={
            <p class="text-sm text-neutral-500">
              No custom keybindings. Built-in shortcuts are listed in the
              keyboard shortcuts overlay.
            </p>
          }
        >
          <ul class="divide-y divide-neutral-800 rounded border border-neutral-800">
            <For each={$bindings()}>
              {(binding) => (
                <li
                  class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  data-keybinding={binding.key}
                >
                  <KbdShortcut shortcut={binding.key} size="compact" />
                  <span class="flex-1 truncate text-neutral-300">
                    {formatActionReference(
                      binding.action,
                      $catalog(),
                      targetNames,
                    )}
                  </span>
                  <Button
                    size="compact"
                    variant="subtle"
                    type="button"
                    aria-label={`Remove keybinding ${formatShortcutLabel(binding.key)}`}
                    onClick={() => removeKeybinding(binding.id)}
                  >
                    Remove
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Add keybinding
        </h3>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="compact"
            type="button"
            aria-pressed={recording()}
            aria-label={
              !recording() && pendingKey()
                ? `Record keys, recorded ${formatShortcutLabel(pendingKey()!)}`
                : undefined
            }
            onClick={() => setRecording(!recording())}
          >
            <Show when={!recording()} fallback="Press a key combination...">
              <Show when={pendingKey()} fallback="Record keys">
                {(key) => <KbdShortcut shortcut={key()} size="compact" />}
              </Show>
            </Show>
          </Button>
          <ActionPicker
            label="Keybinding action"
            inputKinds={[types.ActionInputKind.Trigger]}
            surface={types.ActionSurface.Keyboard}
            includeUiActions
            onChange={setPendingAction}
            onIncomplete={() => setPendingAction(undefined)}
          />
          <Show when={!confirmingReplace()}>
            <Button
              size="compact"
              variant="primary"
              type="button"
              disabled={!pendingKey() || !pendingAction()}
              onClick={addBinding}
            >
              Add
            </Button>
          </Show>
        </div>
        <Show when={conflicts().length > 0}>
          <Alert
            variant="warning"
            role={confirmingReplace() ? "alert" : "status"}
            data-keybinding-conflicts
          >
            <p class="flex flex-wrap items-center gap-1">
              <KbdShortcut shortcut={pendingKey() ?? ""} size="compact" />
              <span>is already used. Adding this keybinding replaces:</span>
            </p>
            <ul class="list-disc pl-5">
              <For each={conflicts()}>
                {(conflict) => <li>{describeConflict(conflict)}</li>}
              </For>
            </ul>
            <Show when={confirmingReplace()}>
              <div class="flex gap-2">
                <Button
                  size="compact"
                  variant="danger"
                  type="button"
                  onClick={saveBinding}
                >
                  Replace
                </Button>
                <Button
                  size="compact"
                  variant="subtle"
                  type="button"
                  onClick={cancelReplace}
                >
                  Cancel
                </Button>
              </div>
            </Show>
          </Alert>
        </Show>
      </section>

      <section class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Disabled built-in shortcuts
        </h3>
        <Show
          when={$disabled().length > 0}
          fallback={
            <p class="text-sm text-neutral-500">
              All built-in shortcuts are enabled.
            </p>
          }
        >
          <ul class="divide-y divide-neutral-800 rounded border border-neutral-800">
            <For each={$disabled()}>
              {(shortcut) => (
                <li
                  class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  data-disabled-shortcut={shortcut.key}
                >
                  <KbdShortcut
                    shortcut={shortcut.key}
                    size="compact"
                    tone="muted"
                  />
                  <span class="flex-1 truncate text-neutral-400">
                    {shortcut.description}
                  </span>
                  <Button
                    size="compact"
                    variant="subtle"
                    type="button"
                    aria-label={`Re-enable ${shortcut.description}`}
                    onClick={() => enableBuiltInShortcut(shortcut)}
                  >
                    Re-enable
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Collapsible class="text-sm" title="Disable a built-in shortcut">
          <ul class="max-h-72 divide-y divide-neutral-800 overflow-y-auto">
            <For
              each={builtIns().filter(
                (shortcut) => !isBuiltInShortcutDisabled(shortcut, $disabled()),
              )}
            >
              {(shortcut) => (
                <li
                  class="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                  data-builtin-shortcut={shortcut.key}
                >
                  <KbdShortcut
                    shortcut={shortcut.key}
                    size="compact"
                    class="w-28"
                  />
                  <span
                    class="flex-1 truncate text-neutral-300"
                    title={shortcut.description}
                  >
                    {shortcut.description}
                  </span>
                  <span class="text-xs text-neutral-500">
                    {builtInScope(shortcut)}
                  </span>
                  <Button
                    size="compact"
                    variant="subtle"
                    type="button"
                    aria-label={`Disable ${shortcut.description}`}
                    onClick={() => disableBuiltInShortcut(shortcut)}
                  >
                    Disable
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Collapsible>
      </section>
    </div>
  );
}
