// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTableFilters,
  createFilterColumnIdentityCache,
  type DataGridFilterColumn,
  filterColumnsFromMetadata,
  getActiveTableFilterCount,
  loadTableFilters,
  resetTableFilters,
  rowMatchesQuickFilter,
  saveTableFilters,
  stabilizeFilterColumns,
} from "./datagrid-filtering";

interface TestRow {
  id: number;
  label: string;
  kind: string;
  tags: string[];
  universe?: number;
  active: boolean;
}

class LocalStorageMock {
  private readonly values = new Map<string, string>();

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const rows: TestRow[] = [
  {
    id: 1,
    label: "Front Wash",
    kind: "Dimmer",
    tags: ["front", "wash"],
    universe: 1,
    active: true,
  },
  {
    id: 2,
    label: "Robe Spot",
    kind: "Moving Head",
    tags: ["moving", "spot"],
    universe: 2,
    active: false,
  },
  {
    id: 3,
    label: "Blue Backlight",
    kind: "LED",
    tags: ["back", "color"],
    active: true,
  },
];

const columns: DataGridFilterColumn<TestRow>[] = [
  { id: "label", label: "Label", kind: "text", value: (row) => row.label },
  { id: "kind", label: "Kind", kind: "enum", value: (row) => row.kind },
  {
    id: "universe",
    label: "Universe",
    kind: "number",
    value: (row) => row.universe,
  },
  {
    id: "active",
    label: "Active",
    kind: "boolean",
    value: (row) => row.active,
  },
  { id: "tags", label: "Tags", kind: "tag", value: (row) => row.tags },
];

/**
 * Runs a test callback with a temporary localStorage implementation.
 */
function withLocalStorage(callback: (storage: LocalStorageMock) => void) {
  const originalLocalStorage = globalThis.localStorage;
  const localStorageMock = new LocalStorageMock();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });

  try {
    callback(localStorageMock);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  }
}

test("quick filter is case-insensitive and requires every term", () => {
  assert.equal(rowMatchesQuickFilter(rows[1], columns, "robe spot"), true);
  assert.equal(rowMatchesQuickFilter(rows[1], columns, "ROBE dimmer"), false);
});

test("quick filter searches searchable columns only", () => {
  const filteredColumns = columns.map((column) =>
    column.id === "kind" ? { ...column, searchable: false } : column,
  );

  assert.deepEqual(
    applyTableFilters(rows, filteredColumns, {
      quickFilter: "head",
      rules: [],
    }),
    [],
  );
});

test("filter columns can be derived from column metadata", () => {
  const derivedColumns = filterColumnsFromMetadata<TestRow>([
    {
      id: "label",
      title: "Label",
      value: (row) => row.label,
    },
    {
      id: "kind",
      title: "",
      group: "Fixture Kind",
      filter: {
        kind: "enum",
        value: (row) => row.kind,
        options: [{ value: "Dimmer", label: "Dimmer" }],
      },
    },
    {
      id: "hidden",
      title: "Hidden",
      value: () => "hidden",
      filter: false,
    },
  ]);

  assert.deepEqual(
    derivedColumns.map(({ id, label, kind, options }) => ({
      id,
      label,
      kind,
      options,
    })),
    [
      { id: "label", label: "Label", kind: "text", options: undefined },
      {
        id: "kind",
        label: "Fixture Kind",
        kind: "enum",
        options: [{ value: "Dimmer", label: "Dimmer" }],
      },
    ],
  );
  assert.deepEqual(
    applyTableFilters(rows, derivedColumns, {
      quickFilter: "",
      rules: [{ columnId: "kind", operator: "equals", value: "Dimmer" }],
    }).map((row) => row.id),
    [1],
  );
});

test("equivalent filter column metadata reuses the previous column array", () => {
  const cache = createFilterColumnIdentityCache<TestRow>();
  const firstColumns: DataGridFilterColumn<TestRow>[] = [
    { id: "label", label: "Label", kind: "text", value: (row) => row.label },
  ];
  const secondColumns: DataGridFilterColumn<TestRow>[] = [
    {
      id: "label",
      label: "Label",
      kind: "text",
      value: (row) => row.label.toUpperCase(),
    },
  ];

  const firstStableColumns = stabilizeFilterColumns(cache, firstColumns);
  const secondStableColumns = stabilizeFilterColumns(cache, secondColumns);

  assert.equal(firstStableColumns, firstColumns);
  assert.equal(secondStableColumns, firstColumns);
});

test("changed filter column metadata replaces the cached column array", () => {
  const cache = createFilterColumnIdentityCache<TestRow>();
  const firstColumns: DataGridFilterColumn<TestRow>[] = [
    { id: "label", label: "Label", kind: "text", value: (row) => row.label },
  ];
  const secondColumns: DataGridFilterColumn<TestRow>[] = [
    { id: "kind", label: "Kind", kind: "enum", value: (row) => row.kind },
  ];

  stabilizeFilterColumns(cache, firstColumns);
  const secondStableColumns = stabilizeFilterColumns(cache, secondColumns);

  assert.equal(secondStableColumns, secondColumns);
});

test("text and enum filter rules match rows", () => {
  assert.deepEqual(
    applyTableFilters(rows, columns, {
      quickFilter: "",
      rules: [
        {
          columnId: "kind",
          operator: "contains",
          value: "head",
        },
      ],
    }).map((row) => row.id),
    [2],
  );
});

test("number filter rules support ranges and empty values", () => {
  assert.deepEqual(
    applyTableFilters(rows, columns, {
      quickFilter: "",
      rules: [
        {
          columnId: "universe",
          operator: "between",
          value: 1,
          secondValue: 2,
        },
      ],
    }).map((row) => row.id),
    [1, 2],
  );

  assert.deepEqual(
    applyTableFilters(rows, columns, {
      quickFilter: "",
      rules: [{ columnId: "universe", operator: "is_empty" }],
    }).map((row) => row.id),
    [3],
  );
});

test("boolean filter rules match boolean values", () => {
  assert.deepEqual(
    applyTableFilters(rows, columns, {
      quickFilter: "",
      rules: [{ columnId: "active", operator: "equals", value: false }],
    }).map((row) => row.id),
    [2],
  );
});

test("tag filter rules support single, any, and all matches", () => {
  assert.deepEqual(
    applyTableFilters(rows, columns, {
      quickFilter: "",
      rules: [{ columnId: "tags", operator: "has", value: "spot" }],
    }).map((row) => row.id),
    [2],
  );

  assert.deepEqual(
    applyTableFilters(rows, columns, {
      quickFilter: "",
      rules: [
        { columnId: "tags", operator: "has_any", value: ["wash", "color"] },
      ],
    }).map((row) => row.id),
    [1, 3],
  );

  assert.deepEqual(
    applyTableFilters(rows, columns, {
      quickFilter: "",
      rules: [
        { columnId: "tags", operator: "has_all", value: ["front", "wash"] },
      ],
    }).map((row) => row.id),
    [1],
  );
});

test("filters persist per scope and reset independently", () => {
  withLocalStorage(() => {
    saveTableFilters("fixtures", {
      quickFilter: "robe",
      rules: [
        { columnId: "active", operator: "equals", value: true },
        { columnId: "tags", operator: "has_any", value: ["moving", "spot"] },
      ],
    });
    saveTableFilters("objects", {
      quickFilter: "truss",
      rules: [],
    });

    assert.deepEqual(loadTableFilters("fixtures"), {
      quickFilter: "robe",
      rules: [
        { columnId: "active", operator: "equals", value: true },
        { columnId: "tags", operator: "has_any", value: ["moving", "spot"] },
      ],
    });

    resetTableFilters("fixtures");

    assert.deepEqual(loadTableFilters("fixtures"), {
      quickFilter: "",
      rules: [],
    });
    assert.equal(loadTableFilters("objects").quickFilter, "truss");
  });
});

test("corrupt storage falls back to empty filters", () => {
  withLocalStorage((storage) => {
    storage.setItem("table-filters", "{");

    assert.deepEqual(loadTableFilters("fixtures"), {
      quickFilter: "",
      rules: [],
    });
  });
});

test("active filter count includes quick filter and rules", () => {
  assert.equal(
    getActiveTableFilterCount({
      quickFilter: "robe",
      rules: [{ columnId: "active", operator: "equals", value: true }],
    }),
    2,
  );
});
