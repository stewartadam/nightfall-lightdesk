// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { usePropertiesContext } from "../context/context-core";

/**
 * Main PropertiesInspector component - now acts as a host for dynamic content
 */
export default function PropertiesInspectorPanel() {
  const context = usePropertiesContext();

  return (
    <div class="flex flex-col w-80 h-full bg-neutral-800 text-neutral-200 font-sans text-sm select-none w-full">
      {/* Header showing active provider */}
      <div class="flex gap-2 p-2 border-b border-neutral-700 bg-neutral-900">
        <Show
          when={context.activeProvider()}
          fallback={
            <span class="text-neutral-400">No properties available</span>
          }
        >
          {(provider) => (
            <span class="font-medium">{provider().label} Properties</span>
          )}
        </Show>
      </div>

      {/* Dynamic content area */}
      <div class="flex-1 overflow-y-auto">
        <Show when={context.activeProvider()}>
          {(provider) => <Dynamic component={provider().component} />}
        </Show>
      </div>
    </div>
  );
}
