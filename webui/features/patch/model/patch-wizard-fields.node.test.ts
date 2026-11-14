// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PATCH_QUANTITY,
  validatePatchWizardFields,
  validConsolePatchStart,
} from "./patch-wizard-fields";

const valid = {
  quantity: 4,
  firstFixtureId: null,
  universeId: 1,
  startAddress: 60,
};

/** Verifies typical typed values pass, including a blank first fixture ID that uses the suggestion. */
test("validatePatchWizardFields accepts in-range whole numbers", () => {
  assert.deepEqual(validatePatchWizardFields(valid), {
    quantity: true,
    firstFixtureId: true,
    universe: true,
    startAddress: true,
  });
});

/** Verifies a start address typed past the universe end is reported instead of kept at its last valid prefix. */
test("validatePatchWizardFields rejects an address past the universe", () => {
  const validity = validatePatchWizardFields({ ...valid, startAddress: 600 });
  assert.equal(validity.startAddress, false);
  assert.equal(validConsolePatchStart({ ...valid, startAddress: 600 }), null);
});

/** Verifies blank, zero and fractional entries are invalid for the required fields. */
test("validatePatchWizardFields rejects blank and non-whole entries", () => {
  assert.deepEqual(
    validatePatchWizardFields({
      quantity: null,
      firstFixtureId: 1.5,
      universeId: 0,
      startAddress: null,
    }),
    {
      quantity: false,
      firstFixtureId: false,
      universe: false,
      startAddress: false,
    },
  );
});

/** Verifies an enormous typed count such as "1e9" is rejected rather than building a huge fixture list. */
test("validatePatchWizardFields caps the fixture count", () => {
  assert.equal(
    validatePatchWizardFields({ ...valid, quantity: MAX_PATCH_QUANTITY })
      .quantity,
    true,
  );
  assert.equal(
    validatePatchWizardFields({ ...valid, quantity: 1e9 }).quantity,
    false,
  );
});

/** Verifies a valid universe and address become the console start the routes are laid out from. */
test("validConsolePatchStart returns the typed start when valid", () => {
  assert.deepEqual(validConsolePatchStart(valid), { universe: 1, address: 60 });
});
