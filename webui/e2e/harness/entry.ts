// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Entry script of the blank harness pages. It publishes the harness loader
 * and, when the URL names a `fixture`, mounts that fixture right away.
 */

import { type HarnessName, loadHarness } from "./registry";

window.__nightfallHarness = { load: loadHarness };

const fixture = new URLSearchParams(window.location.search).get("fixture");
if (fixture) void loadHarness(fixture as HarnessName);
