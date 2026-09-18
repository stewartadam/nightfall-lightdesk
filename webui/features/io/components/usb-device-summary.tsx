// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import { Table, TableScroll } from "../../../components/ui/table";
import type { UsbDmxDeviceInfo } from "../../../types";
import {
  usbDeviceFriendlyName,
  usbDeviceLocationSummary,
  usbDeviceSerialSummary,
  usbDeviceVendorProduct,
} from "../usb/model";

interface UsbDeviceSummaryProps {
  devices: UsbDmxDeviceInfo[];
}

/** Renders the compatible USB devices currently reported by the backend. */
export function UsbDeviceSummary(props: UsbDeviceSummaryProps) {
  return (
    <section
      class="mb-6"
      aria-label="Connected compatible USB devices"
      data-slot="usb-device-summary"
    >
      <h3 class="mb-2 text-xs font-semibold uppercase text-gray-400">
        Connected USB Devices
      </h3>
      <Show
        when={props.devices.length > 0}
        fallback={
          <div class="text-xs text-gray-500">
            No compatible USB devices reported
          </div>
        }
      >
        <TableScroll
          aria-label="Connected USB devices scroll area"
          class="rounded border border-gray-800"
        >
          <Table
            aria-label="Connected USB devices"
            class="min-w-[42rem] table-fixed"
          >
            <thead>
              <tr>
                <th scope="col" class="w-56 whitespace-nowrap text-left">
                  Device
                </th>
                <th scope="col" class="w-28 whitespace-nowrap text-left">
                  USB ID
                </th>
                <th scope="col" class="w-40 whitespace-nowrap text-left">
                  Serial
                </th>
                <th scope="col" class="w-44 whitespace-nowrap text-left">
                  Location
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.devices}>
                {(device) => (
                  <tr>
                    <td>
                      <span class="block truncate">
                        {usbDeviceFriendlyName(device)}
                      </span>
                    </td>
                    <td class="font-mono">
                      <span class="block truncate">
                        {usbDeviceVendorProduct(device)}
                      </span>
                    </td>
                    <td class="font-mono">
                      <span class="block truncate">
                        {usbDeviceSerialSummary(device)}
                      </span>
                    </td>
                    <td class="font-mono">
                      <span class="block truncate">
                        {usbDeviceLocationSummary(device)}
                      </span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </Table>
        </TableScroll>
      </Show>
    </section>
  );
}
