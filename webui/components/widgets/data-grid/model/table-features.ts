// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  createSortedRowModel,
  metaHelper,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/solid-table";
import type { JSX } from "solid-js";
import type { GridColumn } from "../../../../lib/data-grid-types";

/** Carries renderer-specific grid metadata on TanStack column definitions. */
export interface DataGridColumnMeta {
  gridColumn?: GridColumn;
  label: JSX.Element;
}

/** Defines the TanStack capabilities used by the data-grid table model. */
export const dataGridTableFeatures = tableFeatures({
  columnMeta: metaHelper<DataGridColumnMeta>(),
  columnSizingFeature,
  columnResizingFeature,
  columnPinningFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

export type DataGridTableFeatures = typeof dataGridTableFeatures;
