// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

export const BUILT_IN_USB_TARGET_IDS = new Set(["udmx"]);
export const DEFAULT_USB_DEVICE_ID = "default";

/** Returns whether the USB target is built into nightfall. */
export function isBuiltInUsbTarget(target: types.UsbDmxOutputTarget): boolean {
  return BUILT_IN_USB_TARGET_IDS.has(target.id);
}

/** Builds an updated USB target list by replacing one target. */
export function replaceUsbTarget(
  targets: types.UsbDmxOutputTarget[],
  target: types.UsbDmxOutputTarget,
): types.UsbDmxOutputTarget[] {
  return targets.map((item) => (item.id === target.id ? target : item));
}

/** Returns the friendly name shown for a discovered USB DMX device. */
export function usbDeviceFriendlyName(device: types.UsbDmxDeviceInfo): string {
  const manufacturer = device.manufacturer?.trim();
  const product = device.product?.trim();
  if (manufacturer && product) return `${manufacturer} ${product}`;
  if (manufacturer) return manufacturer;
  if (product) return product;

  const label = device.label
    .trim()
    .replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)(?:\s+-\s+.*)?$/, "");
  return label || device.id;
}

/** Returns the vendor/product pair shown for a discovered USB DMX device. */
export function usbDeviceVendorProduct(device: types.UsbDmxDeviceInfo): string {
  return `${device.vendor_id.toString(16).padStart(4, "0")}:${device.product_id
    .toString(16)
    .padStart(4, "0")}`;
}

/** Returns the serial descriptor shown for a discovered USB DMX device. */
export function usbDeviceSerialSummary(device: types.UsbDmxDeviceInfo): string {
  return device.serial_number?.trim() || "No serial";
}

/** Returns the serial label fragment shown in USB selector choices. */
export function usbDeviceSerialChoiceSummary(
  device: types.UsbDmxDeviceInfo,
): string {
  return usbDeviceSerialSummary(device);
}

/** Returns the physical location shown for a discovered USB DMX device. */
export function usbDeviceLocationSummary(
  device: types.UsbDmxDeviceInfo,
): string {
  return device.location?.trim() || "No location";
}

/** Returns the compact physical USB port label shown in add-row device choices. */
export function usbDevicePortSummary(device: types.UsbDmxDeviceInfo): string {
  const location = device.location?.trim();
  if (!location) return "No port";

  const busPort = /^bus\s+(.+?)\s+port\s+(.+)$/i.exec(location);
  if (busPort) return `Port ${busPort[1]}:${busPort[2]}`;

  return location;
}

/** Returns the compact physical USB port label shown in selector choices. */
export function usbDevicePortChoiceSummary(
  device: types.UsbDmxDeviceInfo,
): string {
  return usbDevicePortSummary(device).replace(/^Port\b/, "port");
}

/** Returns a conflict key for USB serial numbers that can collide. */
export function usbDeviceSerialConflictKey(
  device: types.UsbDmxDeviceInfo,
): string | undefined {
  const serial = device.serial_number?.trim();
  if (!serial) return undefined;
  return serial;
}

/** Returns USB serial keys used by more than one discovered device. */
export function usbDeviceSerialConflictKeys(
  devices: types.UsbDmxDeviceInfo[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const key = usbDeviceSerialConflictKey(device);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    Array.from(counts)
      .filter(([, count]) => count > 1)
      .map(([key]) => key),
  );
}

/** Returns whether a USB device needs its physical port shown to disambiguate it. */
export function usbDeviceHasSerialConflict(
  device: types.UsbDmxDeviceInfo,
  conflictKeys: Set<string>,
): boolean {
  const key = usbDeviceSerialConflictKey(device);
  return key !== undefined && conflictKeys.has(key);
}

/** Returns the label shown for compatible USB device selector options. */
export function usbDeviceOptionLabel(
  device: types.UsbDmxDeviceInfo,
  conflictKeys: Set<string>,
): string {
  const parts = [usbDeviceSerialChoiceSummary(device)];
  if (usbDeviceHasSerialConflict(device, conflictKeys)) {
    parts.push(usbDevicePortChoiceSummary(device));
  }
  return `${usbDeviceFriendlyName(device)} (${parts.join(", ")})`;
}

/** Extracts a field value from a comma-separated USB selector. */
export function usbSelectorField(
  deviceId: string,
  prefix: string,
): string | undefined {
  return deviceId
    .split(",")
    .map((field) => field.trim())
    .find((field) => field.startsWith(prefix))
    ?.slice(prefix.length);
}

/** Returns the saved selector detail shown when a USB device is disconnected. */
export function savedUsbDeviceDetailLabel(deviceId: string): string {
  const parts = [];
  const serial = usbSelectorField(deviceId, "serial-");
  const port = usbSelectorField(deviceId, "port-");
  if (serial) parts.push(serial);
  if (port) parts.push(`port ${port}`);
  return parts.join(", ");
}

/** Returns the label shown for a saved USB device selector. */
export function usbDeviceSelectorLabel(
  deviceId: string,
  deviceById: Map<string, types.UsbDmxDeviceInfo>,
  savedLabel?: string,
): string {
  if (deviceId === DEFAULT_USB_DEVICE_ID) {
    return "Auto (first compatible uDMX)";
  }
  const connectedDevice = deviceById.get(deviceId);
  if (connectedDevice) return usbDeviceFriendlyName(connectedDevice);

  const label = savedLabel?.trim();
  const detail = savedUsbDeviceDetailLabel(deviceId);
  if (label && detail) return `${label} (${detail})`;
  if (label) return label;
  return detail ? `${deviceId} (${detail})` : deviceId;
}

/** Returns the label to persist for a selected USB device. */
export function usbTargetDeviceLabel(
  deviceId: string,
  deviceById: Map<string, types.UsbDmxDeviceInfo>,
  savedLabel?: string,
): string | undefined {
  if (deviceId === DEFAULT_USB_DEVICE_ID) return undefined;
  const connectedDevice = deviceById.get(deviceId);
  return connectedDevice
    ? usbDeviceFriendlyName(connectedDevice)
    : savedLabel?.trim() || undefined;
}
