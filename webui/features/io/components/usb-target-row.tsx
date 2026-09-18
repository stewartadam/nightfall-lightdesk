// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import type { UsbDmxOutputTarget } from "../../../types";
import { isBuiltInUsbTarget } from "../usb/model";

interface UsbTargetRowProps {
  target: UsbDmxOutputTarget;
  outputEnabled: boolean;
  deviceAvailable: boolean;
  status: { label: string; kind: "valid" | "invalid" };
  deviceOptions: Array<{ id: string; label: string }>;
  onSave: (target: UsbDmxOutputTarget) => void;
  onRemove: (target: UsbDmxOutputTarget) => void;
}

/** Renders one configured USB output mapping from controller-projected state. */
export function UsbTargetRow(props: UsbTargetRowProps) {
  return (
    <tr data-slot="usb-target-row" data-target-id={props.target.id}>
      <td class="font-mono">{props.target.id}</td>
      <td>
        <NativeSelect
          density="compact"
          aria-label={`${props.target.id} usb device`}
          aria-invalid={!props.deviceAvailable}
          value={props.target.device}
          onChange={(event) =>
            props.onSave({
              ...props.target,
              device: event.currentTarget.value,
            })
          }
        >
          <For each={props.deviceOptions}>
            {(option) => <option value={option.id}>{option.label}</option>}
          </For>
        </NativeSelect>
      </td>
      <td>
        <Show
          when={props.outputEnabled}
          fallback={
            <span
              class="text-xs text-gray-500"
              role="status"
              aria-label={`${props.target.id} usb output disabled`}
            >
              Disabled
            </span>
          }
        >
          <span
            class={`text-xs ${
              props.status.kind === "valid" ? "text-gray-500" : "text-red-300"
            }`}
          >
            {props.status.label}
          </span>
        </Show>
      </td>
      <td class="text-right">
        <Button
          size="compact"
          variant="danger"
          type="button"
          disabled={isBuiltInUsbTarget(props.target)}
          onClick={() => props.onRemove(props.target)}
        >
          Delete
        </Button>
      </td>
    </tr>
  );
}
