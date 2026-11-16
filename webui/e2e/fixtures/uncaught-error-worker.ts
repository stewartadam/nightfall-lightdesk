// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { forwardWorkerUncaughtErrors } from "../../lib/uncaught-error";

forwardWorkerUncaughtErrors();

/** Throws outside any handler, as a worker decoding a bad frame would. */
function decodeFrame(): never {
  throw new RangeError("worker frame out of range");
}

setTimeout(decodeFrame);
void Promise.reject(new Error("worker rejection nobody handled"));
