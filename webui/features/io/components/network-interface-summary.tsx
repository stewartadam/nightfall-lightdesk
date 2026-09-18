// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, type JSX, Show } from "solid-js";
import { Table, TableScroll } from "../../../components/ui/table";
import type { NetworkInterfaceInfo } from "../../../types";
import {
  networkInterfaceAddressSummary,
  networkInterfaceDisplayName,
  networkInterfaceIsListening,
} from "../network/model";

interface NetworkInterfaceSummaryProps {
  children?: JSX.Element;
  interfaces: NetworkInterfaceInfo[];
  listeningAddresses: string[];
  currentInterfaceName: string | undefined;
  defaultInterfaceName: string | undefined;
}

/** Groups network controls with discovered interfaces and their current/default status. */
export function NetworkInterfaceSummary(props: NetworkInterfaceSummaryProps) {
  return (
    <section
      class="mb-6"
      aria-label="Network interfaces"
      data-slot="interface-summary"
    >
      <h2 class="mb-2 text-xs font-semibold uppercase text-gray-400">
        Network Interfaces
      </h2>
      <div class="overflow-hidden rounded border border-gray-800">
        {props.children}
        <Show
          when={props.interfaces.length > 0}
          fallback={
            <div class="p-3 text-xs text-gray-500">
              No network interfaces reported
            </div>
          }
        >
          <TableScroll aria-label="Network interfaces scroll area">
            <Table
              aria-label="Network interfaces"
              class="min-w-[42rem] table-fixed"
            >
              <thead>
                <tr>
                  <th scope="col" class="w-48 whitespace-nowrap text-left">
                    Interface
                  </th>
                  <th scope="col" class="w-48 whitespace-nowrap text-left">
                    Name
                  </th>
                  <th scope="col" class="w-56 whitespace-nowrap text-left">
                    Addresses
                  </th>
                  <th scope="col" class="w-64 whitespace-nowrap text-left">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.interfaces}>
                  {(networkInterface) => (
                    <tr
                      data-interface-name={networkInterface.name}
                      data-slot="network-interface-row"
                    >
                      <td>
                        <span class="block truncate">
                          {networkInterfaceDisplayName(networkInterface)}
                        </span>
                      </td>
                      <td class="font-mono">
                        <span class="block truncate">
                          {networkInterface.name}
                        </span>
                      </td>
                      <td class="font-mono">
                        <span class="block truncate">
                          {networkInterfaceAddressSummary(networkInterface)}
                        </span>
                      </td>
                      <td>
                        <div class="flex flex-wrap gap-1.5">
                          <Show
                            when={networkInterfaceIsListening(
                              networkInterface,
                              props.listeningAddresses,
                            )}
                          >
                            <span
                              class="rounded border border-blue-500/50 px-1.5 py-0.5 text-[10px] uppercase text-blue-300"
                              title="External control is listening on this interface"
                            >
                              Listening
                            </span>
                          </Show>
                          <Show
                            when={
                              networkInterface.name ===
                              props.currentInterfaceName
                            }
                          >
                            <span class="rounded border border-emerald-500/50 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">
                              Current
                            </span>
                          </Show>
                          <Show
                            when={
                              networkInterface.name ===
                              props.defaultInterfaceName
                            }
                          >
                            <span class="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] uppercase text-gray-400">
                              Default
                            </span>
                          </Show>
                          <Show
                            when={
                              networkInterface.name !==
                                props.currentInterfaceName &&
                              networkInterface.name !==
                                props.defaultInterfaceName &&
                              !networkInterfaceIsListening(
                                networkInterface,
                                props.listeningAddresses,
                              )
                            }
                          >
                            <span class="text-xs text-gray-500">Available</span>
                          </Show>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </Table>
          </TableScroll>
        </Show>
      </div>
    </section>
  );
}
