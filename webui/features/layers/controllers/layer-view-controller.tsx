// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  type Setter,
  Show,
} from "solid-js";
import {
  type ContextMenuEntry,
  openContextMenu,
} from "../../../components/providers/context-menu";
import { createKeyedDataGridCellProvider } from "../../../components/widgets/data-grid";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../components/widgets/data-grid/extensions/data-grid-filter-menu";
import { createDataGridFilterState } from "../../../components/widgets/data-grid/extensions/model/data-grid-filter-state";
import type {
  CellClickedEventArgs,
  GridCell,
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { CompactSelection } from "../../../lib/data-grid-types";
import {
  applyAggregateConflictStyling,
  applyElementBackground,
  applyTransitionStyling,
  formatIdWithChevron,
  makeNotApplicableCell,
  makeSafeTextCell,
} from "../../../lib/datagrid";
import { filterVisibleColumns } from "../../../lib/datagrid-column-visibility";
import {
  createFilterColumnIdentityCache,
  type DataGridFilterColumn,
  type FilterableGridColumn,
  filterColumnsFromMetadata,
  stabilizeFilterColumns,
} from "../../../lib/datagrid-filtering";
import { makeColorSwatchCell } from "../../../lib/datagrid-rich-cells";
import { measurePerformanceScope } from "../../../lib/performance-marks";
import type { LayerNavigationRequest } from "../../../state/appStores";
import { attributeMetadata, fixtures } from "../../../state/appStores";
import * as types from "../../../types";
import { LayerGrid } from "../components/layer-grid";
import {
  createLayerCellProjection,
  createLayerValueMaps,
} from "../model/layer-cell-projection";
import {
  createLayerDisplayStructure,
  findRequestedRowIndex,
  type LayerColumnsMemo,
  type LayerDisplayRow,
  type LayerDisplayRowsData,
  layerDisplayStructureRevision,
  memoizeLayerColumns,
} from "../model/layer-display-data";

export type LayerViewProps = {
  contentOnly?: boolean;
  expandedFixtures?: Accessor<Set<string>>;
  layer: types.OutboundLayerState | Accessor<types.OutboundLayerState>;
  summary?: LayerViewSummary | Accessor<LayerViewSummary>;
  layerIndex: number | Accessor<number>;
  panelId: string;
  selectedRowIndex?: Accessor<number | null>;
  setExpandedFixtures?: Setter<Set<string>>;
  setSelectedRowIndex?: Setter<number | null>;
  isOpen?: boolean;
  navigationRequest?: LayerNavigationRequest | null;
  showColumnVisibilityMenu?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  onNavigationHandled?: (requestId: number) => void;
  onNavigateToLayerObject?: (layer: types.OutboundLayerState) => void;
};

type LayerViewSummary = {
  creator: string;
  objectType?: types.ObjectType;
  priority: types.Priority;
};

/** Resolves props that may be passed as accessors by stable keyed parents. */
function resolveMaybeAccessor<T>(value: T | Accessor<T>): T {
  return typeof value === "function" ? (value as Accessor<T>)() : value;
}

type LayerDisplayStructureInput = {
  revision: string;
  layer: types.OutboundLayerState;
  expanded: Set<string>;
  fixtureList: Record<string, types.Fixture>;
};

const EMPTY_DISPLAY_ROWS_DATA: LayerDisplayRowsData = {
  rows: [],
  attributes: [],
  attributeSignature: "[]",
};

/** Coordinates layer-grid projection, selection, filtering, and navigation. */
export function LayerViewController(props: LayerViewProps) {
  const $fixtures = useStore(fixtures);
  const $attributeMetadata = useStore(attributeMetadata);
  const layer = () => resolveMaybeAccessor(props.layer);
  const layerSummary = () =>
    props.summary
      ? resolveMaybeAccessor(props.summary)
      : {
          creator: layer().creator,
          objectType: layer().object_ref?.data.object_type,
          priority: layer().priority,
        };
  const layerIndex = () => resolveMaybeAccessor(props.layerIndex);
  const [localExpandedFixtures, setLocalExpandedFixtures] = createSignal<
    Set<string>
  >(new Set());
  const [localIsOpen, setLocalIsOpen] = createSignal(layerIndex() === 0);
  const [localSelectedRowIndex, setLocalSelectedRowIndex] = createSignal<
    number | null
  >(null);
  const expandedFixtures = props.expandedFixtures ?? localExpandedFixtures;
  const setExpandedFixtures =
    props.setExpandedFixtures ?? setLocalExpandedFixtures;
  const selectedRowIndex = props.selectedRowIndex ?? localSelectedRowIndex;
  const setSelectedRowIndex =
    props.setSelectedRowIndex ?? setLocalSelectedRowIndex;
  const isOpen = () => props.isOpen ?? localIsOpen();
  /** Returns whether the layer represents a sequence playback or preview. */
  const isSequenceLayer = () =>
    layer().object_ref?.data.object_type === types.ObjectType.Sequence;

  const showColumnVisibilityMenu = () => props.showColumnVisibilityMenu ?? true;

  const shouldBuildGridData = () =>
    isOpen() ||
    showColumnVisibilityMenu() ||
    props.navigationRequest?.layerIndex === layerIndex();

  /** Tracks structural inputs that require rebuilding layer grid rows. */
  const displayStructureInput = createMemo<LayerDisplayStructureInput | null>(
    (previous) => {
      return measurePerformanceScope("layer-view.structure-input", () => {
        if (!shouldBuildGridData()) {
          return null;
        }

        const currentLayer = layer();
        const expanded = expandedFixtures();
        const fixtureList = $fixtures();
        const revision = layerDisplayStructureRevision(
          currentLayer,
          expanded,
          fixtureList,
        );
        if (previous?.revision === revision) {
          return previous;
        }

        return { revision, layer: currentLayer, expanded, fixtureList };
      });
    },
  );

  /** Rebuilds structural rows only when structural layer inputs change. */
  const displayRowsData = createMemo<LayerDisplayRowsData>(() => {
    return measurePerformanceScope("layer-view.display-rows-data", () => {
      const input = displayStructureInput();
      if (!input) {
        return EMPTY_DISPLAY_ROWS_DATA;
      }

      return createLayerDisplayStructure(
        input.layer,
        input.expanded,
        input.fixtureList,
      );
    });
  });
  /** Reuses column definitions until layer attributes or attribute metadata change. */
  const displayColumns = createMemo<
    LayerColumnsMemo<types.AttributeMetadata[]>
  >((previous) =>
    memoizeLayerColumns(
      displayRowsData().attributes,
      displayRowsData().attributeSignature,
      $attributeMetadata(),
      previous,
    ),
  );
  const filterColumnIdentityCache =
    createFilterColumnIdentityCache<LayerDisplayRow>();
  /** Returns stable filter metadata for the layer filter menu across layer refreshes. */
  const filterColumns = createMemo<DataGridFilterColumn<LayerDisplayRow>[]>(
    () => {
      const nextColumns: DataGridFilterColumn<LayerDisplayRow>[] = [
        ...filterColumnsFromMetadata(
          displayColumns().columns as FilterableGridColumn<
            LayerDisplayRow,
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
    filteredRows: displayRows,
    setFilters: setTableFilters,
  } = createDataGridFilterState({
    scope: `${props.panelId}:layer-${layerIndex()}`,
    rows: () => displayRowsData().rows,
    columns: filterColumns,
  });

  const visibilityScope = () => `${props.panelId}:layers`;

  const visibleColumns = createMemo(() => {
    return filterVisibleColumns(displayColumns().columns, visibilityScope());
  });

  const gridSelection = createMemo<GridSelection | undefined>(() => {
    const rowIndex = selectedRowIndex();
    if (rowIndex === null) {
      return undefined;
    }

    return {
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromSingleSelection(rowIndex),
      current: {
        cell: [0, rowIndex],
        range: {
          x: 0,
          y: rowIndex,
          width: 1,
          height: 1,
        },
        rangeStack: [],
      },
    };
  });

  createEffect(() => {
    const request = props.navigationRequest;
    if (!request || request.layerIndex !== layerIndex()) {
      return;
    }

    if (props.onOpenChange) {
      props.onOpenChange(true);
    } else {
      setLocalIsOpen(true);
    }

    if (request.elementIndex !== undefined) {
      setExpandedFixtures((prev) => {
        if (prev.has(request.fixtureUid)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(request.fixtureUid);
        return next;
      });
    }

    const rowIndex = findRequestedRowIndex(displayRows(), request);
    if (rowIndex < 0) {
      return;
    }

    setSelectedRowIndex(rowIndex);
    props.onNavigationHandled?.(request.requestId);
  });

  /** Indexes current layer values for visible-cell projection. */
  const layerValueMaps = createMemo(() =>
    measurePerformanceScope("layer-view.value-maps", () =>
      createLayerValueMaps(layer()),
    ),
  );

  /** Builds snapshot-scoped value and aggregate cell projection helpers. */
  const layerCellProjection = createMemo(() =>
    createLayerCellProjection({
      fixtureList: $fixtures(),
      isSequenceLayer: isSequenceLayer(),
      maps: layerValueMaps(),
    }),
  );

  const cellProvider = createMemo(() => {
    return measurePerformanceScope("layer-view.cell-provider", () => {
      if (!isOpen()) {
        return createKeyedDataGridCellProvider<
          LayerDisplayRow,
          GridColumn,
          string,
          string
        >({
          rows: [],
          columns: [],
          rowKey: (row) => row.uid,
          columnKey: (column) => String(column.id),
          getCellContent: (): GridCell => makeSafeTextCell(""),
        });
      }

      void layerCellProjection();
      return createKeyedDataGridCellProvider({
        rows: displayRows(),
        columns: visibleColumns(),
        contentSizingKey: displayRows(),
        rowKey: (row) => row.uid,
        columnKey: (column) => String(column.id),
        getCellContent: ({ row: rowData, column }): GridCell => {
          const columnId = String(column.id ?? "");
          switch (columnId) {
            case "id": {
              const isParent = rowData.type === "parent";
              const text = isParent
                ? formatIdWithChevron(
                    rowData.id,
                    "parent",
                    rowData.hasElements,
                    rowData.isExpanded,
                  )
                : formatIdWithChevron(
                    rowData.id,
                    "element",
                    false,
                    false,
                    rowData.elementIndex,
                  );
              const cell = makeSafeTextCell(text);
              applyElementBackground(cell, !isParent);
              return cell;
            }
            case "name": {
              const cell = makeSafeTextCell(rowData.name);
              applyElementBackground(cell, rowData.type === "element");
              return cell;
            }
            case "color": {
              const cell: GridCell = makeColorSwatchCell({
                color: layerCellProjection().currentRowColor(rowData),
                withLabel: false,
              });
              return applyElementBackground(cell, rowData.type === "element");
            }
            default:
              break;
          }

          const match = columnId.match(/^(.*)_(Value|Out)$/);
          if (!match) {
            return makeSafeTextCell("");
          }

          const attribute = match[1];
          const suffix = match[2] as "Value" | "Out";
          if (
            rowData.type === "parent" &&
            rowData.applicableAttributes.has(attribute)
          ) {
            const { cell, conflict, transitioning } =
              layerCellProjection().parentAttributeCell(
                rowData,
                attribute,
                suffix,
              );
            if (!cell) {
              return makeNotApplicableCell();
            }
            const styledCell = conflict
              ? applyAggregateConflictStyling(cell, true)
              : cell;
            return applyTransitionStyling(styledCell, transitioning);
          }

          if (rowData.type === "element") {
            const { cell, transitioning } =
              layerCellProjection().elementAttributeCell(
                rowData.fixtureUid,
                rowData.elementIndex,
                attribute,
                suffix,
              );
            if (cell) {
              return applyTransitionStyling(cell, transitioning);
            }
          }

          return makeSafeTextCell("");
        },
      });
    });
  });

  /** Returns whether a cell can navigate to the layer source object. */
  const isLayerSourceNavigationCell = (cell: Item): boolean => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    if (!rowData) return false;

    const colId = visibleColumns()[col]?.id;
    return !!colId && /_(Value|Out)$/.test(String(colId));
  };

  /** Opens the source object for the displayed layer. */
  const navigateToLayerSource = (): boolean => {
    if (!props.onNavigateToLayerObject) {
      return false;
    }

    props.onNavigateToLayerObject(layer());
    return true;
  };

  /** Handles layer-grid clicks for expansion and shortcut navigation. */
  const handleCellClicked = (cell: Item, event: CellClickedEventArgs) => {
    const [col, row] = cell;
    const rowData = displayRows()[row];
    if (!rowData) return;

    const colId = visibleColumns()[col]?.id;
    const altKey = (event as CellClickedEventArgs & { altKey?: boolean })
      .altKey;

    if (altKey === true && isLayerSourceNavigationCell(cell)) {
      navigateToLayerSource();
      return;
    }

    if (
      colId === "id" &&
      rowData.type === "parent" &&
      rowData.hasElements &&
      rowData.uid
    ) {
      setExpandedFixtures((prev) => {
        const next = new Set(prev);
        if (next.has(rowData.uid)) {
          next.delete(rowData.uid);
        } else {
          next.add(rowData.uid);
        }
        return next;
      });
    }
  };

  /** Opens right-click affordances for layer source navigation. */
  const handleCellContextMenu = (cell: Item, event: MouseEvent) => {
    if (!isLayerSourceNavigationCell(cell)) {
      return;
    }

    event.preventDefault();
    const items: ContextMenuEntry[] = [
      {
        id: "show-layer-source",
        label: "Show layer source",
        icon: ArrowsClockwiseIcon,
        shortcut: "Alt+Click",
        disabled: props.onNavigateToLayerObject === undefined,
        onSelect: navigateToLayerSource,
      },
    ];
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items,
    });
  };

  const gridContent = (
    <LayerGrid
      cellProvider={cellProvider}
      columns={visibleColumns()}
      gridSelection={gridSelection()}
      isOpen={isOpen()}
      layerIndex={layerIndex()}
      onCellClicked={handleCellClicked}
      onCellContextMenu={handleCellContextMenu}
      panelId={props.panelId}
      performanceProbes={{
        displayRowsData: displayRowsData(),
        visibleRows: displayRows(),
        visibleColumns: visibleColumns(),
        gridSelection: gridSelection(),
        isOpen: isOpen(),
      }}
      rows={displayRows().length}
    />
  );

  if (props.contentOnly) {
    return gridContent;
  }

  return (
    <details
      open={isOpen()}
      onToggle={(event) => {
        const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
        if (props.onOpenChange) {
          props.onOpenChange(nextOpen);
        } else {
          setLocalIsOpen(nextOpen);
        }
      }}
      class="rounded-md border border-gray-700"
    >
      <summary class="flex cursor-pointer select-none items-center justify-between bg-neutral-800 px-4 py-2">
        <span class="flex min-w-0 items-center gap-2 text-white">
          <span class="shrink-0">Layer {layerIndex()}:</span>
          <Show when={layerSummary().objectType}>
            {(objectType) => (
              <span class="shrink-0 rounded border border-gray-600 px-1.5 py-0.5 text-xs font-medium text-gray-300">
                {objectType()}
              </span>
            )}
          </Show>
          <span class="min-w-0 truncate">
            {layerSummary().creator ? layerSummary().creator : "Unnamed"}
          </span>
        </span>
        <span class="ml-3 flex shrink-0 items-center gap-2">
          <span class="text-xs text-gray-500">
            Priority: {layerSummary().priority}
          </span>
          <Show when={showColumnVisibilityMenu()}>
            <DataGridFilterMenu
              columns={filterColumns()}
              filters={tableFilters()}
              visibleRows={displayRows().length}
              totalRows={displayRowsData().rows.length}
              onFiltersChange={setTableFilters}
              placement="above"
            />
            <ColumnVisibilityMenu
              scope={visibilityScope()}
              columns={displayColumns().columns}
            />
          </Show>
        </span>
      </summary>
      {gridContent}
    </details>
  );
}
