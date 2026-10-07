// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  pendingPanelComponentLoads,
  trackPanelComponentLoad,
} from "./panel-component-loads";

/** Verifies a panel import counts as pending until it resolves or fails. */
test("panel component loads stay pending until their import settles", async () => {
  let resolveLoad!: (value: string) => void;
  let rejectLoad!: (error: Error) => void;
  const loadOk = trackPanelComponentLoad(
    () => new Promise<string>((resolve) => (resolveLoad = resolve)),
  );
  const loadFails = trackPanelComponentLoad(
    () => new Promise<string>((_, reject) => (rejectLoad = reject)),
  );

  const ok = loadOk();
  const fails = loadFails();
  assert.equal(pendingPanelComponentLoads.get(), 2);

  resolveLoad("panel");
  assert.equal(await ok, "panel");
  assert.equal(pendingPanelComponentLoads.get(), 1);

  rejectLoad(new Error("chunk failed"));
  await assert.rejects(fails, /chunk failed/);
  assert.equal(pendingPanelComponentLoads.get(), 0);
});
