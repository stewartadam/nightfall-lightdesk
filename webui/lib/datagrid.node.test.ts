// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AttributeCategory } from "../types";
import type { GridSelection } from "./data-grid-types";
import { CompactSelection, GridCellKind } from "./data-grid-types";
import {
  type AttributeValues,
  applyAggregateConflictStyling,
  applyFixtureAttributeValueStyling,
  applyFixtureValueSourceStyling,
  applyInvalidSourceStyling,
  applyLookaheadStyling,
  applyTrackedValueStyling,
  applyTransitionStyling,
  attributeValueColumnWidth,
  createARCell,
  createAttributeValueCell,
  createAttrValueColumns,
  emptyGridSelection,
  FIXTURE_VALUE_TEXT_COLORS,
  getEditTargetRowIndices,
  getRowsToEdit,
} from "./datagrid";

test("getRowsToEdit returns selected rows when the edited row is selected", () => {
  const selection: GridSelection = {
    ...emptyGridSelection(),
    rows: CompactSelection.fromArray([1, 3, 4]),
  };

  assert.deepEqual(getRowsToEdit(selection, 2, 3, 10), [1, 3, 4]);
});

test("getRowsToEdit ignores selected rows when editing outside the row selection", () => {
  const selection: GridSelection = {
    ...emptyGridSelection(),
    rows: CompactSelection.fromArray([1, 3, 4]),
  };

  assert.deepEqual(getRowsToEdit(selection, 2, 2, 10), [2]);
});

test("getRowsToEdit preserves same-column range edit behavior", () => {
  const selection: GridSelection = {
    ...emptyGridSelection(),
    current: {
      cell: [3, 4],
      range: { x: 3, y: 2, width: 1, height: 3 },
      rangeStack: [],
    },
  };

  assert.deepEqual(getRowsToEdit(selection, 3, 4, 10), [2, 3, 4]);
});

/** Verifies additive drag ranges edit every selected row in the edited column. */
test("getRowsToEdit includes same-column stacked ranges", () => {
  const selection: GridSelection = {
    ...emptyGridSelection(),
    current: {
      cell: [3, 8],
      range: { x: 3, y: 7, width: 1, height: 2 },
      rangeStack: [
        { x: 3, y: 2, width: 1, height: 2 },
        { x: 4, y: 5, width: 1, height: 2 },
      ],
    },
  };

  assert.deepEqual(getRowsToEdit(selection, 3, 8, 10), [2, 3, 7, 8]);
});

/**
 * Verifies active-cell selection exposes the single row targeted by editing.
 */
test("getEditTargetRowIndices returns the active cell row", () => {
  const selection: GridSelection = {
    ...emptyGridSelection(),
    current: {
      cell: [6, 8],
      range: { x: 6, y: 8, width: 1, height: 1 },
      rangeStack: [],
    },
  };

  assert.deepEqual(getEditTargetRowIndices(selection, 10), [8]);
});

/**
 * Verifies same-column range selection exposes every row targeted by editing.
 */
test("getEditTargetRowIndices returns same-column range rows", () => {
  const selection: GridSelection = {
    ...emptyGridSelection(),
    current: {
      cell: [6, 8],
      range: { x: 6, y: 6, width: 1, height: 3 },
      rangeStack: [],
    },
  };

  assert.deepEqual(getEditTargetRowIndices(selection, 10), [6, 7, 8]);
});

/**
 * Verifies discontiguous cell selections expose every represented row.
 */
test("getEditTargetRowIndices returns rows from stacked ranges", () => {
  const selection: GridSelection = {
    ...emptyGridSelection(),
    current: {
      cell: [8, 602],
      range: { x: 8, y: 602, width: 1, height: 1 },
      rangeStack: [
        { x: 6, y: 521, width: 1, height: 1 },
        { x: 6, y: 524, width: 1, height: 1 },
        { x: 6, y: 605, width: 1, height: 1 },
      ],
    },
  };

  assert.deepEqual(
    getEditTargetRowIndices(selection, 700),
    [521, 524, 602, 605],
  );
});

/**
 * Verifies attribute groups expose one asserted value column.
 */
test("createAttrValueColumns uses one value column per attribute", () => {
  const columns = createAttrValueColumns(
    ["Red"],
    [{ title: "ID", id: "id", width: 85 }],
  );

  assert.deepEqual(
    columns.map((column) => ({
      id: column.id,
      title: column.title,
      group: column.group,
      width: column.width,
    })),
    [
      { id: "id", title: "ID", group: undefined, width: 85 },
      { id: "Red_Value", title: "", group: "Red", width: 88 },
    ],
  );
});

/** Verifies output columns share grouping metadata with asserted value columns. */
test("createAttrValueColumns appends output columns inside each attribute group", () => {
  const columns = createAttrValueColumns(
    ["Green"],
    [{ title: "ID", id: "id", width: 85 }],
    { outputTitle: "DMX" },
  );

  assert.deepEqual(
    columns.map((column) => ({
      id: column.id,
      title: column.title,
      group: column.group,
      width: column.width,
    })),
    [
      { id: "id", title: "ID", group: undefined, width: 85 },
      { id: "Green_Value", title: "", group: "Green", width: 88 },
      { id: "Green_Out", title: "DMX", group: "Green", width: 54 },
    ],
  );
});

/** Verifies value widths leave room for marker-prefixed percentage text. */
test("attributeValueColumnWidth fits marker-prefixed percentage text", () => {
  assert.equal(attributeValueColumnWidth(), 88);
  assert.equal(
    attributeValueColumnWidth({
      hasPrefixBadge: true,
      stateIndicatorCount: 2,
    }),
    88,
  );
});

/** Verifies attribute value columns accept per-attribute width overrides. */
test("createAttrValueColumns uses per-attribute value widths", () => {
  const columns = createAttrValueColumns(
    ["Red"],
    [{ title: "ID", id: "id", width: 85 }],
    { valueWidths: { Red: 104 } },
  );

  assert.equal(columns.find((column) => column.id === "Red_Value")?.width, 104);
  assert.equal(
    columns.find((column) => column.id === "Red_Value")?.sizing,
    "fixed",
  );
});

/**
 * Verifies relative value cells show the BRD marker without changing copy data.
 */
test("createARCell renders relative values with marker text", () => {
  const values: AttributeValues = {
    absolute: {},
    relative: {
      Red: {
        value: 0.25,
        isPercentage: true,
        isRelative: true,
      },
    },
  };

  const cell = createARCell("Red_Value", values);

  assert.equal(cell.kind, GridCellKind.Text);
  assert.equal(cell.copyData, "25%");
  assert.equal(cell.data, "0.25");
  assert.equal(cell.displayData, "~ 25%");
  assert.equal(cell.prefixBadge, undefined);
  assert.equal(cell.prefixBadgeLabel, undefined);
  assert.equal(cell.themeOverride?.bgCell, "#1a1a1f");
  assert.equal(cell.themeOverride?.textDark, undefined);
});

/** Verifies relative attribute values use marker text rather than badges. */
test("createAttributeValueCell renders relative values with marker text", () => {
  const cell = createAttributeValueCell({
    value: 1,
    isPercentage: true,
    isRelative: true,
  });

  assert.equal(cell.kind, GridCellKind.Text);
  assert.equal(cell.data, "1");
  assert.equal(cell.displayData, "~ 100%");
  assert.equal(cell.copyData, "100%");
  assert.equal(cell.prefixBadge, undefined);
  assert.equal(cell.prefixBadgeLabel, undefined);
  assert.equal(cell.themeOverride?.bgCell, "#1a1a1f");
  assert.equal(cell.themeOverride?.textDark, undefined);
});

/** Verifies cue marker values render as compact marker text. */
test("createAttributeValueCell renders cue value markers", () => {
  const release = createAttributeValueCell({
    marker: "release",
    isPercentage: false,
    isRelative: false,
  });
  const hold = createAttributeValueCell({
    marker: "hold",
    isPercentage: false,
    isRelative: false,
  });
  const block = createAttributeValueCell({
    marker: "block",
    isPercentage: false,
    isRelative: false,
  });
  const blockedValue = createAttributeValueCell({
    marker: "block",
    value: 0,
    isPercentage: false,
    isRelative: false,
  });
  const blockedRelativeValue = createAttributeValueCell({
    marker: "block",
    value: 1,
    isPercentage: true,
    isRelative: true,
  });

  assert.equal(release.kind, GridCellKind.Text);
  assert.equal(hold.kind, GridCellKind.Text);
  assert.equal(block.kind, GridCellKind.Text);
  assert.equal(blockedValue.kind, GridCellKind.Text);
  assert.equal(blockedRelativeValue.kind, GridCellKind.Text);
  assert.equal(release.displayData, "R");
  assert.equal(release.copyData, "R");
  assert.equal(hold.displayData, "H");
  assert.equal(hold.copyData, "H");
  assert.equal(block.displayData, "B");
  assert.equal(block.copyData, "B");
  assert.equal(blockedValue.displayData, "B 0");
  assert.equal(blockedValue.copyData, "B 0");
  assert.equal(blockedRelativeValue.displayData, "~ 100%");
  assert.equal(blockedRelativeValue.copyData, "B ~ 100%");
  assert.equal(blockedRelativeValue.prefixBadge, "B");
  assert.equal(blockedRelativeValue.prefixBadgeLabel, "Blocked");
});

/** Verifies empty attribute cells can opt into editing for cue-editor blanks. */
test("createAttributeValueCell can render editable empty cells", () => {
  const cell = createAttributeValueCell(undefined, { allowOverlay: true });

  assert.equal(cell.kind, GridCellKind.Text);
  assert.equal(cell.data, "");
  assert.equal(cell.displayData, "");
  assert.equal(cell.allowOverlay, true);
});

/** Verifies aggregate conflicts display a varied badge with conflict-colored text. */
test("applyAggregateConflictStyling renders aggregate conflict cells", () => {
  const styled = applyAggregateConflictStyling(
    createAttributeValueCell({
      value: 0.5,
      isPercentage: true,
      isRelative: false,
    }),
    true,
  );

  if (styled.kind !== GridCellKind.Text) {
    assert.fail("Expected an aggregate conflict text cell");
  }
  assert.equal(styled.displayData, "");
  assert.equal(styled.copyData, "[V]");
  assert.equal(styled.prefixBadge, "V");
  assert.equal(styled.prefixBadgeLabel, "Varied element values");
  assert.equal(styled.themeOverride?.bgCell, "#1a1a1f");
  assert.equal(styled.themeOverride?.textDark, "#FFFFFF");

  const blockedRelative = applyAggregateConflictStyling(
    createAttributeValueCell({
      marker: "block",
      value: 1,
      isPercentage: true,
      isRelative: true,
    }),
    true,
  );
  if (blockedRelative.kind !== GridCellKind.Text) {
    assert.fail("Expected a blocked aggregate conflict text cell");
  }
  assert.equal(blockedRelative.displayData, "");
  assert.equal(blockedRelative.copyData, "[V]");
  assert.equal(blockedRelative.prefixBadge, "V");
  assert.equal(blockedRelative.prefixBadgeLabel, "Varied element values");
});

/** Verifies aggregate conflict badges can preserve asserted parent values. */
test("applyAggregateConflictStyling preserves requested aggregate values", () => {
  const styled = applyAggregateConflictStyling(
    createAttributeValueCell({
      value: 1,
      isPercentage: true,
      isRelative: false,
    }),
    true,
    undefined,
    { preserveValue: true },
  );

  if (styled.kind !== GridCellKind.Text) {
    assert.fail("Expected an aggregate conflict text cell");
  }
  assert.equal(styled.displayData, "100%");
  assert.equal(styled.copyData, "[V] 100%");
  assert.equal(styled.prefixBadge, "V");
});

/**
 * Verifies output mode swaps the value column content to DMX output.
 */
test("createARCell renders output values in the same value column", () => {
  const values: AttributeValues = {
    absolute: {
      Red: {
        value: 0.25,
        isPercentage: true,
        isRelative: false,
      },
    },
    relative: {},
  };

  const cell = createARCell("Red_Value", values, { Red: 128 }, true);

  assert.equal(cell.kind, GridCellKind.Text);
  assert.equal(cell.displayData, "128");
});

/** Verifies live Blueprint cells show current values without losing source provenance. */
test("createAttributeValueCell labels materialized Blueprint values", () => {
  const value = {
    value: 0.25,
    isPercentage: true,
    isRelative: false,
    blueprintSource: {
      blueprint_uid: "00000000000000000000000000000005",
      blueprint_id: 5,
      blueprint_label: "Sunset",
      selector: { type: "Category", data: AttributeCategory.Color },
    },
  } as const;
  const cell = createAttributeValueCell(value);

  assert.equal(cell.kind, GridCellKind.Text);
  assert.equal(cell.displayData, "25% · BP 5 Sunset");
  assert.equal(cell.copyData, "25% · BP 5 Sunset");
  assert.equal(cell.data, "0.25");
  assert.equal(
    cell.themeOverride?.textDark,
    FIXTURE_VALUE_TEXT_COLORS.blueprint,
  );

  const programmerStyled = applyFixtureValueSourceStyling(cell, {
    winningSource: "manual",
    hasShadowedManual: false,
  });
  assert.equal(
    programmerStyled.themeOverride?.textDark,
    FIXTURE_VALUE_TEXT_COLORS.blueprint,
  );

  const conflictStyled = createAttributeValueCell(value, {
    themeOverride: { textDark: "#ef4444" },
  });
  assert.equal(conflictStyled.themeOverride?.textDark, "#ef4444");
});

/** Verifies manual source styling colors values without adding markers. */
test("applyFixtureValueSourceStyling marks manual winning values", () => {
  const cell = createAttributeValueCell({
    value: 0.5,
    isPercentage: true,
    isRelative: false,
  });

  const styled = applyFixtureValueSourceStyling(cell, {
    winningSource: "manual",
    hasShadowedManual: false,
  });

  assert.equal(styled.themeOverride?.textDark, "#B71C1C");
  assert.equal(styled.stateIndicators, undefined);
});

/** Verifies tracked and lookahead value states have distinct BRD treatments. */
test("fixture value styling supports tracked and lookahead states", () => {
  const cell = createAttributeValueCell({
    value: 0.5,
    isPercentage: true,
    isRelative: false,
  });

  const tracked = applyTrackedValueStyling(cell);
  const lookahead = applyLookaheadStyling(cell);

  assert.equal(tracked.themeOverride?.textDark, "#9C27B0");
  assert.equal(tracked.stateIndicators, undefined);
  if (lookahead.kind !== GridCellKind.Text) {
    assert.fail("Expected lookahead styling to preserve a text cell");
  }
  assert.equal(lookahead.displayData, "50%");
  assert.equal(lookahead.themeOverride?.bgCell, "#00332b");
  assert.equal(lookahead.themeOverride?.textDark, undefined);
  assert.equal(lookahead.stateIndicators, undefined);
});

/** Verifies invalid source styling uses the BRD error marker and background. */
test("applyInvalidSourceStyling marks untrusted values", () => {
  const cell = createAttributeValueCell({
    value: 0.5,
    isPercentage: true,
    isRelative: false,
  });

  const styled = applyInvalidSourceStyling(cell);

  if (styled.kind !== GridCellKind.Text) {
    assert.fail("Expected invalid source styling to preserve a text cell");
  }
  assert.equal(styled.displayData, "! 50%");
  assert.equal(styled.themeOverride?.bgCell, "#FF6F00");
  assert.equal(styled.themeOverride?.textDark, undefined);
  assert.equal(styled.stateIndicators, undefined);
});

/** Verifies shadowed manual holds do not add color outside the BRD table. */
test("applyFixtureValueSourceStyling ignores shadowed manual holds", () => {
  const cell = createAttributeValueCell({
    value: 0.5,
    isPercentage: true,
    isRelative: true,
  });

  const styled = applyFixtureValueSourceStyling(cell, {
    winningSource: "normal",
    hasShadowedManual: true,
  });

  if (styled.kind !== GridCellKind.Text) {
    assert.fail("Expected shadowed manual styling to preserve a text cell");
  }
  if (cell.kind !== GridCellKind.Text) {
    assert.fail("Expected relative value to be a text cell");
  }
  assert.equal(cell.displayData, "~ 50%");
  assert.equal(styled.displayData, "~ 50%");
  assert.equal(styled.themeOverride?.bgCell, "#1a1a1f");
  assert.equal(styled.themeOverride?.textDark, undefined);
  assert.equal(styled.stateIndicators, undefined);
});

/** Verifies the shared fixture value helper composes source, transition, and row styling. */
test("applyFixtureAttributeValueStyling composes value state styling", () => {
  const cell = createAttributeValueCell({
    value: 0.5,
    isPercentage: true,
    isRelative: false,
  });

  const styled = applyFixtureAttributeValueStyling(cell, {
    sourceState: { winningSource: "manual", hasShadowedManual: false },
    isTransitioning: true,
    isElement: true,
  });

  assert.equal(styled.themeOverride?.bgCell, "#594a00");
  assert.equal(styled.themeOverride?.bgCellMedium, "#594a00");
  assert.equal(styled.themeOverride?.textDark, "#B71C1C");
  assert.equal(styled.stateIndicators, undefined);
});

/** Verifies normal-sourced active transitions use the BRD transition text color. */
test("applyFixtureAttributeValueStyling colors normal transition text", () => {
  const cell = createAttributeValueCell({
    value: 64,
    isPercentage: false,
    isRelative: false,
  });

  const styled = applyFixtureAttributeValueStyling(cell, {
    sourceState: { winningSource: "normal", hasShadowedManual: false },
    isTransitioning: true,
  });

  assert.equal(styled.themeOverride?.bgCell, "#594a00");
  assert.equal(styled.themeOverride?.textDark, "#FFD166");
});

/** Verifies transition styling applies a state background without changing source color. */
test("applyTransitionStyling applies transition background", () => {
  const manual = applyFixtureValueSourceStyling(
    createAttributeValueCell({
      value: 0.5,
      isPercentage: true,
      isRelative: false,
    }),
    { winningSource: "manual", hasShadowedManual: false },
  );

  const transitioning = applyTransitionStyling(manual, true);

  assert.equal(transitioning.themeOverride?.bgCell, "#594a00");
  assert.equal(transitioning.themeOverride?.textDark, "#B71C1C");
  assert.equal(transitioning.stateIndicators, undefined);
});

/** Verifies active lookahead values use the higher-priority state background. */
test("applyTransitionStyling applies active lookahead background", () => {
  const lookahead = applyLookaheadStyling(
    createAttributeValueCell({
      value: 0.5,
      isPercentage: true,
      isRelative: false,
    }),
  );

  const transitioning = applyTransitionStyling(lookahead, true);

  assert.equal(transitioning.themeOverride?.bgCell, "#007360");
  assert.equal(transitioning.themeOverride?.textDark, undefined);
  assert.equal(transitioning.stateIndicators, undefined);
});
