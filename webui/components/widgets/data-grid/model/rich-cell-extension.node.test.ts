// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { GridCell } from "../../../../lib/data-grid-types";
import { GridCellKind } from "../../../../lib/data-grid-types";
import {
  editableRichCellExtension,
  findRichCellExtension,
} from "./rich-cell-extension";
import type { DataGridRichCellExtension } from "./types";

const cell: GridCell = {
  kind: GridCellKind.Custom,
  data: { kind: "example" },
  copyData: "Example",
  allowOverlay: true,
};

const extension: DataGridRichCellExtension = {
  id: "example",
  matches: (candidate) =>
    candidate.kind === GridCellKind.Custom &&
    (candidate.data as { kind?: unknown }).kind === "example",
  isEditable: (candidate) => candidate.allowOverlay === true,
  render: () => "Example",
  renderEditor: () => "Editor",
};

/** Verifies extension lookup returns the first matching registration. */
test("findRichCellExtension resolves matching registrations", () => {
  assert.equal(findRichCellExtension([extension], cell), extension);
  assert.equal(findRichCellExtension([], cell), undefined);
});

/** Verifies editable lookup respects an extension's cell policy. */
test("editableRichCellExtension filters readonly registrations", () => {
  assert.equal(editableRichCellExtension([extension], cell), extension);
  assert.equal(
    editableRichCellExtension([extension], { ...cell, allowOverlay: false }),
    undefined,
  );
});
