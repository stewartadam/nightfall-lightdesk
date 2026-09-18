// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { serverVersion } from "../state/appStores";
import { APP_BUILD_ID, APP_VERSION } from "./app-metadata";
import type { DiagnosticContext } from "./diagnostics";
import { connectionStatus } from "./engine-runtime";
import { isEmbeddedDemoRuntime } from "./runtime-config";
import { isTauriRuntime } from "./tauri";

/** Captures platform and connection metadata without collecting logs or accessing showfile contents. */
export function collectSystemInfo(): DiagnosticContext {
  return {
    version: APP_VERSION,
    buildId: APP_BUILD_ID,
    backendVersion: serverVersion.get(),
    runtime: isEmbeddedDemoRuntime()
      ? "Browser demo"
      : isTauriRuntime()
        ? "Desktop"
        : "Browser connected to native engine",
    connection: connectionStatus(),
    userAgent: navigator.userAgent,
    logs: [],
    logFileStatus: "not requested",
  };
}
