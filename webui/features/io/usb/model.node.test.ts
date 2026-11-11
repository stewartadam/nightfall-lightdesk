// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import {
  resolveUsbTargetDevices,
  savedUsbDeviceDetailLabel,
  usbDeviceFriendlyName,
  usbDeviceOptionLabel,
  usbDeviceSerialConflictKeys,
  usbTargetDeviceLabel,
} from "./model";

const DEVICE = {
  id: "serial-ABC,port-1:2",
  label: "uDMX (16c0:05dc) - bus 1 port 2",
  manufacturer: "Anyma",
  product: "uDMX",
  serial_number: "ABC",
  location: "bus 1 port 2",
  vendor_id: 0x16c0,
  product_id: 0x05dc,
} as types.UsbDmxDeviceInfo;

/** Verifies USB device formatting uses discovered descriptors and saved selectors. */
test("USB device labels preserve friendly and disconnected selector details", () => {
  assert.equal(usbDeviceFriendlyName(DEVICE), "Anyma uDMX");
  assert.equal(
    savedUsbDeviceDetailLabel("serial-ABC,port-1:2"),
    "ABC, port 1:2",
  );
  assert.equal(
    usbTargetDeviceLabel(DEVICE.id, new Map([[DEVICE.id, DEVICE]])),
    "Anyma uDMX",
  );
});

/** Verifies duplicate serials gain physical-port disambiguation in selector labels. */
test("USB selector labels include ports only for conflicting serials", () => {
  const secondDevice = {
    ...DEVICE,
    id: "serial-ABC,port-1:3",
    location: "bus 1 port 3",
  };
  const conflicts = usbDeviceSerialConflictKeys([DEVICE, secondDevice]);
  assert.deepEqual([...conflicts], ["ABC"]);
  assert.equal(
    usbDeviceOptionLabel(DEVICE, conflicts),
    "Anyma uDMX (ABC, port 1:2)",
  );
});

/** Builds an attached FTDI clone sharing serial AB0KT9HX on the given port. */
function ftdiClone(port: string): types.UsbDmxDeviceInfo {
  return {
    id: `id-0403:6001,serial-AB0KT9HX,port-02:${port}`,
    label: `FTDI FT232R USB UART (0403:6001) - serial AB0KT9HX`,
    manufacturer: "FTDI",
    product: "FT232R USB UART",
    serial_number: "AB0KT9HX",
    location: `bus 02 port ${port}`,
    vendor_id: 0x0403,
    product_id: 0x6001,
  } as types.UsbDmxDeviceInfo;
}

/** Builds a USB target saved with the given selector. */
function usbTarget(id: string, device: string): types.UsbDmxOutputTarget {
  return { id, device } as types.UsbDmxOutputTarget;
}

/** Verifies clones sharing a serial keep their own targets as either one is attached or removed. */
test("USB target resolution keeps clones on their saved ports", () => {
  const left = usbTarget("left", "id-0403:6001,serial-AB0KT9HX,port-02:1");
  const right = usbTarget("right", "id-0403:6001,serial-AB0KT9HX,port-02:2");

  const both = resolveUsbTargetDevices(
    [left, right],
    [ftdiClone("2"), ftdiClone("1")],
  );
  assert.equal(both.get("left")?.location, "bus 02 port 1");
  assert.equal(both.get("right")?.location, "bus 02 port 2");

  const rightOnly = resolveUsbTargetDevices([left, right], [ftdiClone("2")]);
  assert.equal(rightOnly.get("left"), undefined);
  assert.equal(rightOnly.get("right")?.location, "bus 02 port 2");
});

/** Verifies a unique serial follows its device to a new port and serial-only selectors resolve. */
test("USB target resolution falls back to unique serials", () => {
  const moved = resolveUsbTargetDevices(
    [usbTarget("udmx", "id-0403:6001,serial-AB0KT9HX,port-02:1")],
    [ftdiClone("3")],
  );
  assert.equal(moved.get("udmx")?.location, "bus 02 port 3");

  const serialOnly = usbTarget("udmx", "id-0403:6001,serial-AB0KT9HX");
  assert.equal(
    resolveUsbTargetDevices([serialOnly], [ftdiClone("1")]).get("udmx")
      ?.location,
    "bus 02 port 1",
  );
  assert.equal(
    resolveUsbTargetDevices([serialOnly], [ftdiClone("1"), ftdiClone("2")]).get(
      "udmx",
    ),
    undefined,
  );
});

/** Verifies the automatic selector takes a uDMX left over by named targets, never an FTDI device. */
test("USB target resolution gives the default target the first free uDMX", () => {
  const udmx = (port: string) =>
    ({
      ...DEVICE,
      id: `id-16c0:05dc,serial-ABC${port},port-1:${port}`,
      serial_number: `ABC${port}`,
      location: `bus 1 port ${port}`,
    }) as types.UsbDmxDeviceInfo;
  const resolved = resolveUsbTargetDevices(
    [
      usbTarget("udmx", "default"),
      usbTarget("stage", "id-16c0:05dc,serial-ABC1,port-1:1"),
    ],
    [ftdiClone("3"), udmx("1"), udmx("2")],
  );

  assert.equal(resolved.get("stage")?.location, "bus 1 port 1");
  assert.equal(resolved.get("udmx")?.location, "bus 1 port 2");
});
