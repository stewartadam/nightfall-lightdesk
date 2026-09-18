// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";
import DataGrid, {
  createKeyedDataGridCellProvider,
} from "../../components/widgets/data-grid";
import { type GridCell, GridCellKind } from "../../lib/data-grid-types";
import "../../index.css";

/** Mounts editable cells with every supported alignment for browser regression coverage. */
function AlignmentGrid() {
  const columns = ["left", "center", "right", "default"].map((id) => ({
    id,
    title: id,
    width: 180,
    sizing: "fixed" as const,
  }));
  const [cells, setCells] = createSignal<GridCell[]>(
    columns.map(({ id }) => ({
      kind: GridCellKind.Text,
      data: "Sample text",
      displayData: "Sample text",
      allowOverlay: true,
      contentAlign:
        id === "default" ? undefined : (id as "left" | "center" | "right"),
    })),
  );
  /** Publishes edited cells through the same keyed provider used by application grids. */
  const provider = createMemo(() => {
    const values = cells();
    return createKeyedDataGridCellProvider({
      rows: [0],
      columns,
      rowKey: (row) => row,
      columnKey: (column) => column.id,
      getCellContent: ({ columnIndex }) => values[columnIndex]!,
    });
  });
  return (
    <DataGrid
      columns={columns}
      rows={1}
      cellProvider={provider}
      height={120}
      onCellEdited={([column], value) => {
        setCells((current) =>
          current.map((cell, index) => (index === column ? value : cell)),
        );
      }}
    />
  );
}

render(() => <AlignmentGrid />, document.getElementById("root")!);
