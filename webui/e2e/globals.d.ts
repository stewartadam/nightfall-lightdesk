// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { NightfallTestHooks } from "../lib/test-hooks";
import type { NightfallHarness } from "./harness/registry";

declare global {
  interface Window {
    /** Lifecycle promises and runtime handles; present on app pages under test. */
    __nightfallTest: NightfallTestHooks;
    /** Browser-side harness loader; present on app pages and harness pages. */
    __nightfallHarness: NightfallHarness;
  }
}
