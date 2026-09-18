// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type noUiSlider from "nouislider";
import type { IStaticMethods } from "preline";

// Declare types for our window exports used by Preline
declare global {
  const __NIGHTFALL_PROJECT_LINKS__: {
    documentation: string;
    feedback: string;
    bugReport: string;
  };
  const __NIGHTFALL_APP_NAME__: string;
  const __NIGHTFALL_APP_TITLE__: string;
  const __NIGHTFALL_APP_VERSION__: string;
  const __NIGHTFALL_APP_BUILD_ID__: string;
  const __NIGHTFALL_APP_BUILD_NAME__: string;
  const __NIGHTFALL_APP_LICENSE__: string;
  const __NIGHTFALL_APP_COPYRIGHT__: string;

  interface Window {
    noUiSlider: typeof noUiSlider;

    // Preline UI
    HSStaticMethods: IStaticMethods;
  }
}
