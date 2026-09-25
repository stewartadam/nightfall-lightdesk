// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { Button } from "../../../components/ui/visual-language/button";
import DataGrid, {
  createKeyedDataGridCellProvider,
} from "../../../components/widgets/data-grid";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../components/widgets/data-grid/extensions/data-grid-filter-menu";
import { createDataGridFilterState } from "../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import type {
  GridCell,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  createRowSelectionHelpers,
  emptyGridSelection,
  getEditTargetRowIndices,
  getRowsToEdit,
} from "../../../lib/datagrid";
import {
  alwaysVisibleColumnMeta,
  columnVisibilityMeta,
  filterVisibleColumns,
  type VisibilityGridColumn,
} from "../../../lib/datagrid-column-visibility";
import {
  type FilterableGridColumn,
  filterColumnsFromMetadata,
} from "../../../lib/datagrid-filtering";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  oscLastEvent,
  oscListenerStatus,
  oscMappings,
  oscSources,
} from "../../../state/appStores";
import {
  ActionInputKind,
  type ActionReference,
  type OscMapping,
  type OscType,
} from "../../../types";
import {
  ActionPicker,
  actionInputKind,
  formatActionReference,
  useActionTargetNames,
  useBindableActionCatalog,
} from "../../actions";
import { oscMappingFromEvent } from "../model/controller-mapping-builders";
import {
  deleteOscMapping,
  upsertOscMapping,
} from "../model/controller-mappings";

/** Input kinds an OSC message can drive: pulses and booleans as buttons, numbers as faders. */
const OSC_INPUT_KINDS = [
  ActionInputKind.Trigger,
  ActionInputKind.Momentary,
  ActionInputKind.Absolute,
];

export interface OscInputPanelProps extends BasePanelComponentProps {}

interface OscMappingRow {
  mapping: OscMapping;
  index: number;
}

const columns: FilterableGridColumn<OscMappingRow, VisibilityGridColumn>[] = [
  {
    title: "Source",
    id: "source",
    width: 160,
    filter: { value: (row) => row.mapping.source ?? "*" },
    ...alwaysVisibleColumnMeta("Identity", "Source"),
  },
  {
    title: "Address",
    id: "address",
    width: 220,
    filter: { value: (row) => row.mapping.address },
    ...columnVisibilityMeta("Binding", "Address"),
  },
  {
    title: "Arg Index",
    id: "arg_index",
    width: 90,
    filter: { kind: "number", value: (row) => row.mapping.arg_index },
    ...columnVisibilityMeta("Binding", "Arg Index"),
  },
  {
    title: "Arg Match",
    id: "arg_value",
    width: 120,
    filter: { value: (row) => row.mapping.arg_value ?? "" },
    ...columnVisibilityMeta("Binding", "Arg Match"),
  },
  {
    title: "Action",
    id: "action",
    width: 260,
    filter: { value: (row) => row.mapping.action.id },
    ...columnVisibilityMeta("Binding", "Action"),
  },
];

function formatArgValue(arg: OscType): string {
  switch (arg.type) {
    case "Int":
      return String(arg.data);
    case "Float":
      return String(arg.data);
    case "Double":
      return String(arg.data);
    case "Long":
      return String(arg.data);
    case "String":
      return arg.data;
    case "Blob":
      return `0x${arg.data.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    case "Time":
      return `${arg.data.seconds}:${arg.data.fractional}`;
    case "Char":
      return arg.data;
    case "Color":
      return `${arg.data.red},${arg.data.green},${arg.data.blue},${arg.data.alpha}`;
    case "Midi":
      return `${arg.data.port},${arg.data.status},${arg.data.data1},${arg.data.data2}`;
    case "Bool":
      return arg.data ? "true" : "false";
    case "Array":
      return `[${arg.data.map(formatArgValue).join(",")}]`;
    case "Nil":
      return "nil";
    case "Inf":
      return "inf";
  }
}

function parseArgIndex(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    return null;
  }

  return parsed;
}

/** Returns a mapping with one text cell edit applied, or undefined for invalid input. */
function editedMapping(
  mapping: OscMapping,
  columnId: string | undefined,
  value: string,
): OscMapping | undefined {
  const trimmed = value.trim();
  switch (columnId) {
    case "source":
      return { ...mapping, source: trimmed === "" ? undefined : trimmed };
    case "address":
      return { ...mapping, address: value };
    case "arg_index": {
      const parsed = parseArgIndex(value);
      return parsed === null ? undefined : { ...mapping, arg_index: parsed };
    }
    case "arg_value":
      return { ...mapping, arg_value: trimmed === "" ? undefined : trimmed };
    default:
      return undefined;
  }
}

export default function OscInputPanel(props: OscInputPanelProps) {
  const $oscSources = useStore(oscSources);
  const $oscMappings = useStore(oscMappings);
  const $oscLastEvent = useStore(oscLastEvent);
  const $oscListenerStatus = useStore(oscListenerStatus);
  const $actionCatalog = useBindableActionCatalog();
  const targetNames = useActionTargetNames();
  const [lastEventAction, setLastEventAction] = createSignal<
    ActionReference | undefined
  >();
  const panelId = props.id;

  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const [gridSelection, setGridSelection] = createSignal<
    GridSelection | undefined
  >(undefined);
  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns, panelId);
  });
  const mappingRows = createMemo<OscMappingRow[]>(() =>
    $oscMappings().map((mapping, index) => ({ mapping, index })),
  );
  const filterColumns = createMemo(() => filterColumnsFromMetadata(columns));
  const { clearSelection } = createRowSelectionHelpers(selection, setSelection);
  /** Returns OSC mapping rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), displayRows().length);

  const clearGridSelection = () => {
    clearSelection();
    setGridSelection(emptyGridSelection());
  };
  const {
    filters: tableFilters,
    filteredRows: displayRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: panelId,
    rows: mappingRows,
    columns: filterColumns,
    onFiltersChange: clearGridSelection,
  });

  const cellProvider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: displayRows(),
      columns: displayColumns(),
      rowKey: (row) => row.mapping.id,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row, column }): GridCell => {
        const rowData = row.mapping;
        const colId = column.id;
        switch (colId) {
          case "source":
            return {
              kind: GridCellKind.Text,
              allowOverlay: true,
              displayData: rowData.source ?? "*",
              data: rowData.source ?? "",
            };
          case "address":
            return {
              kind: GridCellKind.Text,
              allowOverlay: true,
              displayData: rowData.address,
              data: rowData.address,
            };
          case "arg_index":
            return {
              kind: GridCellKind.Text,
              allowOverlay: true,
              displayData:
                rowData.arg_index === null || rowData.arg_index === undefined
                  ? ""
                  : String(rowData.arg_index),
              data:
                rowData.arg_index === null || rowData.arg_index === undefined
                  ? ""
                  : String(rowData.arg_index),
            };
          case "arg_value":
            return {
              kind: GridCellKind.Text,
              allowOverlay: true,
              displayData: rowData.arg_value ?? "",
              data: rowData.arg_value ?? "",
            };
          case "action": {
            const actionStr = formatActionReference(
              rowData.action,
              $actionCatalog(),
              targetNames,
            );
            return {
              kind: GridCellKind.Text,
              allowOverlay: false,
              readonly: true,
              displayData: actionStr,
              data: actionStr,
            };
          }
          default:
            return {
              kind: GridCellKind.Loading,
              allowOverlay: false,
            };
        }
      },
    }),
  );

  /** Applies one edited text cell to every targeted mapping and upserts each result. */
  const handleCellEdited = (cell: Item, newValue: GridCell) => {
    const [col, row] = cell;
    const colId = displayColumns()[col]?.id;
    const visibleRows = displayRows();
    if (row >= visibleRows.length || newValue.kind !== GridCellKind.Text) {
      return;
    }

    const rowsToEdit = getRowsToEdit(
      gridSelection(),
      col,
      row,
      visibleRows.length,
    );
    const value = String(newValue.data ?? "");
    for (const targetRow of rowsToEdit) {
      const mapping = visibleRows[targetRow]?.mapping;
      if (!mapping) continue;
      const edited = editedMapping(mapping, colId, value);
      if (edited) void upsertOscMapping(edited);
    }
  };

  /** Returns the single selected mapping row, when exactly one is selected. */
  const selectedMapping = createMemo(() => {
    const rows = selectedRows();
    if (rows.length !== 1) return undefined;
    return displayRows()[rows[0]];
  });

  /** Replaces the action of the selected mapping. */
  const updateSelectedAction = (action: ActionReference) => {
    const row = selectedMapping();
    if (row) void upsertOscMapping({ ...row.mapping, action });
  };

  /** Deletes every selected mapping by ID. */
  const deleteSelected = () => {
    const visibleRows = displayRows();
    const ids = selectedRows()
      .map((index) => visibleRows[index]?.mapping.id)
      .filter((id): id is string => id !== undefined);
    clearGridSelection();
    for (const id of ids) void deleteOscMapping(id);
  };

  /** Binds the last received OSC address to the action chosen beside it. */
  const applyLastEvent = () => {
    const event = $oscLastEvent();
    const action = lastEventAction();
    if (!event || !action) return;
    void upsertOscMapping(
      oscMappingFromEvent(
        event,
        action,
        actionInputKind($actionCatalog(), action),
      ),
    );
  };

  return (
    <div class="flex flex-col h-full">
      <div class="p-3 border-b border-gray-700">
        <h3 class="text-sm font-medium text-gray-300 mb-2">OSC Listener</h3>
        <Show
          when={$oscListenerStatus()}
          fallback={
            <div class="text-gray-500 text-sm">Listener not running</div>
          }
        >
          <div class="text-sm">
            <span class="text-gray-300">
              {$oscListenerStatus()?.is_listening ? "Listening" : "Stopped"}
            </span>
            <span class="text-gray-400"> at </span>
            <span class="font-mono text-gray-200">
              {$oscListenerStatus()?.bind_address}:{$oscListenerStatus()?.port}
            </span>
          </div>
        </Show>

        <h4 class="text-xs font-medium text-gray-400 mt-3 mb-1">
          Known Sources
        </h4>
        <Show
          when={$oscSources().length > 0}
          fallback={
            <div class="text-gray-500 text-sm">No OSC sources seen yet</div>
          }
        >
          <div class="space-y-1">
            <For each={$oscSources()}>
              {(source) => (
                <div class="bg-gray-800 rounded px-3 py-2 font-mono text-xs">
                  {source.address}
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={$oscLastEvent()}>
          <div class="mt-3 p-2 bg-gray-800 rounded border border-gray-600">
            <div class="flex items-center justify-between gap-2">
              <div class="text-xs text-gray-400 break-all">
                Last Input:{" "}
                <span class="font-mono text-green-400">
                  {$oscLastEvent()?.source} {$oscLastEvent()?.address}{" "}
                  {$oscLastEvent()?.args.map(formatArgValue).join(", ")}
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <ActionPicker
                  label="Action for last input"
                  inputKinds={OSC_INPUT_KINDS}
                  includeUiActions
                  onChange={setLastEventAction}
                  onIncomplete={() => setLastEventAction(undefined)}
                />
                <Button
                  size="compact"
                  variant="primary"
                  class="shrink-0"
                  disabled={!lastEventAction()}
                  onClick={applyLastEvent}
                >
                  Add Mapping
                </Button>
              </div>
            </div>
          </div>
        </Show>
      </div>

      <div class="flex-1 flex flex-col min-h-0">
        <PanelToolbar
          leftClass="min-w-0 flex-1"
          rightClass="flex h-8 shrink-0 items-center gap-2"
          left={
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-gray-300">OSC Mappings</h3>
              <p class="truncate text-xs text-gray-500">
                Leave Source blank to match any sender. Select one mapping to
                change its action.
              </p>
            </div>
          }
          right={
            <>
              <Show when={selectedRows().length > 0}>
                <Button
                  size="compact"
                  variant="danger"
                  type="button"
                  class="flex items-center gap-1"
                  onClick={deleteSelected}
                >
                  <span>Delete</span>
                  <span class="rounded bg-red-900 px-1.5 py-0.5 text-xs">
                    {selectedRows().length}
                  </span>
                </Button>
              </Show>
              <DataGridFilterMenu
                columns={filterColumns()}
                filters={tableFilters()}
                visibleRows={displayRows().length}
                totalRows={mappingRows().length}
                onFiltersChange={setTableFilters}
              />
              <ColumnVisibilityMenu scope={panelId} columns={columns} />
            </>
          }
        />

        <Show when={selectedMapping()}>
          {(row) => (
            <div class="flex items-center gap-2 border-b border-gray-700 px-3 py-2">
              <span class="text-xs text-gray-400">Selected action</span>
              <ActionPicker
                label="Selected mapping action"
                value={row().mapping.action}
                inputKinds={OSC_INPUT_KINDS}
                includeUiActions
                onChange={updateSelectedAction}
              />
            </div>
          )}
        </Show>

        <div class="flex-1 min-h-0">
          <DataGrid
            rows={displayRows().length}
            columns={displayColumns()}
            cellProvider={cellProvider}
            onCellEdited={handleCellEdited}
            rowMarkers="checkbox"
            gridSelection={gridSelection()}
            onGridSelectionChange={(nextSelection) => {
              setGridSelection(nextSelection);
              setSelection(nextSelection);
            }}
            width="100%"
            height="100%"
            freezeColumns={1}
          />
        </div>

        <Show when={mappingRows().length === 0}>
          <div class="p-4 text-center text-gray-500 text-sm">
            No OSC mappings configured. Send OSC input, choose an action, and
            click "Add Mapping" to create one.
          </div>
        </Show>
      </div>
    </div>
  );
}
