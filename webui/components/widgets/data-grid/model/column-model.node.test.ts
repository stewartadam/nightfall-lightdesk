// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createTable } from "@tanstack/solid-table";
import { createRoot } from "solid-js";
import type { GridColumn } from "../../../../lib/data-grid-types";
import { columnWidth, groupColumns, sourceGridColumn } from "./column-model";
import { dataGridTableFeatures } from "./table-features";
import type { TableRow } from "./types";

type NestedGridColumn = GridColumn & {
  visibilityCategory?: string;
  visibilityGroup?: string;
  visibilityGroupLabel?: string;
};

/** Verifies transiently missing virtualized columns fall back to the default width. */
test("columnWidth handles missing column metadata", () => {
  assert.equal(columnWidth(undefined), 120);
});

/** Verifies singleton nested attributes collapse in the authoritative definition tree. */
test("groupColumns collapses single-column nested attribute groups", () => {
  const columns: NestedGridColumn[] = [
    { id: "id", title: "ID", width: 85, visibilityCategory: "Identity" },
    {
      id: "name",
      title: "Fixture",
      width: 150,
      visibilityCategory: "Identity",
    },
    {
      id: "Red_Value",
      title: "",
      width: 96,
      visibilityCategory: "Color",
      visibilityGroup: "Red",
      visibilityGroupLabel: "Red",
    },
  ];

  const definitions = groupColumns(columns, true);
  const colorGroup = definitions.find(
    (definition) => definition.id === "category:Color",
  );
  assert.ok(colorGroup && "columns" in colorGroup);
  assert.equal(colorGroup.columns?.length, 1);
  assert.equal(colorGroup.columns?.[0]?.id, "Red_Value");
  assert.equal(colorGroup.columns?.[0]?.header, "Red");
});

/** Verifies absent per-column bounds preserve table defaults while explicit bounds clamp sizing. */
test("groupColumns preserves default and explicit sizing bounds", () => {
  createRoot((dispose) => {
    const table = createTable({
      features: dataGridTableFeatures,
      data: [{ rowIndex: 0 }],
      columns: groupColumns(
        [
          { id: "default", title: "Default" },
          {
            id: "bounded-min",
            title: "Bounded minimum",
            minWidth: 50,
            maxWidth: 95,
          },
          {
            id: "bounded-max",
            title: "Bounded maximum",
            minWidth: 50,
            maxWidth: 95,
          },
        ],
        false,
      ),
      defaultColumn: { minSize: 36, size: 120 },
      initialState: {
        columnSizing: { default: 0, "bounded-min": 0, "bounded-max": 200 },
      },
    });

    assert.equal(table.getColumn("default")?.getSize(), 36);
    assert.equal(table.getColumn("bounded-min")?.getSize(), 50);
    assert.equal(table.getColumn("bounded-max")?.getSize(), 95);
    dispose();
  });
});

/** Verifies repeated groups remain separate so Table coordinates retain source order. */
test("groupColumns preserves noncontiguous source-column runs", () => {
  const columns: NestedGridColumn[] = [
    {
      id: "intensity",
      title: "Intensity",
      visibilityCategory: "Dimmer",
      visibilityGroup: "Intensity",
    },
    {
      id: "red",
      title: "Red",
      visibilityCategory: "Color",
      visibilityGroup: "Red",
    },
    {
      id: "pan",
      title: "Pan",
      visibilityCategory: "Position",
      visibilityGroup: "Pan",
    },
    {
      id: "strobe",
      title: "Strobe",
      visibilityCategory: "Dimmer",
      visibilityGroup: "Strobe",
    },
  ];

  createRoot((dispose) => {
    const table = createTable({
      features: dataGridTableFeatures,
      data: [{ rowIndex: 0 }],
      columns: groupColumns(columns, true),
    });
    assert.deepEqual(
      table.getAllLeafColumns().map((column) => column.id),
      columns.map((column) => column.id),
    );
    assert.deepEqual(
      table.getAllColumns().map((column) => column.id),
      [
        "category:Dimmer",
        "category:Color",
        "category:Position",
        "category:Dimmer:run:2",
      ],
    );
    dispose();
  });
});

/** Verifies TanStack owns grouped headers, row cells, pin partitions, and sizes. */
test("table model exposes authoritative grid structure and feature state", () => {
  createRoot((dispose) => {
    const columns: NestedGridColumn[] = [
      { id: "id", title: "ID", width: 80 },
      { id: "red_value", title: "Value", width: 90, group: "Red" },
      { id: "red_fade", title: "Fade", width: 100, group: "Red" },
    ];
    const rows: TableRow[] = [{ rowIndex: 4 }, { rowIndex: 8 }];
    const table = createTable({
      features: dataGridTableFeatures,
      data: rows,
      columns: groupColumns(columns, false),
      initialState: { columnPinning: { start: ["id"], end: [] } },
      columnResizeMode: "onChange",
    });

    assert.deepEqual(
      table
        .getHeaderGroups()
        .map((group) => group.headers.map((header) => header.column.id)),
      [
        ["id", "group:Red"],
        ["id", "red_value", "red_fade"],
      ],
    );
    assert.equal(table.getHeaderGroups()[0]?.headers[0]?.isPlaceholder, true);
    assert.equal(table.getHeaderGroups()[0]?.headers[1]?.colSpan, 2);
    assert.deepEqual(
      table.getStartVisibleLeafColumns().map((column) => column.id),
      ["id"],
    );
    assert.deepEqual(
      table.getCenterVisibleLeafColumns().map((column) => column.id),
      ["red_value", "red_fade"],
    );
    assert.deepEqual(
      table
        .getRowModel()
        .rows[0]?.getAllCells()
        .map((cell) => cell.column.id),
      ["id", "red_value", "red_fade"],
    );
    assert.deepEqual(
      table
        .getRowModel()
        .rows[0]?.getStartVisibleCells()
        .map((cell) => cell.column.id),
      ["id"],
    );

    assert.equal(sourceGridColumn(table.getColumn("id")), columns[0]);
    assert.equal(table.getColumn("red_value")?.getSize(), 90);
    assert.equal(table.getColumn("red_fade")?.getStart("center"), 90);
    assert.equal(table.getHeaderGroups()[0]?.headers[1]?.getSize(), 190);
    assert.equal(table.getCenterTotalSize(), 190);
    assert.equal(table.getTotalSize(), 270);
    dispose();
  });
});
