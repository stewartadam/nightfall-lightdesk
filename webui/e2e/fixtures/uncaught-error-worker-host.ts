// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { watchWorkerUncaughtErrors } from "../../lib/uncaught-error-reporter";

/**
 * Starts a worker that forwards its uncaught error and unhandled rejection to
 * the page, watched by the app's reporter as the engine worker is. Vite bundles
 * the worker module, so this runs on dev servers and e2e builds alike.
 */
export function startFailingWorker(label: string): Worker {
  const worker = new Worker(
    new URL("./uncaught-error-worker.ts", import.meta.url),
    { type: "module" },
  );
  watchWorkerUncaughtErrors(worker, label);
  return worker;
}
