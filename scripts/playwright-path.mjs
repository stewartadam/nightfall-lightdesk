// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import os from "node:os";
import { join } from "node:path";

const cacheRoot =
  process.platform === "darwin"
    ? join(os.homedir(), "Library", "Caches")
    : process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_CACHE_HOME ?? join(os.homedir(), ".cache"));

export const sharedBrowsersPath = join(cacheRoot, "ms-playwright");
