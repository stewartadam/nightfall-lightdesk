// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BeamType } from "../../../types";
import { fixturePhysicalSignature } from "./physical-signature";

/** Signatures serialize each photometry object once and change only with its contents. */
test("physical signatures are cached per object and track content changes", () => {
  const physical = {
    beamType: BeamType.Spot,
    beamAngle: 8,
    fieldAngle: 12,
    lumens: 4200,
    colorTemperature: 6500,
  };
  const original = JSON.stringify;
  let serializations = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    serializations += 1;
    return original(...args);
  }) as typeof JSON.stringify;
  try {
    const first = fixturePhysicalSignature(physical);
    assert.equal(fixturePhysicalSignature(physical), first);
    assert.equal(serializations, 1);
    assert.equal(fixturePhysicalSignature({ ...physical }), first);
    assert.notEqual(
      fixturePhysicalSignature({ ...physical, beamAngle: 4 }),
      first,
    );
  } finally {
    JSON.stringify = original;
  }
  assert.equal(fixturePhysicalSignature(undefined), "null");
});
