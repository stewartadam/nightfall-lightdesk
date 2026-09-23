// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, Show } from "solid-js";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridCellEdit,
  type DataGridEditCommitContext,
} from "../../../components/widgets/data-grid";
import { createDataGridFilterState } from "../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import { commandEnvelope } from "../../../lib/command-envelope";
import type {
  GridCell,
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS,
  type AttributeValues,
  applyAggregateConflictStyling,
  applyElementBackground,
  applyFixtureAttributeValueStyling,
  createARCell,
  createAttrValueColumns,
  formatIdWithChevron,
  makeNotApplicableCell,
  sortRowsByIdAndType,
} from "../../../lib/datagrid";
import { COLOR_SWATCH_COLUMN_WIDTH } from "../../../lib/datagrid-color-cell";
import { filterVisibleColumns } from "../../../lib/datagrid-column-visibility";
import {
  createFilterColumnIdentityCache,
  type DataGridFilterColumn,
  type FilterableGridColumn,
  filterColumnsFromMetadata,
  stabilizeFilterColumns,
} from "../../../lib/datagrid-filtering";
import {
  makeColorSwatchCell,
  richColorSwatchCellRenderer,
} from "../../../lib/datagrid-rich-cells";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getFixtureAttributeNames } from "../../../lib/fixture-attributes";
import { anyLayerHasTransitioningAttribute } from "../../../lib/layer-transition-state";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { normalizeAttributeName } from "../../../lib/utils";
import {
  activeInstances,
  blueprints,
  cues,
  fixtures,
  groups,
  layerStack,
  programmerSelection,
  programmerState,
  sequences,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import ProgrammerProperties from "../components/programmer-properties";
import { ProgrammerStoreDialogs } from "../components/programmer-store-dialogs";
import { ProgrammerToolbar } from "../components/programmer-toolbar";
import { createProgrammerGridCommands } from "../controllers/programmer-grid-commands";
import {
  buildProgrammerValueEditCommands,
  type CueTargetOption,
  clampIdInput,
  type GroupTargetOption,
  type ProgrammerDisplayRow,
} from "../model/programmer-grid-model";
import {
  buildClearProgrammerCommand,
  buildCueTargetOptions,
  buildGroupTargetOptions,
  buildStoreCueCommand,
  buildStoreGroupCommand,
  cueDialogDefaults,
  nextAvailableGroupId,
} from "../model/programmer-store-model";

const log = getLogger(import.meta.url);

export interface ProgrammerPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

// Row types for rendering (using shared utilities)
export default function ProgrammerPanel(props: ProgrammerPanelProps) {
  log.trace("mounting");
  const $programmerState = useStore(programmerState);
  const $blueprints = useStore(blueprints);
  const $fixtures = useStore(fixtures);
  const $programmerSelection = useStore(programmerSelection);
  const $layerStack = useShallowStore(layerStack);
  const $activeInstances = useStore(activeInstances);
  const $cues = useShallowStore(cues);
  const $sequences = useShallowStore(sequences);
  const $groups = useStore(groups);
  const panelId = props.initialPanelId ?? props.id;

  // Track which fixtures are expanded (showing element rows)
  const [expandedFixtures, setExpandedFixtures] = createSignal<Set<string>>(
    new Set(),
  );
  const [gridSelection, setGridSelection] = createSignal<
    GridSelection | undefined
  >(undefined);
  const [showStoreCueModal, setShowStoreCueModal] = createSignal(false);
  const [showStoreGroupModal, setShowStoreGroupModal] = createSignal(false);

  const [cueSequenceId, setCueSequenceId] = createSignal(1);
  const [cueId, setCueId] = createSignal(1);
  const [cueLabel, setCueLabel] = createSignal("Cue 1");
  const [cueLabelEdited, setCueLabelEdited] = createSignal(false);

  const [groupId, setGroupId] = createSignal(1);
  const [groupLabel, setGroupLabel] = createSignal("Group 1");
  const [groupLabelEdited, setGroupLabelEdited] = createSignal(false);

  // Register properties with the inspector
  usePropertiesInspector(
    props.initialPanelId,
    "Programmer",
    () => <ProgrammerProperties />,
    { priority: 10, autoActivate: true },
  );

  /** Projects persisted sequence cues into store-dialog selector options. */
  const cueTargetOptions = createMemo<CueTargetOption[]>(() => {
    return buildCueTargetOptions($cues(), $sequences());
  });

  /** Projects persisted groups into store-dialog selector options. */
  const groupTargetOptions = createMemo<GroupTargetOption[]>(() => {
    return buildGroupTargetOptions($groups());
  });

  /** Returns the first group ID after the current sorted options. */
  const nextGroupId = createMemo(() =>
    nextAvailableGroupId(groupTargetOptions()),
  );

  const openStoreCueDialog = () => {
    const defaults = cueDialogDefaults($sequences(), cueTargetOptions());
    setCueSequenceId(defaults.sequenceId);
    setCueId(defaults.cueId);
    setCueLabel(defaults.label);
    setCueLabelEdited(false);
    setShowStoreCueModal(true);
  };

  const openStoreGroupDialog = () => {
    const nextId = nextGroupId();
    setGroupId(nextId);
    setGroupLabel(`Group ${nextId}`);
    setGroupLabelEdited(false);
    setShowStoreGroupModal(true);
  };

  const updateCueId = (nextCueId: number) => {
    const normalized = clampIdInput(nextCueId);
    setCueId(normalized);

    if (!cueLabelEdited()) {
      setCueLabel(`Cue ${normalized}`);
    }
  };

  const updateGroupId = (nextGroupId: number) => {
    const normalized = clampIdInput(nextGroupId);
    setGroupId(normalized);

    if (!groupLabelEdited()) {
      setGroupLabel(`Group ${normalized}`);
    }
  };

  const handleStoreCue = (event: Event) => {
    event.preventDefault();

    const command = buildStoreCueCommand(cueSequenceId(), cueId(), cueLabel());

    engineRuntime.sendCommand({
      module: "ProgrammerCommand",
      command,
    });

    setShowStoreCueModal(false);
  };

  const handleStoreGroup = (event: Event) => {
    event.preventDefault();

    const command = buildStoreGroupCommand(groupId(), groupLabel());

    engineRuntime.sendCommand({
      module: "ProgrammerCommand",
      command,
    });

    setShowStoreGroupModal(false);
  };

  const handleClearProgrammer = () => {
    const command = buildClearProgrammerCommand();

    engineRuntime.sendCommand({
      module: "ProgrammerCommand",
      command,
    });
  };

  const processedData = createMemo(() => {
    const fixtureMap = $fixtures();
    const progState = $programmerState();
    const selection = $programmerSelection();
    const expanded = expandedFixtures();

    const fixtureArray = Object.values(fixtureMap);
    if (!fixtureArray || fixtureArray.length === 0) {
      return { displayRows: [], columns: [], allAttributes: new Set<string>() };
    }

    const displayRows: ProgrammerDisplayRow[] = [];
    const allAttributes = new Set<string>();

    // Process programmer state - now using ProgrammerRow with per-element data
    for (const row of progState) {
      const fixtureUid = row.fixtureUid;
      const fixture = fixtureArray.find(
        (f) => f.identifiers.uid === fixtureUid,
      );
      if (!fixture) {
        log.warn(`Could not find fixture with UUID: ${fixtureUid}`);
        continue;
      }

      const attributeValues: AttributeValues = {
        absolute: {},
        relative: {},
      };

      // Process aggregated attributes for parent row
      for (const [attr, paramValue] of Object.entries(row.attributes)) {
        const normalizedAttr = normalizeAttributeName(attr);
        allAttributes.add(normalizedAttr);

        if (paramValue.isRelative) {
          attributeValues.relative[normalizedAttr] = {
            value: paramValue.value,
            isPercentage: paramValue.isPercentage,
            isRelative: true,
            marker: paramValue.marker,
            blueprintSource: paramValue.blueprintSource,
          };
        } else {
          attributeValues.absolute[normalizedAttr] = {
            value: paramValue.value,
            isPercentage: paramValue.isPercentage,
            isRelative: false,
            marker: paramValue.marker,
            blueprintSource: paramValue.blueprintSource,
          };
        }
      }

      const red =
        attributeValues.absolute.Red?.value ||
        attributeValues.relative.Red?.value ||
        0;
      const green =
        attributeValues.absolute.Green?.value ||
        attributeValues.relative.Green?.value ||
        0;
      const blue =
        attributeValues.absolute.Blue?.value ||
        attributeValues.relative.Blue?.value ||
        0;
      const color = `rgb(${red * 255}, ${green * 255}, ${blue * 255})`;

      const hasElements = row.elements && row.elements.length > 1;
      const isExpanded = expanded.has(fixtureUid);
      const applicableAttributes = getFixtureAttributeNames(fixture);

      // Add parent row
      displayRows.push({
        type: "parent",
        uid: fixtureUid,
        id: fixture.identifiers.id,
        name: fixture.model,
        color,
        attributes: attributeValues,
        hasElements: hasElements || false,
        isExpanded,
        conflicts: row.conflicts,
        applicableAttributes,
      });

      // Add element rows if expanded
      if (hasElements && isExpanded && row.elements) {
        for (const element of row.elements) {
          const elementAttributeValues: AttributeValues = {
            absolute: {},
            relative: {},
          };

          // Process element attributes
          for (const [attr, paramValue] of Object.entries(element.attributes)) {
            const normalizedAttr = normalizeAttributeName(attr);
            allAttributes.add(normalizedAttr);

            if (paramValue.isRelative) {
              elementAttributeValues.relative[normalizedAttr] = {
                value: paramValue.value,
                isPercentage: paramValue.isPercentage,
                isRelative: true,
                marker: paramValue.marker,
                blueprintSource: paramValue.blueprintSource,
              };
            } else {
              elementAttributeValues.absolute[normalizedAttr] = {
                value: paramValue.value,
                isPercentage: paramValue.isPercentage,
                isRelative: false,
                marker: paramValue.marker,
                blueprintSource: paramValue.blueprintSource,
              };
            }
          }

          const elRed =
            elementAttributeValues.absolute.Red?.value ||
            elementAttributeValues.relative.Red?.value ||
            0;
          const elGreen =
            elementAttributeValues.absolute.Green?.value ||
            elementAttributeValues.relative.Green?.value ||
            0;
          const elBlue =
            elementAttributeValues.absolute.Blue?.value ||
            elementAttributeValues.relative.Blue?.value ||
            0;
          const elementColor = `rgb(${elRed * 255}, ${elGreen * 255}, ${elBlue * 255})`;

          displayRows.push({
            type: "element",
            fixtureUid,
            elementIndex: element.elementIndex,
            uid: `${fixtureUid}-${element.elementIndex}`,
            id: fixture.identifiers.id,
            name: `${fixture.identifiers.id}.${element.elementIndex}`,
            color: elementColor,
            attributes: elementAttributeValues,
            applicableAttributes,
          });
        }
      }
    }

    // Also add fixtures that are in the selection but have no asserted attributes
    // Selected fixtures should appear in the table with empty attribute cells.
    for (const selUid of selection) {
      // Skip if already present from programmer state
      if (
        displayRows.find(
          (r) => r.uid === selUid || (r.type === "parent" && r.uid === selUid),
        )
      )
        continue;
      const fixture = fixtureArray.find((f) => f.identifiers.uid === selUid);
      if (!fixture) {
        log.warn(`Could not find selected fixture with UUID: ${selUid}`);
        continue;
      }
      const applicableAttributes = getFixtureAttributeNames(fixture);
      displayRows.push({
        type: "parent",
        uid: selUid,
        id: fixture.identifiers.id,
        name: fixture.model,
        color: "rgb(0, 0, 0)",
        attributes: { absolute: {}, relative: {} },
        hasElements: false,
        isExpanded: false,
        applicableAttributes,
      });
    }

    // Sort rows using shared utility
    sortRowsByIdAndType(displayRows);

    // Create base columns
    const baseColumns: FilterableGridColumn<
      ProgrammerDisplayRow,
      GridColumn
    >[] = [
      {
        title: "ID",
        id: "id",
        width: 85,
        minWidth: 85,
        filter: { kind: "number", value: (row) => row.id },
      },
      {
        title: "Fixture",
        id: "name",
        width: 240,
        minWidth: 240,
        filter: { value: (row) => row.name },
      },
      {
        title: "",
        id: "color",
        width: COLOR_SWATCH_COLUMN_WIDTH,
        minWidth: COLOR_SWATCH_COLUMN_WIDTH,
        sizing: "fixed",
      },
    ];

    // Create value columns for all attributes
    const columns = createAttrValueColumns(
      Array.from(allAttributes),
      baseColumns,
      {
        valueWidths: Object.fromEntries(
          Array.from(allAttributes)
            .filter((attribute) =>
              displayRows.some(
                (row) =>
                  row.attributes.absolute[attribute]?.blueprintSource !==
                    undefined ||
                  row.attributes.relative[attribute]?.blueprintSource !==
                    undefined,
              ),
            )
            .map((attribute) => [attribute, 200]),
        ),
      },
    );

    return {
      displayRows,
      columns,
      allAttributes,
    };
  });

  const filterColumnIdentityCache =
    createFilterColumnIdentityCache<ProgrammerDisplayRow>();
  /** Returns stable filter metadata for the programmer filter menu across programmer refreshes. */
  const filterColumns = createMemo<
    DataGridFilterColumn<ProgrammerDisplayRow>[]
  >(() => {
    const nextColumns: DataGridFilterColumn<ProgrammerDisplayRow>[] = [
      ...filterColumnsFromMetadata(
        processedData().columns as FilterableGridColumn<
          ProgrammerDisplayRow,
          GridColumn
        >[],
      ),
      {
        id: "row_type",
        label: "Row Type",
        kind: "enum",
        value: (row) => (row.type === "parent" ? "Fixture" : "Element"),
        options: [
          { value: "Fixture", label: "Fixture" },
          { value: "Element", label: "Element" },
        ],
      },
      {
        id: "attributes",
        label: "Attributes",
        kind: "tag",
        value: (row) => Array.from(row.applicableAttributes),
      },
    ];
    return stabilizeFilterColumns(filterColumnIdentityCache, nextColumns);
  });
  const {
    filters: tableFilters,
    filteredRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: panelId,
    rows: () => processedData().displayRows,
    columns: filterColumns,
  });

  const displayRows = () => filteredRows();

  const allColumns = () => processedData().columns;
  const columns = createMemo(() => {
    return filterVisibleColumns(allColumns(), panelId);
  });
  const { onCellContextMenu, onColumnHeaderContextMenu, onDelete } =
    createProgrammerGridCommands({
      columns,
      rows: displayRows,
      selection: gridSelection,
      blueprints: $blueprints,
    });

  const cellProvider = createMemo(() => {
    const selectionUids = new Set($programmerSelection());
    const layersArg = $layerStack();
    const activeInstancesData = Object.values($activeInstances());
    const isProgrammerLayer = (layer: types.OutboundLayerState): boolean => {
      if (
        layer.creator === "Programmer" ||
        layer.creator.startsWith("Programmer Instruction ")
      ) {
        return true;
      }

      return activeInstancesData.some(
        (playback) =>
          playback.kind === "Programmer" && playback.name === layer.creator,
      );
    };

    const providerRows = displayRows();
    return createKeyedDataGridCellProvider({
      rows: providerRows,
      columns: columns(),
      contentSizingKey: providerRows,
      rowKey: (row) => row.uid,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: item, column }): GridCell => {
        const colId = String(column.id);
        const isParent = item.type === "parent";
        const isElement = item.type === "element";
        const isSelected = selectionUids.has(
          isElement ? item.fixtureUid : item.uid,
        );

        // Handle ID column with chevron support
        if (colId === "id") {
          const displayText = formatIdWithChevron(
            item.id,
            item.type,
            isParent ? item.hasElements : false,
            isParent ? item.isExpanded : false,
            isElement ? item.elementIndex : undefined,
          );

          const cell: GridCell = {
            kind: GridCellKind.Text,
            data: String(item.id),
            displayData: displayText,
            allowOverlay: false,
            themeOverride: isSelected
              ? {
                  textDark: "#ff0000",
                  baseFontStyle: "bold 13px",
                }
              : undefined,
          };

          return applyElementBackground(cell, isElement);
        }

        // Name column
        if (colId === "name") {
          const cell: GridCell = {
            kind: GridCellKind.Text,
            data: item.name,
            displayData: item.name,
            allowOverlay: false,
          };
          return applyElementBackground(cell, isElement);
        }

        if (colId === "color") {
          const cell: GridCell = makeColorSwatchCell({
            color: item.color,
            withLabel: false,
          });
          return applyElementBackground(cell, isElement);
        }

        // Handle value columns - apply grey text for conflicted values on parent rows
        const match = colId.match(/^(.+)_Value$/);
        if (match && !item.applicableAttributes.has(match[1])) {
          return makeNotApplicableCell();
        }
        const isConflicted = match && isParent && item.conflicts?.has(match[1]);

        const cell = createARCell(colId, item.attributes);
        if (isConflicted) {
          return applyElementBackground(
            applyAggregateConflictStyling(cell, true),
            isElement,
          );
        }

        const fixtureUid = item.type === "parent" ? item.uid : item.fixtureUid;
        const elementIndex =
          item.type === "element" ? item.elementIndex : undefined;
        const attribute = match?.[1];
        const isTransitioning =
          attribute !== undefined &&
          anyLayerHasTransitioningAttribute(
            layersArg,
            fixtureUid,
            elementIndex,
            attribute,
            isProgrammerLayer,
          );

        return applyFixtureAttributeValueStyling(cell, {
          sourceLayers: layersArg,
          fixtureUid,
          elementIndex,
          attribute,
          layerFilter: isProgrammerLayer,
          isTransitioning,
          isElement,
        });
      },
    });
  });

  /** Returns the operator input carried by one concrete grid edit. */
  const inputForCellEdit = (
    edit: DataGridCellEdit,
    context?: DataGridEditCommitContext,
  ): string | undefined => {
    if (edit.inputValue !== undefined) return edit.inputValue;
    if (context?.inputValue !== undefined) return context.inputValue;
    return edit.newValue.kind === GridCellKind.Text ||
      edit.newValue.kind === GridCellKind.Number
      ? String(edit.newValue.data ?? "")
      : undefined;
  };

  /** Parses and persists programmer value edits as grouped fixture instructions. */
  const sendProgrammerValueEdits = (
    edits: readonly DataGridCellEdit[],
    context?: DataGridEditCommitContext,
  ) => {
    const currentRows = displayRows();
    const currentColumns = columns();
    const targets = edits.flatMap((edit) => {
      const [columnIndex, rowIndex] = edit.cell;
      const row = currentRows[rowIndex];
      const columnId = currentColumns[columnIndex]?.id;
      const input = inputForCellEdit(edit, context);
      return row && columnId !== undefined && input !== undefined
        ? [{ row, columnId: String(columnId), input }]
        : [];
    });
    const commands = buildProgrammerValueEditCommands(targets);
    const undoId = commands.length > 1 ? crypto.randomUUID() : undefined;
    for (const command of commands) {
      engineRuntime.sendCommand(
        commandEnvelope("ProgrammerCommand", command, undoId),
      );
    }
  };

  /** Persists a single programmer cell edit. */
  const handleCellEdited = (
    cell: Item,
    newValue: GridCell,
    _selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => {
    sendProgrammerValueEdits([{ cell, newValue }], context);
  };

  /** Persists a multi-cell edit as the fewest compatible programmer commands. */
  const handleCellsEdited = (
    edits: readonly DataGridCellEdit[],
    _selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => {
    sendProgrammerValueEdits(edits, context);
  };

  /** Handle row clicks for expansion/collapse */
  const handleCellClicked = (cell: Item) => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    if (!rowData) return;

    const colId = columns()[col]?.id;
    if (colId === "id" && rowData.type === "parent" && rowData.hasElements) {
      const uid = rowData.uid;
      setExpandedFixtures((prev) => {
        const next = new Set(prev);
        if (next.has(uid)) {
          next.delete(uid);
        } else {
          next.add(uid);
        }
        return next;
      });
    }
  };

  const onFallback = () => {
    return (
      <div class="h-full w-full flex items-center justify-center text-gray-500">
        <div>
          <p class="text-center">Programmer is empty.</p>
          <p class="text-center text-sm mt-2">
            Select fixtures and set values to see them here.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div
      class="h-full w-full flex flex-col bg-neutral-900 text-white"
      data-panel-kind="programmer"
      data-panel-id={panelId}
    >
      <ProgrammerToolbar
        storeCue={openStoreCueDialog}
        storeGroup={openStoreGroupDialog}
        clear={handleClearProgrammer}
        filterMenu={{
          columns: filterColumns(),
          filters: tableFilters(),
          visibleRows: displayRows().length,
          totalRows: processedData().displayRows.length,
          onFiltersChange: setTableFilters,
        }}
        columnVisibilityMenu={{ scope: panelId, columns: allColumns() }}
      />

      <div class="flex-1 min-h-0">
        <Show when={displayRows().length > 0} fallback={onFallback()}>
          <DataGrid
            rows={displayRows().length}
            columns={columns()}
            cellProvider={cellProvider}
            onCellEdited={handleCellEdited}
            onCellsEdited={handleCellsEdited}
            customRenderers={[richColorSwatchCellRenderer]}
            onCellClicked={handleCellClicked}
            onCellContextMenu={onCellContextMenu}
            onColumnHeaderContextMenu={onColumnHeaderContextMenu}
            onDelete={onDelete}
            gridSelection={gridSelection()}
            onGridSelectionChange={setGridSelection}
            freezeColumns={1}
            width="100%"
            height="100%"
            nestedColumnGroups={ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS}
          />
        </Show>
      </div>

      <ProgrammerStoreDialogs
        showCue={showStoreCueModal()}
        showGroup={showStoreGroupModal()}
        cueTargets={cueTargetOptions()}
        groupTargets={groupTargetOptions()}
        cueSequenceId={cueSequenceId()}
        cueId={cueId()}
        cueLabel={cueLabel()}
        groupId={groupId()}
        groupLabel={groupLabel()}
        setCueSequenceId={setCueSequenceId}
        setCueId={updateCueId}
        setCueLabel={setCueLabel}
        setCueLabelEdited={setCueLabelEdited}
        setGroupId={updateGroupId}
        setGroupLabel={setGroupLabel}
        setGroupLabelEdited={setGroupLabelEdited}
        closeCue={() => setShowStoreCueModal(false)}
        closeGroup={() => setShowStoreGroupModal(false)}
        storeCue={handleStoreCue}
        storeGroup={handleStoreGroup}
      />
    </div>
  );
}
