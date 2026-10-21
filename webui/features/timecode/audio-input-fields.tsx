// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, For, Show } from "solid-js";
import { NativeSelect } from "../../components/ui/form-controls";
import { audioInputDevices } from "../../state/appStores";
import type * as types from "../../types";

/** Channels offered when the engine hasn't reported how many a device has. */
const FALLBACK_CHANNEL_COUNT = 2;

type TimecodeAudioInputFieldsProps = {
  /** The timecode's saved audio input; absent means the default input's first channel. */
  input: types.TimecodeAudioInput | undefined;
  /** Called with the complete input after the user picks a device or channel. */
  onChange: (input: types.TimecodeAudioInput) => void;
};

/**
 * Device and channel pickers for the audio input an LTC timecode reads.
 *
 * Lists the inputs the engine discovered. A saved device that is currently
 * unplugged stays selectable as "unavailable" so viewing the timecode never
 * rewrites its saved input.
 */
export function TimecodeAudioInputFields(props: TimecodeAudioInputFieldsProps) {
  const $devices = useStore(audioInputDevices);
  const deviceId = () => props.input?.device_id ?? "";
  const channel = () => props.input?.channel ?? 0;

  /** The system default input, which a timecode without a chosen device reads. */
  const defaultDevice = createMemo(() =>
    $devices().find((device) => device.is_default),
  );

  /** The device the timecode reads, resolving "default input" to the actual device. */
  const selectedDevice = createMemo(() => {
    const id = deviceId();
    return id ? $devices().find((device) => device.id === id) : defaultDevice();
  });

  /** Whether the saved device is missing from the engine's current device list. */
  const savedDeviceMissing = createMemo(
    () => deviceId() !== "" && !$devices().some((d) => d.id === deviceId()),
  );

  /**
   * Channel numbers to offer: every channel of the selected device, and always
   * the saved channel so an unplugged device still shows its setting.
   */
  const channels = createMemo(() => {
    const reported = selectedDevice()?.channels || FALLBACK_CHANNEL_COUNT;
    const count = Math.max(reported, channel() + 1);
    return Array.from({ length: count }, (_, index) => index);
  });

  /**
   * Merges `patch` onto the current input and reports the result. Picking a
   * device with fewer channels than the saved one falls back to channel 1.
   */
  const update = (patch: Partial<types.TimecodeAudioInput>) => {
    const next: types.TimecodeAudioInput = {
      device_id: props.input?.device_id,
      channel: channel(),
      ...patch,
    };
    if (!next.device_id) delete next.device_id;
    if ("device_id" in patch) {
      const device = next.device_id
        ? $devices().find((d) => d.id === next.device_id)
        : defaultDevice();
      if (device?.channels && (next.channel ?? 0) >= device.channels) {
        next.channel = 0;
      }
    }
    props.onChange(next);
  };

  return (
    <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
      <label class="block min-w-0 space-y-1">
        <span class="text-xs text-neutral-400">Audio input</span>
        <NativeSelect
          density="compact"
          aria-label="Timecode audio input"
          class="w-full"
          value={deviceId()}
          onChange={(event) =>
            update({ device_id: event.currentTarget.value || undefined })
          }
        >
          <option value="">
            {defaultDevice()
              ? `Default input (${defaultDevice()?.name})`
              : "Default input"}
          </option>
          <For each={$devices()}>
            {(device) => <option value={device.id}>{device.name}</option>}
          </For>
          <Show when={savedDeviceMissing()}>
            <option value={deviceId()}>Unavailable device</option>
          </Show>
        </NativeSelect>
      </label>
      <label class="block space-y-1">
        <span class="text-xs text-neutral-400">Channel</span>
        <NativeSelect
          density="compact"
          aria-label="Timecode audio channel"
          value={String(channel())}
          onChange={(event) =>
            update({ channel: Number(event.currentTarget.value) })
          }
        >
          <For each={channels()}>
            {(index) => <option value={String(index)}>{index + 1}</option>}
          </For>
        </NativeSelect>
      </label>
    </div>
  );
}
