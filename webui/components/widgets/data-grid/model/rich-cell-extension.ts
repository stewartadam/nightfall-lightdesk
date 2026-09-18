// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GridCell } from "../../../../lib/data-grid-types";
import type { DataGridRichCellExtension } from "./types";

/** Finds the first registered rich-cell extension that accepts a cell. */
export function findRichCellExtension(
  extensions: readonly DataGridRichCellExtension[] | undefined,
  cell: GridCell,
): DataGridRichCellExtension | undefined {
  return extensions?.find((extension) => extension.matches(cell));
}

/** Returns the matching extension only when it permits editing the cell. */
export function editableRichCellExtension(
  extensions: readonly DataGridRichCellExtension[] | undefined,
  cell: GridCell,
): DataGridRichCellExtension | undefined {
  const extension = findRichCellExtension(extensions, cell);
  return !cell.readonly && extension?.isEditable(cell) ? extension : undefined;
}
