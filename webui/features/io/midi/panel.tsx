// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
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
  midiDevices,
  midiLastEvent,
  midiMappingDiagnostics,
  midiMappings,
} from "../../../state/appStores";
import type { MidiMapping } from "../../../types";
import {
  ActionInputKind,
  ActionSurface,
  MidiBindingInput,
} from "../../../types";
import { ActionBindingEditor } from "../../action-mapping";
import { cloneMidiAction, formatMidiAction } from "./model/action-format";

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
    id: m.id,
    input: m.input,
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
  const $mappingDiagnostics = useStore(midiMappingDiagnostics);
  const $midiLastEvent = useStore(midiLastEvent);
  const panelId = props.id;
  const [draft, setDraft] = createSignal<{
    mapping: MidiMapping;
    expected?: MidiMapping;
  }>();
  const [draftValid, setDraftValid] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [editError, setEditError] = createSignal<string>();

  /** Saves only the version the operator edited, leaving other clients' bindings intact. */
  async function persistMapping(
    mapping: MidiMapping,
    expected?: MidiMapping,
  ): Promise<boolean> {
    try {
      const result = await engineRuntime.sendCommandAndAwait({
        module: "MidiCommand",
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
    if (!current || !draftValid() || saving()) return;
    setSaving(true);
    try {
      if (await persistMapping(current.mapping, current.expected))
        setDraft(undefined);
    } finally {
      setSaving(false);
    }
  }

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
              allowOverlay: false,
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

  /** Delete selected mappings */
  /** Deletes exact selected versions without replacing the complete binding collection. */
  const deleteSelected = async () => {
    const selected = selectedRows()
      .map((index) => displayRows()[index]?.mapping)
      .filter((mapping): mapping is MidiMapping => Boolean(mapping))
      .map(cloneMapping);
    try {
      for (const expected of selected) {
        const result = await engineRuntime.sendCommandAndAwait({
          module: "MidiCommand",
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
  /** Apply last event to a new mapping row */
  /** Freezes the last observed source while the operator chooses a registered action. */
  const applyLastEvent = () => {
    const event = $midiLastEvent();
    if (!event) return;
    setDraft({
      mapping: {
        id: crypto.randomUUID().replace(/-/g, ""),
        input: MidiBindingInput.Press,
        device_name: event.device,
        channel:
          (event.channel & 0xf0) === 0x80
            ? 0x90 | (event.channel & 0x0f)
            : event.channel,
        note: event.note,
        velocity: undefined,
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
            aria-label="MIDI mapping action editor"
            class="p-3 border-b border-gray-700 space-y-2"
          >
            <p class="text-xs text-gray-400">
              Source: {current().mapping.device_name} · {current().mapping.note}
            </p>
            <ActionBindingEditor
              surface={ActionSurface.Midi}
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
                      ? MidiBindingInput.Continuous
                      : value.mapping.input === MidiBindingInput.Continuous
                        ? MidiBindingInput.Press
                        : value.mapping.input,
                  },
                });
              }}
            />
            <Show
              when={current().mapping.input !== MidiBindingInput.Continuous}
              fallback={
                <p class="text-xs text-gray-400">
                  Controller values 0–127 map to the action’s full range.
                </p>
              }
            >
              <label class="block text-xs">
                Activation
                <NativeSelect
                  aria-label="MIDI activation"
                  value={current().mapping.input}
                  onChange={(event) => {
                    const input = event.currentTarget.value;
                    if (
                      input === MidiBindingInput.Press ||
                      input === MidiBindingInput.Release
                    )
                      setDraft({
                        ...current(),
                        mapping: { ...current().mapping, input },
                      });
                  }}
                >
                  <option value={MidiBindingInput.Press}>Button press</option>
                  <option value={MidiBindingInput.Release}>
                    Button release
                  </option>
                </NativeSelect>
              </label>
            </Show>
            <div class="flex gap-2">
              <Button
                size="compact"
                disabled={!draftValid() || saving()}
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
              <h3 class="text-sm font-medium text-gray-300">MIDI Mappings</h3>
              <p class="truncate text-xs text-gray-500">
                Edit source cells or select a mapping and choose Edit action.
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
