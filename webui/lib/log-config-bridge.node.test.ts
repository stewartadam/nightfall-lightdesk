// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { backendLogConfigToUi } from "./log-config-bridge";

test("binds nightfall target level to UI default level", () => {
  assert.equal(
    backendLogConfigToUi("nightfall=debug,worker-renderer=trace"),
    "debug,worker-renderer=trace",
  );
});

test("clear resets UI config to info", () => {
  assert.equal(backendLogConfigToUi("clear"), "info");
  assert.equal(backendLogConfigToUi("CLEAR"), "info");
});

test("nightfall target overrides explicit default for UI default", () => {
  assert.equal(
    backendLogConfigToUi("info,nightfall=trace,worker-renderer=debug"),
    "trace,worker-renderer=debug",
  );
});

test("preserves non-nightfall overrides when no explicit default exists", () => {
  assert.equal(
    backendLogConfigToUi("worker-renderer=trace,websocket=debug"),
    "worker-renderer=trace,websocket=debug",
  );
});

test("does not split directives on commas inside braces", () => {
  assert.equal(
    backendLogConfigToUi(
      "nightfall[{composited_layers,a=b}]=trace,worker-renderer=debug",
    ),
    "worker-renderer=debug",
  );
});

test("ignores scoped directives for non-nightfall targets", () => {
  assert.equal(
    backendLogConfigToUi("info,worker-renderer[{phase=sync}]=trace"),
    "info",
  );
});
