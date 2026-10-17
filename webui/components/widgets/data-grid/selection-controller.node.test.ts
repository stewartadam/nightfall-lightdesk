// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";
import { type GridCell, GridCellKind } from "../../../lib/data-grid-types";
import { initialDataGridSelectionState } from "./model/selection-model";
import type { DataGridSelectionMode } from "./model/types";
import { createDataGridSelectionController } from "./selection-controller";

/** Builds a controller in one selection mode and counts the selections it publishes. */
function controllerFor(mode: DataGridSelectionMode) {
  const cell: GridCell = { kind: GridCellKind.Text, data: "Value" };
  let published = 0;
  const controller = createDataGridSelectionController({
    editingCell: () => undefined,
    getCellContent: () => () => cell,
    primaryColumnIndex: () => 0,
    selectionMode: () => mode,
    columnCount: () => 3,
    focusRoot: () => undefined,
    scrollCellIntoView: () => undefined,
    onGridSelectionChange: () => {
      published += 1;
    },
  });
  return { controller, published: () => published };
}

/** Text and none grids must ignore clicks, keys and owner-supplied selections so nothing is highlighted or reported. */
test("text and none selection modes keep the grid selection empty", () => {
  for (const mode of ["text", "none"] as const) {
    createRoot((dispose) => {
      const { controller, published } = controllerFor(mode);
      controller.selectCell([1, 2], { extend: false });
      controller.dispatchSelection({
        type: "toggleRow",
        row: 1,
        extend: false,
      });
      controller.dispatchSelection({
        type: "selectColumnRange",
        start: 0,
        endExclusive: 2,
        activeRow: 0,
      });
      assert.equal(controller.selectionState(), initialDataGridSelectionState);
      assert.equal(published(), 0);
      dispose();
    });
  }
});

/** Cell mode still selects and publishes, guarding the shared gate against over-blocking. */
test("cell selection mode still selects and publishes clicked cells", () => {
  createRoot((dispose) => {
    const { controller, published } = controllerFor("cell");
    controller.selectCell([1, 2], { extend: false });
    assert.deepEqual(controller.selectionState().activeCell, [1, 2]);
    assert.equal(published(), 1);
    dispose();
  });
});
