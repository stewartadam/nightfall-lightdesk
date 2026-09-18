// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, For, Show } from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
import { ToggleSwitch } from "../../../components/ui/toggle-switch";
import { engineRuntime } from "../../../lib/engine-runtime";
import {
  $availableNetworkInterfaces,
  $externalControlState,
} from "../../../state/settings";
import type { ExternalControlSettings as ControlSettings } from "../../../types";

/** Edits host-scoped remote access and displays listener configuration errors. */
export function ExternalControlSettings() {
  const state = useStore($externalControlState);
  const interfaces = useStore($availableNetworkInterfaces);
  /** Retains a saved interface in the selector when its adapter is disconnected. */
  const missingInterface = createMemo(() => {
    const selected = state().settings.interface;
    return selected && !interfaces().some((item) => item.name === selected)
      ? selected
      : undefined;
  });
  /** Submits complete host preferences through the settings command lifecycle. */
  const updateSettings = (patch: Partial<ControlSettings>) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: {
        type: "SetExternalControl",
        data: { ...state().settings, ...patch },
      },
    });
  };

  return (
    <Show when={state().available}>
      <section
        class="border-b border-gray-800 p-3"
        aria-label="External control"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <ToggleSwitch
            label="External control"
            ariaLabel="Enable external control"
            checked={state().settings.enabled}
            onChange={(enabled) => updateSettings({ enabled })}
          />
          <label class="flex items-center gap-2 text-xs text-gray-400">
            Interface
            <NativeSelect
              density="compact"
              aria-label="External control interface"
              class="max-w-full"
              value={state().settings.interface ?? ""}
              onChange={(event) =>
                updateSettings({
                  interface: event.currentTarget.value || undefined,
                })
              }
            >
              <option value="">All</option>
              <Show when={missingInterface()}>
                {(name) => (
                  <option value={name()}>{name()} (unavailable)</option>
                )}
              </Show>
              <For each={interfaces()}>
                {(item) => (
                  <option value={item.name}>
                    {item.friendly_name ?? item.name} (
                    {item.addresses.join(", ")})
                  </option>
                )}
              </For>
            </NativeSelect>
          </label>
        </div>
        <p class="mt-2 text-xs text-gray-400">
          Allow devices on your network to control Nightfall. Use a trusted
          network. Local control remains available. Saved on this computer,
          independently of your showfile.
        </p>
        <Show when={state().error}>
          {(error) => (
            <p class="mt-2 text-xs text-red-300" role="alert">
              {error()}
            </p>
          )}
        </Show>
      </section>
    </Show>
  );
}
