// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createScheduled,
  leadingAndTrailing,
  throttle,
} from "@solid-primitives/scheduled";
import { createMemo, createSignal } from "solid-js";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridScrollRequest,
} from "../../../components/widgets/data-grid";
import { createDataGridFilterState } from "../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import { PROGRAMMER_SELECTION_ID_TEXT_COLOR } from "../../../lib/constants";
import type {
  GridCell,
  GridColumn,
  GridSelection,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS,
  applyAggregateConflictStyling,
  applyElementBackground,
  applyFixtureAttributeValueStyling,
  cellHasDisplayValue,
  createAttributeARCell,
  emptyGridSelection,
  formatIdWithChevron,
  makeNotApplicableCell,
  sortRowsByIdAndType,
} from "../../../lib/datagrid";
import { filterVisibleColumns } from "../../../lib/datagrid-column-visibility";
import {
  createFilterColumnIdentityCache,
  type DataGridFilterColumn,
  type FilterableGridColumn,
  filterColumnsFromMetadata,
  stabilizeFilterColumns,
} from "../../../lib/datagrid-filtering";
import {
  getFixtureAttributeNames,
  getFixtureElementAttributeNames,
} from "../../../lib/fixture-attributes";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { measurePerformanceScope } from "../../../lib/performance-marks";
import { recordExternalPerformanceMeasure } from "../../../lib/performance-measure-collector";
import { usePanelVisibility } from "../../../lib/use-panel-visibility";
import { useConditionalShallowStore } from "../../../lib/use-shallow-store";
import {
  fixtures,
  layerStack,
  type ParameterMap,
  parameters,
  programmerSelection,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import FixturesProperties from "../components/fixtures-properties";
import { FixturesToolbar } from "../components/fixtures-toolbar";
import { createFixturesGridController } from "../controllers/fixtures-grid-controller";
import {
  buildFixtureLayerCellState,
  type FixtureLayerCellState,
  fixtureLayerCellKey,
} from "../model/fixture-layer-cell-state";
import {
  applyVirtualDimmerBadge,
  childElementDisplaysVary,
  createFixtureGridColumns,
  type DisplayedFixtureRows,
  elementRowValueState,
  emptyAttributeValues,
  type FixtureDisplayRow,
  type FixtureElementParameterState,
  type FixtureElementValueState,
  type FixtureGridStructure,
  type FixtureParameterState,
  type FixtureRowValueState,
  type FixtureValueSnapshot,
  fixtureAttributeSignature,
  fixtureRowSignature,
  fixtureValueColumnAttribute,
  indexedElementRowValueState,
  parentRowValueState,
  resolvedFixtureValueAttributes,
  rowHasAssertedValues,
} from "../model/fixtures-grid-model";
import {
  fixturesExpandedSet,
  fixturesShowOnlyWithAttributes,
  fixturesShowReleasedOutput,
  setFixturesShowOnlyWithAttributes,
  setFixturesShowReleasedOutput,
} from "../state/panel-settings";

/** Throttle interval for displayed fixture state updates (ms) - 5fps is plenty for this panel. */
const DISPLAY_STATE_THROTTLE_MS = 200;
const FIXTURES_PANEL_MEASURE_PREFIX = "nightfall:fixtures-panel.";

/** Records one Fixtures panel count metric for baseline and optimized comparisons. */
function recordFixturesPanelCount(metric: string, value: number): void {
  if (value <= 0) return;
  recordExternalPerformanceMeasure(
    `${FIXTURES_PANEL_MEASURE_PREFIX}${metric}`,
    value,
    "count",
  );
}

export interface FixturesPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

export default function FixturesPanel(props: FixturesPanelProps) {
  const isPanelVisible = usePanelVisibility(props.panelApi);
  const $fixtures = useStore(fixtures);
  const $layerStack = useConditionalShallowStore(layerStack, isPanelVisible);
  const $parametersRaw = useStore(parameters);
  const $programmerSelection = useStore(programmerSelection);
  const $showOnlyWithAttributes = useStore(fixturesShowOnlyWithAttributes);
  const $expandedFixtures = useStore(fixturesExpandedSet);
  const $showReleasedOutput = useStore(fixturesShowReleasedOutput);
  const panelId = props.initialPanelId ?? props.id;
  const [selection, setSelection] = createSignal<GridSelection>(
    emptyGridSelection(),
  );
  const [scrollRequest, setScrollRequest] =
    createSignal<DataGridScrollRequest>();

  /** Coalesces live output updates into the displayed grid snapshot cadence. */
  const displayedOutputStateScheduled = createScheduled((callback) =>
    leadingAndTrailing(throttle, callback, DISPLAY_STATE_THROTTLE_MS),
  );

  /** Samples value state for displayed cell contents without subscribing the grid to every engine tick. */
  const displayedParameterMap = createMemo<ParameterMap>((previous) => {
    const next = $parametersRaw();
    return displayedOutputStateScheduled() ? next : previous;
  }, $parametersRaw());

  /** Samples layer-derived display styling at the same cadence as displayed fixture values. */
  const displayedLayerStack = createMemo<readonly types.OutboundLayerState[]>(
    (previous) => {
      const next = $layerStack();
      return displayedOutputStateScheduled() ? next : previous;
    },
    $layerStack(),
  );

  /** Builds fixture source and transition styling from the shallow layer-stack snapshot. */
  const displayedLayerCellState = createMemo<FixtureLayerCellState>(() =>
    measurePerformanceScope("fixtures-panel.layer-cell-state", () =>
      buildFixtureLayerCellState(displayedLayerStack()),
    ),
  );

  // Register filter control in Properties Inspector
  usePropertiesInspector(
    props.initialPanelId,
    "Fixtures",
    () => (
      <FixturesProperties
        filterZero={$showOnlyWithAttributes()}
        onFilterZeroToggle={(enabled: boolean) =>
          setFixturesShowOnlyWithAttributes(enabled)
        }
        showReleasedOutput={$showReleasedOutput()}
        onShowReleasedOutputToggle={(enabled: boolean) =>
          setFixturesShowReleasedOutput(enabled)
        }
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Builds stable row and column structure, reusing identities when shape signatures do not change. */
  const fixtureGridStructure = createMemo<FixtureGridStructure>(
    (previous) =>
      measurePerformanceScope("fixtures-panel.processed-data", () => {
        const fixtureList = Object.values($fixtures());
        const expanded = $expandedFixtures();
        const rows: FixtureDisplayRow[] = [];
        const allAttributes = new Set<string>();

        for (const fixture of fixtureList) {
          const applicableAttributes = getFixtureAttributeNames(fixture);
          const hasElements = fixture.elements.length > 1;
          const isExpanded = expanded.has(fixture.identifiers.uid);

          for (const attribute of applicableAttributes) {
            allAttributes.add(attribute);
          }
          rows.push({
            type: "parent",
            uid: fixture.identifiers.uid,
            id: fixture.identifiers.id,
            name: fixture.model,
            hasElements,
            isExpanded,
            applicableAttributes,
          });

          if (hasElements && isExpanded) {
            for (let index = 0; index < fixture.elements.length; index += 1) {
              const elementIndex = index + 1;
              const elementAttributes = getFixtureElementAttributeNames(
                fixture,
                elementIndex,
              );
              rows.push({
                type: "element",
                fixtureUid: fixture.identifiers.uid,
                elementIndex,
                uid: `${fixture.identifiers.uid}-${elementIndex}`,
                id: fixture.identifiers.id,
                name: `${fixture.identifiers.id}.${elementIndex}`,
                applicableAttributes: elementAttributes,
              });
            }
          }
        }

        sortRowsByIdAndType(rows);

        const rowSignature = fixtureRowSignature(rows);
        const attributeSignature = fixtureAttributeSignature(allAttributes);
        if (
          previous?.rowSignature === rowSignature &&
          previous.attributeSignature === attributeSignature
        ) {
          recordFixturesPanelCount("structure.reused", 1);
          return previous;
        }

        const baseColumns: FilterableGridColumn<
          FixtureDisplayRow,
          GridColumn
        >[] = [
          {
            title: "ID",
            id: "id",
            width: 85,
            filter: { kind: "number", value: (row) => row.id },
          },
          {
            title: "Fixture",
            id: "name",
            width: 150,
            filter: { value: (row) => row.name },
          },
        ];
        const columns = createFixtureGridColumns(allAttributes, baseColumns);

        recordFixturesPanelCount("structure.rebuilt", 1);
        return {
          rows,
          columns,
          allAttributes,
          rowSignature,
          attributeSignature,
        };
      }),
    {
      rows: [],
      columns: [],
      allAttributes: new Set<string>(),
      rowSignature: "",
      attributeSignature: "",
    },
  );

  /** Builds live fixture values separately from structural rows and columns. */
  const fixtureValueSnapshot = createMemo<FixtureValueSnapshot>(
    (previous) =>
      measurePerformanceScope("fixtures-panel.value-snapshot", () => {
        const parameterMap = displayedParameterMap();
        const showAllOutputValues = $showReleasedOutput();
        const rowsByUid = new Map<string, FixtureRowValueState>();
        const elementRowsByFixtureUid = new Map<
          string,
          FixtureElementValueState[]
        >();
        const rowInputsByUid = new Map<
          string,
          FixtureParameterState | FixtureElementParameterState | undefined
        >();
        const fixtureInputsByUid = new Map<
          string,
          FixtureParameterState | undefined
        >();
        const canReusePrevious =
          previous?.showAllOutputValues === showAllOutputValues;
        let reusedRows = 0;
        let rebuiltRows = 0;

        /** Returns a cached row value state when the source parameter identity is unchanged. */
        const rowValueStateForInput = (
          rowUid: string,
          input:
            | FixtureParameterState
            | FixtureElementParameterState
            | undefined,
          build: () => FixtureRowValueState,
        ): FixtureRowValueState => {
          rowInputsByUid.set(rowUid, input);
          const previousState = previous?.rowsByUid.get(rowUid);
          if (
            canReusePrevious &&
            previous?.rowInputsByUid.get(rowUid) === input &&
            previousState
          ) {
            reusedRows += 1;
            return previousState;
          }

          rebuiltRows += 1;
          return build();
        };

        for (const row of fixtureGridStructure().rows) {
          if (row.type === "parent") {
            const param = parameterMap.get(row.uid);
            rowsByUid.set(
              row.uid,
              rowValueStateForInput(row.uid, param, () =>
                parentRowValueState(param, showAllOutputValues),
              ),
            );
            fixtureInputsByUid.set(row.uid, param);
            if (param?.elements) {
              const previousElementRows =
                canReusePrevious &&
                previous?.fixtureInputsByUid.get(row.uid) === param
                  ? previous.elementRowsByFixtureUid.get(row.uid)
                  : undefined;
              elementRowsByFixtureUid.set(
                row.uid,
                previousElementRows ??
                  param.elements.map((element) =>
                    indexedElementRowValueState(element, showAllOutputValues),
                  ),
              );
            }
            continue;
          }

          const param = parameterMap.get(row.fixtureUid);
          const element = param?.elements?.[row.elementIndex - 1];
          rowsByUid.set(
            row.uid,
            rowValueStateForInput(row.uid, element, () =>
              elementRowValueState(element, showAllOutputValues),
            ),
          );
        }

        recordFixturesPanelCount("value-rows.reused", reusedRows);
        recordFixturesPanelCount("value-rows.rebuilt", rebuiltRows);
        return {
          rowsByUid,
          elementRowsByFixtureUid,
          rowInputsByUid,
          fixtureInputsByUid,
          showAllOutputValues,
        };
      }),
    {
      rowsByUid: new Map<string, FixtureRowValueState>(),
      elementRowsByFixtureUid: new Map<string, FixtureElementValueState[]>(),
      rowInputsByUid: new Map<
        string,
        FixtureParameterState | FixtureElementParameterState | undefined
      >(),
      fixtureInputsByUid: new Map<string, FixtureParameterState | undefined>(),
      showAllOutputValues: false,
    },
  );

  /** Computes displayed rows while preserving the row array identity when filtered row keys are unchanged. */
  const displayedRows = createMemo<DisplayedFixtureRows>(
    (previous) =>
      measurePerformanceScope("fixtures-panel.displayed-data", () => {
        const structureRows = fixtureGridStructure().rows;
        const rows = $showOnlyWithAttributes()
          ? structureRows.filter((row) =>
              rowHasAssertedValues(
                fixtureValueSnapshot().rowsByUid.get(row.uid),
              ),
            )
          : structureRows;
        const rowSignature = rows.map((row) => row.uid).join("|");

        if (
          previous?.sourceRows === structureRows &&
          previous.rowSignature === rowSignature
        ) {
          return previous;
        }

        return { rows, rowSignature, sourceRows: structureRows };
      }),
    { rows: [], rowSignature: "", sourceRows: [] },
  );

  const filterColumnIdentityCache =
    createFilterColumnIdentityCache<FixtureDisplayRow>();
  /** Returns stable filter metadata for the Fixtures filter menu across row refreshes. */
  const filterColumns = createMemo<DataGridFilterColumn<FixtureDisplayRow>[]>(
    () => {
      const nextColumns: DataGridFilterColumn<FixtureDisplayRow>[] = [
        ...filterColumnsFromMetadata(
          fixtureGridStructure().columns as FilterableGridColumn<
            FixtureDisplayRow,
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
    },
  );
  const {
    filters: tableFilters,
    filteredRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: panelId,
    rows: () => displayedRows().rows,
    columns: filterColumns,
  });

  const rows = () => filteredRows();

  const allColumns = () => fixtureGridStructure().columns;
  const columns = createMemo(() => {
    return filterVisibleColumns(allColumns(), panelId);
  });

  const cellProvider = createMemo(() => {
    const providerRows = rows();
    const providerColumns = columns();
    const valueSnapshot = fixtureValueSnapshot();
    const selectionSet = new Set($programmerSelection());
    const layerCellState = displayedLayerCellState();
    const showReleasedOutput = $showReleasedOutput();
    const layerStackSnapshot = displayedLayerStack();
    const fixtureList = $fixtures();
    return createKeyedDataGridCellProvider({
      rows: providerRows,
      columns: providerColumns,
      contentSizingKey: providerRows,
      rowKey: (row) => row.uid,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: item, column }): GridCell => {
        const colId = String(column.id);
        const isParent = item.type === "parent";
        const isElement = item.type === "element";
        const rowValueState = valueSnapshot.rowsByUid.get(item.uid);
        const attributes = rowValueState?.attributes ?? emptyAttributeValues();
        const outputValues = rowValueState?.outputValues ?? {};
        const isSelected = selectionSet.has(
          isElement ? item.fixtureUid : item.uid,
        );

        // Handle static columns
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
                  textDark: PROGRAMMER_SELECTION_ID_TEXT_COLOR,
                  baseFontStyle: "bold 13px",
                }
              : undefined,
          };

          return applyElementBackground(cell, isElement);
        }

        if (colId === "name") {
          const cell: GridCell = {
            kind: GridCellKind.Text,
            data: item.name,
            displayData: item.name,
            allowOverlay: false,
          };
          return applyElementBackground(cell, isElement);
        }

        const attribute = fixtureValueColumnAttribute(column);
        if (!attribute) {
          return makeNotApplicableCell();
        }
        const hasAttributeValue =
          attributes.absolute[attribute] !== undefined ||
          attributes.relative[attribute] !== undefined ||
          outputValues[attribute] !== undefined;
        if (!item.applicableAttributes.has(attribute) && !hasAttributeValue) {
          return makeNotApplicableCell();
        }
        const fixtureUid = item.type === "parent" ? item.uid : item.fixtureUid;
        const elementIndex =
          item.type === "element" ? item.elementIndex : undefined;
        const displayAttributes = resolvedFixtureValueAttributes(
          layerStackSnapshot,
          fixtureList[fixtureUid],
          fixtureUid,
          elementIndex,
          attribute,
          attributes,
          outputValues[attribute],
          showReleasedOutput,
        );
        const cell = createAttributeARCell(
          attribute,
          displayAttributes,
          outputValues,
          showReleasedOutput,
        );
        const childValuesVary =
          isParent &&
          childElementDisplaysVary(
            valueSnapshot.elementRowsByFixtureUid.get(item.uid) ?? [],
            layerStackSnapshot,
            fixtureList[fixtureUid],
            fixtureUid,
            attribute,
            showReleasedOutput,
          );
        const isConflicted =
          isParent &&
          (rowValueState?.conflicts?.has(attribute) || childValuesVary);
        if (isConflicted) {
          return applyElementBackground(
            applyAggregateConflictStyling(cell, true, undefined, {
              preserveValue: cellHasDisplayValue(cell),
            }),
            isElement,
          );
        }

        const cellWithConflict = cell;
        const hasDisplayValue = cellHasDisplayValue(cell);
        const canShowTransition = hasDisplayValue;
        const layerCellKey = fixtureLayerCellKey(
          fixtureUid,
          elementIndex,
          attribute,
        );
        const sourceState =
          hasDisplayValue && layerCellKey
            ? layerCellState.sourceStates.get(layerCellKey)
            : undefined;
        const isTransitioning =
          canShowTransition &&
          layerCellKey !== undefined &&
          layerCellState.transitioning.has(layerCellKey);
        const currentOutputValue = outputValues[attribute];
        const cellWithCurrentValue =
          isTransitioning &&
          !showReleasedOutput &&
          typeof currentOutputValue === "number"
            ? createAttributeARCell(
                attribute,
                {
                  absolute: {
                    [attribute]: {
                      value: currentOutputValue,
                      isPercentage: false,
                      isRelative: false,
                    },
                  },
                  relative: {},
                },
                undefined,
                false,
              )
            : cellWithConflict;
        const cellWithVirtualDimmerBadge = applyVirtualDimmerBadge(
          cellWithCurrentValue,
          fixtureList[fixtureUid],
          elementIndex,
          attribute,
        );
        return applyFixtureAttributeValueStyling(cellWithVirtualDimmerBadge, {
          sourceState,
          sourceStateEnabled: hasDisplayValue,
          isTransitioning: !!isTransitioning,
          isElement,
        });
      },
    });
  });

  const { onCellClicked, onCellContextMenu } = createFixturesGridController({
    allRows: () => fixtureGridStructure().rows,
    rows,
    columns,
    layerStack: $layerStack,
    showReleasedOutput: $showReleasedOutput,
    setTableFilters,
    setSelection,
    setScrollRequest,
  });

  return (
    <div
      class="h-full w-full text-white"
      data-panel-kind="fixtures"
      data-panel-id={panelId}
    >
      <div class="flex h-full w-full min-h-0 flex-col">
        <FixturesToolbar
          panelId={panelId}
          showOnlyWithAttributes={$showOnlyWithAttributes()}
          showReleasedOutput={$showReleasedOutput()}
          filterColumns={filterColumns()}
          filters={tableFilters()}
          visibleRows={rows().length}
          totalRows={displayedRows().rows.length}
          columns={allColumns()}
          setShowOnlyWithAttributes={setFixturesShowOnlyWithAttributes}
          setShowReleasedOutput={setFixturesShowReleasedOutput}
          setFilters={setTableFilters}
        />
        <div class="min-h-0 flex-1">
          {Object.keys($fixtures()).length === 0 ? (
            <div class="p-4 text-center text-gray-500">Loading fixtures...</div>
          ) : (
            <DataGrid
              columns={columns()}
              rows={rows().length}
              cellProvider={cellProvider}
              onCellClicked={onCellClicked}
              onCellContextMenu={onCellContextMenu}
              onGridSelectionChange={setSelection}
              gridSelection={selection()}
              scrollRequest={scrollRequest()}
              freezeColumns={1}
              width="100%"
              height="100%"
              nestedColumnGroups={ATTRIBUTE_VALUE_NESTED_COLUMN_GROUPS}
              performanceScope={`fixtures.${panelId}`}
              performanceProbes={{
                fixtureStructure: fixtureGridStructure(),
                fixtureValues: fixtureValueSnapshot(),
                visibleRows: rows(),
                visibleColumns: columns(),
                programmerSelection: $programmerSelection(),
                showReleasedOutput: $showReleasedOutput(),
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
