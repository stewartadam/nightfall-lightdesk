// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal, type Setter } from "solid-js";
import type * as types from "../../../types";

export type LayerPanelEntrySummary = {
  creator: string;
  objectType?: types.ObjectType;
  priority: types.Priority;
};

export type LayerPanelEntry = {
  key: string;
  layer: Accessor<types.OutboundLayerState>;
  setLayer: Setter<types.OutboundLayerState>;
  summary: Accessor<LayerPanelEntrySummary>;
  setSummary: Setter<LayerPanelEntrySummary>;
  index: Accessor<number>;
  setIndex: Setter<number>;
  expandedFixtures: Accessor<Set<string>>;
  setExpandedFixtures: Setter<Set<string>>;
  selectedRowIndex: Accessor<number | null>;
  setSelectedRowIndex: Setter<number | null>;
};

/** Returns the stable logical identity for one layer row across stack reordering. */
export function getLayerIdentityKey(layer: types.OutboundLayerState): string {
  return layer.object_ref === undefined
    ? `creator:${layer.creator}`
    : `object:${JSON.stringify(layer.object_ref)}`;
}

/** Returns a row key that disambiguates duplicate logical layers in one snapshot. */
export function getLayerExpansionKey(
  identity: string,
  occurrence: number,
): string {
  return `${identity}:${occurrence}`;
}

/** Returns the source object type associated with a layer, when available. */
function layerObjectType(
  layer: types.OutboundLayerState,
): types.ObjectType | undefined {
  return layer.object_ref?.data.object_type;
}

/** Returns the fields needed by a collapsed layer-row header. */
export function summarizeLayer(
  layer: types.OutboundLayerState,
): LayerPanelEntrySummary {
  return {
    creator: layer.creator,
    objectType: layerObjectType(layer),
    priority: layer.priority,
  };
}

/** Returns whether two collapsed row summaries render the same header. */
export function layerSummariesEqual(
  left: LayerPanelEntrySummary,
  right: LayerPanelEntrySummary,
): boolean {
  return (
    left.creator === right.creator &&
    left.objectType === right.objectType &&
    left.priority === right.priority
  );
}

/** Returns whether two ordered key lists contain the same entries. */
export function layerKeyListsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

/** Creates a stable entry whose layer snapshot can refresh without remounting its row. */
export function createLayerPanelEntry(
  key: string,
  layer: types.OutboundLayerState,
  index: number,
): LayerPanelEntry {
  const [entryLayer, setEntryLayer] = createSignal(layer);
  const [entrySummary, setEntrySummary] = createSignal(summarizeLayer(layer));
  const [entryIndex, setEntryIndex] = createSignal(index);
  const [expandedFixtures, setExpandedFixtures] = createSignal<Set<string>>(
    new Set(),
  );
  const [selectedRowIndex, setSelectedRowIndex] = createSignal<number | null>(
    null,
  );
  return {
    key,
    layer: entryLayer,
    setLayer: setEntryLayer,
    summary: entrySummary,
    setSummary: setEntrySummary,
    index: entryIndex,
    setIndex: setEntryIndex,
    expandedFixtures,
    setExpandedFixtures,
    selectedRowIndex,
    setSelectedRowIndex,
  };
}
