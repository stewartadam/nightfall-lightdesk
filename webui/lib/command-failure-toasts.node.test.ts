// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeCommandFailurePresented,
  markCommandFailurePresented,
} from "./command-failure-toasts";

/** Verifies a presented failure suppresses exactly one generic toast, across ID formats. */
test("presented command failures are consumed once regardless of hyphenation", () => {
  markCommandFailurePresented("12345678123412341234123456789ABC");

  assert.equal(
    consumeCommandFailurePresented("12345678-1234-1234-1234-123456789abc"),
    true,
  );
  assert.equal(
    consumeCommandFailurePresented("12345678123412341234123456789abc"),
    false,
  );
});

/** Verifies commands never marked as presented keep their generic failure toast. */
test("unmarked command failures are not suppressed", () => {
  assert.equal(
    consumeCommandFailurePresented("ffffffffffffffffffffffffffffffff"),
    false,
  );
  assert.equal(consumeCommandFailurePresented(undefined), false);
});
