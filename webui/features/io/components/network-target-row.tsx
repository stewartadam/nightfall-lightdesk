// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, Show } from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { networkOutputFailureSummary } from "../../../lib/network-dmx-output-health";
import { isValidIpv4Address } from "../../../lib/network-dmx-output-targets";
import * as types from "../../../types";
import {
  deliveryForProtocolChange,
  deliveryFromMode,
  deliveryIp,
  deliveryLabel,
  isBuiltInTarget,
} from "../network/model";

interface NetworkTargetRowProps {
  target: types.NetworkDmxOutputTarget;
  sendFailure: types.NetworkOutputSendFailure | undefined;
  outputEnabled: boolean;
  onSave: (target: types.NetworkDmxOutputTarget) => void;
  onRemove: (target: types.NetworkDmxOutputTarget) => void;
}

/** Renders and coordinates local draft delivery edits for one network target. */
export function NetworkTargetRow(props: NetworkTargetRowProps) {
  const [draftDelivery, setDraftDelivery] =
    createSignal<types.NetworkDmxDelivery>(props.target.delivery);
  /** Projects the saved target with its locally edited delivery. */
  const draftTarget = () => ({
    ...props.target,
    delivery: draftDelivery(),
  });
  /** Returns the editable IP string for unicast delivery. */
  const ip = () => deliveryIp(draftDelivery());
  /** Returns whether the active delivery exposes an IP field. */
  const canEditIp = () => draftDelivery().type === "Unicast";
  /** Returns whether the current IP draft can be persisted. */
  const ipValid = () => !canEditIp() || isValidIpv4Address(ip());

  return (
    <tr data-slot="target-row" data-target-id={props.target.id}>
      <td class="font-mono">{props.target.id}</td>
      <td>
        <NativeSelect
          density="compact"
          aria-label={`${props.target.id} protocol`}
          class="w-full"
          value={props.target.protocol}
          disabled={isBuiltInTarget(props.target)}
          onChange={(event) => {
            const protocol = event.currentTarget
              .value as types.NetworkDmxProtocol;
            const delivery = deliveryForProtocolChange(draftDelivery());
            setDraftDelivery(delivery);
            props.onSave({ ...props.target, protocol, delivery });
          }}
        >
          <option value={types.NetworkDmxProtocol.Sacn}>sACN</option>
          <option value={types.NetworkDmxProtocol.ArtNet}>Art-Net</option>
        </NativeSelect>
      </td>
      <td>
        <NativeSelect
          density="compact"
          aria-label={`${props.target.id} delivery mode`}
          class="w-full"
          value={deliveryLabel(draftTarget())}
          onChange={(event) => {
            const delivery = deliveryFromMode(
              props.target.protocol,
              event.currentTarget.value,
              ip() || "127.0.0.1",
            );
            setDraftDelivery(delivery);
            props.onSave({ ...props.target, delivery });
          }}
        >
          <Show
            when={props.target.protocol === types.NetworkDmxProtocol.Sacn}
            fallback={<option value="Broadcast">Broadcast</option>}
          >
            <option value="Multicast">Multicast</option>
          </Show>
          <option value="Unicast">Unicast</option>
        </NativeSelect>
      </td>
      <td>
        <Input
          density="compact"
          aria-label={`${props.target.id} unicast ip`}
          aria-invalid={!ipValid()}
          value={ip()}
          disabled={!canEditIp()}
          onChange={(event) => {
            const value = event.currentTarget.value.trim();
            const delivery: types.NetworkDmxDelivery = {
              type: "Unicast",
              data: { ip: value },
            };
            setDraftDelivery(delivery);
            if (isValidIpv4Address(value)) {
              props.onSave({ ...props.target, delivery });
            }
          }}
        />
      </td>
      <td>
        <Show
          when={props.outputEnabled}
          fallback={
            <span
              class="text-xs text-gray-500"
              role="status"
              aria-label={`${props.target.id} output disabled`}
            >
              Disabled
            </span>
          }
        >
          <Show
            when={props.sendFailure}
            fallback={<span class="text-xs text-gray-500">OK</span>}
          >
            {(failure) => (
              <span
                class="inline-flex max-w-full rounded border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200"
                title={networkOutputFailureSummary(failure())}
                role="status"
                aria-label={`${props.target.id} output warning: ${networkOutputFailureSummary(failure())}`}
              >
                <span class="truncate">{failure().error_kind}</span>
              </span>
            )}
          </Show>
        </Show>
      </td>
      <td class="text-right">
        <Button
          size="compact"
          variant="danger"
          type="button"
          disabled={isBuiltInTarget(props.target)}
          onClick={() => props.onRemove(props.target)}
        >
          Delete
        </Button>
      </td>
    </tr>
  );
}
