// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types/index";
import {
  networkOutputFailureForTarget,
  networkOutputFailureSummary,
} from "./network-dmx-output-health";

/**
 * Builds an Art-Net unicast target for network output health tests.
 */
function artnetTarget(ip: string): types.NetworkDmxOutputTarget {
  return {
    id: "tubes1",
    protocol: types.NetworkDmxProtocol.ArtNet,
    delivery: { type: "Unicast", data: { ip } },
  };
}

test("networkOutputFailureForTarget matches Art-Net unicast failures by destination", () => {
  const failure: types.NetworkOutputSendFailure = {
    protocol: "ArtNet",
    universe: 1,
    destination_ip: "2.0.0.50",
    error_kind: "HostUnreachable",
    message: "No route to host",
    count: 3,
  };

  assert.equal(
    networkOutputFailureForTarget(artnetTarget("2.0.0.50"), [failure]),
    failure,
  );
  assert.equal(
    networkOutputFailureForTarget(artnetTarget("2.0.0.51"), [failure]),
    undefined,
  );
});

test("networkOutputFailureForTarget matches broadcast failures without destination", () => {
  const failure: types.NetworkOutputSendFailure = {
    protocol: "ArtNet",
    universe: 1,
    destination_ip: null as unknown as string,
    error_kind: "HostUnreachable",
    message: "No route to host",
    count: 3,
  };

  assert.equal(
    networkOutputFailureForTarget(
      {
        id: "artnet",
        protocol: types.NetworkDmxProtocol.ArtNet,
        delivery: { type: "ArtNetBroadcast" },
      },
      [failure],
    ),
    failure,
  );
});

test("networkOutputFailureSummary includes destination, message, universe, and count", () => {
  assert.equal(
    networkOutputFailureSummary({
      protocol: "ArtNet",
      universe: 1,
      destination_ip: [2, 0, 0, 50] as unknown as string,
      error_kind: "HostUnreachable",
      message: "No route to host",
      count: 3,
    }),
    "HostUnreachable to 2.0.0.50: No route to host (universe 1, 3x)",
  );
});
