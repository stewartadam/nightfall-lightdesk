// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createRoot } from "solid-js";

/**
 * Wraps a callback that a non-Solid library invokes, such as a noUiSlider event handler or
 * formatter, so each call runs inside its own reactive root that is disposed as soon as the
 * callback returns.
 *
 * Library callbacks run outside any Solid owner. Reading a component prop there can still create
 * computations, because Solid compiles a conditional JSX expression into a getter that builds a
 * memo each time it is read; without an owner those memos are never disposed and Solid warns.
 * Inside the transient root they are owned, cleaned up immediately, and the reads are untracked,
 * so a callback fired synchronously from within an effect does not subscribe that effect to
 * whatever it reads.
 */
export function withTransientOwner<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) =>
    createRoot((dispose) => {
      try {
        return callback(...args);
      } finally {
        dispose();
      }
    });
}
