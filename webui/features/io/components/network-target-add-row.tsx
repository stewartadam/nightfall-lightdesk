// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { isValidIpv4Address } from "../../../lib/network-dmx-output-targets";
import * as types from "../../../types";
import { deliveryModeValidForProtocol } from "../network/model";

interface NetworkTargetAddRowProps {
  id: string;
  protocol: types.NetworkDmxProtocol;
  deliveryMode: string;
  ip: string;
  invalid: boolean;
  canAdd: boolean;
  status: { label: string; kind: "idle" | "invalid" | "valid" };
  statusClass: string;
  cellClass: (edge?: "first" | "last") => string;
  onIdChange: (id: string) => void;
  onProtocolChange: (protocol: types.NetworkDmxProtocol) => void;
  onDeliveryModeChange: (mode: string) => void;
  onIpChange: (ip: string) => void;
  onAdd: () => void;
}

/** Renders the validated add row for a new network DMX transport. */
export function NetworkTargetAddRow(props: NetworkTargetAddRowProps) {
  return (
    <tr
      class={`bg-gray-900/60 ${
        props.invalid
          ? "outline outline-1 outline-red-500/70 outline-offset-[-1px]"
          : ""
      }`}
      data-slot="new-target-row"
    >
      <td class={props.cellClass("first")}>
        <Input
          density="compact"
          aria-label="New transport id"
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
          aria-label="New transport protocol"
          class="w-full"
          value={props.protocol}
          onChange={(event) => {
            const protocol = event.currentTarget
              .value as types.NetworkDmxProtocol;
            props.onProtocolChange(protocol);
            if (!deliveryModeValidForProtocol(protocol, props.deliveryMode)) {
              props.onDeliveryModeChange("Unicast");
            }
          }}
        >
          <option value={types.NetworkDmxProtocol.Sacn}>sACN</option>
          <option value={types.NetworkDmxProtocol.ArtNet}>Art-Net</option>
        </NativeSelect>
      </td>
      <td class={props.cellClass()}>
        <NativeSelect
          density="compact"
          aria-label="New transport delivery mode"
          class="w-full"
          value={props.deliveryMode}
          onChange={(event) =>
            props.onDeliveryModeChange(event.currentTarget.value)
          }
        >
          <Show
            when={props.protocol === types.NetworkDmxProtocol.Sacn}
            fallback={<option value="Broadcast">Broadcast</option>}
          >
            <option value="Multicast">Multicast</option>
          </Show>
          <option value="Unicast">Unicast</option>
        </NativeSelect>
      </td>
      <td class={props.cellClass()}>
        <Input
          density="compact"
          aria-label="New transport unicast ip"
          aria-invalid={
            props.deliveryMode === "Unicast" && !isValidIpv4Address(props.ip)
          }
          value={props.ip}
          disabled={props.deliveryMode !== "Unicast"}
          onInput={(event) =>
            props.onIpChange(event.currentTarget.value.trim())
          }
        />
      </td>
      <td class={props.cellClass()}>
        <span
          class={`text-xs ${props.statusClass}`}
          role="status"
          aria-label={`New transport status: ${props.status.label}`}
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
