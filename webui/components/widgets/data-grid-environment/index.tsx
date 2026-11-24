// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getLogger } from "../../../lib/logger";
import { recordExternalPerformanceMeasure } from "../../../lib/performance-measure-collector";
import { EmptyState } from "../../ui/empty-state";
import { overlayHost } from "../../ui/modal/dialog-stack";
import { PrelineAdvancedSelect } from "../advanced-select/preline-advanced-select";
import {
  configureDataGrid,
  type DataGridDropdownSelectProps,
  type DataGridEmptyStateProps,
  type DataGridPerformanceUnit,
} from "../data-grid/environment";
import "./preline-dropdown-select.css";

/**
 * Logs grid diagnostics under the grid component's own module name, so
 * `nightfallLog.setModuleLevel` filters keep matching the grid.
 */
const log = getLogger(
  new URL("../data-grid/tanstack-data-grid.tsx", import.meta.url).href,
);

/** Metrics-table prefix that groups grid samples under the app's namespace. */
const DATA_GRID_MEASURE_PREFIX = "nightfall:data-grid.";

/** Edits dropdown cells with the app's Preline select, opened as soon as editing starts. */
function PrelineDropdownSelect(props: DataGridDropdownSelectProps) {
  return (
    <PrelineAdvancedSelect
      options={props.options}
      selectedValues={
        props.selectedKey === undefined ? [] : [props.selectedKey]
      }
      onSelectedValuesChange={(selectedKeys) => {
        const selectedKey = selectedKeys[0];
        if (selectedKey === undefined) return;
        props.onSelect(selectedKey);
      }}
      ariaLabel={props.ariaLabel}
      containerClass="h-full w-full"
      selectIdPrefix="dropdown-cell-select"
      variant="grid"
      openOnMount
    />
  );
}

/** Shows a grid's empty message as the app's muted inline empty state. */
function InlineEmptyState(props: DataGridEmptyStateProps) {
  return (
    <EmptyState
      variant="inline"
      role="status"
      class={props.class}
      style={props.style}
      title={props.children}
    />
  );
}

/** Writes one grid diagnostic message at debug level. */
function logGridDebug(message: string) {
  log.debug(message);
}

/** Records a grid metric under the app's data-grid namespace in the metrics table. */
function recordGridMeasure(
  name: string,
  value: number,
  unit?: DataGridPerformanceUnit,
) {
  recordExternalPerformanceMeasure(
    `${DATA_GRID_MEASURE_PREFIX}${name}`,
    value,
    unit,
  );
}

/** Portals grid overlays into the dialog stack's current overlay host, above open modals. */
function gridOverlayMount(): Node {
  return overlayHost();
}

/**
 * Connects data grids to the app's logger, performance metrics, overlay host
 * and design-system components. Every entry point that renders grids calls
 * this once before mounting.
 */
export function installDataGridEnvironment() {
  configureDataGrid({
    logger: { debug: logGridDebug },
    recordPerformanceMeasure: recordGridMeasure,
    overlayMount: gridOverlayMount,
    DropdownSelect: PrelineDropdownSelect,
    EmptyState: InlineEmptyState,
  });
}
