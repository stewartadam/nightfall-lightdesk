// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { runtimeCapabilities } from "../state/appStores";

/** Returns the active backend policy; disconnected and public demo sessions default off. */
export function areExperimentalFlowsEnabled(): boolean {
  return runtimeCapabilities.get()?.experimental_flows === true;
}

/** Identifies panel implementations that require the experimental flow runtime. */
export function isExperimentalFlowPanel(componentName: string): boolean {
  return componentName === "FlowList" || componentName === "FlowEditor";
}
