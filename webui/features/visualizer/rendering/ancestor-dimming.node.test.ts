// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyAncestorDimmers } from "./ancestor-dimming";

/** A blinder's two lamps, each with its own dimmer, below one master dimmer. */
const blinder = [
  { controlledElement: "Lens 1", dimmedBy: ["Master"] },
  { controlledElement: "Lens 2", dimmedBy: ["Master"] },
];

/** Keeps a blinder dark while its master is at zero, whatever the lamps' own dimmers say. */
test("a master dimmer at zero darkens the lamps below it", () => {
  const colors = new Map([
    ["Master", { intensity: 0 }],
    ["Lens 1", { intensity: 1 }],
    ["Lens 2", { intensity: 1 }],
  ]);
  applyAncestorDimmers(blinder, colors, () => true);
  assert.equal(colors.get("Lens 1")?.intensity, 0);
  assert.equal(colors.get("Lens 2")?.intensity, 0);
});

/** Multiplies master and lamp levels, as the fixture does. */
test("lamp levels scale with the master", () => {
  const colors = new Map([
    ["Master", { intensity: 0.5 }],
    ["Lens 1", { intensity: 1 }],
    ["Lens 2", { intensity: 0.4 }],
  ]);
  applyAncestorDimmers(blinder, colors, () => true);
  assert.equal(colors.get("Lens 1")?.intensity, 0.5);
  assert.equal(colors.get("Lens 2")?.intensity, 0.2);
  assert.equal(colors.get("Master")?.intensity, 0.5);
});

/** Leaves lamps without a dimmer of their own to the fixture-level dimmer, so they are not dimmed twice. */
test("lamps without their own dimmer are left alone", () => {
  const colors = new Map([
    ["Master", { intensity: 0.5 }],
    ["Lens 1", { intensity: 0.5 }],
  ]);
  applyAncestorDimmers(
    [{ controlledElement: "Lens 1", dimmedBy: ["Master"] }],
    colors,
    (label) => label !== "Lens 1",
  );
  assert.equal(colors.get("Lens 1")?.intensity, 0.5);
});

/** Scales a lamp once even when several apertures share its element. */
test("an element with several apertures is scaled once", () => {
  const colors = new Map([
    ["Master", { intensity: 0.5 }],
    ["Cells", { intensity: 1 }],
  ]);
  applyAncestorDimmers(
    [
      { controlledElement: "Cells", dimmedBy: ["Master"] },
      { controlledElement: "Cells", dimmedBy: ["Master"] },
    ],
    colors,
    () => true,
  );
  assert.equal(colors.get("Cells")?.intensity, 0.5);
});
