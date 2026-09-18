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
import { setStoreAction } from "../../../lib/nanostore-action";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  midiDevices,
  midiLastEvent,
  midiMappings,
} from "../../../state/appStores";
import type { MidiMapping } from "../../../types";
import {
  cloneMidiAction,
  formatMidiAction,
  parseMidiAction,
} from "./model/action-format";

export interface MidiInputPanelProps extends BasePanelComponentProps {}

interface MidiMappingRow {
  mapping: MidiMapping;
  index: number;
}

const columns: FilterableGridColumn<MidiMappingRow, VisibilityGridColumn>[] = [
  {
    title: "Device",
    id: "device_name",
    width: 150,
    filter: { value: (row) => row.mapping.device_name },
    ...alwaysVisibleColumnMeta("Identity", "Device"),
  },
  {
    title: "Channel",
    id: "channel",
    width: 80,
    filter: { kind: "number", value: (row) => row.mapping.channel },
    ...columnVisibilityMeta("Binding", "Channel"),
  },
  {
    title: "Note",
    id: "note",
    width: 80,
    filter: { kind: "number", value: (row) => row.mapping.note },
    ...columnVisibilityMeta("Binding", "Note"),
  },
  {
    title: "Velocity",
    id: "velocity",
    width: 80,
    filter: { kind: "number", value: (row) => row.mapping.velocity },
    ...columnVisibilityMeta("Binding", "Velocity"),
  },
  {
    title: "Action",
    id: "action",
    width: 200,
    filter: { value: (row) => formatMidiAction(row.mapping.action) },
    ...columnVisibilityMeta("Binding", "Action"),
  },
];

/** Deep clone a mapping to ensure it's a plain object that can be sent via postMessage */
function cloneMapping(m: MidiMapping): MidiMapping {
  return {
    device_name: m.device_name,
    channel: m.channel,
    note: m.note,
    velocity: m.velocity,
    action: cloneMidiAction(m.action),
  };
}

export default function MidiInputPanel(props: MidiInputPanelProps) {
  const $midiDevices = useStore(midiDevices);
  const $midiMappings = useStore(midiMappings);
  const $midiLastEvent = useStore(midiLastEvent);
  const panelId = props.id;

  // Row selection state using shared helpers
  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const [gridSelection, setGridSelection] = createSignal<
    GridSelection | undefined
  >(undefined);
  const displayColumns = createMemo(() => {
    return filterVisibleColumns(columns, panelId);
  });
  const mappingRows = createMemo<MidiMappingRow[]>(() =>
    $midiMappings().map((mapping, index) => ({ mapping, index })),
  );
  const filterColumns = createMemo(() => filterColumnsFromMetadata(columns));
  const { clearSelection } = createRowSelectionHelpers(selection, setSelection);
  /** Returns MIDI mapping rows targeted by row markers, active cells, or cell ranges. */
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
          case "device_name":
            return {
              kind: GridCellKind.Text,
              allowOverlay: true,
              displayData: rowData.device_name,
              data: rowData.device_name,
            };
          case "channel":
            return {
              kind: GridCellKind.Number,
              data: rowData.channel,
              displayData: String(rowData.channel),
              allowOverlay: true,
            };
          case "note":
            return {
              kind: GridCellKind.Number,
              data: rowData.note,
              displayData: String(rowData.note),
              allowOverlay: true,
            };
          case "velocity":
            return {
              kind: GridCellKind.Text,
              allowOverlay: true,
              displayData:
                rowData.velocity === null ? "any" : String(rowData.velocity),
              data: rowData.velocity === null ? "" : String(rowData.velocity),
            };
          case "action": {
            const actionStr = formatMidiAction(rowData.action);
            return {
              kind: GridCellKind.Text,
              data: actionStr,
              displayData: actionStr,
              allowOverlay: true,
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

  /** Handle cell edits */
  const handleCellEdited = (cell: Item, newValue: GridCell) => {
    const [col, row] = cell;
    const colId = displayColumns()[col]?.id;
    const mappings = $midiMappings();
    const visibleRows = displayRows();

    if (row >= visibleRows.length) return;

    // Determine which rows to edit based on selection
    const rowsToEdit = getRowsToEdit(
      gridSelection(),
      col,
      row,
      visibleRows.length,
    );

    /** Extract value based on cell kind */
    const getValue = (): string | number | undefined => {
      if (newValue.kind === GridCellKind.Text) {
        return newValue.data;
      }
      if (newValue.kind === GridCellKind.Number) {
        return newValue.data;
      }
      return undefined;
    };

    const value = getValue();

    // Build updated mappings array (deep clone to ensure plain objects for postMessage)
    const currentMappings = mappings.map(cloneMapping);

    // Apply edit to all target rows
    for (const targetRow of rowsToEdit) {
      const originalIndex = visibleRows[targetRow]?.index;
      if (originalIndex === undefined) continue;
      const rowData = { ...currentMappings[originalIndex] };

      switch (colId) {
        case "device_name":
          if (newValue.kind !== GridCellKind.Text) continue;
          rowData.device_name = String(value ?? "");
          break;
        case "channel":
          if (newValue.kind !== GridCellKind.Number) continue;
          rowData.channel = Number(value ?? 144);
          break;
        case "note":
          if (newValue.kind !== GridCellKind.Number) continue;
          rowData.note = Number(value ?? 0);
          break;
        case "velocity": {
          if (newValue.kind !== GridCellKind.Text) continue;
          const val = String(value ?? "").trim();
          rowData.velocity =
            val === "" || val === "any" ? undefined : Number(val);
          break;
        }
        case "action": {
          if (newValue.kind !== GridCellKind.Text) continue;
          const parsed = parseMidiAction(String(value ?? ""));
          if (parsed) {
            rowData.action = parsed;
          }
          break;
        }
      }

      currentMappings[originalIndex] = cloneMapping(rowData);
    }

    // Optimistically update the store immediately for instant UI feedback
    setStoreAction(midiMappings, "Update MIDI Mappings", currentMappings);

    // Send update to backend
    engineRuntime.sendCommand({
      module: "MidiCommand",
      command: {
        type: "StoreMappings",
        data: currentMappings,
      },
    });
  };

  /** Delete selected mappings */
  const deleteSelected = () => {
    const indices = selectedRows();
    if (indices.length === 0) return;

    // Sort indices in descending order so we delete from the end first
    const visibleRows = displayRows();
    const sortedIndices = indices
      .map((index) => visibleRows[index]?.index)
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => b - a);

    // Build new mappings array without the selected rows
    const currentMappings = $midiMappings().map(cloneMapping);
    for (const idx of sortedIndices) {
      currentMappings.splice(idx, 1);
    }

    clearGridSelection();

    // Send update to backend
    engineRuntime.sendCommand({
      module: "MidiCommand",
      command: {
        type: "StoreMappings",
        data: currentMappings,
      },
    });
  };

  /** Apply last event to a new mapping row */
  const applyLastEvent = () => {
    const event = $midiLastEvent();
    if (!event) return;

    // Deep clone existing mappings to ensure plain objects for postMessage
    const currentMappings = $midiMappings().map(cloneMapping);
    currentMappings.push({
      device_name: event.device,
      channel: event.channel,
      note: event.note,
      velocity: event.velocity,
      action: parseMidiAction("StartClip(1)")!,
    });

    engineRuntime.sendCommand({
      module: "MidiCommand",
      command: {
        type: "StoreMappings",
        data: currentMappings,
      },
    });
  };

  return (
    <div class="flex flex-col h-full">
      {/* Device List Section */}
      <div class="p-3 border-b border-gray-700">
        <h3 class="text-sm font-medium text-gray-300 mb-2">
          Connected MIDI Devices
        </h3>
        <Show
          when={$midiDevices().length > 0}
          fallback={
            <div class="text-gray-500 text-sm">No MIDI devices connected</div>
          }
        >
          <div class="space-y-1">
            <For each={$midiDevices()}>
              {(device) => (
                <div class="bg-gray-800 rounded px-3 py-2">
                  <span class="text-sm">{device.name}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Last Event Quick-Add */}
        <Show when={$midiLastEvent()}>
          <div class="mt-3 p-2 bg-gray-800 rounded border border-gray-600">
            <div class="flex items-center justify-between">
              <div class="text-xs text-gray-400">
                Last Input:{" "}
                <span class="font-mono text-green-400">
                  {$midiLastEvent()?.device} Ch:{$midiLastEvent()?.channel}{" "}
                  Note:
                  {$midiLastEvent()?.note} Vel:{$midiLastEvent()?.velocity}
                </span>
              </div>
              <Button size="compact" variant="primary" onClick={applyLastEvent}>
                Add Mapping
              </Button>
            </div>
          </div>
        </Show>
      </div>

      {/* Mappings Section */}
      <div class="flex-1 flex flex-col min-h-0">
        <PanelToolbar
          leftClass="min-w-0 flex-1"
          rightClass="flex h-8 shrink-0 items-center gap-2"
          left={
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-gray-300">MIDI Mappings</h3>
              <p class="truncate text-xs text-gray-500">
                Edit cells to configure. Action format: StartClip(1),
                StopClip(2), etc.
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

        {/* Empty state */}
        <Show when={mappingRows().length === 0}>
          <div class="p-4 text-center text-gray-500 text-sm">
            No mappings configured. Press a MIDI button and click "Add Mapping"
            to create one.
          </div>
        </Show>
      </div>
    </div>
  );
}
