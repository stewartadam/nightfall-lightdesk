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
import { engineRuntime } from "../../../lib/engine-runtime";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  actionCatalog,
  oscLastEvent,
  oscListenerStatus,
  oscMappingDiagnostics,
  oscMappings,
  oscSources,
} from "../../../state/appStores";
import type { OscMapping, OscType } from "../../../types";
import { ActionInputKind, ActionSurface } from "../../../types";
import { ActionBindingEditor } from "../../action-mapping";
import { OscInputOptions } from "./input-options";
import { cloneOscAction, formatOscAction } from "./model/action-format";

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
    filter: { value: (row) => formatOscAction(row.mapping.action) },
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

function cloneMapping(mapping: OscMapping): OscMapping {
  return {
    id: mapping.id,
    input: mapping.input,
    source: mapping.source,
    address: mapping.address,
    arg_index: mapping.arg_index,
    arg_value: mapping.arg_value,
    action: cloneOscAction(mapping.action),
  };
}

export default function OscInputPanel(props: OscInputPanelProps) {
  const $oscSources = useStore(oscSources);
  const $oscMappings = useStore(oscMappings);
  const $mappingDiagnostics = useStore(oscMappingDiagnostics);
  const $oscLastEvent = useStore(oscLastEvent);
  const $oscListenerStatus = useStore(oscListenerStatus);
  const panelId = props.id;
  const [draft, setDraft] = createSignal<{
    mapping: OscMapping;
    expected?: OscMapping;
  }>();
  const [draftValid, setDraftValid] = createSignal(false);
  const [inputValid, setInputValid] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [editError, setEditError] = createSignal<string>();

  /** Saves only the version the operator edited, leaving other clients' bindings intact. */
  async function persistMapping(
    mapping: OscMapping,
    expected?: OscMapping,
  ): Promise<boolean> {
    try {
      const result = await engineRuntime.sendCommandAndAwait({
        module: "OscCommand",
        command: { type: "StoreMapping", data: { mapping, expected } },
      });
      if (result.outcome.type === "Failed")
        throw new Error(result.outcome.data.message);
      setEditError(undefined);
      return true;
    } catch (error) {
      setEditError(String(error));
      return false;
    }
  }

  /** Captures the selected binding version before its action editor opens. */
  function editSelectedAction() {
    const row = displayRows()[selectedRows()[0]];
    if (row)
      setDraft({
        mapping: cloneMapping(row.mapping),
        expected: cloneMapping(row.mapping),
      });
  }

  /** Commits the validated action draft and retains it if the backend reports a conflict. */
  async function saveDraft() {
    const current = draft();
    if (!current || !draftValid() || !inputValid() || saving()) return;
    setSaving(true);
    try {
      if (await persistMapping(current.mapping, current.expected))
        setDraft(undefined);
    } finally {
      setSaving(false);
    }
  }

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
      rowKey: (row) => row.index,
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
            const actionStr = formatOscAction(rowData.action);
            return {
              kind: GridCellKind.Text,
              allowOverlay: false,
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

  const handleCellEdited = (cell: Item, newValue: GridCell) => {
    const [col, row] = cell;
    const colId = displayColumns()[col]?.id;
    const mappings = $oscMappings();
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

    const currentMappings = mappings.map(cloneMapping);
    for (const targetRow of rowsToEdit) {
      const originalIndex = visibleRows[targetRow]?.index;
      if (originalIndex === undefined) continue;
      const rowData = { ...currentMappings[originalIndex] };
      switch (colId) {
        case "source":
          rowData.source = value.trim() === "" ? undefined : value.trim();
          break;
        case "address":
          rowData.address = value;
          break;
        case "arg_index": {
          const parsed = parseArgIndex(value);
          if (parsed === null) {
            continue;
          }
          rowData.arg_index = parsed;
          break;
        }
        case "arg_value": {
          const trimmed = value.trim();
          rowData.arg_value = trimmed === "" ? undefined : trimmed;
          break;
        }
        case "action":
          continue;
      }
      currentMappings[originalIndex] = cloneMapping(rowData);
    }

    for (const mapping of currentMappings) {
      const expected = mappings.find((previous) => previous.id === mapping.id);
      if (expected && JSON.stringify(expected) !== JSON.stringify(mapping))
        void persistMapping(mapping, cloneMapping(expected));
    }
  };

  /** Deletes exact selected versions without replacing the complete binding collection. */
  const deleteSelected = async () => {
    const selected = selectedRows()
      .map((index) => displayRows()[index]?.mapping)
      .filter((mapping): mapping is OscMapping => Boolean(mapping))
      .map(cloneMapping);
    try {
      for (const expected of selected) {
        const result = await engineRuntime.sendCommandAndAwait({
          module: "OscCommand",
          command: { type: "RemoveMapping", data: { expected } },
        });
        if (result.outcome.type === "Failed") {
          setEditError(result.outcome.data.message);
          return;
        }
      }
      setEditError(undefined);
      clearGridSelection();
    } catch (error) {
      setEditError(String(error));
    }
  };
  /** Freezes the last observed source while the operator chooses a registered action. */
  const applyLastEvent = () => {
    const event = $oscLastEvent();
    if (!event) return;
    setDraft({
      mapping: {
        id: crypto.randomUUID().replace(/-/g, ""),
        input: { type: event.args.length ? "Press" : "Pulse" },
        source: undefined,
        address: event.address,
        arg_index: event.args.length ? 0 : undefined,
        arg_value: undefined,
        action: { id: "", arguments: {} },
      },
    });
  };
  return (
    <div class="flex flex-col h-full">
      <Show when={editError()}>
        {(error) => (
          <p role="alert" class="p-3 text-sm text-red-400">
            {error()}
          </p>
        )}
      </Show>
      <Show when={draft()}>
        {(current) => (
          <section
            aria-label="OSC mapping action editor"
            class="p-3 border-b border-gray-700 space-y-2"
          >
            <p class="text-xs text-gray-400">
              Source: {current().mapping.address}
            </p>
            <ActionBindingEditor
              surface={ActionSurface.Osc}
              value={current().mapping.action}
              onValidityChange={setDraftValid}
              onChange={(action) => {
                const value = current();
                const scalar =
                  actionCatalog
                    .get()
                    .find((descriptor) => descriptor.id === action.id)
                    ?.input_kind === ActionInputKind.Scalar;
                setDraft({
                  ...value,
                  mapping: {
                    ...value.mapping,
                    action,
                    input: scalar
                      ? value.mapping.input.type === "Continuous" ||
                        value.mapping.input.type === "LegacyContinuous"
                        ? value.mapping.input
                        : {
                            type: "Continuous",
                            data: { minimum: 0, maximum: 1 },
                          }
                      : value.mapping.input.type === "Continuous" ||
                          value.mapping.input.type === "LegacyContinuous"
                        ? { type: "Press" }
                        : value.mapping.input,
                  },
                });
              }}
            />
            <OscInputOptions
              mapping={current().mapping}
              onValidityChange={setInputValid}
              onChange={(mapping) => setDraft({ ...current(), mapping })}
            />
            <div class="flex gap-2">
              <Button
                size="compact"
                disabled={!draftValid() || !inputValid() || saving()}
                onClick={() => void saveDraft()}
              >
                Save mapping
              </Button>
              <Button
                size="compact"
                disabled={saving()}
                onClick={() => setDraft(undefined)}
              >
                Cancel edit
              </Button>
            </div>
          </section>
        )}
      </Show>
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
              <Button
                size="compact"
                variant="primary"
                class="shrink-0"
                onClick={applyLastEvent}
              >
                Add Mapping
              </Button>
            </div>
          </div>
        </Show>
      </div>

      <div class="flex-1 flex flex-col min-h-0">
        <For each={$mappingDiagnostics()}>
          {(error, index) => (
            <Show when={error}>
              <p role="alert" class="px-3 py-1 text-sm text-amber-400">
                Mapping {index() + 1} disabled: {error?.message}. Edit or remove
                this mapping to repair it.
              </p>
            </Show>
          )}
        </For>
        <PanelToolbar
          leftClass="min-w-0 flex-1"
          rightClass="flex h-8 shrink-0 items-center gap-2"
          left={
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-gray-300">OSC Mappings</h3>
              <p class="truncate text-xs text-gray-500">
                Leave Source blank to match any sender. Select a mapping to edit
                its action.
              </p>
            </div>
          }
          right={
            <>
              <Show when={selectedRows().length === 1}>
                <Button size="compact" onClick={editSelectedAction}>
                  Edit action
                </Button>
              </Show>
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
            No OSC mappings configured. Send OSC input and click "Add Mapping"
            to create one.
          </div>
        </Show>
      </div>
    </div>
  );
}
