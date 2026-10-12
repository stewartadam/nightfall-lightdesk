// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Mirrors the desktop window's console output and uncaught errors into the
 * native log. Imported first by the entry module so messages logged while
 * later modules evaluate are captured too. Workers must not import it: its
 * hot-reload hook would load Vite's client there, which then fails on CSS
 * updates because workers have no document.
 */

import { isTauri } from "@tauri-apps/api/core";
import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";
import { forwardDiagnosticConsole } from "./diagnostic-console";

if (isTauri()) {
  const nativeLoggers = { log: info, info, debug, trace, warn, error };
  const dispose = forwardDiagnosticConsole(
    console,
    (level, message) => nativeLoggers[level](message),
    window,
  );
  import.meta.hot?.dispose(dispose);
}
