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
  midiDevices,
  midiLastEvent,
  midiMappingDiagnostics,
  midiMappings,
} from "../../../state/appStores";
import {
  ActionInputKind,
  type ActionReference,
  ActionSurface,
  ControlBehavior,
  type InvocationError,
  type MidiMapping,
} from "../../../types";
import {
  ActionPicker,
  findCatalogEntry,
  formatActionReference,
  useActionTargetNames,
  useBindableActionCatalog,
} from "../../actions";
import { BehaviorSelect } from "../components/behavior-select";
import { actionBehaviors } from "../model/binding-behaviors";
import {
  formatBehavior,
  midiMappingFromEvent,
  midiSourceLabel,
  midiSourceNumber,
  parseBehavior,
  withMidiChannel,
  withMidiNumber,
} from "../model/controller-mapping-builders";
import {
  announceReplacedMappings,
  deleteMidiMapping,
  upsertMidiMapping,
} from "../model/controller-mappings";
import {
  diagnosticsByMapping,
  mappingStatusCell,
  mappingStatusText,
} from "../model/mapping-diagnostics";

/** Input kinds a MIDI control can drive: notes as buttons, controllers as faders or buttons. */
const MIDI_INPUT_KINDS = [
  ActionInputKind.Trigger,
  ActionInputKind.Momentary,
  ActionInputKind.Absolute,
];

export interface MidiInputPanelProps extends BasePanelComponentProps {}

interface MidiMappingRow {
  mapping: MidiMapping;
  index: number;
  /** Why the mapping cannot currently invoke its action, when the backend diagnosed it. */
  error?: InvocationError;
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
    title: "Status",
    id: "status",
    width: 200,
    filter: { value: (row) => mappingStatusText(row.error) },
    ...columnVisibilityMeta("Binding", "Status"),
  },
  {
    title: "Control",
    id: "control",
    width: 130,
    filter: { value: (row) => midiSourceLabel(row.mapping.source) },
    ...columnVisibilityMeta("Binding", "Control"),
  },
  {
    title: "Channel",
    id: "channel",
    width: 80,
    filter: {
      kind: "number",
      value: (row) => row.mapping.source.data.channel + 1,
    },
    ...columnVisibilityMeta("Binding", "Channel"),
  },
  {
    title: "Number",
    id: "number",
    width: 80,
    filter: {
      kind: "number",
      value: (row) => midiSourceNumber(row.mapping.source),
    },
    ...columnVisibilityMeta("Binding", "Number"),
  },
  {
    title: "Behavior",
    id: "behavior",
    width: 90,
    filter: { value: (row) => formatBehavior(row.mapping.behavior) },
    ...columnVisibilityMeta("Binding", "Behavior"),
  },
  {
    title: "Action",
    id: "action",
    width: 240,
    filter: { value: (row) => row.mapping.action.id },
    ...columnVisibilityMeta("Binding", "Action"),
  },
];

/** Renders MIDI devices, the last received message, and editable controller mappings. */
export default function MidiInputPanel(props: MidiInputPanelProps) {
  const $midiDevices = useStore(midiDevices);
  const $midiMappings = useStore(midiMappings);
  const $midiLastEvent = useStore(midiLastEvent);
  const $midiMappingDiagnostics = useStore(midiMappingDiagnostics);
  const $actionCatalog = useBindableActionCatalog();
  const targetNames = useActionTargetNames();
  const [lastEventAction, setLastEventAction] = createSignal<
    ActionReference | undefined
  >();
  const [chosenBehavior, setLastEventBehavior] = createSignal(
    ControlBehavior.Press,
  );
  /** Returns the catalog entry of the action chosen for the last input. */
  const lastEventEntry = createMemo(() => {
    const action = lastEventAction();
    return action ? findCatalogEntry($actionCatalog(), action.id) : undefined;
  });
  /** Returns the chosen behavior, or Press when the chosen action does not support it. */
  const lastEventBehavior = () =>
    actionBehaviors(lastEventEntry()).includes(chosenBehavior())
      ? chosenBehavior()
      : ControlBehavior.Press;
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
  /** Pairs each mapping with its backend diagnostic, if it cannot currently run. */
  const mappingRows = createMemo<MidiMappingRow[]>(() => {
    const errorFor = diagnosticsByMapping($midiMappingDiagnostics());
    return $midiMappings().map((mapping, index) => ({
      mapping,
      index,
      error: errorFor(mapping.id),
    }));
  });
  const filterColumns = createMemo(() => filterColumnsFromMetadata(columns));
  const { clearSelection } = createRowSelectionHelpers(selection, setSelection);
  /** Returns MIDI mapping rows targeted by row markers, active cells, or cell ranges. */
  const selectedRows = (): number[] =>
    getEditTargetRowIndices(selection(), displayRows().length);

  /** Clears both the tracked row selection and the grid's visible selection. */
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
        const mapping = row.mapping;
        switch (column.id) {
          case "device_name":
            return {
              kind: GridCellKind.Text,
              allowOverlay: true,
              displayData: mapping.device_name,
              data: mapping.device_name,
            };
          case "control": {
            const label = midiSourceLabel(mapping.source);
            return {
              kind: GridCellKind.Text,
              allowOverlay: false,
              readonly: true,
              displayData: label,
              data: label,
            };
          }
          case "channel":
            return {
              kind: GridCellKind.Number,
              data: mapping.source.data.channel + 1,
              displayData: String(mapping.source.data.channel + 1),
              allowOverlay: true,
            };
          case "number": {
            const value = midiSourceNumber(mapping.source);
            if (value === undefined) {
              return {
                kind: GridCellKind.Text,
                data: "",
                displayData: "",
                allowOverlay: false,
                readonly: true,
              };
            }
            return {
              kind: GridCellKind.Number,
              data: value,
              displayData: String(value),
              allowOverlay: true,
            };
          }
          case "behavior":
            return {
              kind: GridCellKind.Text,
              data: formatBehavior(mapping.behavior),
              displayData: formatBehavior(mapping.behavior),
              allowOverlay: true,
            };
          case "action": {
            const label = formatActionReference(
              mapping.action,
              $actionCatalog(),
              targetNames,
            );
            return {
              kind: GridCellKind.Text,
              data: label,
              displayData: label,
              allowOverlay: false,
              readonly: true,
            };
          }
          case "status":
            return mappingStatusCell(row.error);
          default:
            return {
              kind: GridCellKind.Loading,
              allowOverlay: false,
            };
        }
      },
    }),
  );

  /** Applies one edited cell to every targeted mapping and upserts each result. */
  const handleCellEdited = (cell: Item, newValue: GridCell) => {
    const [col, row] = cell;
    const colId = displayColumns()[col]?.id;
    const visibleRows = displayRows();
    if (row >= visibleRows.length) return;

    const rowsToEdit = getRowsToEdit(
      gridSelection(),
      col,
      row,
      visibleRows.length,
    );
    for (const targetRow of rowsToEdit) {
      const mapping = visibleRows[targetRow]?.mapping;
      if (!mapping) continue;
      const edited = editedMapping(mapping, colId, newValue);
      if (edited) void upsertMidiMapping(edited).then(announceReplacedMappings);
    }
  };

  /** Deletes every selected mapping by ID. */
  const deleteSelected = () => {
    const visibleRows = displayRows();
    const ids = selectedRows()
      .map((index) => visibleRows[index]?.mapping.id)
      .filter((id): id is string => id !== undefined);
    clearGridSelection();
    for (const id of ids) void deleteMidiMapping(id);
  };

  /** Binds, with the chosen behavior, the control that sent the last MIDI message to the chosen action. */
  const applyLastEvent = () => {
    const event = $midiLastEvent();
    const action = lastEventAction();
    if (!event || !action) return;
    const mapping = midiMappingFromEvent(event, action, lastEventBehavior());
    if (mapping) void upsertMidiMapping(mapping).then(announceReplacedMappings);
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
    if (row) {
      void upsertMidiMapping({ ...row.mapping, action }).then(
        announceReplacedMappings,
      );
    }
  };

  return (
    <div class="flex flex-col h-full">
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

        <Show when={$midiLastEvent()}>
          {(event) => (
            <div class="mt-3 p-2 bg-gray-800 rounded border border-gray-600">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-xs text-gray-400">
                  Last Input:{" "}
                  <span class="font-mono text-green-400">
                    {event().device}{" "}
                    {event().source
                      ? midiSourceLabel(event().source!)
                      : `Status ${event().channel}`}{" "}
                    Value {event().velocity}
                  </span>
                </div>
                <Show when={event().source}>
                  <div class="flex flex-wrap items-center gap-2">
                    <ActionPicker
                      label="Action for last input"
                      value={lastEventAction()}
                      inputKinds={MIDI_INPUT_KINDS}
                      surface={ActionSurface.Midi}
                      includeUiActions
                      onChange={setLastEventAction}
                      onIncomplete={() => setLastEventAction(undefined)}
                    />
                    <BehaviorSelect
                      value={lastEventBehavior()}
                      behaviors={actionBehaviors(lastEventEntry())}
                      inputKind={lastEventEntry()?.descriptor.input}
                      onChange={setLastEventBehavior}
                    />
                    <Button
                      size="compact"
                      variant="primary"
                      disabled={!lastEventAction()}
                      onClick={applyLastEvent}
                    >
                      Add Mapping
                    </Button>
                  </div>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </div>

      <div class="flex-1 flex flex-col min-h-0">
        <PanelToolbar
          leftClass="min-w-0 flex-1"
          rightClass="flex h-8 shrink-0 items-center gap-2"
          left={
            <div class="min-w-0">
              <h3 class="text-sm font-medium text-gray-300">MIDI Mappings</h3>
              <p class="truncate text-xs text-gray-500">
                Edit cells to change the control. Select one mapping to change
                its action.
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
                inputKinds={MIDI_INPUT_KINDS}
                surface={ActionSurface.Midi}
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
            No mappings configured. Press a MIDI control, choose an action, and
            click "Add Mapping" to create one.
          </div>
        </Show>
      </div>
    </div>
  );
}

/** Returns a mapping with one grid cell edit applied, or undefined for invalid input. */
function editedMapping(
  mapping: MidiMapping,
  columnId: string | undefined,
  value: GridCell,
): MidiMapping | undefined {
  switch (columnId) {
    case "device_name":
      return value.kind === GridCellKind.Text
        ? { ...mapping, device_name: String(value.data ?? "") }
        : undefined;
    case "channel": {
      if (value.kind !== GridCellKind.Number) return undefined;
      const channel = Number(value.data);
      if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
        return undefined;
      }
      return {
        ...mapping,
        source: withMidiChannel(mapping.source, channel - 1),
      };
    }
    case "number": {
      if (value.kind !== GridCellKind.Number) return undefined;
      const number = Number(value.data);
      if (!Number.isInteger(number) || number < 0 || number > 127) {
        return undefined;
      }
      return { ...mapping, source: withMidiNumber(mapping.source, number) };
    }
    case "behavior": {
      if (value.kind !== GridCellKind.Text) return undefined;
      const behavior = parseBehavior(String(value.data ?? ""));
      return behavior === undefined ? undefined : { ...mapping, behavior };
    }
    default:
      return undefined;
  }
}
