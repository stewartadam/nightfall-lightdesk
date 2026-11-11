// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { WarningIcon } from "@squidlab/phosphor-solid/warning";
import { For, Show } from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import type { UsbDmxOutputTarget } from "../../../types";
import { isBuiltInUsbTarget, type UsbTargetStatusView } from "../usb/model";

/** Text color for each status kind. */
const STATUS_CLASS: Record<UsbTargetStatusView["kind"], string> = {
  valid: "text-gray-500",
  warning: "text-amber-300",
  invalid: "text-red-300",
};

interface UsbTargetRowProps {
  target: UsbDmxOutputTarget;
  outputEnabled: boolean;
  deviceAvailable: boolean;
  status: UsbTargetStatusView;
  deviceOptions: Array<{ id: string; label: string }>;
  onSave: (target: UsbDmxOutputTarget) => void;
  onRemove: (target: UsbDmxOutputTarget) => void;
  /** Binds the target to an attached adapter, saving the port it is on now. */
  onAssignDevice: (target: UsbDmxOutputTarget, device: string) => void;
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
          <div class="flex flex-col items-start gap-1">
            <span
              class={`inline-flex items-center gap-1 text-xs ${STATUS_CLASS[props.status.kind]}`}
            >
              <Show when={props.status.kind !== "valid"}>
                <WarningIcon class="size-3.5 shrink-0" aria-hidden="true" />
              </Show>
              {props.status.label}
            </span>
            <Show when={props.status.detail}>
              {(detail) => (
                <span class="text-xs text-gray-500">{detail()}</span>
              )}
            </Show>
            <Show when={props.status.fix}>
              {(fix) => (
                <Button
                  size="compact"
                  type="button"
                  aria-label={`${props.target.id} ${fix().label.toLowerCase()}`}
                  onClick={() =>
                    props.onAssignDevice(props.target, fix().device)
                  }
                >
                  {fix().label}
                </Button>
              )}
            </Show>
          </div>
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
