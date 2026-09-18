// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { setAttributeMetadata } from "../../../lib/attribute-metadata";
import type { VisibilityGridColumn } from "../../../lib/datagrid-column-visibility";
import * as types from "../../../types";
import {
  createLayerDisplayStructure,
  type LayerColumnsMemo,
  layerDisplayStructureRevision,
  memoizeLayerColumns,
} from "./layer-display-data";

/** Creates the minimum fixture shape needed by Layer View display-data tests. */
function fixtureWithElements(elementCount: number): types.Fixture {
  return {
    identifiers: { id: 7, uid: "fixture-1", label: "Fixture 1" },
    make: "Test",
    model: "Pixel Bar",
    mode: "Basic",
    elements: Array.from({ length: elementCount }, (_, index) => ({
      label: `Cell ${index + 1}`,
      parameters: [
        {
          attribute: { type: "Intensity" },
        } as types.ParameterMetadata,
      ],
    })),
  };
}

/** Creates a layer snapshot with computed intensity values for one fixture. */
function layerWithIntensityValues(values: number[]): types.OutboundLayerState {
  return {
    creator: "Test Layer",
    priority: 0,
    is_releasing: false,
    asserted_absolute_values: [],
    asserted_relative_values: [],
    lookahead_asserted_values: [],
    computed_values: [
      {
        fixture_uid: "fixture-1",
        parameters: values.map((value) => ({ Intensity: value })),
      },
    ],
    computed_transitioning: [],
  };
}

/** Verifies structural revisions ignore value-only updates and track row-shape inputs. */
test("Layer View structure revision separates values from row shape", () => {
  const fixtures = { "fixture-1": fixtureWithElements(2) };
  const firstRevision = layerDisplayStructureRevision(
    layerWithIntensityValues([10, 20]),
    new Set(),
    fixtures,
  );
  const valueOnlyRevision = layerDisplayStructureRevision(
    layerWithIntensityValues([30, 40]),
    new Set(),
    fixtures,
  );
  const expandedRevision = layerDisplayStructureRevision(
    layerWithIntensityValues([30, 40]),
    new Set(["fixture-1"]),
    fixtures,
  );
  const elementCountRevision = layerDisplayStructureRevision(
    layerWithIntensityValues([30, 40, 50]),
    new Set(),
    fixtures,
  );

  assert.equal(firstRevision, valueOnlyRevision);
  assert.notEqual(firstRevision, expandedRevision);
  assert.notEqual(firstRevision, elementCountRevision);
});

/** Verifies Solid memoization keeps columns stable when attributes do not change. */
test("Layer View column memo keeps columns stable when attributes do not change", () => {
  const fixtures = { "fixture-1": fixtureWithElements(2) };

  createRoot((dispose) => {
    const [layer, setLayer] = createSignal(layerWithIntensityValues([10, 20]));
    const displayRows = createMemo(() =>
      createLayerDisplayStructure(layer(), new Set(), fixtures),
    );
    const columns = createMemo<LayerColumnsMemo<string>>((previous) =>
      memoizeLayerColumns(
        displayRows().attributes,
        displayRows().attributeSignature,
        "metadata",
        previous,
      ),
    );

    const first = columns().columns;
    setLayer(layerWithIntensityValues([30, 40]));
    const second = columns().columns;

    assert.strictEqual(first, second);
    assert.deepEqual(
      first.map((column) => column.id),
      second.map((column) => column.id),
    );
    dispose();
  });
});

/** Verifies expansion changes control whether element rows are rendered. */
test("createLayerDisplayStructure expands element rows from current layer data", () => {
  const fixtures = { "fixture-1": fixtureWithElements(2) };
  const layer = layerWithIntensityValues([10, 20]);

  const collapsed = createLayerDisplayStructure(layer, new Set(), fixtures);
  const expanded = createLayerDisplayStructure(
    layer,
    new Set(["fixture-1"]),
    fixtures,
  );
  const collapsedParent = collapsed.rows[0];
  const expandedParent = expanded.rows[0];

  assert.equal(collapsedParent?.type, "parent");
  assert.equal(expandedParent?.type, "parent");
  if (collapsedParent?.type !== "parent" || expandedParent?.type !== "parent") {
    throw new Error("expected parent rows");
  }

  assert.equal(collapsed.rows.length, 1);
  assert.equal(expanded.rows.length, 3);
  assert.equal(expandedParent.isExpanded, true);
  assert.equal(expanded.rows[1]?.type, "element");
  assert.equal(expanded.rows[2]?.type, "element");
});

/** Verifies metadata reloads rebuild columns for an unchanged attribute set. */
test("Layer View column memo invalidates columns when metadata revision changes", () => {
  const fixtures = { "fixture-1": fixtureWithElements(1) };
  const layer = layerWithIntensityValues([10]);
  const firstMetadata: types.AttributeMetadata[] = [
    {
      key: "Intensity",
      attribute: { type: "Intensity" },
      label: "Intensity",
      category: types.AttributeCategory.Dimmer,
      sort_order: 0,
    },
  ];
  const secondMetadata: types.AttributeMetadata[] = [
    {
      key: "Intensity",
      attribute: { type: "Intensity" },
      label: "Intensity",
      category: types.AttributeCategory.Color,
      sort_order: 0,
    },
  ];

  setAttributeMetadata(firstMetadata);
  const displayRows = createLayerDisplayStructure(layer, new Set(), fixtures);
  const first = memoizeLayerColumns(
    displayRows.attributes,
    displayRows.attributeSignature,
    firstMetadata,
  );

  setAttributeMetadata(secondMetadata);
  const second = memoizeLayerColumns(
    displayRows.attributes,
    displayRows.attributeSignature,
    secondMetadata,
    first,
  );

  assert.notStrictEqual(first.columns, second.columns);
  assert.equal(
    (first.columns as VisibilityGridColumn[]).find(
      (column) => column.id === "Intensity_Value",
    )?.visibilityCategory,
    "Dimmer",
  );
  assert.equal(
    (second.columns as VisibilityGridColumn[]).find(
      (column) => column.id === "Intensity_Value",
    )?.visibilityCategory,
    "Color",
  );

  setAttributeMetadata([]);
});
