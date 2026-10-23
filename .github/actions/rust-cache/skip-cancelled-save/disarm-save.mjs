// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { appendFileSync } from "node:fs";

// A cancelled job stops mid-build. Saving then would store a partial cache under
// the exact key, and later runs would restore it as an exact hit, rebuild what is
// missing and never save a complete one. Clearing CACHE_ON_FAILURE makes
// rust-cache's post-if (success() || CACHE_ON_FAILURE) skip the save.
appendFileSync(process.env.GITHUB_ENV, "CACHE_ON_FAILURE=false\n");
console.log("Job was cancelled; skipping the Rust cache save.");
