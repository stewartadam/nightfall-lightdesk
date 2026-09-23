// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import { GUIDE_LESSONS } from "./lessons";

export const guideLessons = atom(GUIDE_LESSONS);

if (import.meta.hot) {
  /** Updates lesson subscribers without invalidating the guide or shell modules. */
  import.meta.hot.accept("./lessons", (updated) => {
    if (updated) guideLessons.set(updated.GUIDE_LESSONS);
  });
}
