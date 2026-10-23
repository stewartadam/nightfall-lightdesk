// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, onCleanup, onMount } from "solid-js";
import { Collapsible } from "../../../components/ui/collapsible";
import type { LayerState } from "../../../lib/ws/types";
import type { LayerNavigationRequest } from "../../../state/appStores";
import type { LayerPanelEntry } from "../controllers/layer-panel-entries";
import { LayerSectionTitle } from "./layer-section-title";
import LayerView from "./layer-view";

interface LayerEntryListProps {
  entries: LayerPanelEntry[];
  navigationRequest: LayerNavigationRequest | null;
  onNavigateToLayerObject: (layer: LayerState) => void;
  onNavigationHandled: (requestId: number) => void;
  onOpenChange: (layerKey: string, isOpen: boolean) => void;
  onVisibleLayersChange: (keys: Set<string>) => void;
  openLayerKeys: Set<string>;
  panelId: string;
  scrollRoot: HTMLDivElement;
}

/** Presents stable layer entries and delegates expanded grids to LayerView. */
export function LayerEntryList(props: LayerEntryListProps) {
  const observedLayers = new Map<Element, string>();
  const visibleLayers = new Set<string>();
  let observer: IntersectionObserver | undefined;
  let disposed = false;

  /** Limits live snapshots to layer rows intersecting this panel's scroll viewport. */
  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const key = observedLayers.get(entry.target);
          if (key === undefined) continue;
          if (entry.isIntersecting && !visibleLayers.has(key)) {
            visibleLayers.add(key);
            changed = true;
          } else if (!entry.isIntersecting && visibleLayers.delete(key)) {
            changed = true;
          }
        }
        if (changed) props.onVisibleLayersChange(new Set(visibleLayers));
      },
      { root: props.scrollRoot },
    );
    for (const element of observedLayers.keys()) observer.observe(element);
  });

  /** Releases the old viewport and its visible keys when the layer list disappears. */
  onCleanup(() => {
    disposed = true;
    observer?.disconnect();
    observedLayers.clear();
    visibleLayers.clear();
    props.onVisibleLayersChange(new Set());
  });

  return (
    <For each={props.entries}>
      {(entry) => {
        let element: HTMLDivElement | undefined;
        /** Stops tracking removed layers without retaining stale visibility keys. */
        onCleanup(() => {
          if (element) {
            observer?.unobserve(element);
            observedLayers.delete(element);
          }
          if (visibleLayers.delete(entry.key) && !disposed) {
            props.onVisibleLayersChange(new Set(visibleLayers));
          }
        });
        /** Returns whether this row needs its full grid controller mounted. */
        const isLayerOpen = () =>
          props.openLayerKeys.has(entry.key) ||
          props.navigationRequest?.layerIndex === entry.index();
        return (
          <Collapsible
            ref={(node) => {
              element = node;
              observedLayers.set(node, entry.key);
              observer?.observe(node);
            }}
            lazy
            open={isLayerOpen()}
            onOpenChange={(isOpen) => props.onOpenChange(entry.key, isOpen)}
            title={
              <LayerSectionTitle
                index={entry.index()}
                summary={entry.summary()}
              />
            }
            actions={
              <span class="text-xs text-gray-500">
                Priority: {entry.summary().priority}
              </span>
            }
          >
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
          </Collapsible>
        );
      }}
    </For>
  );
}
