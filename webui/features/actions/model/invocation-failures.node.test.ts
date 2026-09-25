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
  appendInvocationFailure,
  CONTINUOUS_FAILURE_TOAST_MS,
  describeInvocationFailure,
} from "./invocation-failures";

/** Catalog containing only the clip start action. */
const CATALOG = [
  {
    descriptor: {
      id: "clip.start",
      label: "Start clip",
      description: "",
      category: "Clips",
      input: "Trigger",
      parameters: [],
      surfaces: [],
    },
    capabilities: [],
    behaviors: [],
  },
] as unknown as types.ActionCatalogEntry[];

/** Builds a failure for an action ID with the given raw surface input. */
function failure(
  id: string,
  input: types.ActionInput = { type: "Trigger" },
  invocationId = "1",
): types.ActionInvocationFailure {
  return {
    invocation_id: invocationId,
    action: { id, arguments: {} },
    surface: "midi" as types.ActionSurface,
    source: "MIDI Launchpad",
    input,
    error: { code: "clip.not_found", message: "Clip does not exist" },
  };
}

/** Verifies history keeps the newest failure first and drops the oldest beyond the limit. */
test("appendInvocationFailure keeps newest failures within the limit", () => {
  let history: types.ActionInvocationFailure[] = [];
  for (const id of ["1", "2", "3"]) {
    history = appendInvocationFailure(
      history,
      failure("clip.start", undefined, id),
      2,
    );
  }

  assert.deepEqual(
    history.map((entry) => entry.invocation_id),
    ["3", "2"],
  );
});

/** Verifies discrete failures are titled with the catalog label and cite their source. */
test("describeInvocationFailure uses the catalog label for discrete input", () => {
  assert.deepEqual(describeInvocationFailure(failure("clip.start"), CATALOG), {
    level: "error",
    title: "Start clip failed",
    message: "Clip does not exist (MIDI Launchpad)",
  });
});

/** Verifies fader failures are short-lived warnings and unknown actions show their ID. */
test("describeInvocationFailure softens continuous input failures", () => {
  const toast = describeInvocationFailure(
    failure("master.level", { type: "Scalar", data: 0.5 }),
    CATALOG,
  );

  assert.equal(toast.level, "warning");
  assert.equal(toast.title, "master.level failed");
  assert.equal(toast.ttlMs, CONTINUOUS_FAILURE_TOAST_MS);
});
