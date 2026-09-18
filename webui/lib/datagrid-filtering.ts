// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const STORAGE_PREFIX = "table-filters";

export type DataGridFilterKind = "text" | "number" | "boolean" | "enum" | "tag";

export type DataGridFilterOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "starts_with"
  | "is_empty"
  | "is_not_empty"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "has"
  | "not_has"
  | "has_any"
  | "has_all";

export type DataGridFilterValue = string | number | boolean | string[] | null;

interface DataGridFilterOption {
  value: string | number | boolean;
  label: string;
}

export interface DataGridColumnFilterConfig<T> {
  kind?: DataGridFilterKind;
  label?: string;
  value?: (row: T) => unknown;
  searchable?: boolean;
  options?: readonly DataGridFilterOption[];
}

export interface DataGridFilterColumnMeta {
  id: string;
  label: string;
  kind: DataGridFilterKind;
  options?: readonly DataGridFilterOption[];
}

export interface DataGridFilterColumn<T> extends DataGridFilterColumnMeta {
  value: (row: T) => unknown;
  searchable?: boolean;
}

export interface DataGridFilterColumnIdentityCache<T> {
  columns: DataGridFilterColumn<T>[];
  identity: string;
}

export type FilterableGridColumn<
  T,
  TColumn extends {
    id?: string;
    title: string;
    group?: string;
    value?: (row: T) => unknown;
  } = {
    id?: string;
    title: string;
    group?: string;
    value?: (row: T) => unknown;
  },
> = TColumn & {
  filter?: false | DataGridColumnFilterConfig<T>;
};

export interface DataGridFilterRule {
  columnId: string;
  operator: DataGridFilterOperator;
  value?: DataGridFilterValue;
  secondValue?: DataGridFilterValue;
}

export interface TableFilterSettings {
  quickFilter: string;
  rules: DataGridFilterRule[];
}

interface DataGridFilterStorage {
  version: 1;
  tables: Record<string, TableFilterSettings>;
}

export const EMPTY_TABLE_FILTERS: TableFilterSettings = {
  quickFilter: "",
  rules: [],
};

/**
 * Creates a mutable cache used to preserve filter column array identity across equivalent rebuilds.
 */
export function createFilterColumnIdentityCache<
  T,
>(): DataGridFilterColumnIdentityCache<T> {
  return {
    columns: [],
    identity: "",
  };
}

/**
 * Builds a comparable identity key for filter fields without including row value callbacks.
 */
function filterColumnIdentityKey(
  columns: readonly DataGridFilterColumnMeta[],
): string {
  return JSON.stringify(
    columns.map((column) => ({
      id: column.id,
      label: column.label,
      kind: column.kind,
      searchable: "searchable" in column ? column.searchable : undefined,
      options:
        column.options?.map((option) => ({
          value: option.value,
          label: option.label,
        })) ?? [],
    })),
  );
}

/**
 * Reuses the previous filter column array when selectable field metadata is unchanged.
 */
export function stabilizeFilterColumns<T>(
  cache: DataGridFilterColumnIdentityCache<T>,
  nextColumns: DataGridFilterColumn<T>[],
): DataGridFilterColumn<T>[] {
  const nextIdentity = filterColumnIdentityKey(nextColumns);
  if (nextIdentity === cache.identity) {
    return cache.columns;
  }

  cache.columns = nextColumns;
  cache.identity = nextIdentity;
  return nextColumns;
}

function storageKeyFor(scope: string): string {
  return scope.startsWith(`${STORAGE_PREFIX}:`)
    ? scope
    : `${STORAGE_PREFIX}:${scope}`;
}

/**
 * Derives filter definitions from grid column metadata.
 */
export function filterColumnsFromMetadata<
  T,
  TColumn extends {
    id?: string;
    title: string;
    group?: string;
    value?: (row: T) => unknown;
  } = {
    id?: string;
    title: string;
    group?: string;
    value?: (row: T) => unknown;
  },
>(
  columns: readonly FilterableGridColumn<T, TColumn>[],
): DataGridFilterColumn<T>[] {
  return columns.flatMap((column) => {
    if (column.filter === false || !column.id) return [];
    const filterConfig =
      typeof column.filter === "object" ? column.filter : undefined;
    const value = filterConfig?.value ?? column.value;
    if (!value) return [];

    const fallbackLabel =
      column.title.trim().length > 0
        ? column.title
        : (column.group ?? column.id);

    return [
      {
        id: column.id,
        label: filterConfig?.label ?? fallbackLabel,
        kind: filterConfig?.kind ?? "text",
        value,
        searchable: filterConfig?.searchable,
        options: filterConfig?.options,
      },
    ];
  });
}

function defaultStorage(): DataGridFilterStorage {
  return {
    version: 1,
    tables: {},
  };
}

function cloneFilters(settings: TableFilterSettings): TableFilterSettings {
  return {
    quickFilter: settings.quickFilter,
    rules: settings.rules.map((rule) => ({ ...rule })),
  };
}

function isFilterValue(value: unknown): value is DataGridFilterValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function sanitizeRule(rule: unknown): DataGridFilterRule | null {
  if (!rule || typeof rule !== "object") return null;
  const candidate = rule as Partial<DataGridFilterRule>;
  if (typeof candidate.columnId !== "string") return null;
  if (typeof candidate.operator !== "string") return null;

  return {
    columnId: candidate.columnId,
    operator: candidate.operator as DataGridFilterOperator,
    ...(isFilterValue(candidate.value) ? { value: candidate.value } : {}),
    ...(isFilterValue(candidate.secondValue)
      ? { secondValue: candidate.secondValue }
      : {}),
  };
}

function sanitizeFilters(settings: unknown): TableFilterSettings {
  if (!settings || typeof settings !== "object") {
    return cloneFilters(EMPTY_TABLE_FILTERS);
  }

  const candidate = settings as Partial<TableFilterSettings>;
  return {
    quickFilter:
      typeof candidate.quickFilter === "string" ? candidate.quickFilter : "",
    rules: Array.isArray(candidate.rules)
      ? candidate.rules.flatMap((rule) => {
          const sanitized = sanitizeRule(rule);
          return sanitized ? [sanitized] : [];
        })
      : [],
  };
}

function loadAllSettings(): DataGridFilterStorage {
  if (typeof localStorage === "undefined") return defaultStorage();

  try {
    const raw = localStorage.getItem(STORAGE_PREFIX);
    if (!raw) return defaultStorage();
    const parsed = JSON.parse(raw) as Partial<DataGridFilterStorage>;
    if (parsed.version !== 1 || typeof parsed.tables !== "object") {
      return defaultStorage();
    }

    const tables: Record<string, TableFilterSettings> = {};
    for (const [scope, filters] of Object.entries(parsed.tables ?? {})) {
      tables[scope] = sanitizeFilters(filters);
    }

    return {
      version: 1,
      tables,
    };
  } catch {
    return defaultStorage();
  }
}

function saveAllSettings(settings: DataGridFilterStorage): void {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(STORAGE_PREFIX, JSON.stringify(settings));
  } catch {
    // localStorage can be unavailable or full; table filters are best effort.
  }
}

export function loadTableFilters(scope: string): TableFilterSettings {
  const settings = loadAllSettings();
  return cloneFilters(
    settings.tables[storageKeyFor(scope)] ?? EMPTY_TABLE_FILTERS,
  );
}

export function saveTableFilters(
  scope: string,
  filters: TableFilterSettings,
): void {
  const settings = loadAllSettings();
  settings.tables[storageKeyFor(scope)] = sanitizeFilters(filters);
  saveAllSettings(settings);
}

export function resetTableFilters(scope: string): void {
  const settings = loadAllSettings();
  delete settings.tables[storageKeyFor(scope)];
  saveAllSettings(settings);
}

function normalizeFilterText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFilterText(entry)).join(" ");
  }
  if (typeof value === "object") return "";
  return String(value);
}

function normalizeFilterValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeFilterText(entry).trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  }
  const text = normalizeFilterText(value).trim().toLowerCase();
  return text.length > 0 ? [text] : [];
}

function quickFilterTerms(filter: string): string[] {
  return filter
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

export function rowMatchesQuickFilter<T>(
  row: T,
  columns: readonly DataGridFilterColumn<T>[],
  quickFilter: string,
): boolean {
  const terms = quickFilterTerms(quickFilter);
  if (terms.length === 0) return true;

  const searchableText = columns
    .filter((column) => column.searchable !== false)
    .map((column) => normalizeFilterText(column.value(row)).toLowerCase())
    .join(" ");

  return terms.every((term) => searchableText.includes(term));
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function toComparableNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareText(
  value: unknown,
  operator: DataGridFilterOperator,
  expected: DataGridFilterValue | undefined,
): boolean {
  const actualText = normalizeFilterText(value).toLowerCase();
  const expectedText = normalizeFilterText(expected).toLowerCase();

  switch (operator) {
    case "contains":
      return actualText.includes(expectedText);
    case "not_contains":
      return !actualText.includes(expectedText);
    case "equals":
      return actualText === expectedText;
    case "not_equals":
      return actualText !== expectedText;
    case "starts_with":
      return actualText.startsWith(expectedText);
    case "is_empty":
      return isEmptyValue(value);
    case "is_not_empty":
      return !isEmptyValue(value);
    default:
      return true;
  }
}

function compareTags(
  value: unknown,
  operator: DataGridFilterOperator,
  expected: DataGridFilterValue | undefined,
): boolean {
  if (operator === "is_empty") return isEmptyValue(value);
  if (operator === "is_not_empty") return !isEmptyValue(value);

  const actualTags = normalizeFilterValues(value);
  const expectedTags = normalizeFilterValues(expected);
  if (expectedTags.length === 0) return true;

  switch (operator) {
    case "has":
      return actualTags.includes(expectedTags[0]);
    case "not_has":
      return !actualTags.includes(expectedTags[0]);
    case "has_any":
      return expectedTags.some((tag) => actualTags.includes(tag));
    case "has_all":
      return expectedTags.every((tag) => actualTags.includes(tag));
    default:
      return compareText(value, operator, expected);
  }
}

function compareNumber(
  value: unknown,
  operator: DataGridFilterOperator,
  expected: DataGridFilterValue | undefined,
  secondExpected: DataGridFilterValue | undefined,
): boolean {
  if (operator === "is_empty") return isEmptyValue(value);
  if (operator === "is_not_empty") return !isEmptyValue(value);

  const actual = toComparableNumber(value);
  const expectedNumber = toComparableNumber(expected);
  if (actual === null || expectedNumber === null) return false;

  switch (operator) {
    case "equals":
      return actual === expectedNumber;
    case "not_equals":
      return actual !== expectedNumber;
    case "lt":
      return actual < expectedNumber;
    case "lte":
      return actual <= expectedNumber;
    case "gt":
      return actual > expectedNumber;
    case "gte":
      return actual >= expectedNumber;
    case "between": {
      const secondNumber = toComparableNumber(secondExpected);
      if (secondNumber === null) return false;
      const min = Math.min(expectedNumber, secondNumber);
      const max = Math.max(expectedNumber, secondNumber);
      return actual >= min && actual <= max;
    }
    default:
      return true;
  }
}

function rowMatchesRule<T>(
  row: T,
  columnsById: ReadonlyMap<string, DataGridFilterColumn<T>>,
  rule: DataGridFilterRule,
): boolean {
  const column = columnsById.get(rule.columnId);
  if (!column) return true;

  const value = column.value(row);
  if (column.kind === "number") {
    return compareNumber(value, rule.operator, rule.value, rule.secondValue);
  }
  if (column.kind === "boolean") {
    if (rule.operator === "is_empty") return isEmptyValue(value);
    if (rule.operator === "is_not_empty") return !isEmptyValue(value);
    return Boolean(value) === Boolean(rule.value);
  }
  if (column.kind === "tag") {
    return compareTags(value, rule.operator, rule.value);
  }

  return compareText(value, rule.operator, rule.value);
}

export function applyTableFilters<T>(
  rows: readonly T[],
  columns: readonly DataGridFilterColumn<T>[],
  filters: TableFilterSettings,
): T[] {
  const columnsById = new Map(columns.map((column) => [column.id, column]));

  return rows.filter(
    (row) =>
      rowMatchesQuickFilter(row, columns, filters.quickFilter) &&
      filters.rules.every((rule) => rowMatchesRule(row, columnsById, rule)),
  );
}

export function getActiveTableFilterCount(
  filters: TableFilterSettings,
): number {
  const quickFilterCount = filters.quickFilter.trim().length > 0 ? 1 : 0;
  return quickFilterCount + filters.rules.length;
}

export function hasActiveTableFilters(filters: TableFilterSettings): boolean {
  return getActiveTableFilterCount(filters) > 0;
}
