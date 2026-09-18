// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import PanelToolbar from "../../../components/ui/panel-toolbar";
import { ToggleSwitch } from "../../../components/ui/toggle-switch";
import ColumnVisibilityMenu from "../../../components/widgets/data-grid/extensions/column-visibility-menu";
import DataGridFilterMenu from "../../../components/widgets/data-grid/extensions/data-grid-filter-menu";
import type { GridColumn } from "../../../lib/data-grid-types";
import type {
  DataGridFilterColumn,
  TableFilterSettings,
} from "../../../lib/datagrid-filtering";
import type { FixtureDisplayRow } from "../model/fixtures-grid-model";

export type FixturesToolbarProps = {
  panelId: string;
  showOnlyWithAttributes: boolean;
  showReleasedOutput: boolean;
  filterColumns: DataGridFilterColumn<FixtureDisplayRow>[];
  filters: TableFilterSettings;
  visibleRows: number;
  totalRows: number;
  columns: GridColumn[];
  setShowOnlyWithAttributes: (enabled: boolean) => void;
  setShowReleasedOutput: (enabled: boolean) => void;
  setFilters: (filters: TableFilterSettings) => void;
};

/** Renders fixture display controls and shared grid filter menus. */
export function FixturesToolbar(props: FixturesToolbarProps) {
  return (
    <PanelToolbar
      rightClass="gap-1"
      right={
        <>
          <ToggleSwitch
            label="Hide default"
            ariaLabel="Hide default values"
            checked={props.showOnlyWithAttributes}
            onChange={props.setShowOnlyWithAttributes}
          />
          <ToggleSwitch
            label="Show DMX"
            ariaLabel="Show DMX"
            checked={props.showReleasedOutput}
            onChange={props.setShowReleasedOutput}
          />
          <div class="mx-1 h-6 w-px bg-neutral-700" aria-hidden="true" />
          <DataGridFilterMenu
            columns={props.filterColumns}
            filters={props.filters}
            visibleRows={props.visibleRows}
            totalRows={props.totalRows}
            onFiltersChange={props.setFilters}
          />
          <ColumnVisibilityMenu scope={props.panelId} columns={props.columns} />
        </>
      }
    />
  );
}
