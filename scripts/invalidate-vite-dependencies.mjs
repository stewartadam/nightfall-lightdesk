// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { utimesSync } from "node:fs";

// Vite includes the patches directory mtime in its dependency cache key.
// Applying patches only changes node_modules, so advance the key explicitly
// after patch-package succeeds. Restart Vite to load the patched dependencies.
const now = new Date();
utimesSync(new URL("../patches/", import.meta.url), now, now);
