// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import type { LayerPanelEntrySummary } from "../controllers/layer-panel-entries";

/** Labels a collapsible layer section with its stack index, object type badge and creator. */
export function LayerSectionTitle(props: {
  index: number;
  summary: LayerPanelEntrySummary;
}) {
  return (
    <span class="flex min-w-0 items-center gap-2 text-white">
      <span class="shrink-0">Layer {props.index}:</span>
      <Show when={props.summary.objectType}>
        {(objectType) => (
          <span class="shrink-0 rounded border border-gray-600 px-1.5 py-0.5 text-xs font-medium text-gray-300">
            {objectType()}
          </span>
        )}
      </Show>
      <span class="min-w-0 truncate">{props.summary.creator || "Unnamed"}</span>
    </span>
  );
}
