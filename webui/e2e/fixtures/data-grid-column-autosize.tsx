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
import { GridCellKind, type GridColumn } from "../../lib/data-grid-types";
import "../../index.css";

/** Exercises fixed, content-sized, bounded, and virtualized column measurements. */
function AutoSizeGrid() {
  const columns: GridColumn[] = [
    { id: "fixed", title: "Fixed", width: 90, sizing: "fixed" },
    { id: "content", title: "Content", sizing: "content" },
    {
      id: "bounded",
      title: "Bounded",
      width: 90,
      sizing: "fixed",
      maxWidth: 140,
    },
    { id: "minimum", title: "Min", width: 180, sizing: "fixed", minWidth: 100 },
  ];
  const [longText, setLongText] = createSignal(false);
  const [lastResize, setLastResize] = createSignal("");
  /** Keeps the sizing key stable so explicit auto-size must read live content. */
  const provider = createMemo(() => {
    const expanded = longText();
    return createKeyedDataGridCellProvider({
      rows: Array.from({ length: 100 }, (_, index) => index),
      columns,
      contentSizingKey: "stable-row-set",
      rowKey: (row) => row,
      columnKey: (column) => column.id!,
      getCellContent: ({ rowIndex, columnIndex }) => {
        const text =
          columnIndex === 3
            ? "x"
            : rowIndex === 99 && expanded
              ? "A much longer value outside the visible rows"
              : "Short";
        return {
          kind: GridCellKind.Text,
          data: text,
          displayData: text,
          allowOverlay: false,
        };
      },
    });
  });
  return (
    <>
      <button type="button" onClick={() => setLongText((value) => !value)}>
        Toggle long content
      </button>
      <output data-testid="last-resize">{lastResize()}</output>
      <DataGrid
        columns={columns}
        rows={100}
        cellProvider={provider}
        freezeColumns={1}
        height={240}
        onColumnResize={(column, width) =>
          setLastResize(`${column.id}:${width}`)
        }
      />
    </>
  );
}

render(() => <AutoSizeGrid />, document.getElementById("root")!);
