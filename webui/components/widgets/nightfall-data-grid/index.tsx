// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import DataGrid, {
  type DataGridMetricSample,
  type DataGridProps,
  type DataGridRichCellExtension,
} from "@stewartadam/nightfall-data-grid";
import "@stewartadam/nightfall-data-grid/styles.css";
import { createMemo, type JSX, splitProps } from "solid-js";
import { recordExternalPerformanceMeasure } from "../../../lib/performance-measure-collector";
import { EmptyState } from "../../ui/empty-state";
import { prelineDropdownCellExtension } from "./preline-dropdown-cell";

export * from "@stewartadam/nightfall-data-grid";

/** Prefix of the metrics table rows Nightfall grids report into. */
const METRIC_PREFIX = "nightfall:data-grid.";

export interface NightfallDataGridProps
  extends Omit<DataGridProps, "onMetric" | "empty" | "placeholder"> {
  /**
   * Names the grid in the app's metrics table, such as `fixtures.<panelId>`.
   * Grids without a scope report no metrics.
   */
  performanceScope?: string;
  /** Message shown in the app's inline empty-state style when loaded data has no rows. */
  empty?: JSX.Element;
  /** Message shown with a loading spinner while `loading` and there are no rows yet; defaults to "Loading…". */
  placeholder?: JSX.Element;
}

/**
 * Nightfall's data grid: the generic grid with the app's defaults applied.
 * It reports metrics into the app's metrics table under `performanceScope`,
 * renders `empty` and `placeholder` as the app's inline empty states, and
 * edits dropdown cells with the app's Preline select. Extensions the caller
 * registers take precedence over the Preline dropdown.
 */
export default function NightfallDataGrid(props: NightfallDataGridProps) {
  const [local, rest] = splitProps(props, [
    "performanceScope",
    "empty",
    "placeholder",
    "richCellExtensions",
  ]);
  const scope = local.performanceScope?.trim();

  /** Records one grid metric sample under this grid's scope in the app's metrics table. */
  const onMetric = scope
    ? (sample: DataGridMetricSample) =>
        recordExternalPerformanceMeasure(
          `${METRIC_PREFIX}${scope}.${sample.metric}`,
          sample.value,
          sample.unit,
        )
    : undefined;

  /** Caller extensions first so they win, then the app's Preline dropdown. */
  const richCellExtensions = createMemo(
    (): readonly DataGridRichCellExtension[] => [
      ...(local.richCellExtensions ?? []),
      prelineDropdownCellExtension,
    ],
  );

  /** The app's inline empty state around `empty`, built once per message. */
  const empty = createMemo(() =>
    local.empty === undefined ? undefined : (
      <EmptyState variant="inline" class="h-full" title={local.empty} />
    ),
  );

  /**
   * The app's inline loading state, shown while `loading` with no rows. It uses
   * `placeholder` as its message and falls back to "Loading…". The grid already
   * marks its no-rows content as a status region, so the inner one is dropped.
   */
  const placeholder = (
    <EmptyState
      variant="inline"
      class="h-full"
      role="none"
      title={local.placeholder}
      loading
    />
  );

  return (
    <DataGrid
      {...rest}
      onMetric={onMetric}
      richCellExtensions={richCellExtensions()}
      empty={empty()}
      placeholder={placeholder}
    />
  );
}
