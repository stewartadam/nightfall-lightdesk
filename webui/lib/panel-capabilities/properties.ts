// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import type { PanelCapabilityContract } from "./types";

export interface RenderPropertiesMetadata {
  label: string;
  priority: number;
  component: () => JSX.Element;
}

export const RENDER_PROPERTIES_CAPABILITY: PanelCapabilityContract<
  "render-properties",
  Record<string, never>,
  RenderPropertiesMetadata
> = {
  id: "render-properties",
  description: "Provide properties inspector content for a panel instance.",
};

export type RenderPropertiesCapability = typeof RENDER_PROPERTIES_CAPABILITY;
