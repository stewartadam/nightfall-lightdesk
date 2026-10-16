// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { setStoreAction } from "../../../lib/nanostore-action";
import { referenceListWatch } from "../../../state/appStores";

/** Number of views currently showing the full reference list. */
let watchers = 0;

/**
 * Asks the backend for the full reference list until the returned function is called. Several
 * views may watch at once; the list keeps arriving until every one released it.
 */
export function watchReferenceList(): () => void {
  watchers++;
  if (!referenceListWatch.get()) {
    setStoreAction(referenceListWatch, "Watch references", true);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers--;
    if (watchers === 0) {
      setStoreAction(referenceListWatch, "Stop watching references", false);
    }
  };
}
