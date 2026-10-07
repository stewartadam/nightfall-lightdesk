// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import {
  deliveryFromMode,
  deliveryModeValidForProtocol,
  networkInterfaceAddressSummary,
  networkInterfaceDisplayName,
  shareableHosts,
  shareableUrl,
} from "./model";

/** Share links skip loopback listeners and expand the All binding to each interface address. */
test("shareableHosts lists the addresses other devices can reach", () => {
  const interfaces: types.NetworkInterfaceInfo[] = [
    { name: "lo", addresses: ["127.0.0.1"] },
    { name: "eth0", addresses: ["192.168.1.20"] },
    { name: "wlan0", addresses: ["10.0.0.5", "192.168.1.20"] },
    { name: "usb0", addresses: ["169.254.10.2"] },
  ];
  assert.deepEqual(shareableHosts(["0.0.0.0:3030"], interfaces), [
    "192.168.1.20",
    "10.0.0.5",
  ]);
  assert.deepEqual(
    shareableHosts(["192.168.1.20:3030", "127.0.0.1:3030"], interfaces),
    ["192.168.1.20"],
  );
  assert.deepEqual(shareableHosts(["127.0.0.1:3030"], interfaces), []);
});

/** The PIN travels in the fragment so the server never receives it. */
test("shareableUrl carries the PIN in the fragment", () => {
  assert.equal(shareableUrl("192.168.1.20", 3030), "http://192.168.1.20:3030/");
  assert.equal(
    shareableUrl("192.168.1.20", 3031, "042000"),
    "http://192.168.1.20:3031/#pin=042000",
  );
});

/** Verifies delivery mode projection follows the selected network protocol. */
test("network transport delivery projection preserves unicast and protocol defaults", () => {
  assert.deepEqual(
    deliveryFromMode(types.NetworkDmxProtocol.Sacn, "Unicast", "10.0.0.4"),
    { type: "Unicast", data: { ip: "10.0.0.4" } },
  );
  assert.equal(
    deliveryModeValidForProtocol(types.NetworkDmxProtocol.Sacn, "Multicast"),
    true,
  );
  assert.equal(
    deliveryModeValidForProtocol(types.NetworkDmxProtocol.ArtNet, "Multicast"),
    false,
  );
});

/** Verifies network interface labels prefer operator-facing metadata. */
test("network interface formatting uses friendly names and address fallbacks", () => {
  const iface = {
    name: "en0",
    friendly_name: "Lighting LAN",
    addresses: ["10.0.0.2", "10.0.0.3"],
  } as types.NetworkInterfaceInfo;
  assert.equal(networkInterfaceDisplayName(iface), "Lighting LAN");
  assert.equal(networkInterfaceAddressSummary(iface), "10.0.0.2, 10.0.0.3");
  assert.equal(
    networkInterfaceAddressSummary({ ...iface, addresses: [] }),
    "No IPv4",
  );
});
