// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import * as types from "../types";
import {
  defaultDeliveryForProtocol,
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  ipv4AddressToString,
  isValidIpv4Address,
  isValidNetworkDmxTargetId,
  isValidUsbDmxTargetId,
  normalizeNetworkDmxOutputs,
  normalizeUsbDmxOutputs,
  outputTransportForOutputTargetId,
  refreshReservedOutputTargetKeywords,
} from "./network-dmx-output-targets";

/** Verifies built-in targets are present in default Network DMX settings. */
test("default network dmx outputs include built-ins", () => {
  const outputs = defaultNetworkDmxOutputs();

  assert.deepEqual(
    outputs.targets.map((target) => target.id),
    ["sacn", "artnet"],
  );
});

/** Verifies built-in targets are present in default USB DMX settings. */
test("default usb dmx outputs include built-ins", () => {
  const outputs = defaultUsbDmxOutputs();

  assert.deepEqual(outputs.targets, [
    { id: "udmx", device: "default", device_label: undefined },
  ]);
});

/** Verifies command target IDs accept only CLI-safe non-reserved values. */
test("validates network dmx target ids", async () => {
  await refreshReservedOutputTargetKeywords();

  assert.equal(isValidNetworkDmxTargetId("sacnnode4"), true);
  assert.equal(isValidNetworkDmxTargetId("node-4"), true);
  assert.equal(isValidNetworkDmxTargetId("Fixture"), false);
  assert.equal(isValidNetworkDmxTargetId("fixture"), false);
  assert.equal(isValidNetworkDmxTargetId("4node"), false);
});

/** Verifies USB target IDs accept uDMX and reject network built-ins. */
test("validates usb dmx target ids", async () => {
  await refreshReservedOutputTargetKeywords();

  assert.equal(isValidUsbDmxTargetId("udmx"), true);
  assert.equal(isValidUsbDmxTargetId("front-usb"), true);
  assert.equal(isValidUsbDmxTargetId("sacn"), false);
  assert.equal(isValidUsbDmxTargetId("Fixture"), false);
});

/** Verifies IPv4 validation accepts only dotted decimal addresses. */
test("validates ipv4 addresses", () => {
  assert.equal(isValidIpv4Address("192.168.1.50"), true);
  assert.equal(isValidIpv4Address([192, 168, 1, 50]), true);
  assert.equal(isValidIpv4Address("256.168.1.50"), false);
  assert.equal(isValidIpv4Address("192.168.1"), false);
});

/** Verifies backend-serialized IPv4 octets are rendered as dotted text. */
test("formats backend ipv4 address values", () => {
  assert.equal(ipv4AddressToString([10, 0, 0, 4]), "10.0.0.4");
  assert.equal(ipv4AddressToString({ 0: 10, 1: 0, 2: 0, 3: 4 }), "10.0.0.4");
  assert.equal(ipv4AddressToString({ data: [10, 0, 0, 4] }), "10.0.0.4");
});

/** Verifies command payload normalization converts echoed IP octets back to text. */
test("normalizes network dmx output ip values", () => {
  const normalized = normalizeNetworkDmxOutputs({
    targets: [
      {
        id: "node1",
        protocol: types.NetworkDmxProtocol.Sacn,
        delivery: {
          type: "Unicast",
          data: { ip: [10, 0, 0, 4] as unknown as string },
        },
      },
    ],
  });

  const target = normalized.targets.find((target) => target.id === "node1");
  assert.deepEqual(target?.delivery, {
    type: "Unicast",
    data: { ip: "10.0.0.4" },
  });
});

/** Verifies Network DMX normalization restores built-ins from explicit empty settings. */
test("normalizes network dmx outputs restores built-ins", () => {
  const normalized = normalizeNetworkDmxOutputs({ targets: [] });

  assert.deepEqual(
    normalized.targets.map((target) => target.id),
    ["sacn", "artnet"],
  );
});

/** Verifies Network DMX normalization removes duplicate concrete transports. */
test("normalizes network dmx outputs removes duplicate transports", () => {
  const normalized = normalizeNetworkDmxOutputs({
    targets: [
      {
        id: "sacn",
        protocol: types.NetworkDmxProtocol.Sacn,
        delivery: {
          type: "Unicast",
          data: { ip: "10.0.0.4" },
        },
      },
      {
        id: "node1",
        protocol: types.NetworkDmxProtocol.Sacn,
        delivery: {
          type: "Unicast",
          data: { ip: "10.0.0.4" },
        },
      },
    ],
  });

  assert.equal(
    normalized.targets.some((target) => target.id === "node1"),
    false,
  );
});

/** Verifies USB output normalization trims device identifiers. */
test("normalizes usb dmx output device values", () => {
  const normalized = normalizeUsbDmxOutputs({
    targets: [
      {
        id: "front-usb",
        device: " usb-serial-1 ",
        device_label: " Anyma uDMX ",
      },
    ],
  });

  const target = normalized.targets.find((target) => target.id === "front-usb");
  assert.deepEqual(target, {
    id: "front-usb",
    device: "usb-serial-1",
    device_label: "Anyma uDMX",
  });
});

/** Verifies USB normalization restores the built-in uDMX target from explicit empty settings. */
test("normalizes usb dmx outputs restores built-ins", () => {
  const normalized = normalizeUsbDmxOutputs({ targets: [] });

  assert.deepEqual(normalized.targets, defaultUsbDmxOutputs().targets);
});

/** Verifies USB normalization removes duplicate concrete devices. */
test("normalizes usb dmx outputs removes duplicate devices", () => {
  const normalized = normalizeUsbDmxOutputs({
    targets: [
      {
        id: "udmx",
        device: "usb-serial-1",
        device_label: undefined,
      },
      {
        id: "front-usb",
        device: " usb-serial-1 ",
        device_label: undefined,
      },
    ],
  });

  assert.equal(
    normalized.targets.some((target) => target.id === "front-usb"),
    false,
  );
});

/** Verifies protocol-specific default delivery labels. */
test("chooses protocol default delivery", () => {
  assert.deepEqual(defaultDeliveryForProtocol(types.NetworkDmxProtocol.Sacn), {
    type: "SacnMulticast",
  });
  assert.deepEqual(
    defaultDeliveryForProtocol(types.NetworkDmxProtocol.ArtNet),
    {
      type: "ArtNetBroadcast",
    },
  );
});

/** Verifies named targets resolve to concrete output transports. */
test("resolves network dmx target ids to output transports", () => {
  const transport = outputTransportForOutputTargetId(
    "artnode4",
    {
      targets: [
        {
          id: "artnode4",
          protocol: types.NetworkDmxProtocol.ArtNet,
          delivery: {
            type: "Unicast",
            data: { ip: "10.0.0.4" },
          },
        },
      ],
    },
    defaultUsbDmxOutputs(),
  );

  assert.deepEqual(transport, {
    type: "ArtNet",
    data: {
      mode: { type: "Unicast", data: { ip: "10.0.0.4" } },
    },
  });
});

/** Verifies named USB targets resolve through the combined output target helper. */
test("resolves usb dmx target ids to output transports", () => {
  const transport = outputTransportForOutputTargetId(
    "front-usb",
    defaultNetworkDmxOutputs(),
    {
      targets: [
        {
          id: "front-usb",
          device: "usb-serial-1",
          device_label: "Anyma uDMX",
        },
      ],
    },
  );

  assert.deepEqual(transport, {
    type: "Udmx",
    data: { device: "usb-serial-1" },
  });
});

/** Verifies the built-in uDMX target is resolved from USB defaults. */
test("resolves built-in udmx target through usb outputs", () => {
  const transport = outputTransportForOutputTargetId(
    "udmx",
    { targets: [] },
    { targets: [] },
  );

  assert.deepEqual(transport, {
    type: "Udmx",
    data: { device: "default" },
  });
});
