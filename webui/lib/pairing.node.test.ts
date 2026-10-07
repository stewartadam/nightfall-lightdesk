// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatPairingPin, parsePinFragment } from "./pairing";

/** A shared link's PIN is extracted and removed, keeping any other fragment state. */
test("parsePinFragment extracts the PIN and keeps the rest of the fragment", () => {
  assert.deepEqual(parsePinFragment("#pin=123456"), {
    pin: "123456",
    remainingHash: "",
  });
  assert.deepEqual(parsePinFragment("#panel=cues&pin=042000"), {
    pin: "042000",
    remainingHash: "#panel=cues",
  });
});

/** Pages opened without a PIN keep their fragment untouched. */
test("parsePinFragment leaves fragments without a PIN alone", () => {
  assert.deepEqual(parsePinFragment(""), { pin: null, remainingHash: "" });
  assert.deepEqual(parsePinFragment("#panel=cues"), {
    pin: null,
    remainingHash: "#panel=cues",
  });
});

/** Six-digit PINs are grouped for reading aloud; anything else is shown as is. */
test("formatPairingPin groups six digits", () => {
  assert.equal(formatPairingPin("042000"), "042 000");
  assert.equal(formatPairingPin("12345"), "12345");
});
