// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  dropdownDisplaySwatch,
  dropdownDisplayValue,
  isDropdownCell,
  makeDropdownEditedCellByValue,
} from "../../../lib/tanstack-dropdown-cell";
import type { MidiDeviceProfile } from "../../../types";
import { editedLedValue, ledValueCell } from "./led-values";

/** A two-color profile shaped like the Launchpad's, for cell tests. */
const PROFILE: MidiDeviceProfile = {
  device: "Launchpad",
  id: "novation.launchpad",
  name: "Novation Launchpad",
  hint: undefined,
  colors: [
    { name: "Off", value: 12, swatch: "#1f1f1f", blink: false },
    { name: "Green", value: 60, swatch: "#2cff3c", blink: false },
  ],
  defaultLed: { on: 60, off: 12, held: undefined },
};

/** Verifies a profiled device offers its colors and names the default it falls back to. */
test("ledValueCell offers profile colors with the default named", () => {
  const cell = ledValueCell(undefined, "on", PROFILE);
  assert.ok(isDropdownCell(cell));
  assert.equal(dropdownDisplayValue(cell), "Default (Green)");
  assert.equal(dropdownDisplaySwatch(cell), "#2cff3c");
  assert.deepEqual(
    cell.data.allowedValues.map((option) =>
      typeof option === "object" && option ? option.label : option,
    ),
    ["Default (Green)", "Off", "Green"],
  );
});

/** Verifies held falls back to the on color when the profile names no held color. */
test("ledValueCell names the on color as the held default", () => {
  const cell = ledValueCell({}, "held", PROFILE);
  assert.ok(isDropdownCell(cell));
  assert.equal(dropdownDisplayValue(cell), "Default (Green)");
});

/** Verifies an unset held value follows the mapping's own on color when it picks one. */
test("ledValueCell names the mapping's on color as the held default", () => {
  const cell = ledValueCell({ on: 12 }, "held", PROFILE);
  assert.ok(isDropdownCell(cell));
  assert.equal(dropdownDisplayValue(cell), "Default (Off)");
});

/** Verifies a raw value matching no color stays selectable, listed by number. */
test("ledValueCell lists an unnamed value by number", () => {
  const cell = ledValueCell({ off: 47 }, "off", PROFILE);
  assert.ok(isDropdownCell(cell));
  assert.equal(dropdownDisplayValue(cell), "Value 47");
});

/** Verifies devices without a profile keep a typed number with a Default placeholder. */
test("ledValueCell uses number entry without a profile", () => {
  const unset = ledValueCell(undefined, "on", undefined);
  assert.equal(unset.kind, GridCellKind.Text);
  const set = ledValueCell({ on: 21 }, "on", undefined);
  assert.equal(set.kind, GridCellKind.Number);
});

/** Verifies picking a color stores its raw value and picking Default clears it. */
test("editedLedValue reads chosen colors as raw values", () => {
  const cell = ledValueCell({ on: 12 }, "on", PROFILE);
  assert.ok(isDropdownCell(cell));
  assert.equal(editedLedValue(makeDropdownEditedCellByValue(cell, "60")), 60);
  assert.equal(editedLedValue(makeDropdownEditedCellByValue(cell, "")), null);
});

/** Verifies typed values must be MIDI data bytes. */
test("editedLedValue rejects values outside 0-127", () => {
  const typed = (data: string) =>
    editedLedValue({
      kind: GridCellKind.Text,
      data,
      displayData: data,
      allowOverlay: true,
    });
  assert.equal(typed("127"), 127);
  assert.equal(typed(""), null);
  assert.equal(typed("128"), undefined);
  assert.equal(typed("1.5"), undefined);
});
