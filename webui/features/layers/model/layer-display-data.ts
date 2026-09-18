// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GridColumn } from "../../../lib/data-grid-types";
import {
  createAttrValueColumns,
  type ElementRowExtension,
  type ExpandableRowExtension,
  sortRowsByIdAndType,
} from "../../../lib/datagrid";
import { COLOR_SWATCH_COLUMN_WIDTH } from "../../../lib/datagrid-color-cell";
import type { FilterableGridColumn } from "../../../lib/datagrid-filtering";
import { getFixtureAttributeNames } from "../../../lib/fixture-attributes";
import { startPerformanceMeasure } from "../../../lib/performance-marks";
import { normalizeAttributeName } from "../../../lib/utils";
import type { LayerNavigationRequest } from "../../../state/appStores";
import type * as types from "../../../types";

type DisplayRow = {
  uid: string;
  id: number;
  name: string;
  color: string;
  applicableAttributes: Set<string>;
  [key: string]:
    | number
    | string
    | Set<string>
    | boolean
    | LayerElementRow[]
    | undefined;
};

type LayerParentRow = DisplayRow &
  ExpandableRowExtension & {
    elementData?: LayerElementRow[];
    transitioning?: Set<string>;
  };

type LayerElementRow = DisplayRow &
  ElementRowExtension & {
    transitioning?: Set<string>;
  };

export type LayerDisplayRow = LayerParentRow | LayerElementRow;

export type LayerDisplayRowsData = {
  rows: LayerDisplayRow[];
  attributes: string[];
  attributeSignature: string;
};
export type LayerColumnsMemo<TRevision> = {
  attributeSignature: string;
  revision: TRevision;
  columns: GridColumn[];
};

/** Returns a stable, sorted signature for a layer attribute set. */
export function layerAttributeSignature(attributes: Iterable<string>): string {
  return JSON.stringify(Array.from(attributes).sort());
}

/** Returns Layer View columns for the supplied sorted attribute list. */
function createLayerColumns(attributes: readonly string[]): GridColumn[] {
  return createAttrValueColumns(
    Array.from(attributes),
    [
      {
        title: "ID",
        id: "id",
        width: 85,
        filter: { kind: "number", value: (row: LayerDisplayRow) => row.id },
      },
      {
        title: "Fixture",
        id: "name",
        width: 150,
        filter: { value: (row: LayerDisplayRow) => row.name },
      },
      { title: "", id: "color", width: COLOR_SWATCH_COLUMN_WIDTH },
    ] as FilterableGridColumn<LayerDisplayRow, GridColumn>[],
    {
      valueTitle: "Value",
      outputTitle: "DMX",
    },
  );
}

/** Reuses memoized columns until the attribute signature or metadata revision changes. */
export function memoizeLayerColumns<TRevision>(
  attributes: readonly string[],
  attributeSignature: string,
  revision: TRevision,
  previous?: LayerColumnsMemo<TRevision>,
): LayerColumnsMemo<TRevision> {
  if (
    previous?.attributeSignature === attributeSignature &&
    previous.revision === revision
  ) {
    return previous;
  }

  return {
    attributeSignature,
    revision,
    columns: createLayerColumns(attributes),
  };
}

/** Adds normalized parameter names from element parameter maps to an attribute set. */
function collectElementParameterAttributes(
  values:
    | readonly types.OutboundElementParameterValues[]
    | readonly types.OutboundElementComputedState[],
  attributes: Set<string>,
): void {
  for (const fixtureValues of values) {
    for (const elementParameters of fixtureValues.parameters) {
      for (const attribute of Object.keys(elementParameters)) {
        attributes.add(normalizeAttributeName(attribute));
      }
    }
  }
}

/** Returns the layer attribute names without constructing display rows or cells. */
export function collectLayerAttributeNames(
  layer: types.OutboundLayerState,
): string[] {
  const attributes = new Set<string>();
  collectElementParameterAttributes(layer.asserted_absolute_values, attributes);
  collectElementParameterAttributes(layer.asserted_relative_values, attributes);
  collectElementParameterAttributes(layer.computed_values, attributes);
  return Array.from(attributes).sort();
}

/** Returns whether a layer has any rendered fixture rows. */
export function layerHasDisplayContent(
  layer: types.OutboundLayerState,
): boolean {
  return (
    layer.asserted_absolute_values.length > 0 ||
    layer.asserted_relative_values.length > 0 ||
    layer.computed_values.length > 0
  );
}

/** Returns the largest element count present for one fixture in a layer. */
function layerFixtureElementCount(
  absSource: types.OutboundElementParameterValues | undefined,
  relSource: types.OutboundElementParameterValues | undefined,
  outSource: types.OutboundElementComputedState | undefined,
): number {
  return Math.max(
    absSource?.parameters?.length ?? 0,
    relSource?.parameters?.length ?? 0,
    outSource?.parameters?.length ?? 0,
  );
}

/** Returns a stable fixture metadata summary for layer row construction. */
function fixtureStructureRevision(fixture: types.Fixture): unknown[] {
  return [
    fixture.identifiers.id,
    fixture.model,
    Array.from(getFixtureAttributeNames(fixture)).sort(),
  ];
}

/** Returns the row and column structure revision for a layer without building rows. */
export function layerDisplayStructureRevision(
  layer: types.OutboundLayerState,
  expanded: Set<string>,
  fixtureList: Record<string, types.Fixture>,
): string {
  const elementCounts = new Map<string, number>();
  /** Records the largest parameter row count found for each fixture UID. */
  const recordElementCount = (
    values:
      | readonly types.OutboundElementParameterValues[]
      | readonly types.OutboundElementComputedState[],
  ): void => {
    for (const item of values) {
      elementCounts.set(
        item.fixture_uid,
        Math.max(
          elementCounts.get(item.fixture_uid) ?? 0,
          item.parameters.length,
        ),
      );
    }
  };

  recordElementCount(layer.asserted_absolute_values);
  recordElementCount(layer.asserted_relative_values);
  recordElementCount(layer.computed_values);

  const fixtures = Array.from(elementCounts.entries())
    .sort(([leftUid], [rightUid]) => leftUid.localeCompare(rightUid))
    .map(([fixtureUid, elementCount]) => {
      const fixture = fixtureList[fixtureUid];
      return [
        fixtureUid,
        elementCount,
        expanded.has(fixtureUid),
        fixture ? fixtureStructureRevision(fixture) : null,
      ];
    });

  return JSON.stringify({
    attributes: collectLayerAttributeNames(layer),
    fixtures,
  });
}

/** Flattens parent rows with the current fixture expansion state. */
function flattenLayerRows(
  parentRows: LayerParentRow[],
  expanded: Set<string>,
): LayerDisplayRow[] {
  const displayRows: LayerDisplayRow[] = [];
  for (const parent of parentRows) {
    const isExpanded = expanded.has(parent.uid);
    const displayParent =
      parent.isExpanded === isExpanded ? parent : { ...parent, isExpanded };
    displayRows.push(displayParent);
    if (parent.hasElements && isExpanded && parent.elementData) {
      displayRows.push(...parent.elementData);
    }
  }
  return displayRows;
}

/** Builds Layer View row and column structure without materializing per-cell values. */
export function createLayerDisplayStructure(
  layer: types.OutboundLayerState,
  expanded: Set<string>,
  fixtureList: Record<string, types.Fixture>,
): LayerDisplayRowsData {
  const finishPerformanceMeasure = startPerformanceMeasure(
    "layer-view.create-display-structure",
  );
  const empty = { rows: [], attributes: [], attributeSignature: "[]" };
  if (!layer) {
    finishPerformanceMeasure({ layerPresent: false });
    return empty;
  }

  const absMap = new Map<string, types.OutboundElementParameterValues>();
  for (const item of layer.asserted_absolute_values) {
    absMap.set(item.fixture_uid, item);
  }

  const relMap = new Map<string, types.OutboundElementParameterValues>();
  for (const item of layer.asserted_relative_values) {
    relMap.set(item.fixture_uid, item);
  }

  const outMap = new Map<string, types.OutboundElementComputedState>();
  for (const item of layer.computed_values) {
    outMap.set(item.fixture_uid, item);
  }

  const parentRows: LayerParentRow[] = [];
  const allFixtureUids = new Set<string>([
    ...absMap.keys(),
    ...relMap.keys(),
    ...outMap.keys(),
  ]);

  for (const fixtureUid of allFixtureUids) {
    const fixture = fixtureList[fixtureUid];
    if (!fixture) continue;

    const elementCount = layerFixtureElementCount(
      absMap.get(fixtureUid),
      relMap.get(fixtureUid),
      outMap.get(fixtureUid),
    );
    if (elementCount === 0) continue;

    const applicableAttributes = getFixtureAttributeNames(fixture);
    const elements: LayerElementRow[] = [];
    for (let elementIdx = 0; elementIdx < elementCount; elementIdx++) {
      elements.push({
        type: "element",
        fixtureUid,
        elementIndex: elementIdx + 1,
        uid: `${fixtureUid}-${elementIdx + 1}`,
        id: fixture.identifiers.id,
        name: `${fixture.identifiers.id}.${elementIdx + 1}`,
        color: "rgb(0, 0, 0)",
        applicableAttributes,
      });
    }

    parentRows.push({
      type: "parent",
      uid: fixtureUid,
      id: fixture.identifiers.id,
      name: fixture.model,
      color: "rgb(0, 0, 0)",
      hasElements: elementCount > 1,
      isExpanded: false,
      elementData: elements,
      applicableAttributes,
    });
  }

  sortRowsByIdAndType(parentRows);

  const attributes = collectLayerAttributeNames(layer);
  const rows = flattenLayerRows(parentRows, expanded);
  finishPerformanceMeasure({
    layerPresent: true,
    rowCount: rows.length,
    columnCount: attributes.length,
  });

  return {
    rows,
    attributes,
    attributeSignature: layerAttributeSignature(attributes),
  };
}

/** Locates the current rendered row for a Layer View navigation request. */
export function findRequestedRowIndex(
  rows: LayerDisplayRow[],
  request: LayerNavigationRequest,
): number {
  if (request.elementIndex !== undefined) {
    return rows.findIndex(
      (row) =>
        row.type === "element" &&
        row.fixtureUid === request.fixtureUid &&
        row.elementIndex === request.elementIndex,
    );
  }

  return rows.findIndex(
    (row) => row.type === "parent" && row.uid === request.fixtureUid,
  );
}
