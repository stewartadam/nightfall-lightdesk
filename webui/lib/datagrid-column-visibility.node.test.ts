// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import {
  cleanTestStorage,
  getTestStorage,
  setPersistentEngine,
  useTestStorageEngine,
} from "@nanostores/persistent";
import { AttributeCategory } from "../types";
import { setAttributeMetadata } from "./attribute-metadata";
import type { GridColumn } from "./data-grid-types";
import {
  attributeColumnVisibilityMeta,
  filterVisibleColumns,
  getColumnVisibilityMenuCategories,
  resetColumnVisibility,
  setCategoryVisibility,
  setColumnVisibility,
  type VisibilityGridColumn,
} from "./datagrid-column-visibility";

before(() => {
  useTestStorageEngine();
});

afterEach(() => {
  resetColumnVisibility("fixtures");
  cleanTestStorage();
});

setAttributeMetadata([
  {
    key: "Intensity",
    attribute: { type: "Intensity" },
    label: "Intensity",
    category: AttributeCategory.Dimmer,
    sort_order: 0,
  },
  {
    key: "Red",
    attribute: { type: "Red" },
    label: "Red",
    category: AttributeCategory.Color,
    sort_order: 2,
  },
  {
    key: "Blue",
    attribute: { type: "Blue" },
    label: "Blue",
    category: AttributeCategory.Color,
    sort_order: 4,
  },
  {
    key: "Pan",
    attribute: { type: "Pan" },
    label: "Pan",
    category: AttributeCategory.Position,
    sort_order: 13,
  },
]);

const identityColumn: GridColumn = {
  id: "id",
  title: "ID",
  width: 80,
};

const attrColumn = (
  id: string,
  attribute: string,
  label: string,
  defaultVisible = true,
): VisibilityGridColumn => ({
  id,
  title: label,
  width: 54,
  group: attribute,
  ...attributeColumnVisibilityMeta(attribute, label),
  defaultVisible,
});

/**
 * Runs a test callback with isolated persistent column visibility settings.
 */
function withPersistentColumnVisibility(callback: () => void) {
  resetColumnVisibility("fixtures");
  try {
    callback();
  } finally {
    resetColumnVisibility("fixtures");
  }
}

/**
 * Builds a storage engine that can hydrate but rejects all persistence writes.
 */
function createWriteFailingStorage(): Record<string, string> {
  return new Proxy<Record<string, string>>(
    {},
    {
      deleteProperty() {
        throw new Error("forced storage delete failure");
      },
      set() {
        throw new Error("forced storage write failure");
      },
    },
  );
}

test("columns are visible by default and identity columns stay visible", () => {
  withPersistentColumnVisibility(() => {
    const columns = [identityColumn, attrColumn("Red_Value", "Red", "Value")];

    setCategoryVisibility("fixtures", columns, "Color", false);

    assert.deepEqual(
      filterVisibleColumns(columns, "fixtures").map((column) => column.id),
      ["id"],
    );
  });
});

test("column override can restore one column inside a hidden category", () => {
  withPersistentColumnVisibility(() => {
    const columns = [
      attrColumn("Red_Value", "Red", "Value"),
      attrColumn("Blue_Value", "Blue", "Value"),
    ];

    setCategoryVisibility("fixtures", columns, "Color", false);
    setColumnVisibility("fixtures", "Red_Value", true);

    assert.deepEqual(
      filterVisibleColumns(columns, "fixtures").map((column) => column.id),
      ["Red_Value"],
    );
  });
});

test("default-hidden columns can be made visible by overrides and categories", () => {
  withPersistentColumnVisibility(() => {
    const columns = [
      attrColumn("Red_Value", "Red", "Value"),
      attrColumn("Blue_Value", "Blue", "Value", false),
    ];

    assert.deepEqual(
      filterVisibleColumns(columns, "fixtures").map((column) => column.id),
      ["Red_Value"],
    );

    setColumnVisibility("fixtures", "Blue_Value", true);
    assert.deepEqual(
      filterVisibleColumns(columns, "fixtures").map((column) => column.id),
      ["Red_Value", "Blue_Value"],
    );

    setCategoryVisibility("fixtures", columns, "Color", true);
    assert.deepEqual(
      filterVisibleColumns(columns, "fixtures").map((column) => column.id),
      ["Red_Value", "Blue_Value"],
    );
  });
});

test("visible category defaults apply to future default-hidden columns", () => {
  withPersistentColumnVisibility(() => {
    const initialColumns = [attrColumn("Red_Value", "Red", "Value")];
    setCategoryVisibility("fixtures", initialColumns, "Color", true);

    const futureColumns = [
      attrColumn("Red_Value", "Red", "Value"),
      attrColumn("Blue_Value", "Blue", "Value", false),
      attrColumn("Pan_Value", "Pan", "Value", false),
    ];

    assert.deepEqual(
      filterVisibleColumns(futureColumns, "fixtures").map(
        (column) => column.id,
      ),
      ["Red_Value", "Blue_Value"],
    );
  });
});

test("category defaults apply to future columns in that category", () => {
  withPersistentColumnVisibility(() => {
    const initialColumns = [attrColumn("Red_Value", "Red", "Value")];
    setCategoryVisibility("fixtures", initialColumns, "Color", false);

    const futureColumns = [
      attrColumn("Red_Value", "Red", "Value"),
      attrColumn("Blue_Value", "Blue", "Value"),
      attrColumn("Pan_Value", "Pan", "Value"),
    ];

    assert.deepEqual(
      filterVisibleColumns(futureColumns, "fixtures").map(
        (column) => column.id,
      ),
      ["Pan_Value"],
    );
  });
});

test("reset restores default visibility", () => {
  withPersistentColumnVisibility(() => {
    const columns = [attrColumn("Red_Value", "Red", "Value")];

    setCategoryVisibility("fixtures", columns, "Color", false);
    assert.deepEqual(filterVisibleColumns(columns, "fixtures"), []);

    resetColumnVisibility("fixtures");
    assert.deepEqual(
      filterVisibleColumns(columns, "fixtures").map((column) => column.id),
      ["Red_Value"],
    );
  });
});

test("menu categories report tri-state category status and attribute groups", () => {
  withPersistentColumnVisibility(() => {
    const columns = [
      attrColumn("Red_Value", "Red", "Value"),
      attrColumn("Blue_Value", "Blue", "Value"),
      attrColumn("Pan_Value", "Pan", "Value"),
    ];

    setCategoryVisibility("fixtures", columns, "Color", false);
    setColumnVisibility("fixtures", "Red_Value", true);

    const categories = getColumnVisibilityMenuCategories(columns, "fixtures");
    const color = categories.find((category) => category.id === "Color");
    const position = categories.find((category) => category.id === "Position");
    const redGroup = color?.groups.find((group) => group.label === "Red");

    assert.equal(color?.state, "dash");
    assert.deepEqual(
      redGroup?.columns.map((column) => column.label),
      ["Value"],
    );
    assert.equal(position?.state, "activated");
  });
});

test("column visibility writes the legacy columns-config storage key", () => {
  withPersistentColumnVisibility(() => {
    const columns = [attrColumn("Red_Value", "Red", "Value")];

    setCategoryVisibility("fixtures", columns, "Color", false);

    const stored = JSON.parse(getTestStorage()["columns-config"]);
    assert.equal(
      stored.tables["columns-config:fixtures"].categoryDefaults.Color,
      false,
    );
  });
});

test("column visibility updates memory when storage writes fail", () => {
  const columns = [attrColumn("Red_Value", "Red", "Value")];
  setPersistentEngine(createWriteFailingStorage(), {
    addEventListener() {},
    removeEventListener() {},
  });

  try {
    setCategoryVisibility("fixtures", columns, "Color", false);

    assert.deepEqual(filterVisibleColumns(columns, "fixtures"), []);
  } finally {
    useTestStorageEngine();
    resetColumnVisibility("fixtures");
    cleanTestStorage();
  }
});
