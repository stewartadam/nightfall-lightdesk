// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shows the page's uncaught failures to the user and forwards them to the
 * engine's error reports. Imported first by the entry module so failures while
 * later modules evaluate are reported too.
 */

import { forwardUncaughtError } from "./error-report-forwarding";
import {
  reportWindowUncaughtErrors,
  setFatalErrorPresenter,
  setUncaughtErrorForwarder,
} from "./uncaught-error-reporter";

/** Loads the error dialog on first use, keeping it out of the initial bundle. */
setFatalErrorPresenter(async (failure) => {
  const { showFatalError } = await import(
    "../components/shell/app/fatal-error-dialog"
  );
  showFatalError(failure);
});
setUncaughtErrorForwarder(forwardUncaughtError);
const stopReporting = reportWindowUncaughtErrors(window);
import.meta.hot?.dispose(stopReporting);
