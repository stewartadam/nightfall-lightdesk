// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FunctionIcon } from "@squidlab/phosphor-solid/function";
import type { GridCell, GridColumn } from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  type AttributeValues,
  attributeValueColumnWidth,
  createAttributeARCell,
  createAttrValueColumns,
} from "../../../lib/datagrid";
import type { FilterableGridColumn } from "../../../lib/datagrid-filtering";
import {
  normalizeAttributeName,
  resolveParameterValue,
} from "../../../lib/utils";
import type { ParameterMap } from "../../../state/appStores";
import * as types from "../../../types";
export type FixtureParameterState = NonNullable<
  ReturnType<ParameterMap["get"]>
>;
export type FixtureElementParameterState = NonNullable<
  FixtureParameterState["elements"]
>[number];

export type FixtureBaseRow = {
  uid: string;
  id: number;
  name: string;
  applicableAttributes: Set<string>;
};

export type FixtureParentRow = FixtureBaseRow & {
  type: "parent";
  hasElements: boolean;
  isExpanded: boolean;
};
export type FixtureElementRow = FixtureBaseRow & {
  type: "element";
  fixtureUid: string;
  elementIndex: number;
};
export type FixtureDisplayRow = FixtureParentRow | FixtureElementRow;
export type FixtureGridColumn =
  | (GridColumn & { fixtureColumnKind: "identity" | "name" })
  | (GridColumn & {
      fixtureColumnKind: "attributeValue";
      fixtureAttribute: string;
    });
export type FixtureGridStructure = {
  rows: FixtureDisplayRow[];
  columns: FixtureGridColumn[];
  allAttributes: Set<string>;
  attributeSignature: string;
  rowSignature: string;
};
export type FixtureRowValueState = {
  attributes: AttributeValues;
  outputValues: Record<string, number>;
  conflicts?: Set<string>;
};
export type FixtureElementValueState = FixtureRowValueState & {
  elementIndex: number;
};
export type FixtureValueSnapshot = {
  rowsByUid: Map<string, FixtureRowValueState>;
  elementRowsByFixtureUid: Map<string, FixtureElementValueState[]>;
  rowInputsByUid: Map<
    string,
    FixtureParameterState | FixtureElementParameterState | undefined
  >;
  fixtureInputsByUid: Map<string, FixtureParameterState | undefined>;
  showAllOutputValues: boolean;
};
export type DisplayedFixtureRows = {
  rows: FixtureDisplayRow[];
  rowSignature: string;
  sourceRows: readonly FixtureDisplayRow[];
};

/** Creates an empty attribute value container for one fixture grid row. */
export function emptyAttributeValues(): AttributeValues {
  return { absolute: {}, relative: {} };
}

/** Records resolved absolute or relative parameter values into one row value container. */
export function recordAttributeValues(
  target: AttributeValues,
  entries: Record<string, types.ParameterValue> | undefined,
  isRelative: boolean,
  allAttributes?: Set<string>,
): void {
  if (!entries) return;

  const targetValues = isRelative ? target.relative : target.absolute;
  for (const [attr, paramValue] of Object.entries(entries)) {
    const normalizedAttr = normalizeAttributeName(attr);
    allAttributes?.add(normalizedAttr);
    const processed = resolveParameterValue(paramValue);
    if (processed.value !== null) {
      targetValues[normalizedAttr] = {
        value: processed.value,
        isPercentage: processed.isPercentage,
        isRelative,
      };
    }
  }
}

/** Records normalized attribute names without resolving live parameter values. */
export function recordAttributeNames(
  entries: Record<string, unknown> | undefined,
  allAttributes: Set<string>,
): void {
  if (!entries) return;

  for (const attr of Object.keys(entries)) {
    allAttributes.add(normalizeAttributeName(attr));
  }
}

/** Records every attribute key that can affect the fixture grid schema for a parent row. */
export function recordParentAttributeNames(
  param: FixtureParameterState | undefined,
  allAttributes: Set<string>,
): void {
  recordAttributeNames(param?.raw, allAttributes);
  recordAttributeNames(param?.absolute, allAttributes);
  recordAttributeNames(param?.relative, allAttributes);
}

/** Records every attribute key that can affect the fixture grid schema for an element row. */
export function recordElementAttributeNames(
  element: FixtureElementParameterState | undefined,
  allAttributes: Set<string>,
): void {
  recordAttributeNames(element?.raw, allAttributes);
  recordAttributeNames(element?.absolute, allAttributes);
  recordAttributeNames(element?.relative, allAttributes);
}

/** Returns normalized output values, optionally limited to asserted attributes. */
export function outputValuesForRawValues(
  raw: Record<string, number> | undefined,
  assertedAttributes: Set<string>,
  showAllOutputValues: boolean,
): Record<string, number> {
  const outputValues: Record<string, number> = {};
  if (!raw) return outputValues;

  for (const [attr, value] of Object.entries(raw)) {
    const normalizedAttr = normalizeAttributeName(attr);
    if (showAllOutputValues || assertedAttributes.has(normalizedAttr)) {
      outputValues[normalizedAttr] = value;
    }
  }

  return outputValues;
}

/** Builds the live value state for a parent fixture row. */
export function parentRowValueState(
  param: FixtureParameterState | undefined,
  showAllOutputValues: boolean,
  allAttributes?: Set<string>,
): FixtureRowValueState {
  const attributes = emptyAttributeValues();
  const raw = param?.raw ?? {};

  for (const attr of Object.keys(raw)) {
    allAttributes?.add(normalizeAttributeName(attr));
  }

  recordAttributeValues(attributes, param?.absolute, false, allAttributes);
  recordAttributeValues(attributes, param?.relative, true, allAttributes);

  const assertedAttributes = new Set([
    ...Object.keys(attributes.absolute),
    ...Object.keys(attributes.relative),
  ]);

  return {
    attributes,
    outputValues: outputValuesForRawValues(
      raw,
      assertedAttributes,
      showAllOutputValues,
    ),
    conflicts: param?.conflicts,
  };
}

/** Builds the live value state for one fixture element row. */
export function elementRowValueState(
  element: FixtureElementParameterState | undefined,
  showAllOutputValues: boolean,
  allAttributes?: Set<string>,
): FixtureRowValueState {
  const attributes = emptyAttributeValues();
  const raw = element?.raw ?? {};

  for (const attr of Object.keys(raw)) {
    allAttributes?.add(normalizeAttributeName(attr));
  }

  recordAttributeValues(attributes, element?.absolute, false, allAttributes);
  recordAttributeValues(attributes, element?.relative, true, allAttributes);

  const assertedAttributes = new Set([
    ...Object.keys(attributes.absolute),
    ...Object.keys(attributes.relative),
  ]);

  return {
    attributes,
    outputValues: outputValuesForRawValues(
      raw,
      assertedAttributes,
      showAllOutputValues,
    ),
  };
}

/** Builds the live value state for one fixture element with its fixture-local index. */
export function indexedElementRowValueState(
  element: FixtureElementParameterState,
  showAllOutputValues: boolean,
  allAttributes?: Set<string>,
): FixtureElementValueState {
  return {
    ...elementRowValueState(element, showAllOutputValues, allAttributes),
    elementIndex: element.elementIndex,
  };
}

/** Returns the parsed fixture value attribute carried by a grid column. */
export function fixtureValueColumnAttribute(
  column: GridColumn | undefined,
): string | undefined {
  const fixtureColumn = column as FixtureGridColumn | undefined;
  return fixtureColumn?.fixtureColumnKind === "attributeValue"
    ? fixtureColumn.fixtureAttribute
    : undefined;
}

/** Builds fixture-grid columns with parsed metadata for hot cell-resolution paths. */
export function createFixtureGridColumns(
  attributes: Iterable<string>,
  baseColumns: FilterableGridColumn<FixtureDisplayRow, GridColumn>[],
): FixtureGridColumn[] {
  const attributeList = Array.from(attributes);
  return createAttrValueColumns(attributeList, baseColumns, {
    valueWidths: createFixtureValueColumnWidths(attributeList),
  }).map((column) => {
    if (column.id === "id") {
      return { ...column, fixtureColumnKind: "identity" };
    }
    if (column.id === "name") {
      return { ...column, fixtureColumnKind: "name" };
    }

    const attribute = String(column.id ?? "").match(/^(.+)_Value$/)?.[1];
    return attribute
      ? {
          ...column,
          fixtureColumnKind: "attributeValue",
          fixtureAttribute: attribute,
        }
      : { ...column, fixtureColumnKind: "name" };
  });
}

/** Returns whether a row has any asserted values in the current value snapshot. */
export function rowHasAssertedValues(
  valueState: FixtureRowValueState | undefined,
) {
  if (!valueState) return false;
  return (
    Object.keys(valueState.attributes.absolute).length > 0 ||
    Object.keys(valueState.attributes.relative).length > 0
  );
}

/** Builds a deterministic signature for the fixture grid's structural rows. */
export function fixtureRowSignature(
  rows: readonly FixtureDisplayRow[],
): string {
  return rows
    .map((row) => {
      const applicableAttributes = Array.from(row.applicableAttributes)
        .sort()
        .join(",");
      return [
        row.uid,
        row.id,
        row.name,
        row.type,
        row.type === "parent" ? row.hasElements : row.fixtureUid,
        row.type === "parent" ? row.isExpanded : row.elementIndex,
        applicableAttributes,
      ].join(":");
    })
    .join("|");
}

/** Builds a deterministic signature for the currently available value columns. */
export function fixtureAttributeSignature(
  attributes: Iterable<string>,
): string {
  return Array.from(attributes).sort().join("|");
}

/** Returns whether parameter rows assert an attribute for a fixture element. */
export function layerHasAssertedAttribute(
  rows: types.OutboundElementParameterValues[],
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
): boolean {
  const fixtureRow = rows.find((row) => row.fixture_uid === fixtureUid);
  if (!fixtureRow) {
    return false;
  }

  if (elementIndex !== undefined) {
    const elementParams = fixtureRow.parameters[elementIndex - 1];
    if (!elementParams) {
      return false;
    }
    return Object.keys(elementParams).some(
      (key) => normalizeAttributeName(key) === attribute,
    );
  }

  return fixtureRow.parameters.some((elementParams) =>
    Object.keys(elementParams).some(
      (key) => normalizeAttributeName(key) === attribute,
    ),
  );
}

/** Finds normalized parameter values in one asserted layer row set. */
export function layerParameterValuesForAttribute(
  rows: readonly types.OutboundElementParameterValues[],
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
): types.ParameterValue[] {
  const fixtureRow = rows.find((row) => row.fixture_uid === fixtureUid);
  if (!fixtureRow) {
    return [];
  }

  const values: types.ParameterValue[] = [];
  const collectValue = (parameters: Record<string, types.ParameterValue>) => {
    for (const [key, value] of Object.entries(parameters)) {
      if (normalizeAttributeName(key) === attribute) {
        values.push(value);
      }
    }
  };

  if (elementIndex !== undefined) {
    const elementParameters = fixtureRow.parameters[elementIndex - 1];
    if (elementParameters) {
      collectValue(elementParameters);
    }
    return values;
  }

  for (const elementParameters of fixtureRow.parameters) {
    collectValue(elementParameters);
  }
  return values;
}

export type FixtureParameterMetadataIndex = {
  aggregateParameters: ReadonlyMap<string, types.ParameterMetadata>;
  elementParameters: ReadonlyMap<string, types.ParameterMetadata>;
};

export const fixtureParameterMetadataIndexes = new WeakMap<
  types.Fixture,
  FixtureParameterMetadataIndex
>();

/** Builds a cache key for one fixture element parameter lookup. */
export function fixtureElementParameterKey(
  elementIndex: number,
  attribute: string,
): string {
  return `${elementIndex}|${attribute}`;
}

/** Builds parameter metadata lookup maps for repeated fixture value formatting. */
export function buildFixtureParameterMetadataIndex(
  fixture: types.Fixture,
): FixtureParameterMetadataIndex {
  const aggregateParameters = new Map<string, types.ParameterMetadata>();
  const elementParameters = new Map<string, types.ParameterMetadata>();

  fixture.elements.forEach((element, index) => {
    const elementIndex = index + 1;
    for (const parameter of element.parameters) {
      const attribute = normalizeAttributeName(parameter.attribute.type);
      aggregateParameters.set(
        attribute,
        aggregateParameters.get(attribute) ?? parameter,
      );
      elementParameters.set(
        fixtureElementParameterKey(elementIndex, attribute),
        parameter,
      );
    }
  });

  return {
    aggregateParameters,
    elementParameters,
  };
}

/** Returns cached parameter metadata lookup maps for one fixture definition. */
export function fixtureParameterMetadataIndex(
  fixture: types.Fixture,
): FixtureParameterMetadataIndex {
  const cached = fixtureParameterMetadataIndexes.get(fixture);
  if (cached) {
    return cached;
  }

  const index = buildFixtureParameterMetadataIndex(fixture);
  fixtureParameterMetadataIndexes.set(fixture, index);
  return index;
}

/** Finds fixture parameter metadata for formatting computed output as a displayed value. */
export function fixtureParameterForAttribute(
  fixture: types.Fixture | undefined,
  elementIndex: number | undefined,
  attribute: string,
): types.ParameterMetadata | undefined {
  if (!fixture) {
    return undefined;
  }

  const index = fixtureParameterMetadataIndex(fixture);
  if (elementIndex === undefined) {
    return index.aggregateParameters.get(attribute);
  }

  return index.elementParameters.get(
    fixtureElementParameterKey(elementIndex, attribute),
  );
}

/** Returns whether a visible fixture attribute is backed by a virtual dimmer parameter. */
export function fixtureAttributeIsVirtualDimmer(
  fixture: types.Fixture | undefined,
  elementIndex: number | undefined,
  attribute: string,
): boolean {
  const parameter = fixtureParameterForAttribute(
    fixture,
    elementIndex,
    attribute,
  );
  return parameter?.attribute.type === "VirtualIntensity";
}

/** Adds the virtual-dimmer function badge without replacing higher-priority value badges. */
export function applyVirtualDimmerBadge(
  cell: GridCell,
  fixture: types.Fixture | undefined,
  elementIndex: number | undefined,
  attribute: string,
): GridCell {
  if (
    cell.prefixBadge ||
    cell.prefixBadgeIcon ||
    !fixtureAttributeIsVirtualDimmer(fixture, elementIndex, attribute)
  ) {
    return cell;
  }

  return {
    ...cell,
    prefixBadgeIcon: FunctionIcon,
    prefixBadgeLabel: "Virtual dimmer",
  };
}

/** Creates an attribute value set that displays computed output as a resolved fixture value. */
export function computedFixtureValueAttributes(
  fixture: types.Fixture | undefined,
  elementIndex: number | undefined,
  attribute: string,
  outputValue: number,
): AttributeValues {
  const parameter = fixtureParameterForAttribute(
    fixture,
    elementIndex,
    attribute,
  );
  const min = parameter?.min;
  const max = parameter?.max;
  const canFormatIntensityPercent =
    attribute === "Intensity" &&
    min !== undefined &&
    max !== undefined &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    max !== min;

  return {
    absolute: {
      [attribute]: {
        value: canFormatIntensityPercent
          ? (outputValue - min) / (max - min)
          : outputValue,
        isPercentage: canFormatIntensityPercent,
        isRelative: false,
      },
    },
    relative: {},
  };
}

/** Creates an attribute value set from asserted layer values. */
export function assertedFixtureValueAttributes(
  attribute: string,
  values: readonly types.ParameterValue[],
  isRelative: boolean,
): AttributeValues {
  const processedValues = values
    .map((value) => resolveParameterValue(value))
    .filter((value) => value.value !== null);
  if (processedValues.length === 0) {
    return emptyAttributeValues();
  }

  const first = processedValues[0];
  const isUniform = processedValues.every(
    (value) =>
      value.value === first.value && value.isPercentage === first.isPercentage,
  );
  if (!isUniform) {
    return emptyAttributeValues();
  }

  return {
    absolute: isRelative
      ? {}
      : {
          [attribute]: {
            value: first.value ?? 0,
            isPercentage: first.isPercentage,
            isRelative: false,
          },
        },
    relative: isRelative
      ? {
          [attribute]: {
            value: first.value ?? 0,
            isPercentage: first.isPercentage,
            isRelative: true,
          },
        }
      : {},
  };
}

/** Resolves the value display for the topmost layer assertion affecting a fixture cell. */
export function fixtureValueAttributesForTopLayer(
  layers: readonly types.OutboundLayerState[],
  fixture: types.Fixture | undefined,
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
  outputValue: number | undefined,
): AttributeValues | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const absoluteValues = layerParameterValuesForAttribute(
      layer.asserted_absolute_values,
      fixtureUid,
      elementIndex,
      attribute,
    );
    const relativeValues = layerParameterValuesForAttribute(
      layer.asserted_relative_values,
      fixtureUid,
      elementIndex,
      attribute,
    );
    if (absoluteValues.length > 0) {
      return assertedFixtureValueAttributes(attribute, absoluteValues, false);
    }
    if (relativeValues.length === 0) {
      continue;
    }

    const isSequenceRelativeZero =
      layer.object_ref?.data.object_type === types.ObjectType.Sequence &&
      relativeValues.every((value) => resolveParameterValue(value).value === 0);
    if (isSequenceRelativeZero && outputValue !== undefined) {
      return computedFixtureValueAttributes(
        fixture,
        elementIndex,
        attribute,
        outputValue,
      );
    }

    return assertedFixtureValueAttributes(attribute, relativeValues, true);
  }

  return undefined;
}

/** Resolves the attribute values that should be rendered for one fixture value cell. */
export function resolvedFixtureValueAttributes(
  layers: readonly types.OutboundLayerState[],
  fixture: types.Fixture | undefined,
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
  attributes: AttributeValues,
  outputValue: number | undefined,
  showReleasedOutput: boolean,
): AttributeValues {
  if (
    showReleasedOutput ||
    (attributes.absolute[attribute] === undefined &&
      attributes.relative[attribute] === undefined)
  ) {
    return attributes;
  }

  return (
    fixtureValueAttributesForTopLayer(
      layers,
      fixture,
      fixtureUid,
      elementIndex,
      attribute,
      outputValue,
    ) ?? attributes
  );
}

/** Returns the text used to compare child fixture value cells for aggregate variation. */
export function fixtureValueCellDisplayText(cell: GridCell): string {
  if (cell.kind !== GridCellKind.Text) {
    return String(cell.copyData ?? "");
  }

  return cell.displayData ?? cell.data ?? "";
}

/** Returns whether child element cells render non-uniform values for one attribute. */
export function childElementDisplaysVary(
  childStates: readonly FixtureElementValueState[],
  layers: readonly types.OutboundLayerState[],
  fixture: types.Fixture | undefined,
  fixtureUid: string,
  attribute: string,
  showReleasedOutput: boolean,
): boolean {
  if (childStates.length < 2) {
    return false;
  }

  const applicableChildStates = childStates.filter(
    (childState) =>
      fixtureParameterForAttribute(
        fixture,
        childState.elementIndex,
        attribute,
      ) !== undefined,
  );
  if (applicableChildStates.length < 2) {
    return false;
  }

  const displayTexts = applicableChildStates.map((childState) => {
    const attributes = resolvedFixtureValueAttributes(
      layers,
      fixture,
      fixtureUid,
      childState.elementIndex,
      attribute,
      childState.attributes,
      childState.outputValues[attribute],
      showReleasedOutput,
    );
    return fixtureValueCellDisplayText(
      createAttributeARCell(
        attribute,
        attributes,
        childState.outputValues,
        showReleasedOutput,
      ),
    );
  });

  if (displayTexts.every((displayText) => displayText === "")) {
    return false;
  }

  const first = displayTexts[0];
  return displayTexts.some((displayText) => displayText !== first);
}

/** Finds the highest layer asserting a fixture value channel. */
export function findAssertingLayerIndexIn(
  layers: readonly types.OutboundLayerState[],
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
  channelKind: "Value" | "Out",
): number | null {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const hasAbsolute = layerHasAssertedAttribute(
      layer.asserted_absolute_values,
      fixtureUid,
      elementIndex,
      attribute,
    );
    const hasRelative = layerHasAssertedAttribute(
      layer.asserted_relative_values,
      fixtureUid,
      elementIndex,
      attribute,
    );

    if (
      (channelKind === "Value" && (hasAbsolute || hasRelative)) ||
      (channelKind === "Out" && (hasAbsolute || hasRelative))
    ) {
      return index;
    }
  }

  return null;
}

/** Computes per-attribute value widths without subscribing column layout to live layer-state updates. */
export function createFixtureValueColumnWidths(
  attributes: Iterable<string>,
): Record<string, number> {
  const widths: Record<string, number> = {};

  for (const attribute of attributes) {
    widths[attribute] = attributeValueColumnWidth();
  }

  return widths;
}
