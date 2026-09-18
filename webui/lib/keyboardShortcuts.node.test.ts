// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isPrintableTextEntryEvent } from "./keyboardShortcutEvents";

/** Verifies shifted printable characters still count as text entry. */
test("printable text entry includes shifted printable keys", () => {
  assert.equal(
    isPrintableTextEntryEvent({
      altKey: false,
      ctrlKey: false,
      key: "~",
      metaKey: false,
    }),
    true,
  );
});

/** Verifies command-modified keys remain available to shortcuts. */
test("printable text entry excludes command-modified keys", () => {
  assert.equal(
    isPrintableTextEntryEvent({
      altKey: false,
      ctrlKey: false,
      key: "f",
      metaKey: true,
    }),
    false,
  );
});
