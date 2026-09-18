// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { getAttributeMetadata } from "./attribute-metadata";
import { bestEffortPersistentAtom } from "./best-effort-persistent-atom";
import type { GridColumn } from "./data-grid-types";
import { normalizeAttributeName } from "./utils";

const STORAGE_PREFIX = "columns-config";

export type DataGridColumnVisibilityCategory =
  | "Identity"
  | "Dimmer"
  | "Position"
  | "Color"
  | "Gobo"
  | "Beam"
  | "Focus"
  | "Control"
  | "Other"
  | "Placement"
  | "Rotation"
  | "Binding"
  | "Metadata";

export type VisibilityCheckState = "empty" | "activated" | "dash";

export interface DataGridColumnVisibilityMeta {
  hideable?: boolean;
  defaultVisible?: boolean;
  visibilityCategory?: DataGridColumnVisibilityCategory;
  visibilityLabel?: string;
  visibilityGroup?: string;
  visibilityGroupLabel?: string;
}

export type VisibilityGridColumn = GridColumn & DataGridColumnVisibilityMeta;

interface TableColumnVisibilitySettings {
  categoryDefaults: Record<string, boolean>;
  columnOverrides: Record<string, boolean>;
}

interface DataGridVisibilitySettings {
  version: 1;
  tables: Record<string, TableColumnVisibilitySettings>;
}

interface ColumnVisibilityMenuColumn {
  id: string;
  label: string;
  visible: boolean;
}

interface ColumnVisibilityMenuGroup {
  id: string;
  label: string;
  columns: ColumnVisibilityMenuColumn[];
}

export interface ColumnVisibilityMenuCategory {
  id: DataGridColumnVisibilityCategory;
  label: string;
  state: VisibilityCheckState;
  groups: ColumnVisibilityMenuGroup[];
}

const EMPTY_TABLE_SETTINGS: TableColumnVisibilitySettings = {
  categoryDefaults: {},
  columnOverrides: {},
};

const [columnVisibilitySettingsRevision, setColumnVisibilitySettingsRevision] =
  createSignal(0);

const CATEGORY_ORDER: DataGridColumnVisibilityCategory[] = [
  "Identity",
  "Dimmer",
  "Color",
  "Position",
  "Gobo",
  "Beam",
  "Focus",
  "Control",
  "Placement",
  "Rotation",
  "Binding",
  "Metadata",
  "Other",
];

function storageKeyFor(scope: string): string {
  return scope.startsWith(`${STORAGE_PREFIX}:`)
    ? scope
    : `${STORAGE_PREFIX}:${scope}`;
}

function defaultSettings(): DataGridVisibilitySettings {
  return {
    version: 1,
    tables: {},
  };
}

/**
 * Drops invalid persisted column visibility values while preserving valid table entries.
 */
function sanitizeTableSettings(
  settings: unknown,
): TableColumnVisibilitySettings {
  if (settings === null || typeof settings !== "object") {
    return cloneTableSettings(EMPTY_TABLE_SETTINGS);
  }

  const candidate = settings as Partial<TableColumnVisibilitySettings>;
  const categoryDefaults: Record<string, boolean> = {};
  if (
    candidate.categoryDefaults !== null &&
    typeof candidate.categoryDefaults === "object"
  ) {
    for (const [category, visible] of Object.entries(
      candidate.categoryDefaults,
    )) {
      if (typeof visible === "boolean") {
        categoryDefaults[category] = visible;
      }
    }
  }

  const columnOverrides: Record<string, boolean> = {};
  if (
    candidate.columnOverrides !== null &&
    typeof candidate.columnOverrides === "object"
  ) {
    for (const [columnId, visible] of Object.entries(
      candidate.columnOverrides,
    )) {
      if (typeof visible === "boolean") {
        columnOverrides[columnId] = visible;
      }
    }
  }

  return {
    categoryDefaults,
    columnOverrides,
  };
}

/**
 * Merges persisted column visibility settings with current defaults.
 */
function sanitizeVisibilitySettings(
  value: unknown,
): DataGridVisibilitySettings {
  if (value === null || typeof value !== "object") {
    return defaultSettings();
  }

  const parsed = value as Partial<DataGridVisibilitySettings>;
  if (parsed.version !== 1 || typeof parsed.tables !== "object") {
    return defaultSettings();
  }

  const tables: Record<string, TableColumnVisibilitySettings> = {};
  for (const [scope, settings] of Object.entries(parsed.tables ?? {})) {
    tables[scope] = sanitizeTableSettings(settings);
  }

  return {
    version: 1,
    tables,
  };
}

/**
 * Decodes persisted column visibility settings from localStorage.
 */
function decodeVisibilitySettings(value: string): DataGridVisibilitySettings {
  try {
    return sanitizeVisibilitySettings(JSON.parse(value));
  } catch {
    return defaultSettings();
  }
}

const columnVisibilitySettings =
  bestEffortPersistentAtom<DataGridVisibilitySettings>(
    STORAGE_PREFIX,
    defaultSettings(),
    {
      decode: decodeVisibilitySettings,
      encode: JSON.stringify,
    },
  );

/**
 * Reads the full persisted column visibility settings object.
 */
function loadAllSettings(): DataGridVisibilitySettings {
  const settings = columnVisibilitySettings.get();
  return {
    version: 1,
    tables: Object.fromEntries(
      Object.entries(settings.tables).map(([scope, tableSettings]) => [
        scope,
        cloneTableSettings(tableSettings),
      ]),
    ),
  };
}

/**
 * Persists the full column visibility settings object.
 */
function saveAllSettings(settings: DataGridVisibilitySettings): void {
  columnVisibilitySettings.set(sanitizeVisibilitySettings(settings));
}

function cloneTableSettings(
  settings: TableColumnVisibilitySettings,
): TableColumnVisibilitySettings {
  return {
    categoryDefaults: { ...settings.categoryDefaults },
    columnOverrides: { ...settings.columnOverrides },
  };
}

function getColumnId(column: GridColumn): string | null {
  if (column.id === undefined || column.id === null) return null;
  return String(column.id);
}

function getColumnCategory(
  column: VisibilityGridColumn,
): DataGridColumnVisibilityCategory {
  return column.visibilityCategory ?? "Other";
}

function getColumnLabel(column: VisibilityGridColumn): string {
  return column.visibilityLabel ?? String(column.title ?? column.id ?? "");
}

function categoryOrder(category: DataGridColumnVisibilityCategory): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function sortCategories(
  categories: ColumnVisibilityMenuCategory[],
): ColumnVisibilityMenuCategory[] {
  return categories.sort((left, right) => {
    const order = categoryOrder(left.id) - categoryOrder(right.id);
    return order !== 0 ? order : left.label.localeCompare(right.label);
  });
}

function sortGroups(
  groups: ColumnVisibilityMenuGroup[],
): ColumnVisibilityMenuGroup[] {
  return groups.sort((left, right) => left.label.localeCompare(right.label));
}

function getAttributeVisibilityCategory(
  attribute: string,
): DataGridColumnVisibilityCategory {
  const normalized = normalizeAttributeName(attribute);
  return (
    getAttributeMetadata(attribute)?.category ??
    getAttributeMetadata(normalized)?.category ??
    "Other"
  );
}

export function attributeColumnVisibilityMeta(
  attribute: string,
  label: string,
): DataGridColumnVisibilityMeta {
  const normalizedAttribute = normalizeAttributeName(attribute);
  return {
    hideable: true,
    visibilityCategory: getAttributeVisibilityCategory(normalizedAttribute),
    visibilityGroup: normalizedAttribute,
    visibilityGroupLabel: normalizedAttribute,
    visibilityLabel: label,
  };
}

export function columnVisibilityMeta(
  category: DataGridColumnVisibilityCategory,
  label?: string,
): DataGridColumnVisibilityMeta {
  return {
    hideable: true,
    visibilityCategory: category,
    visibilityLabel: label,
  };
}

export function alwaysVisibleColumnMeta(
  category: DataGridColumnVisibilityCategory = "Identity",
  label?: string,
): DataGridColumnVisibilityMeta {
  return {
    hideable: false,
    visibilityCategory: category,
    visibilityLabel: label,
  };
}

function loadTableColumnVisibility(
  scope: string,
): TableColumnVisibilitySettings {
  columnVisibilitySettingsRevision();
  const settings = loadAllSettings();
  return settings.tables[storageKeyFor(scope)] ?? EMPTY_TABLE_SETTINGS;
}

function isColumnVisible(
  column: VisibilityGridColumn,
  tableSettings: TableColumnVisibilitySettings,
): boolean {
  if (column.hideable !== true) return true;

  const id = getColumnId(column);
  if (id && tableSettings.columnOverrides[id] !== undefined) {
    return tableSettings.columnOverrides[id];
  }

  const category = getColumnCategory(column);
  const categoryDefault = tableSettings.categoryDefaults[category];
  return categoryDefault ?? column.defaultVisible ?? true;
}

export function filterVisibleColumns<T extends VisibilityGridColumn>(
  columns: readonly T[],
  scope: string,
): T[] {
  const tableSettings = loadTableColumnVisibility(scope);
  return columns.filter((column) => isColumnVisible(column, tableSettings));
}

export function getColumnVisibilityMenuCategories(
  columns: readonly VisibilityGridColumn[],
  scope: string,
): ColumnVisibilityMenuCategory[] {
  const tableSettings = loadTableColumnVisibility(scope);
  const categoryMap = new Map<
    DataGridColumnVisibilityCategory,
    Map<string, ColumnVisibilityMenuGroup>
  >();

  for (const column of columns) {
    if (column.hideable !== true) continue;
    const columnId = getColumnId(column);
    if (!columnId) continue;

    const category = getColumnCategory(column);
    let groups = categoryMap.get(category);
    if (!groups) {
      groups = new Map();
      categoryMap.set(category, groups);
    }

    const groupId = column.visibilityGroup ?? columnId;
    let group = groups.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        label: column.visibilityGroupLabel ?? getColumnLabel(column),
        columns: [],
      };
      groups.set(groupId, group);
    }

    group.columns.push({
      id: columnId,
      label: getColumnLabel(column),
      visible: isColumnVisible(column, tableSettings),
    });
  }

  const categories: ColumnVisibilityMenuCategory[] = [];
  for (const [category, groupMap] of categoryMap.entries()) {
    const groups = sortGroups(Array.from(groupMap.values()));
    const visibleCount = groups.reduce(
      (count, group) =>
        count + group.columns.filter((column) => column.visible).length,
      0,
    );
    const columnCount = groups.reduce(
      (count, group) => count + group.columns.length,
      0,
    );
    const state: VisibilityCheckState =
      visibleCount === 0
        ? "empty"
        : visibleCount === columnCount
          ? "activated"
          : "dash";

    categories.push({
      id: category,
      label: category,
      state,
      groups,
    });
  }

  return sortCategories(categories);
}

function updateTableSettings(
  scope: string,
  update: (settings: TableColumnVisibilitySettings) => void,
): void {
  const allSettings = loadAllSettings();
  const key = storageKeyFor(scope);
  const tableSettings = cloneTableSettings(
    allSettings.tables[key] ?? EMPTY_TABLE_SETTINGS,
  );
  update(tableSettings);
  allSettings.tables[key] = tableSettings;
  saveAllSettings(allSettings);
  setColumnVisibilitySettingsRevision((revision) => revision + 1);
}

export function setColumnVisibility(
  scope: string,
  columnId: string,
  visible: boolean,
): void {
  updateTableSettings(scope, (settings) => {
    settings.columnOverrides[columnId] = visible;
  });
}

export function setCategoryVisibility(
  scope: string,
  columns: readonly VisibilityGridColumn[],
  category: DataGridColumnVisibilityCategory,
  visible: boolean,
): void {
  updateTableSettings(scope, (settings) => {
    settings.categoryDefaults[category] = visible;

    for (const column of columns) {
      if (column.hideable !== true || getColumnCategory(column) !== category) {
        continue;
      }
      const columnId = getColumnId(column);
      if (columnId) {
        delete settings.columnOverrides[columnId];
      }
    }
  });
}

export function resetColumnVisibility(scope: string): void {
  const allSettings = loadAllSettings();
  delete allSettings.tables[storageKeyFor(scope)];
  saveAllSettings(allSettings);
  setColumnVisibilitySettingsRevision((revision) => revision + 1);
}
