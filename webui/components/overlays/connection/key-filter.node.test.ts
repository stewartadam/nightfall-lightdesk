// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { shouldBlockDisconnectedOverlayKey } from "./key-filter";

/** Creates the keyboard event shape needed by overlay shortcut filtering tests. */
function keyEvent(
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">
  > = {},
): KeyboardEvent {
  return {
    key,
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
  } as KeyboardEvent;
}

test("disconnected overlay allows function keys through", () => {
  assert.equal(shouldBlockDisconnectedOverlayKey(keyEvent("F1")), false);
  assert.equal(shouldBlockDisconnectedOverlayKey(keyEvent("F12")), false);
});

test("disconnected overlay allows unhandled browser shortcuts through", () => {
  assert.equal(
    shouldBlockDisconnectedOverlayKey(keyEvent("Tab", { metaKey: true })),
    false,
  );
  assert.equal(
    shouldBlockDisconnectedOverlayKey(keyEvent("ArrowLeft", { altKey: true })),
    false,
  );
});

test("disconnected overlay blocks modified shortcuts handled by the app", () => {
  assert.equal(
    shouldBlockDisconnectedOverlayKey(
      keyEvent("s", { metaKey: true }),
      () => true,
    ),
    true,
  );
});

test("disconnected overlay blocks unmodified app input keys", () => {
  assert.equal(shouldBlockDisconnectedOverlayKey(keyEvent("a")), true);
  assert.equal(shouldBlockDisconnectedOverlayKey(keyEvent("Enter")), true);
});
