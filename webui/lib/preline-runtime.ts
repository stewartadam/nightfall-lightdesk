// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as FloatingUIDOM from "@floating-ui/dom";

/** Installs Preline's positioning runtime and initializes controls already in the DOM. */
export async function initializePrelineRuntime(): Promise<void> {
  (
    window as unknown as { FloatingUIDOM?: typeof FloatingUIDOM }
  ).FloatingUIDOM = FloatingUIDOM;
  const preline = await import("preline");
  (window as unknown as { HSSelect?: typeof preline.HSSelect }).HSSelect =
    preline.HSSelect;
  window.HSStaticMethods?.autoInit();
}
