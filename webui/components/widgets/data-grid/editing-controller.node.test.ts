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
import { createDataGridEditingController } from "./editing-controller";
import { initialDataGridSelectionState } from "./model/selection-model";
import type { DataGridProps } from "./model/types";

/** A read-only transition must discard a pending edit before either single or batch callbacks run. */
test("read-only policy blocks new editors and pending commits", () => {
  createRoot((dispose) => {
    let readOnly = false;
    let commits = 0;
    const source: GridCell = {
      kind: GridCellKind.Text,
      data: "Original",
      allowOverlay: true,
    };
    const props: DataGridProps = {
      columns: [{ id: "name", title: "Name" }],
      rows: 1,
      get readOnly() {
        return readOnly;
      },
      cellProvider: () => ({
        rows: ["row"],
        columns: ["name"],
        rowKeys: ["row"],
        columnKeys: ["name"],
        contentSizingKey: 0,
        getCellContent: () => source,
      }),
      onCellEdited: () => {
        commits += 1;
      },
      onCellsEdited: () => {
        commits += 1;
      },
    };
    const controller = createDataGridEditingController({
      props,
      getCellContent: () => () => source,
      selectionState: () => initialDataGridSelectionState,
      dispatchSelection: () => initialDataGridSelectionState,
      columnCount: () => 1,
      focusRoot: () => undefined,
    });
    controller.beginEdit(0, 0, "Replacement");
    assert.notEqual(controller.editingCell(), undefined);
    readOnly = true;
    controller.commitEdit();
    assert.equal(commits, 0);
    assert.equal(controller.editingCell(), undefined);
    controller.beginEdit(0, 0, "Another replacement");
    assert.equal(controller.editingCell(), undefined);
    controller.commitDiscreteEdit([0, 0], () => ({
      ...source,
      data: "Changed",
    }));
    assert.equal(commits, 0);
    dispose();
  });
});
