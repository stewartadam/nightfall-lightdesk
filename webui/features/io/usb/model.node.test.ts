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
