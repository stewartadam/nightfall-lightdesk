// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type DropdownGridCell,
  dropdownDisplayValue,
  dropdownOptions,
  dropdownSelectedKey,
  isDropdownCell,
  makeDropdownEditedCell,
  makeDropdownEditedCellByValue,
} from "./tanstack-dropdown-cell";

/**
 * Builds a dropdown grid cell with a configurable selected value.
 */
function dropdownCell(value: string | null = "Manual"): DropdownGridCell {
  return {
    kind: "custom" as DropdownGridCell["kind"],
    data: {
      kind: "dropdown-cell",
      value,
      allowedValues: [
        { value: "Manual", label: "Manual" },
        { value: "FollowPrevious", label: "Follow Previous" },
        "AfterDelay",
        null,
      ],
    },
    copyData: value ?? "",
    allowOverlay: true,
  };
}

test("dropdown cells are detected by data shape", () => {
  assert.equal(isDropdownCell(dropdownCell()), true);
  assert.equal(
    isDropdownCell({
      kind: "text",
      data: "Manual",
      displayData: "Manual",
      allowOverlay: true,
    } as never),
    false,
  );
});

test("dropdown options normalize labels and stable keys", () => {
  assert.deepEqual(dropdownOptions(dropdownCell()), [
    { key: "0", value: "Manual", label: "Manual" },
    { key: "1", value: "FollowPrevious", label: "Follow Previous" },
    { key: "2", value: "AfterDelay", label: "AfterDelay" },
    { key: "3", value: null, label: "" },
  ]);
});

test("dropdown display and selected key use labels", () => {
  const cell = dropdownCell("FollowPrevious");

  assert.equal(dropdownDisplayValue(cell), "Follow Previous");
  assert.equal(dropdownSelectedKey(cell), "1");
});

test("editing a dropdown cell preserves the cell shape", () => {
  const edited = makeDropdownEditedCell(dropdownCell("Manual"), "2");

  assert.equal(edited.kind, "custom");
  assert.deepEqual(edited.data, {
    kind: "dropdown-cell",
    value: "AfterDelay",
    allowedValues: [
      { value: "Manual", label: "Manual" },
      { value: "FollowPrevious", label: "Follow Previous" },
      "AfterDelay",
      null,
    ],
  });
  assert.equal(edited.copyData, "AfterDelay");
});

test("editing a dropdown by value ignores local option order", () => {
  const edited = makeDropdownEditedCellByValue(
    {
      ...dropdownCell("Manual"),
      data: {
        kind: "dropdown-cell",
        value: "Manual",
        allowedValues: [
          "AfterDelay",
          { value: "Manual", label: "Manual" },
          { value: "FollowPrevious", label: "Follow Previous" },
        ],
      },
    },
    "FollowPrevious",
  );

  assert.equal(edited.data.value, "FollowPrevious");
  assert.equal(edited.copyData, "Follow Previous");
});

test("editing a dropdown by missing value preserves the cell", () => {
  const original = dropdownCell("Manual");

  assert.equal(makeDropdownEditedCellByValue(original, "Missing"), original);
});
