// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { LayoutIcon } from "@squidlab/phosphor-solid/layout";
import type { Setter } from "solid-js";
import {
  type ContextMenuEntry,
  openContextMenu,
} from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import type { DataGridScrollRequest } from "../../../components/widgets/data-grid";
import type {
  CellClickedEventArgs,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { CompactSelection } from "../../../lib/data-grid-types";
import { emptyGridSelection } from "../../../lib/datagrid";
import { EMPTY_TABLE_FILTERS } from "../../../lib/datagrid-filtering";
import { dockApi, requestLayerNavigation } from "../../../state/appStores";
import type * as types from "../../../types";
import type {
  FixtureDisplayRow,
  FixtureGridColumn,
} from "../model/fixtures-grid-model";
import {
  findAssertingLayerIndexIn,
  fixtureValueColumnAttribute,
} from "../model/fixtures-grid-model";
import {
  setFixturesShowOnlyWithAttributes,
  toggleFixtureExpanded,
} from "../state/panel-settings";

interface FixturesGridControllerOptions {
  allRows: () => readonly FixtureDisplayRow[];
  rows: () => readonly FixtureDisplayRow[];
  columns: () => readonly FixtureGridColumn[];
  layerStack: () => readonly types.OutboundLayerState[];
  showReleasedOutput: () => boolean;
  setTableFilters: (filters: typeof EMPTY_TABLE_FILTERS) => void;
  setSelection: Setter<GridSelection>;
  setScrollRequest: Setter<DataGridScrollRequest | undefined>;
}

/** Creates fixture-grid reveal, expansion, and asserting-layer navigation behavior. */
export function createFixturesGridController(
  options: FixturesGridControllerOptions,
) {
  const $dockApi = useStore(dockApi);

  /** Handles one-shot palette navigation to a fixture row. */
  useRevealObjectCapability(
    "panel-FixtureGrid",
    (request) => {
      const targetExists = options
        .allRows()
        .some((row) => row.type === "parent" && row.uid === request.uid);
      if (!targetExists) return;

      const rowIndex = options
        .rows()
        .findIndex((row) => row.type === "parent" && row.uid === request.uid);
      if (rowIndex < 0) {
        setFixturesShowOnlyWithAttributes(false);
        options.setTableFilters(EMPTY_TABLE_FILTERS);
        return;
      }

      const nextSelection: GridSelection = {
        ...emptyGridSelection(),
        rows: CompactSelection.fromSingleSelection(rowIndex),
        current: {
          cell: [0, rowIndex] as Item,
          range: { x: 0, y: rowIndex, width: 1, height: 1 },
          rangeStack: [],
        },
      };
      options.setSelection(nextSelection);
      options.setScrollRequest({
        cell: [0, rowIndex] as Item,
        requestId: request.requestId,
      });
    },
    { accepts: (payload) => payload.type === "fixture" },
  );

  /** Finds the layer index used for value-channel navigation. */
  const findAssertingLayerIndex = (
    fixtureUid: string,
    elementIndex: number | undefined,
    attribute: string,
    channelKind: "Value" | "Out",
  ): number | null =>
    findAssertingLayerIndexIn(
      options.layerStack(),
      fixtureUid,
      elementIndex,
      attribute,
      channelKind,
    );

  /** Opens the layer panel or focuses its existing instance. */
  const openOrFocusLayerPanel = () => {
    const api = $dockApi();
    if (!api) return;

    const panel = api.getPanel("panel-LayerStack");
    if (panel) {
      panel.focus();
      return;
    }

    api.addPanel({
      id: "panel-LayerStack",
      component: "LayerStack",
      title: "Layers",
      params: {},
    });
  };

  /** Navigates to the highest layer asserting the fixture value cell. */
  const navigateToAssertingLayerForCell = (
    rowData: FixtureDisplayRow,
    attribute: string,
    channelKind: "Value" | "Out",
  ): boolean => {
    const fixtureUid =
      rowData.type === "parent" ? rowData.uid : rowData.fixtureUid;
    const elementIndex =
      rowData.type === "element" ? rowData.elementIndex : undefined;
    const layerIndex = findAssertingLayerIndex(
      fixtureUid,
      elementIndex,
      attribute,
      channelKind,
    );
    if (layerIndex === null) return false;

    requestLayerNavigation({ layerIndex, fixtureUid, elementIndex });
    openOrFocusLayerPanel();
    return true;
  };

  /** Handles row expansion and asserting-layer modifier clicks. */
  const onCellClicked = (cell: Item, event: CellClickedEventArgs) => {
    const [col, row] = cell;
    const rowData = options.rows()[row];
    if (!rowData) return;
    const modifiers = event as CellClickedEventArgs & {
      altKey?: boolean;
      shiftKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
    };
    const colId = options.columns()[col]?.id;
    const attribute = fixtureValueColumnAttribute(options.columns()[col]);

    if (modifiers.altKey === true && modifiers.shiftKey === true && attribute) {
      const channelKind = options.showReleasedOutput() ? "Out" : "Value";
      if (navigateToAssertingLayerForCell(rowData, attribute, channelKind)) {
        return;
      }
    }

    if (
      modifiers.shiftKey === true ||
      modifiers.ctrlKey === true ||
      modifiers.metaKey === true
    ) {
      return;
    }

    if (colId === "id" && rowData.type === "parent" && rowData.hasElements) {
      toggleFixtureExpanded(rowData.uid);
    }
  };

  /** Opens right-click affordances for asserting-layer navigation. */
  const onCellContextMenu = (cell: Item, event: MouseEvent) => {
    const [col, row] = cell;
    const rowData = options.rows()[row];
    if (!rowData) return;

    const attribute = fixtureValueColumnAttribute(options.columns()[col]);
    if (!attribute) return;

    event.preventDefault();
    const channelKind = options.showReleasedOutput() ? "Out" : "Value";
    const items: ContextMenuEntry[] = [
      {
        id: "show-asserting-layer",
        label: "Show asserting layer",
        icon: LayoutIcon,
        shortcut: "Alt+Shift+Click",
        disabled:
          findAssertingLayerIndex(
            rowData.type === "parent" ? rowData.uid : rowData.fixtureUid,
            rowData.type === "element" ? rowData.elementIndex : undefined,
            attribute,
            channelKind,
          ) === null,
        onSelect: () =>
          navigateToAssertingLayerForCell(rowData, attribute, channelKind),
      },
    ];

    openContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  return { onCellClicked, onCellContextMenu };
}
