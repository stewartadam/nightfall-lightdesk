// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GridCell } from "../../../lib/data-grid-types";
import {
  applyFixtureValueSourceStyling,
  createAttributeValueCell,
} from "../../../lib/datagrid";
import { fixtureValueSourceForLayer } from "../../../lib/fixture-value-state";
import {
  normalizeAttributeName,
  resolveParameterValue,
} from "../../../lib/utils";
import type * as types from "../../../types";
import type { LayerDisplayRow } from "./layer-display-data";

export interface LayerValueMaps {
  absolute: Map<
    string,
    types.OutboundLayerState["asserted_absolute_values"][number]
  >;
  relative: Map<
    string,
    types.OutboundLayerState["asserted_relative_values"][number]
  >;
  output: Map<string, types.OutboundLayerState["computed_values"][number]>;
  transitioning: Map<
    string,
    types.OutboundLayerState["computed_transitioning"][number]
  >;
  sourceState: {
    winningSource: ReturnType<typeof fixtureValueSourceForLayer>;
    hasShadowedManual: false;
  };
  isReleasing: boolean;
}

/** Indexes one layer snapshot by fixture UID for visible-cell lookups. */
export function createLayerValueMaps(
  layer: types.OutboundLayerState,
): LayerValueMaps {
  return {
    absolute: new Map(
      layer.asserted_absolute_values.map((item) => [item.fixture_uid, item]),
    ),
    relative: new Map(
      layer.asserted_relative_values.map((item) => [item.fixture_uid, item]),
    ),
    output: new Map(
      layer.computed_values.map((item) => [item.fixture_uid, item]),
    ),
    transitioning: new Map(
      layer.computed_transitioning.map((item) => [item.fixture_uid, item]),
    ),
    sourceState: {
      winningSource: fixtureValueSourceForLayer(layer),
      hasShadowedManual: false,
    },
    isReleasing: layer.is_releasing,
  };
}

interface LayerCellProjectionOptions {
  fixtureList: Record<string, types.Fixture>;
  isSequenceLayer: boolean;
  maps: LayerValueMaps;
}

export interface LayerAttributeCellResult {
  cell?: GridCell;
  transitioning: boolean;
}

export interface LayerParentCellResult extends LayerAttributeCellResult {
  conflict: boolean;
}

/** Builds current value, output, color, and aggregate cells for one layer snapshot. */
export function createLayerCellProjection(options: LayerCellProjectionOptions) {
  /** Finds a parameter entry by normalized attribute name. */
  const findNormalizedEntry = <T>(
    parameters: Record<string, T> | undefined,
    attribute: string,
  ): T | undefined => {
    if (!parameters) return undefined;
    for (const [rawAttribute, value] of Object.entries(parameters)) {
      if (normalizeAttributeName(rawAttribute) === attribute) {
        return value;
      }
    }
    return undefined;
  };

  /** Creates a styled cell for an asserted layer parameter value. */
  const createLayerValueCell = (
    value: types.ParameterValue,
    isRelative: boolean,
  ): GridCell | undefined => {
    const resolved = resolveParameterValue(value);
    if (resolved.value === null) return undefined;
    return applyFixtureValueSourceStyling(
      createAttributeValueCell(
        {
          value: resolved.value,
          isPercentage: resolved.isPercentage,
          isRelative,
        },
        { allowOverlay: false },
      ),
      options.maps.sourceState,
    );
  };

  /** Creates a styled cell for a layer's computed output value. */
  const createLayerOutputCell = (value: number): GridCell =>
    applyFixtureValueSourceStyling(
      createAttributeValueCell(
        { value, isPercentage: false, isRelative: false },
        { allowOverlay: false },
      ),
      options.maps.sourceState,
    );

  /** Creates a value-cell fallback from computed output and parameter metadata. */
  const createLayerComputedValueCell = (
    fixtureUid: string,
    elementIndex: number,
    attribute: string,
    value: number,
  ): GridCell => {
    const parameter = options.fixtureList[fixtureUid]?.elements[
      elementIndex - 1
    ]?.parameters.find(
      (candidate) =>
        normalizeAttributeName(candidate.attribute.type) === attribute,
    );
    const min = parameter?.min;
    const max = parameter?.max;
    if (
      attribute === "Intensity" &&
      min !== undefined &&
      max !== undefined &&
      Number.isFinite(min) &&
      Number.isFinite(max) &&
      max !== min
    ) {
      return applyFixtureValueSourceStyling(
        createAttributeValueCell(
          {
            value: (value - min) / (max - min),
            isPercentage: true,
            isRelative: false,
          },
          { allowOverlay: false },
        ),
        options.maps.sourceState,
      );
    }
    return createLayerOutputCell(value);
  };

  /** Returns the element count represented in a layer row. */
  const rowElementCount = (row: LayerDisplayRow): number =>
    row.type === "element" ? row.elementIndex : (row.elementData?.length ?? 0);

  /** Resolves the current output color for a row. */
  const currentRowColor = (row: LayerDisplayRow): string => {
    const fixtureUid = row.type === "element" ? row.fixtureUid : row.uid;
    const outputParameters = options.maps.output.get(fixtureUid)?.parameters;
    const elementIndex =
      row.type === "element"
        ? row.elementIndex
        : (outputParameters?.length ?? rowElementCount(row));
    const elementParameters = outputParameters?.[elementIndex - 1];
    const colorValue = (attribute: string): number => {
      const value = findNormalizedEntry(elementParameters, attribute);
      return typeof value === "number" ? value : 0;
    };
    return `rgb(${colorValue("Red")}, ${colorValue("Green")}, ${colorValue("Blue")})`;
  };

  /** Returns display text used to detect aggregate parent conflicts. */
  const cellConflictValue = (cell: GridCell): string =>
    "displayData" in cell ? (cell.displayData ?? cell.copyData ?? "") : "";

  /** Builds one element value or output cell from the current snapshot. */
  const elementAttributeCell = (
    fixtureUid: string,
    elementIndex: number,
    attribute: string,
    suffix: "Value" | "Out",
  ): LayerAttributeCellResult => {
    const elementOffset = elementIndex - 1;
    const absoluteParameters =
      options.maps.absolute.get(fixtureUid)?.parameters?.[elementOffset];
    const relativeParameters =
      options.maps.relative.get(fixtureUid)?.parameters?.[elementOffset];
    const outputParameters =
      options.maps.output.get(fixtureUid)?.parameters?.[elementOffset];
    const transitionParameters =
      options.maps.transitioning.get(fixtureUid)?.parameters?.[elementOffset];
    const outputValue = findNormalizedEntry(outputParameters, attribute);
    const isTransitioning =
      findNormalizedEntry(transitionParameters, attribute) === true;

    if (suffix === "Out") {
      return {
        cell:
          typeof outputValue === "number"
            ? createLayerOutputCell(outputValue)
            : undefined,
        transitioning: isTransitioning && typeof outputValue === "number",
      };
    }

    const absoluteValue = findNormalizedEntry(absoluteParameters, attribute);
    const relativeValue = findNormalizedEntry(relativeParameters, attribute);
    const assertedValue = relativeValue ?? absoluteValue;
    if (assertedValue === undefined) return { transitioning: false };

    if (
      options.isSequenceLayer &&
      relativeValue !== undefined &&
      typeof outputValue === "number"
    ) {
      const resolvedRelativeValue = resolveParameterValue(relativeValue);
      if (resolvedRelativeValue.value === 0) {
        return {
          cell: createLayerComputedValueCell(
            fixtureUid,
            elementIndex,
            attribute,
            outputValue,
          ),
          transitioning: isTransitioning,
        };
      }
    }

    const assertedCell = createLayerValueCell(
      assertedValue,
      relativeValue !== undefined,
    );
    if (!assertedCell) return { transitioning: false };
    if (
      (isTransitioning || options.maps.isReleasing) &&
      typeof outputValue === "number"
    ) {
      return {
        cell: createLayerOutputCell(outputValue),
        transitioning: true,
      };
    }
    return { cell: assertedCell, transitioning: isTransitioning };
  };

  /** Builds an aggregate parent cell for a visible value or output column. */
  const parentAttributeCell = (
    row: LayerDisplayRow,
    attribute: string,
    suffix: "Value" | "Out",
  ): LayerParentCellResult => {
    if (row.type !== "parent") {
      return { conflict: false, transitioning: false };
    }
    let cell: GridCell | undefined;
    let transitioning = false;
    const conflictValues = new Set<string>();
    for (
      let elementIndex = 1;
      elementIndex <= rowElementCount(row);
      elementIndex++
    ) {
      const elementCell = elementAttributeCell(
        row.uid,
        elementIndex,
        attribute,
        suffix,
      );
      if (!elementCell.cell) continue;
      cell = elementCell.cell;
      transitioning ||= elementCell.transitioning;
      conflictValues.add(cellConflictValue(elementCell.cell));
    }
    return {
      cell,
      conflict: conflictValues.size > 1,
      transitioning,
    };
  };

  return { currentRowColor, elementAttributeCell, parentAttributeCell };
}
