// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createMemo, type Setter, Show } from "solid-js";
import type {
  CellClickedEventArgs,
  CustomCell,
  CustomRenderer,
  GridCell,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import { CellDecorationCanvas, CustomCellCanvas } from "./canvas-cells";
import { resolveCellContent } from "./cell-renderer-registry";
import type { DataGridCellKey } from "./model/cell-provider";
import { canUseCellEditor } from "./model/cell-utils";
import type { DataGridTableColumn } from "./model/column-model";
import { selectionOutline } from "./model/selection-outline";
import type {
  DataGridCellDecorationCallback,
  DataGridCellEditFactory,
  DataGridEditCommitContext,
  DataGridEditCommitMode,
  DataGridInlineEditTooltipContext,
  DataGridRichCellExtension,
  EditingCell,
} from "./model/types";

type CoordinateAxis = "x" | "y" | "z";

const COORDINATE_AXIS_COLORS: Record<CoordinateAxis, string> = {
  x: "rgba(239, 68, 68, 0.55)",
  y: "rgba(34, 197, 94, 0.55)",
  z: "rgba(59, 130, 246, 0.55)",
};
const GRID_CELL_BACKGROUND = "var(--data-grid-bg, #16161b)";
const SELECTED_CELL_BACKGROUND =
  "var(--data-grid-selected-bg, rgba(23, 37, 84, 0.4))";
const PAUSED_GRID_CELL: GridCell = { kind: GridCellKind.Loading };

const objectHasOwnProperty = Object.prototype.hasOwnProperty;

/** Layers a cell color over the grid base so sticky cells never show scrolled content through translucent fills. */
function opaqueStickyBackground(cellBackground: string): string {
  return `linear-gradient(${cellBackground}, ${cellBackground}), ${GRID_CELL_BACKGROUND}`;
}

/** Compares render-relevant cell data by value while ignoring callback fields. */
function renderValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (left === undefined || right === undefined) return false;
  if (typeof left === "function") return true;
  if (typeof left !== "object") return false;

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const leftArray = left as readonly unknown[];
    const rightArray = right as readonly unknown[];
    return (
      leftArray.length === rightArray.length &&
      leftArray.every((entry, index) =>
        renderValuesEqual(entry, rightArray[index]),
      )
    );
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter(
    (key) => typeof leftRecord[key] !== "function",
  );
  const rightKeys = Object.keys(rightRecord).filter(
    (key) => typeof rightRecord[key] !== "function",
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        objectHasOwnProperty.call(rightRecord, key) &&
        typeof rightRecord[key] !== "function" &&
        renderValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/** Returns a coordinate axis for conventional X/Y/Z placement columns. */
function coordinateAxisForColumn(columnId: string | undefined) {
  if (columnId?.endsWith("_x")) return "x";
  if (columnId?.endsWith("_y")) return "y";
  if (columnId?.endsWith("_z")) return "z";
  return undefined;
}

export interface BodyCellProps {
  col: number;
  rowIndex: number;
  columnKey: Accessor<DataGridCellKey | undefined>;
  rowKey: Accessor<DataGridCellKey | undefined>;
  activeCell: Accessor<Item | undefined>;
  beginDragSelection: (col: number, row: number, event: PointerEvent) => void;
  beginEdit: (col: number, row: number) => void;
  cancelEdit: () => void;
  cellDecorations?: DataGridCellDecorationCallback;
  cellsUpdating: Accessor<boolean>;
  cellUpdateVersion: Accessor<number>;
  commitEdit: (mode?: DataGridEditCommitMode) => void;
  currentSelection: Accessor<GridSelection["current"] | undefined>;
  customRenderers?: readonly CustomRenderer<any>[];
  richCellExtensions?: readonly DataGridRichCellExtension[];
  editingCell: Accessor<EditingCell | undefined>;
  column: Accessor<DataGridTableColumn>;
  columnWidthVariable: string;
  getCellContent: Accessor<(cell: Item) => GridCell>;
  handleCellClick: (col: number, row: number, event: MouseEvent) => void;
  handleCellEnterKey: (col: number, row: number, event: KeyboardEvent) => void;
  decorationInvalidateKey?: unknown;
  onCellResolved?: () => void;
  onCellHovered?: (cell: Item | undefined, element?: HTMLElement) => void;
  onCellContextMenu?: (cell: Item, event: CellClickedEventArgs) => void;
  onCellEdited?: (
    cell: Item,
    newValue: GridCell,
    selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => void;
  inlineEditTooltip?: (
    context: DataGridInlineEditTooltipContext,
  ) => string | undefined;
  commitDiscreteEdit: (
    cell: Item,
    makeEditedCell: DataGridCellEditFactory,
  ) => void;
  rowHeight: Accessor<number>;
  rowCount: Accessor<number>;
  columnCount: Accessor<number>;
  selectedColumnSet: Accessor<ReadonlySet<number>>;
  selectedRowSet: Accessor<ReadonlySet<number>>;
  selectCell: (
    target: Item,
    options: { append?: boolean; extend: boolean; scroll?: boolean },
  ) => void;
  setActiveCell: (cell: Item | undefined) => void;
  setEditingCell: Setter<EditingCell | undefined>;
  setInputRef: (element: HTMLInputElement) => void;
  stickyLeft: Accessor<number>;
}

/** Renders one body cell with selection, editing, decoration, and sticky state. */
export function BodyCell(props: BodyCellProps) {
  let previousGridCell:
    | {
        cell: GridCell;
      }
    | undefined;

  const coordinateAxis = () => coordinateAxisForColumn(props.column().id);

  const gridCell = createMemo(() => {
    if (!props.cellsUpdating()) {
      return previousGridCell?.cell ?? PAUSED_GRID_CELL;
    }
    void props.cellUpdateVersion();

    const cell = props.getCellContent()([props.col, props.rowIndex]);
    props.onCellResolved?.();
    if (
      previousGridCell !== undefined &&
      renderValuesEqual(previousGridCell.cell, cell)
    ) {
      return previousGridCell.cell;
    }
    previousGridCell = { cell };
    return cell;
  });

  /** Returns whether this cell is the current keyboard active cell. */
  const isActiveCell = () =>
    props.activeCell()?.[0] === props.col &&
    props.activeCell()?.[1] === props.rowIndex;

  /** Computes the selection perimeter from logical neighbors, including cells outside the viewport. */
  const outline = createMemo(() =>
    selectionOutline(
      {
        current: props.currentSelection(),
        active: props.activeCell(),
        rows: props.selectedRowSet(),
        columns: props.selectedColumnSet(),
        rowCount: props.rowCount(),
        columnCount: props.columnCount(),
      },
      props.col,
      props.rowIndex,
    ),
  );

  /** Returns whether any selection state applies to this cell. */
  const isSelectedCellOrRange = () => outline().selected;

  /** Returns whether this cell currently owns the inline editor. */
  const isEditingCell = () =>
    props.editingCell()?.col === props.col &&
    props.editingCell()?.row === props.rowIndex;

  /** Returns the stable editor kind for this cell without tracking edit text. */
  const editingCellKind = createMemo(() => {
    const editing = props.editingCell();
    if (editing?.col !== props.col || editing?.row !== props.rowIndex) {
      return undefined;
    }
    return editing.kind;
  });

  /** Returns the registered rich-cell extension that opened this editor. */
  const editingExtensionId = createMemo(() => {
    const editing = props.editingCell();
    if (editing?.col !== props.col || editing?.row !== props.rowIndex) {
      return undefined;
    }
    return editing.kind === "rich" ? editing.extensionId : undefined;
  });

  /** Returns the cell snapshot that opened the active editor for this coordinate. */
  const editingSourceCell = createMemo(() => {
    const editing = props.editingCell();
    if (editing?.col !== props.col || editing?.row !== props.rowIndex) {
      return undefined;
    }
    return editing.sourceCell;
  });

  /** Returns the cell data used to resolve editor or display content. */
  const contentCell = createMemo(() => editingSourceCell() ?? gridCell());

  /** Returns the current edit value for the active inline editor. */
  const editingValue = () => {
    const editing = props.editingCell();
    return isEditingCell() &&
      editing !== undefined &&
      (editing.kind === GridCellKind.Text ||
        editing.kind === GridCellKind.Number)
      ? editing.value
      : "";
  };

  /** Returns whether this cell is in the frozen column region. */
  const isSticky = () => props.column().getIsPinned() === "start";

  /** Computes the sticky offset for frozen cells. */
  const left = () => props.stickyLeft();

  /** Resolves the cell background from theme and selection state. */
  const bg = () => {
    const cellBackground =
      gridCell().themeOverride?.bgCell ??
      (isSelectedCellOrRange()
        ? SELECTED_CELL_BACKGROUND
        : GRID_CELL_BACKGROUND);
    const base = isSticky()
      ? opaqueStickyBackground(cellBackground)
      : cellBackground;
    const color = "var(--data-grid-selection-ring, #60a5fa)";
    const edges: string[] = [];
    if (outline().top)
      edges.push(
        `linear-gradient(${color}, ${color}) top / 100% 1px no-repeat border-box`,
      );
    if (outline().right)
      edges.push(
        `linear-gradient(${color}, ${color}) right / 1px 100% no-repeat border-box`,
      );
    if (outline().bottom)
      edges.push(
        `linear-gradient(${color}, ${color}) bottom / 100% 1px no-repeat border-box`,
      );
    if (outline().left)
      edges.push(
        `linear-gradient(${color}, ${color}) left / 1px 100% no-repeat border-box`,
      );
    return [...edges, base].join(", ");
  };

  /** Resolves the cell foreground color. */
  const color = () =>
    gridCell().themeOverride?.textDark ?? "var(--data-grid-text, #ffffff)";

  /** Retains coordinate accents on unselected cells without adding interior selection rings. */
  const cellRings = () => {
    const rings: string[] = [];
    const axis = coordinateAxis();
    if (axis && !isSelectedCellOrRange()) {
      rings.push(`inset -3px 0 0 0 ${COORDINATE_AXIS_COLORS[axis]}`);
    }
    return rings.length > 0 ? rings.join(", ") : undefined;
  };

  /** Renders the optional decoration overlay for the current cell. */
  const decoration = () => (
    <Show when={props.cellDecorations}>
      {(drawDecoration) => (
        <CellDecorationCanvas
          cell={gridCell()}
          col={props.col}
          row={props.rowIndex}
          drawDecoration={drawDecoration()}
          redrawKey={props.decorationInvalidateKey}
        />
      )}
    </Show>
  );

  /** Resolves cell content through the renderer/editor registry. */
  const cellContent = createMemo(() =>
    resolveCellContent({
      cell: contentCell(),
      col: props.col,
      row: props.rowIndex,
      customRenderers: props.customRenderers,
      richCellExtensions: props.richCellExtensions,
      editingCellKind: editingCellKind(),
      editingExtensionId: editingExtensionId(),
      editingValue,
      commitDiscreteEdit: props.commitDiscreteEdit,
      onCellEdited: props.onCellEdited,
      inlineEditTooltip: props.inlineEditTooltip,
      selectCell: props.selectCell,
      setActiveCell: props.setActiveCell,
      setEditingCell: props.setEditingCell,
      setInputRef: props.setInputRef,
      commitEdit: props.commitEdit,
      cancelEdit: props.cancelEdit,
    }),
  );

  /** Returns whether the current cell body should render through a custom canvas. */
  const shouldUseCustomCanvas = () =>
    cellContent().customCanvasRenderer !== undefined && !isEditingCell();

  /** Returns whether the current cell body should use standard padded cell spacing. */
  const cellContentPadded = () => {
    const content = cellContent();
    return shouldUseCustomCanvas() ? true : content.padded;
  };

  /** Adds space so the right-side coordinate border does not overlap content. */
  const coordinatePaddingRight = () =>
    coordinateAxis() && cellContentPadded() ? "calc(0.5rem + 3px)" : undefined;

  /** Renders the visible body content while preserving custom canvas DOM identity. */
  const renderedCellContent = () => {
    const content = cellContent();
    return (
      <Show
        when={
          shouldUseCustomCanvas() ? content.customCanvasRenderer : undefined
        }
        fallback={content.element}
      >
        {(renderer) => (
          <>
            <CustomCellCanvas
              cell={contentCell() as CustomCell}
              col={props.col}
              row={props.rowIndex}
              renderer={renderer()}
            />
            <span class="sr-only">{contentCell().copyData ?? ""}</span>
          </>
        )}
      </Show>
    );
  };

  return (
    <div
      id={`tanstack-cell-${props.col}-${props.rowIndex}`}
      role="gridcell"
      tabIndex={-1}
      data-coordinate-axis={coordinateAxis()}
      data-grid-column-index={props.col}
      data-grid-column-key={
        props.columnKey() === undefined ? undefined : String(props.columnKey())
      }
      data-grid-row-index={props.rowIndex}
      data-grid-row-key={
        props.rowKey() === undefined ? undefined : String(props.rowKey())
      }
      data-editable={
        canUseCellEditor(gridCell(), props.richCellExtensions)
          ? "true"
          : "false"
      }
      data-kind={gridCell().kind}
      aria-selected={isActiveCell() ? "true" : "false"}
      data-selected={isSelectedCellOrRange() ? "true" : "false"}
      class={`relative flex shrink-0 items-center overflow-hidden border-r border-b border-white/15 ${cellContentPadded() ? "px-2" : "p-0"} ${isSticky() ? "sticky z-10" : ""}`}
      style={{
        width: `var(${props.columnWidthVariable})`,
        height: `${props.rowHeight()}px`,
        left: isSticky() ? `${left()}px` : undefined,
        background: bg(),
        color: color(),
        "box-shadow": cellRings(),
        "border-right-color": outline().sharedRight
          ? "var(--data-grid-selection-divider, var(--data-grid-column-border, transparent))"
          : outline().right
            ? "transparent"
            : undefined,
        "border-bottom-color": outline().sharedBottom
          ? "var(--data-grid-selection-divider, var(--data-grid-column-border, transparent))"
          : outline().bottom
            ? "transparent"
            : undefined,
        "padding-right": coordinatePaddingRight(),
      }}
      onPointerDown={(event) =>
        props.beginDragSelection(props.col, props.rowIndex, event)
      }
      onMouseEnter={(event) =>
        props.onCellHovered?.([props.col, props.rowIndex], event.currentTarget)
      }
      onMouseLeave={() => props.onCellHovered?.(undefined)}
      onClick={(event) =>
        props.handleCellClick(props.col, props.rowIndex, event)
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          props.handleCellEnterKey(props.col, props.rowIndex, event);
        }
      }}
      onDblClick={() => props.beginEdit(props.col, props.rowIndex)}
      onContextMenu={(event) => {
        props.onCellContextMenu?.(
          [props.col, props.rowIndex],
          event as unknown as CellClickedEventArgs,
        );
      }}
    >
      {renderedCellContent()}
      {decoration()}
    </div>
  );
}
