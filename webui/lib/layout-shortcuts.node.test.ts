// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutSlotShortcut } from "./layout-shortcuts";

/** Checks all browser function keys and desktop digits, including the tenth slot. */
test("layout slot bindings follow the runtime without claiming browser tab shortcuts", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });
    for (let slot = 1; slot <= 10; slot++) {
      assert.equal(layoutSlotShortcut(slot), `F${slot}`);
    }
    Object.defineProperty(globalThis, "window", {
      value: { __TAURI_INTERNALS__: {} },
      configurable: true,
    });
    for (let slot = 1; slot <= 10; slot++) {
      assert.equal(layoutSlotShortcut(slot), `$mod+${slot % 10}`);
    }
    assert.equal(layoutSlotShortcut(undefined), undefined);
    assert.equal(layoutSlotShortcut(11), undefined);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
