// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";

interface UsbTargetAddRowProps {
  id: string;
  device: string;
  deviceOptions: Array<{ id: string; label: string }>;
  invalid: boolean;
  canAdd: boolean;
  status: { label: string; kind: "idle" | "invalid" | "valid" };
  statusClass: string;
  cellClass: (edge?: "first" | "last") => string;
  onIdChange: (id: string) => void;
  onDeviceChange: (device: string) => void;
  onAdd: () => void;
}

/** Renders the validated add row for a new USB DMX transport mapping. */
export function UsbTargetAddRow(props: UsbTargetAddRowProps) {
  return (
    <tr
      class={`bg-gray-900/60 ${
        props.invalid
          ? "outline outline-1 outline-red-500/70 outline-offset-[-1px]"
          : ""
      }`}
      data-slot="new-usb-target-row"
    >
      <td class={props.cellClass("first")}>
        <Input
          density="compact"
          aria-label="New USB transport id"
          class="w-full"
          value={props.id}
          onInput={(event) =>
            props.onIdChange(event.currentTarget.value.toLowerCase())
          }
        />
      </td>
      <td class={props.cellClass()}>
        <NativeSelect
          density="compact"
          aria-label="New USB device"
          aria-invalid={
            props.device.trim() === "" && props.deviceOptions.length > 0
          }
          disabled={props.deviceOptions.length === 0}
          value={props.device}
          onChange={(event) => props.onDeviceChange(event.currentTarget.value)}
        >
          <Show
            when={props.deviceOptions.length > 0}
            fallback={<option value="">No compatible USB devices</option>}
          >
            <For each={props.deviceOptions}>
              {(option) => <option value={option.id}>{option.label}</option>}
            </For>
          </Show>
        </NativeSelect>
      </td>
      <td class={props.cellClass()}>
        <span
          class={`text-xs ${props.statusClass}`}
          role="status"
          aria-label={`New USB transport status: ${props.status.label}`}
        >
          {props.status.label}
        </span>
      </td>
      <td class={`${props.cellClass("last")} text-right`}>
        <Button
          size="compact"
          type="button"
          disabled={!props.canAdd}
          onClick={props.onAdd}
        >
          Add
        </Button>
      </td>
    </tr>
  );
}
