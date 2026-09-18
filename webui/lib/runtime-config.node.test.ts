// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserDemoShowfileUrl } from "./runtime-config";

/** Browser demo showfiles remain beneath the configured application base path. */
test("browser demo showfile URL respects the deployment base", () => {
  assert.equal(
    resolveBrowserDemoShowfileUrl(
      "/demo/app/",
      "https://foo.example/current/page?engine=embedded-demo",
    ),
    "https://foo.example/demo/app/nightfall-demo.nightfall-show/showfile.json",
  );
});
