// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shows the page's uncaught failures to the user. Imported first by the entry
 * module so failures while later modules evaluate are reported too.
 */

import { reportWindowUncaughtErrors } from "./uncaught-error-reporter";

const stopReporting = reportWindowUncaughtErrors(window);
import.meta.hot?.dispose(stopReporting);
