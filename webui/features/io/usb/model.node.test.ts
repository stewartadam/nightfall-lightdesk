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
  savedUsbDeviceDetailLabel,
  usbDeviceFriendlyName,
  usbDeviceOptionLabel,
  usbDeviceSerialConflictKeys,
  usbDevicesSharingSerials,
  usbTargetDeviceLabel,
  usbTargetStatusView,
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

/** Verifies adapters are grouped only when more than one reports the same serial number. */
test("USB devices sharing a serial are grouped by serial", () => {
  const twin = { ...DEVICE, id: "serial-ABC,port-1:3" };
  const other = { ...DEVICE, id: "serial-XYZ,port-1:4", serial_number: "XYZ" };

  assert.deepEqual(usbDevicesSharingSerials([DEVICE, other, twin]), [
    { serial: "ABC", devices: [DEVICE, twin] },
  ]);
  assert.deepEqual(usbDevicesSharingSerials([DEVICE, other]), []);
});

/** Verifies each backend status maps to its row text and the adapter its fix binds. */
test("USB target status view offers a fix for moved and ambiguous adapters", () => {
  const target = {
    id: "left",
    device: "serial-ABC,port-1:1",
  } as types.UsbDmxOutputTarget;
  const deviceById = new Map([[DEVICE.id, DEVICE]]);

  assert.deepEqual(
    usbTargetStatusView(
      target,
      { type: "Connected", data: { device: DEVICE.id } },
      deviceById,
    ),
    { label: "Configured", kind: "valid" },
  );
  assert.deepEqual(
    usbTargetStatusView(
      target,
      { type: "Moved", data: { device: DEVICE.id } },
      deviceById,
    ).fix,
    { label: "Update port", device: DEVICE.id },
  );
  const choice = usbTargetStatusView(
    target,
    { type: "NeedsChoice", data: { device: DEVICE.id } },
    deviceById,
  );
  assert.equal(choice.kind, "warning");
  assert.match(choice.detail ?? "", /port 1:2/);
  assert.deepEqual(choice.fix, { label: "Use adapter", device: DEVICE.id });
  assert.equal(
    usbTargetStatusView(target, { type: "Missing" }, deviceById).fix,
    undefined,
  );
});
