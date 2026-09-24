// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Checkbox } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import * as types from "../../../types";
import {
  ActionPicker,
  formatActionReference,
  useActionTargetNames,
  useBindableActionCatalog,
} from "../../actions";
import {
  $keybindings,
  $recordingKeybinding,
  $respondToControllerUiActions,
  formatKey,
  keyFromEvent,
  removeKeybinding,
  saveKeybinding,
} from "../model/keybindings";

/** Settings tab for user keybindings and controller-driven UI actions on this client. */
export function KeybindingsSettings() {
  const $bindings = useStore($keybindings);
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

  /** Captures the next key combination while recording, before other shortcuts run. */
  const captureKey = (event: KeyboardEvent) => {
    if (!recording()) return;
    const key = keyFromEvent(event);
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setPendingKey(key);
    setRecording(false);
  };
  window.addEventListener("keydown", captureKey, { capture: true });
  onCleanup(() =>
    window.removeEventListener("keydown", captureKey, { capture: true }),
  );

  /** Saves the recorded key and chosen action as a keybinding. */
  const addBinding = () => {
    const key = pendingKey();
    const action = pendingAction();
    if (!key || !action) return;
    saveKeybinding({ id: crypto.randomUUID(), key, action });
    setPendingKey(undefined);
  };

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
                  <kbd class="font-mono text-xs text-neutral-200">
                    {formatKey(binding.key)}
                  </kbd>
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
                    aria-label={`Remove keybinding ${formatKey(binding.key)}`}
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
            onClick={() => setRecording(!recording())}
          >
            {recording()
              ? "Press a key combination..."
              : pendingKey()
                ? formatKey(pendingKey()!)
                : "Record keys"}
          </Button>
          <ActionPicker
            label="Keybinding action"
            inputKinds={[types.ActionInputKind.Trigger]}
            includeUiActions
            onChange={setPendingAction}
            onIncomplete={() => setPendingAction(undefined)}
          />
          <Button
            size="compact"
            variant="primary"
            type="button"
            disabled={!pendingKey() || !pendingAction()}
            onClick={addBinding}
          >
            Add
          </Button>
        </div>
      </section>
    </div>
  );
}
