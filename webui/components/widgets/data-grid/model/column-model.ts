// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  Cell,
  Column,
  ColumnDef,
  Header,
  HeaderGroup,
  Row,
  Table,
} from "@tanstack/solid-table";
import type { GridColumn } from "../../../../lib/data-grid-types";
import type { DataGridTableFeatures } from "./table-features";
import type { TableRow } from "./types";

export type DataGridColumnDef = ColumnDef<DataGridTableFeatures, TableRow>;
export type DataGridTable = Table<DataGridTableFeatures, TableRow>;
export type DataGridTableColumn = Column<DataGridTableFeatures, TableRow>;
export type DataGridTableHeader = Header<DataGridTableFeatures, TableRow>;
export type DataGridTableHeaderGroup = HeaderGroup<
  DataGridTableFeatures,
  TableRow
>;
export type DataGridTableRow = Row<DataGridTableFeatures, TableRow>;
export type DataGridTableCell = Cell<DataGridTableFeatures, TableRow>;

type GroupColumnDef = DataGridColumnDef & { columns: DataGridColumnDef[] };

type GroupableGridColumn = GridColumn & {
  visibilityCategory?: string;
  visibilityGroup?: string;
  visibilityGroupLabel?: string;
};

/** Builds the stable table column id used by TanStack and DOM test hooks. */
export function columnId(column: GridColumn): string {
  return String(column.id ?? column.title);
}

/** Resolves a column width, falling back to the grid default when unset or temporarily unavailable. */
export function columnWidth(column: GridColumn | undefined): number {
  return column && "width" in column && typeof column.width === "number"
    ? column.width
    : 120;
}

/** Resolves the nested attribute label represented by a source grid column. */
function attributeGroupFor(column: GroupableGridColumn): string | undefined {
  return column.visibilityGroupLabel ?? column.visibilityGroup ?? column.group;
}

/** Creates a uniquely identified group for one adjacent source-column run. */
function createGroup(
  groupOccurrences: Map<string, number>,
  baseId: string,
  label: string,
): GroupColumnDef {
  const occurrence = (groupOccurrences.get(baseId) ?? 0) + 1;
  groupOccurrences.set(baseId, occurrence);
  return {
    id: occurrence === 1 ? baseId : `${baseId}:run:${occurrence}`,
    header: label,
    meta: { label },
    columns: [],
  };
}

/** Returns whether the nested hierarchy needs a separate attribute-group level. */
function hasMultiColumnAttributeGroup(columns: readonly GridColumn[]): boolean {
  const counts = new Map<string, number>();
  for (const sourceColumn of columns) {
    const column = sourceColumn as GroupableGridColumn;
    const category =
      column.visibilityCategory !== "Identity"
        ? column.visibilityCategory
        : undefined;
    const attributeGroup = attributeGroupFor(column);
    if (!category || !attributeGroup) continue;
    const key = `${category}\u0000${attributeGroup}`;
    const count = (counts.get(key) ?? 0) + 1;
    if (count > 1) return true;
    counts.set(key, count);
  }
  return false;
}

/** Converts grid columns into the authoritative TanStack column-definition hierarchy. */
export function groupColumns(
  columns: readonly GridColumn[],
  nestedColumnGroups: boolean,
): DataGridColumnDef[] {
  const result: DataGridColumnDef[] = [];
  const groupOccurrences = new Map<string, number>();
  const preserveAttributeLevel =
    nestedColumnGroups && hasMultiColumnAttributeGroup(columns);
  let activeRootGroupId: string | undefined;
  let activeRootGroup: GroupColumnDef | undefined;
  let activeNestedGroupId: string | undefined;
  let activeNestedGroup: GroupColumnDef | undefined;

  /** Clears adjacent-run state after emitting an ungrouped leaf. */
  const clearActiveGroups = () => {
    activeRootGroupId = undefined;
    activeRootGroup = undefined;
    activeNestedGroupId = undefined;
    activeNestedGroup = undefined;
  };

  for (const sourceColumn of columns) {
    const column = sourceColumn as GroupableGridColumn;
    const category =
      nestedColumnGroups && column.visibilityCategory !== "Identity"
        ? column.visibilityCategory
        : undefined;
    const attributeGroup = attributeGroupFor(column);
    const label =
      category && attributeGroup && !preserveAttributeLevel
        ? attributeGroup
        : column.title;
    const def: DataGridColumnDef = {
      id: columnId(column),
      header: label,
      size: columnWidth(column),
      ...(column.minWidth === undefined ? {} : { minSize: column.minWidth }),
      ...(column.maxWidth === undefined ? {} : { maxSize: column.maxWidth }),
      meta: { gridColumn: column, label },
      cell: (context) => context.row.original.rowIndex,
    };

    if (category) {
      const categoryGroupId = `category:${category}`;
      if (activeRootGroupId !== categoryGroupId || !activeRootGroup) {
        activeRootGroupId = categoryGroupId;
        activeRootGroup = createGroup(
          groupOccurrences,
          categoryGroupId,
          category,
        );
        result.push(activeRootGroup);
        activeNestedGroupId = undefined;
        activeNestedGroup = undefined;
      }

      if (!attributeGroup || !preserveAttributeLevel) {
        activeRootGroup.columns.push(def);
        activeNestedGroupId = undefined;
        activeNestedGroup = undefined;
        continue;
      }

      const nestedId = `category:${category}:group:${attributeGroup}`;
      if (activeNestedGroupId !== nestedId || !activeNestedGroup) {
        activeNestedGroupId = nestedId;
        activeNestedGroup = createGroup(
          groupOccurrences,
          nestedId,
          attributeGroup,
        );
        activeRootGroup.columns.push(activeNestedGroup);
      }
      activeNestedGroup.columns.push(def);
      continue;
    }

    if (!column.group) {
      result.push(def);
      clearActiveGroups();
      continue;
    }

    const groupId = `group:${column.group}`;
    if (activeRootGroupId !== groupId || !activeRootGroup) {
      activeRootGroupId = groupId;
      activeRootGroup = createGroup(groupOccurrences, groupId, column.group);
      result.push(activeRootGroup);
    }
    activeRootGroup.columns.push(def);
    activeNestedGroupId = undefined;
    activeNestedGroup = undefined;
  }

  return result;
}

/** Resolves the source grid column stored on a TanStack leaf column. */
export function sourceGridColumn(
  column: DataGridTableColumn | undefined,
): GridColumn | undefined {
  return column?.columnDef.meta?.gridColumn;
}
