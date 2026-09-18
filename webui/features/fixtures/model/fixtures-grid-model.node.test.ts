// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  type AttributeValues,
  createARCell,
  createAttributeARCell,
} from "../../../lib/datagrid";
import {
  createFixtureGridColumns,
  fixtureValueColumnAttribute,
} from "./fixtures-grid-model";

/**
 * Verifies fixture grid columns carry parsed attribute metadata for cell hot paths.
 */
test("createFixtureGridColumns annotates fixture value columns", () => {
  const columns = createFixtureGridColumns(
    ["Red"],
    [
      {
        title: "ID",
        id: "id",
        width: 85,
        filter: { kind: "number", value: (row) => row.id },
      },
      {
        title: "Fixture",
        id: "name",
        width: 150,
        filter: { value: (row) => row.name },
      },
    ],
  );

  assert.equal(columns[0]?.fixtureColumnKind, "identity");
  assert.equal(columns[1]?.fixtureColumnKind, "name");
  assert.equal(columns[2]?.fixtureColumnKind, "attributeValue");
  assert.equal(fixtureValueColumnAttribute(columns[2]), "Red");
});

/**
 * Verifies attribute-direct AR cells preserve legacy column-id rendering behavior.
 */
test("createAttributeARCell matches createARCell display output", () => {
  const attributes: AttributeValues = {
    absolute: {
      Red: { value: 128, isPercentage: false, isRelative: false },
    },
    relative: {},
  };

  const directCell = createAttributeARCell("Red", attributes);
  const columnCell = createARCell("Red_Value", attributes);

  assert.equal(directCell.kind, GridCellKind.Text);
  assert.deepEqual(directCell, columnCell);
});
