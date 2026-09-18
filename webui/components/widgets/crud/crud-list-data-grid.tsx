// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  CompactSelection,
  type CustomRenderer,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
  type Item,
} from "../../../lib/data-grid-types";
import { makeSafeTextCell } from "../../../lib/datagrid";
import {
  alwaysVisibleColumnMeta,
  columnVisibilityMeta,
  type DataGridColumnVisibilityCategory,
  filterVisibleColumns,
} from "../../../lib/datagrid-column-visibility";
import {
  applyTableFilters,
  type DataGridColumnFilterConfig,
  EMPTY_TABLE_FILTERS,
  filterColumnsFromMetadata,
  loadTableFilters,
  saveTableFilters,
  type TableFilterSettings,
} from "../../../lib/datagrid-filtering";
import {
  getActionAtPosition,
  isRichActionButtonCell,
  normalizeGridClickPosition,
} from "../../../lib/datagrid-rich-cells";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridCellKey,
  type DataGridProps,
} from "../data-grid";
import ColumnVisibilityMenu from "../data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../data-grid/extensions/data-grid-filter-menu";

interface RowClickModifiers {
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface CrudListDataGridEditRequest<T> {
  row: T;
  columnId: string;
  requestId: number;
}

export interface CrudListDataGridSelectionRequest<T> {
  row: T;
  requestId: number;
}

export interface CrudListDataGridColumn<T> {
  id: string;
  title: string;
  width?: number;
  sizing?: GridColumn["sizing"];
  minWidth?: number;
  maxWidth?: number;
  value?: (row: T) => unknown;
  cell?: (row: T) => GridCell;
  onEdit?: (row: T, value: string) => void;
  onAction?: (row: T, actionId: string, modifiers: RowClickModifiers) => void;
  filter?: false | DataGridColumnFilterConfig<T>;
  hideable?: boolean;
  visibilityCategory?: DataGridColumnVisibilityCategory;
  visibilityLabel?: string;
  visibilityGroup?: string;
  visibilityGroupLabel?: string;
}

interface CrudListDataGridProps<T> {
  panelId: string;
  rows: T[];
  columns: CrudListDataGridColumn<T>[];
  rowKey?: (row: T, rowIndex: number) => DataGridCellKey;
  rowMarkers?: DataGridProps["rowMarkers"];
  rowSelectionOnly?: boolean;
  isRowSelectable?: (row: T) => boolean;
  isRowSelected?: (row: T) => boolean;
  editRequest?: CrudListDataGridEditRequest<T>;
  selectionRequest?: CrudListDataGridSelectionRequest<T>;
  onDeleteRequested?: () => void;
  onActiveRowChange?: (row: T | null) => void;
  onSelectionChange?: (rows: T[]) => void;
  multiSelectOnPlainClick?: boolean;
  onRowClick: (row: T, modifiers: RowClickModifiers) => void;
  onRowContextMenu?: (
    row: T,
    modifiers: RowClickModifiers,
    position: ContextMenuPosition,
  ) => void;
  customRenderers?: readonly CustomRenderer[];
  height?: number | string;
  class?: string;
}

const selectedRowTheme = {
  bgCell: "rgba(23, 37, 84, 0.4)",
  bgCellMedium: "rgba(23, 37, 84, 0.4)",
};

function isDefaultAlwaysVisibleColumn<T>(
  column: CrudListDataGridColumn<T>,
): boolean {
  return (
    column.visibilityCategory === "Identity" ||
    column.id.toLowerCase() === "id" ||
    column.title.toLowerCase() === "id"
  );
}

export default function CrudListDataGrid<T>(props: CrudListDataGridProps<T>) {
  let rootRef: HTMLDivElement | undefined;
  const [lastInteractedRow, setLastInteractedRow] = createSignal<number | null>(
    null,
  );
  const [selectionCurrent, setSelectionCurrent] = createSignal<
    GridSelection["current"] | undefined
  >(undefined);
  let suppressNextGridSelectionChange = false;
  let handledSelectionRequestId: number | undefined;
  let clearSuppressSelectionTimer: ReturnType<typeof setTimeout> | undefined;
  let modifierSelectionSnapshot: number[] | undefined;

  const visibilityScope = () => `${props.panelId}-list`;

  const filterScope = () => `${props.panelId}-list`;
  const [tableFilters, setTableFiltersSignal] =
    createSignal<TableFilterSettings>(loadTableFilters(filterScope()));

  const isSelectableRow = (rowData: T) =>
    props.isRowSelectable ? props.isRowSelectable(rowData) : true;
  const normalizeCurrentSelection = (
    current: GridSelection["current"] | undefined,
  ): GridSelection["current"] | undefined => {
    if (!current || !props.rowSelectionOnly) return current;
    const rowWidth = Math.max(displayColumns().length, 1);
    return {
      ...current,
      cell: [0, current.cell[1]],
      range: {
        ...current.range,
        x: 0,
        width: rowWidth,
      },
      rangeStack: current.rangeStack.map((range) => ({
        ...range,
        x: 0,
        width: rowWidth,
      })),
    };
  };

  const columns = createMemo<GridColumn[]>(() =>
    props.columns.map((column) => {
      const isAlwaysVisible =
        column.hideable === false ||
        (column.hideable !== true && isDefaultAlwaysVisibleColumn(column));

      return {
        id: column.id,
        title: column.title,
        width: column.width ?? 120,
        sizing: column.sizing,
        minWidth: column.minWidth,
        maxWidth: column.maxWidth,
        ...(isAlwaysVisible
          ? alwaysVisibleColumnMeta(
              column.visibilityCategory,
              column.visibilityLabel ?? column.title,
            )
          : columnVisibilityMeta(
              column.visibilityCategory ?? "Metadata",
              column.visibilityLabel ?? column.title,
            )),
        visibilityGroup: column.visibilityGroup,
        visibilityGroupLabel: column.visibilityGroupLabel,
      };
    }),
  );

  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns(), visibilityScope());
  });

  const displayColumnDefinitions = createMemo(() => {
    const visibleIds = new Set(displayColumns().map((column) => column.id));
    return props.columns.filter((column) => visibleIds.has(column.id));
  });

  /** Reports whether any visible column can commit inline edits. */
  const hasEditableColumns = createMemo(() =>
    displayColumnDefinitions().some((column) => column.onEdit !== undefined),
  );

  const filterColumns = createMemo(() =>
    filterColumnsFromMetadata(
      props.columns.map((column) => ({
        ...column,
        title: column.visibilityLabel ?? column.title,
      })),
    ),
  );

  const displayRows = createMemo(() => {
    const columns = filterColumns();
    if (columns.length === 0) return props.rows;
    return applyTableFilters(props.rows, columns, tableFilters());
  });

  /** Maps owner-level row edit requests to the visible grid cell coordinates. */
  const editRequest = createMemo(() => {
    const request = props.editRequest;
    if (!request) return undefined;
    const row = displayRows().indexOf(request.row);
    const col = displayColumnDefinitions().findIndex(
      (column) => column.id === request.columnId,
    );
    if (row < 0 || col < 0) return undefined;
    return { cell: [col, row] as Item, requestId: request.requestId };
  });

  /** Maps owner-level row selection requests to visible grid coordinates. */
  const selectionScrollRequest = createMemo(() => {
    const request = props.selectionRequest;
    if (!request) return undefined;
    const row = displayRows().indexOf(request.row);
    if (row < 0) return undefined;
    return { cell: [0, row] as Item, requestId: request.requestId };
  });

  const setTableFilters = (filters: TableFilterSettings) => {
    setTableFiltersSignal(filters);
    saveTableFilters(filterScope(), filters);
  };

  /** Applies one-shot owner selection requests after filtering has settled. */
  const applySelectionRequest = (allowFilterRetry = true) => {
    const request = props.selectionRequest;
    if (!request || !props.onSelectionChange) return;

    const row = displayRows().indexOf(request.row);
    if (row < 0) {
      if (allowFilterRetry) {
        setTableFilters(EMPTY_TABLE_FILTERS);
        setTimeout(() => applySelectionRequest(false), 0);
      }
      return;
    }

    setSelectionCurrent({
      cell: [0, row],
      range: {
        x: 0,
        y: row,
        width: Math.max(displayColumns().length, 1),
        height: 1,
      },
      rangeStack: [],
    });
    setLastInteractedRow(row);
    applySelectionByIndices([row]);
  };

  /** Marks text-like cells editable when their column can commit edited values. */
  const applyEditability = (
    column: CrudListDataGridColumn<T>,
    cell: GridCell,
  ): GridCell => {
    if (!column.onEdit) return cell;
    if (cell.kind !== GridCellKind.Text && cell.kind !== GridCellKind.Number) {
      return cell;
    }
    return { ...cell, allowOverlay: true };
  };

  const cellProvider = createMemo(() => {
    const isRowSelected = props.isRowSelected;

    return createKeyedDataGridCellProvider({
      rows: displayRows(),
      columns: displayColumnDefinitions(),
      rowKey: (row, rowIndex) => props.rowKey?.(row, rowIndex) ?? rowIndex,
      columnKey: (column) => column.id,
      getCellContent: ({ row: rowData, column }): GridCell => {
        const baseCell = column.cell
          ? column.cell(rowData)
          : makeSafeTextCell(column.value ? column.value(rowData) : "");
        const cell = applyEditability(column, baseCell);

        if (!isRowSelected?.(rowData)) {
          return cell;
        }

        return {
          ...cell,
          themeOverride: {
            ...(cell.themeOverride ?? {}),
            ...selectedRowTheme,
          },
        };
      },
    });
  });

  const getColumnCell = (
    column: CrudListDataGridColumn<T> | undefined,
    rowData: T,
  ): GridCell => {
    if (!column) return makeSafeTextCell("");
    const cell = column.cell
      ? column.cell(rowData)
      : makeSafeTextCell(column.value ? column.value(rowData) : "");
    return applyEditability(column, cell);
  };

  const selectedRowIndices = createMemo<number[]>(() => {
    const isRowSelected = props.isRowSelected;
    if (!isRowSelected) return [];

    const indices: number[] = [];
    displayRows().forEach((row, index) => {
      if (isRowSelected(row)) {
        indices.push(index);
      }
    });
    return indices;
  });

  const handleKeyDownCapture = (event: KeyboardEvent) => {
    if (!props.onDeleteRequested) return;
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;

    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }

    if (selectedRowIndices().length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    props.onDeleteRequested();
  };

  /** Captures controlled row selection before the grid applies a modifier range. */
  const handlePointerDownCapture = (event: PointerEvent) => {
    modifierSelectionSnapshot =
      event.ctrlKey || event.metaKey ? selectedRowIndices() : undefined;
  };

  onMount(() => {
    if (!rootRef) return;
    rootRef.addEventListener("keydown", handleKeyDownCapture, {
      capture: true,
    });
    rootRef.addEventListener("pointerdown", handlePointerDownCapture, {
      capture: true,
    });
    onCleanup(() => {
      rootRef?.removeEventListener("keydown", handleKeyDownCapture, {
        capture: true,
      });
      rootRef?.removeEventListener("pointerdown", handlePointerDownCapture, {
        capture: true,
      });
    });
  });

  const applySelectionByIndices = (indices: number[]) => {
    if (!props.onSelectionChange) return;

    const selectedRows: T[] = [];
    const rows = displayRows();
    for (const index of indices) {
      const row = rows[index];
      if (row !== undefined) {
        selectedRows.push(row);
      }
    }
    suppressNextGridSelectionChange = true;
    if (clearSuppressSelectionTimer !== undefined) {
      clearTimeout(clearSuppressSelectionTimer);
    }
    clearSuppressSelectionTimer = setTimeout(() => {
      suppressNextGridSelectionChange = false;
      clearSuppressSelectionTimer = undefined;
    }, 120);
    props.onSelectionChange(selectedRows);
  };

  /** Handles one-shot owner requests to select and reveal a specific row. */
  createEffect(() => {
    const request = props.selectionRequest;
    if (!request || handledSelectionRequestId === request.requestId) return;
    handledSelectionRequestId = request.requestId;
    applySelectionRequest();
  });

  const getSelectedIndicesFromGridSelection = (selection: GridSelection) => {
    const next = new Set<number>();
    const rows = displayRows();

    for (const index of selection.rows) {
      if (index >= 0 && index < rows.length) {
        const rowData = rows[index];
        if (rowData !== undefined && !isSelectableRow(rowData)) {
          continue;
        }
        next.add(index);
      }
    }

    const addRangeRows = (range: { y: number; height: number }) => {
      const start = Math.max(0, range.y);
      const end = Math.min(rows.length - 1, range.y + range.height - 1);
      for (let row = start; row <= end; row += 1) {
        const rowData = rows[row];
        if (rowData !== undefined && !isSelectableRow(rowData)) {
          continue;
        }
        next.add(row);
      }
    };

    const current = selection.current;
    if (current) {
      addRangeRows(current.range);
      for (const range of current.rangeStack) {
        addRangeRows(range);
      }
    }

    return Array.from(next).sort((a, b) => a - b);
  };

  const gridSelection = createMemo<GridSelection | undefined>(() => {
    if (!props.isRowSelected) {
      return undefined;
    }

    const baseSelection: GridSelection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromArray(selectedRowIndices()),
    };

    const current = selectionCurrent();
    return current
      ? {
          ...baseSelection,
          current,
        }
      : baseSelection;
  });

  /** Commits edited grid text back to the owning column definition. */
  const handleCellEdited = ([col, row]: Item, newCell: GridCell) => {
    const rowData = displayRows()[row];
    const column = displayColumnDefinitions()[col];
    if (!rowData || !column?.onEdit) return;
    if (newCell.kind === GridCellKind.Text) {
      column.onEdit(rowData, newCell.data);
      return;
    }
    if (newCell.kind === GridCellKind.Number) {
      column.onEdit(rowData, String(newCell.data));
    }
  };

  return (
    <div
      ref={rootRef}
      class={
        props.class
          ? `${props.class} relative`
          : props.height === undefined
            ? "relative h-full min-h-0"
            : "relative min-h-0"
      }
    >
      <DataGrid
        rows={displayRows().length}
        columns={displayColumns()}
        cellProvider={cellProvider}
        editRequest={editRequest()}
        scrollRequest={selectionScrollRequest()}
        onCellEdited={hasEditableColumns() ? handleCellEdited : undefined}
        onDelete={() => {
          if (!props.onDeleteRequested || selectedRowIndices().length === 0) {
            return undefined;
          }
          props.onDeleteRequested();
          return true;
        }}
        width="100%"
        height={props.height ?? "100%"}
        rowMarkers={props.rowMarkers ?? "checkbox"}
        gridSelection={gridSelection()}
        onGridSelectionChange={(selection) => {
          const normalizedCurrent = normalizeCurrentSelection(
            selection.current,
          );
          const normalizedSelection: GridSelection = normalizedCurrent
            ? {
                ...selection,
                current: normalizedCurrent,
              }
            : {
                columns: selection.columns,
                rows: selection.rows,
              };
          setSelectionCurrent(normalizedCurrent);
          const activeRowIndex = normalizedCurrent?.range.y;
          if (activeRowIndex === undefined) {
            props.onActiveRowChange?.(null);
          } else {
            const activeRow = displayRows()[activeRowIndex];
            props.onActiveRowChange?.(activeRow ?? null);
          }
          if (!props.onSelectionChange) return;
          if (suppressNextGridSelectionChange) {
            suppressNextGridSelectionChange = false;
            if (clearSuppressSelectionTimer !== undefined) {
              clearTimeout(clearSuppressSelectionTimer);
              clearSuppressSelectionTimer = undefined;
            }
            return;
          }

          let hasExplicitRowSelection = false;
          for (const _ of normalizedSelection.rows) {
            hasExplicitRowSelection = true;
            break;
          }

          const currentSelection = normalizedSelection.current;
          const isCellOnlyActivation =
            !hasExplicitRowSelection &&
            currentSelection !== undefined &&
            currentSelection.range.width === 1 &&
            currentSelection.range.height === 1 &&
            currentSelection.rangeStack.length === 0;
          if (isCellOnlyActivation) {
            return;
          }

          const selectedRows: T[] = [];
          const selectedIndices =
            getSelectedIndicesFromGridSelection(normalizedSelection);
          const rows = displayRows();
          for (const index of selectedIndices) {
            const row = rows[index];
            if (row !== undefined) {
              selectedRows.push(row);
            }
          }
          if (selectedIndices.length > 0) {
            setLastInteractedRow(selectedIndices[selectedIndices.length - 1]);
          }
          props.onSelectionChange(selectedRows);
        }}
        freezeColumns={1}
        customRenderers={props.customRenderers}
        onCellClicked={([col, row], event) => {
          const rowData = displayRows()[row];
          if (!rowData) return;
          const column = displayColumnDefinitions()[col];
          const modifiers = {
            altKey:
              (event as typeof event & { altKey?: boolean }).altKey === true,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
          };
          if (column?.onAction) {
            const cell = getColumnCell(column, rowData);
            const eventWithBounds = event as typeof event & {
              bounds?: { x: number; y: number; width: number; height: number };
              localEventX?: number;
              localEventY?: number;
            };
            if (
              cell.kind === GridCellKind.Custom &&
              isRichActionButtonCell(cell) &&
              eventWithBounds.bounds &&
              eventWithBounds.localEventX !== undefined &&
              eventWithBounds.localEventY !== undefined
            ) {
              const position = normalizeGridClickPosition(
                eventWithBounds.bounds,
                eventWithBounds.localEventX,
                eventWithBounds.localEventY,
              );
              const action = getActionAtPosition(
                cell.data,
                eventWithBounds.bounds.width,
                eventWithBounds.bounds.height,
                position.x,
                position.y,
                (text) => text.length * 7,
              );
              if (action) {
                event.preventDefault();
                if (action.disabled !== true) {
                  column.onAction(rowData, action.actionId, modifiers);
                }
                return;
              }
            }
          }
          const rowSelectable = isSelectableRow(rowData);
          const eventWithAlt = event as typeof event & { altKey?: boolean };
          const isModifierToggleClick = event.ctrlKey || event.metaKey;

          // The grid publishes its appended range before this click callback.
          // Toggle from the pointer-down snapshot to avoid applying the row twice.
          if (
            col >= 0 &&
            props.onSelectionChange &&
            rowSelectable &&
            isModifierToggleClick
          ) {
            event.preventDefault();
            const next = new Set(
              modifierSelectionSnapshot ?? selectedRowIndices(),
            );
            modifierSelectionSnapshot = undefined;
            if (next.has(row)) {
              next.delete(row);
            } else {
              next.add(row);
            }
            applySelectionByIndices(Array.from(next).sort((a, b) => a - b));
            setLastInteractedRow(row);
            props.onRowClick(rowData, modifiers);
            return;
          }

          if (
            col >= 0 &&
            !eventWithAlt.altKey &&
            props.onSelectionChange &&
            rowSelectable
          ) {
            const anchor = lastInteractedRow() ?? row;
            const rangeStart = Math.min(anchor, row);
            const rangeEnd = Math.max(anchor, row);
            setSelectionCurrent({
              cell: props.rowSelectionOnly ? [0, row] : [col, row],
              range: {
                x: props.rowSelectionOnly ? 0 : col,
                y: event.shiftKey ? rangeStart : row,
                width: props.rowSelectionOnly
                  ? Math.max(displayColumns().length, 1)
                  : 1,
                height: event.shiftKey ? rangeEnd - rangeStart + 1 : 1,
              },
              rangeStack: [],
            });

            if (event.shiftKey) {
              const next = new Set(selectedRowIndices());
              for (let index = rangeStart; index <= rangeEnd; index += 1) {
                next.add(index);
              }
              applySelectionByIndices(Array.from(next).sort((a, b) => a - b));
            } else if (props.multiSelectOnPlainClick) {
              const next = new Set(selectedRowIndices());
              if (next.has(row)) {
                next.delete(row);
              } else {
                next.add(row);
              }
              applySelectionByIndices(Array.from(next).sort((a, b) => a - b));
              setLastInteractedRow(row);
            } else {
              applySelectionByIndices([row]);
              setLastInteractedRow(row);
            }
          }

          props.onRowClick(rowData, modifiers);
        }}
        onCellContextMenu={
          props.onRowContextMenu
            ? ([, row], event) => {
                const rowData = displayRows()[row];
                if (!rowData) return;
                event.preventDefault();
                const eventWithAlt = event as typeof event & {
                  altKey?: boolean;
                };
                const eventWithBounds = event as typeof event & {
                  bounds?: {
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                  };
                };
                const position = eventWithBounds.bounds
                  ? {
                      x: eventWithBounds.bounds.x,
                      y:
                        eventWithBounds.bounds.y +
                        eventWithBounds.bounds.height,
                    }
                  : {
                      x: event.clientX,
                      y: event.clientY,
                    };
                props.onRowContextMenu?.(
                  rowData,
                  {
                    altKey: eventWithAlt.altKey === true,
                    shiftKey: event.shiftKey,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                  },
                  position,
                );
              }
            : undefined
        }
      />
      <div class="absolute right-2 top-0.5 z-10 flex h-8 items-center gap-0.5">
        {filterColumns().length > 0 ? (
          <DataGridFilterMenu
            columns={filterColumns()}
            filters={tableFilters()}
            visibleRows={displayRows().length}
            totalRows={props.rows.length}
            onFiltersChange={setTableFilters}
          />
        ) : null}
        <ColumnVisibilityMenu scope={visibilityScope()} columns={columns()} />
      </div>
    </div>
  );
}
