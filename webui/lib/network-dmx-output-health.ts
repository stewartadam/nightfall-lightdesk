// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../types";
import { ipv4AddressToString } from "./network-dmx-output-targets";

/**
 * Returns the protocol label used by network output failure metrics for a target.
 */
function networkOutputFailureProtocol(
  target: types.NetworkDmxOutputTarget,
): string {
  return target.protocol === types.NetworkDmxProtocol.ArtNet
    ? "ArtNet"
    : "Sacn";
}

/**
 * Returns the recent send failure that applies to a Network DMX target.
 */
export function networkOutputFailureForTarget(
  target: types.NetworkDmxOutputTarget,
  failures: types.NetworkOutputSendFailure[],
): types.NetworkOutputSendFailure | undefined {
  return failures.find((failure) => {
    if (failure.protocol !== networkOutputFailureProtocol(target)) {
      return false;
    }
    const targetIp =
      target.delivery.type === "Unicast"
        ? ipv4AddressToString(target.delivery.data.ip)
        : "";
    if (!targetIp) {
      return failure.destination_ip == null;
    }
    return ipv4AddressToString(failure.destination_ip) === targetIp;
  });
}

/**
 * Returns a compact operator-facing summary for a send failure.
 */
export function networkOutputFailureSummary(
  failure: types.NetworkOutputSendFailure,
): string {
  const destination = failure.destination_ip
    ? ` to ${ipv4AddressToString(failure.destination_ip)}`
    : "";
  return `${failure.error_kind}${destination}: ${failure.message} (universe ${failure.universe}, ${failure.count}x)`;
}
