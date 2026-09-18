// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import type { LayerNavigationRequest } from "../../../state/appStores";
import type * as types from "../../../types";
import type { LayerPanelEntry } from "../controllers/layer-panel-entries";
import LayerView from "./layer-view";

interface LayerEntryListProps {
  entries: LayerPanelEntry[];
  navigationRequest: LayerNavigationRequest | null;
  onNavigateToLayerObject: (layer: types.OutboundLayerState) => void;
  onNavigationHandled: (requestId: number) => void;
  onOpenChange: (layerKey: string, isOpen: boolean) => void;
  openLayerKeys: Set<string>;
  panelId: string;
}

/** Presents stable layer entries and delegates expanded grids to LayerView. */
export function LayerEntryList(props: LayerEntryListProps) {
  return (
    <For each={props.entries}>
      {(entry) => {
        /** Returns whether this row needs its full grid controller mounted. */
        const isLayerOpen = () =>
          props.openLayerKeys.has(entry.key) ||
          props.navigationRequest?.layerIndex === entry.index();
        return (
          <details
            open={isLayerOpen()}
            onToggle={(event) =>
              props.onOpenChange(
                entry.key,
                (event.currentTarget as HTMLDetailsElement).open,
              )
            }
            class="rounded-md border border-gray-700"
          >
            <summary class="flex cursor-pointer select-none items-center justify-between bg-neutral-800 px-4 py-2">
              <span class="flex min-w-0 items-center gap-2 text-white">
                <span class="shrink-0">Layer {entry.index()}:</span>
                <Show when={entry.summary().objectType}>
                  {(objectType) => (
                    <span class="shrink-0 rounded border border-gray-600 px-1.5 py-0.5 text-xs font-medium text-gray-300">
                      {objectType()}
                    </span>
                  )}
                </Show>
                <span class="min-w-0 truncate">
                  {entry.summary().creator || "Unnamed"}
                </span>
              </span>
              <span class="ml-3 shrink-0 text-xs text-gray-500">
                Priority: {entry.summary().priority}
              </span>
            </summary>
            <Show when={isLayerOpen()}>
              <LayerView
                contentOnly={true}
                expandedFixtures={entry.expandedFixtures}
                layer={entry.layer}
                summary={entry.summary}
                layerIndex={entry.index}
                panelId={props.panelId}
                selectedRowIndex={entry.selectedRowIndex}
                setExpandedFixtures={entry.setExpandedFixtures}
                setSelectedRowIndex={entry.setSelectedRowIndex}
                isOpen={true}
                showColumnVisibilityMenu={false}
                navigationRequest={props.navigationRequest}
                onOpenChange={(isOpen) => props.onOpenChange(entry.key, isOpen)}
                onNavigationHandled={props.onNavigationHandled}
                onNavigateToLayerObject={props.onNavigateToLayerObject}
              />
            </Show>
          </details>
        );
      }}
    </For>
  );
}
