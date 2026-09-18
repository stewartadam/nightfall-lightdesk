// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  defaultDeliveryForProtocol,
  ipv4AddressToString,
  outputTransportForNetworkDmxTarget,
  outputTransportKey,
} from "../../../lib/network-dmx-output-targets";
import * as types from "../../../types";

export const BUILT_IN_TARGET_IDS = new Set(["sacn", "artnet"]);

/** Returns the editable IPv4 value from a delivery mode. */
export function deliveryIp(delivery: types.NetworkDmxDelivery): string {
  return delivery.type === "Unicast"
    ? ipv4AddressToString(delivery.data.ip)
    : "";
}

/** Returns a delivery mode updated for a protocol. */
export function protocolDefaultDelivery(
  protocol: types.NetworkDmxProtocol,
): types.NetworkDmxDelivery {
  return defaultDeliveryForProtocol(protocol);
}

/** Returns delivery settings for an explicit mode selection. */
export function deliveryFromMode(
  protocol: types.NetworkDmxProtocol,
  mode: string,
  ip: string,
): types.NetworkDmxDelivery {
  if (mode === "Unicast") {
    return { type: "Unicast", data: { ip } };
  }
  return protocolDefaultDelivery(protocol);
}

/** Returns whether a delivery mode can be selected for a protocol. */
export function deliveryModeValidForProtocol(
  protocol: types.NetworkDmxProtocol,
  mode: string,
): boolean {
  if (mode === "Unicast") return true;
  if (protocol === types.NetworkDmxProtocol.Sacn) return mode === "Multicast";
  return mode === "Broadcast";
}

/** Returns delivery settings when changing protocols without losing IP editability. */
export function deliveryForProtocolChange(
  delivery: types.NetworkDmxDelivery,
): types.NetworkDmxDelivery {
  return {
    type: "Unicast",
    data: { ip: deliveryIp(delivery) || "127.0.0.1" },
  };
}

/** Returns whether the target is built into nightfall. */
export function isBuiltInTarget(target: types.NetworkDmxOutputTarget): boolean {
  return BUILT_IN_TARGET_IDS.has(target.id);
}

/** Returns the delivery mode label for a target. */
export function deliveryLabel(target: types.NetworkDmxOutputTarget): string {
  if (target.delivery.type === "Unicast") return "Unicast";
  if (target.delivery.type === "ArtNetBroadcast") return "Broadcast";
  return "Multicast";
}

/** Builds an updated target list by replacing one target. */
export function replaceTarget(
  targets: types.NetworkDmxOutputTarget[],
  target: types.NetworkDmxOutputTarget,
): types.NetworkDmxOutputTarget[] {
  return targets.map((item) => (item.id === target.id ? target : item));
}

/** Returns a comparable physical output key for a target. */
export function targetOutputKey(
  target: types.NetworkDmxOutputTarget,
): string | null {
  const transport = outputTransportForNetworkDmxTarget(target);
  return transport ? outputTransportKey(transport) : null;
}

/** Returns the display text for interface IPv4 addresses. */
export function networkInterfaceAddressSummary(
  iface: types.NetworkInterfaceInfo,
): string {
  return iface.addresses.length > 0 ? iface.addresses.join(", ") : "No IPv4";
}

/** Returns the human-readable interface name, falling back to the system name. */
export function networkInterfaceDisplayName(
  iface: types.NetworkInterfaceInfo,
): string {
  return iface.friendly_name?.trim() || iface.name;
}

/** Matches an interface's IPv4 addresses against actual host listeners, including the All binding. */
export function networkInterfaceIsListening(
  iface: types.NetworkInterfaceInfo,
  listeningAddresses: string[],
): boolean {
  return iface.addresses.some((address) =>
    listeningAddresses.some(
      (listener) =>
        listener.startsWith("0.0.0.0:") || listener.startsWith(`${address}:`),
    ),
  );
}
