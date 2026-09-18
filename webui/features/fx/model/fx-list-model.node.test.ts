// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import {
  createModuleFxListEntry,
  createRegularFxListEntry,
  createStepFxListEntry,
  formatConfigText,
  nextFxId,
  parseConfigText,
} from "./fx-list-model";

/** Verifies module configuration text round-trips in stable key order. */
test("module FX configuration text round-trips", () => {
  const text = formatConfigText({ zeta: "2", alpha: "1" });
  assert.equal(text, "alpha=1\nzeta=2");
  assert.deepEqual(parseConfigText(text), { alpha: "1", zeta: "2" });
});

/** Verifies malformed module configuration lines return an operator-facing error. */
test("module FX configuration rejects lines without separators", () => {
  assert.equal(
    parseConfigText("valid=yes\ninvalid"),
    "Config line 2 must use key=value.",
  );
});

/** Verifies list projections preserve type-specific labels and edit policy. */
test("FX list projections classify regular step and module entries", () => {
  const identifiers = { id: 7, uid: "fx-7", label: "Seven" };
  const regular = createRegularFxListEntry({
    identifiers,
    attributes: { Intensity: {} },
  } as unknown as types.Fx);
  const step = createStepFxListEntry({
    identifiers,
    lanes: [],
  } as unknown as types.StepFx);
  const moduleFx = createModuleFxListEntry({
    identifiers,
    module_name: "pulse",
  } as types.StoredFxModule);

  assert.deepEqual(
    [regular.type, step.type, moduleFx.type],
    ["regular", "step", "module"],
  );
  assert.equal(regular.canEdit, true);
  assert.equal(step.canDelete, true);
  assert.equal(moduleFx.detail, "pulse");
});

/** Verifies ID allocation fills the first gap across mixed FX list entries. */
test("nextFxId fills the first available mixed FX id", () => {
  const entries = [1, 3].map((id) => ({
    identifiers: { id, uid: `fx-${id}`, label: `FX ${id}` },
    type: "regular" as const,
    typeLabel: "Regular",
    typeIcon: (() => null) as never,
    detail: "",
    canEdit: true,
    canDelete: true,
  }));
  assert.equal(nextFxId(entries), 2);
});
