// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  $uiActionCatalog,
  $uiActions,
  describeUiAction,
  executeUiAction,
  registerUiAction,
} from "./ui-action-registry";

/** Verifies closing one of two mounts sharing an ID keeps the other's handler running. */
test("disposing one registration keeps another mount of the same action", () => {
  const calls: string[] = [];
  const disposeFirst = registerUiAction({
    id: "test.shared",
    name: "Shared",
    execute: () => calls.push("first"),
  });
  const disposeSecond = registerUiAction({
    id: "test.shared",
    name: "Shared",
    execute: () => calls.push("second"),
  });

  assert.equal(
    executeUiAction("ui.test.shared", { source: "keybinding" }),
    "succeeded",
  );
  disposeSecond();
  assert.equal(
    executeUiAction("ui.test.shared", { source: "keybinding" }),
    "succeeded",
  );
  disposeSecond();
  assert.equal(
    $uiActions.get().filter((action) => action.id === "test.shared").length,
    1,
  );
  disposeFirst();

  assert.deepEqual(calls, ["second", "first"]);
  assert.equal(
    executeUiAction("ui.test.shared", { source: "keybinding" }),
    "unavailable",
  );
});

/** Verifies an unmounted action stays bindable in the catalog but reports unavailable. */
test("unmounted actions stay in the catalog and report unavailable", () => {
  const dispose = registerUiAction({
    id: "test.closed-panel",
    name: "Closed Panel Action",
    category: "Timeline",
    execute: () => {},
  });
  dispose();

  assert.equal(
    $uiActions.get().some((action) => action.id === "test.closed-panel"),
    false,
  );
  assert.equal(
    describeUiAction("ui.test.closed-panel")?.name,
    "Closed Panel Action",
  );
  assert.equal(
    $uiActionCatalog.get().filter((action) => action.id === "test.closed-panel")
      .length,
    1,
  );
  assert.equal(
    executeUiAction("ui.test.closed-panel", { source: "midi" }),
    "unavailable",
  );
});

/** Verifies a throwing handler reports failure instead of escaping to the caller. */
test("a throwing handler reports failed", () => {
  const dispose = registerUiAction({
    id: "test.throws",
    name: "Throws",
    execute: () => {
      throw new Error("boom");
    },
  });

  assert.equal(executeUiAction("ui.test.throws", { source: "osc" }), "failed");
  dispose();
});
