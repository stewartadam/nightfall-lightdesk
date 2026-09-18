// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ShowfileObjectType } from "../showfile-object-search";
import type { PanelCapabilityContract } from "./types";

export const REVEAL_OBJECT_CAPABILITY: PanelCapabilityContract<
  "reveal-object",
  {
    type: ShowfileObjectType;
    uid: string;
    intent?: "select" | "properties";
  }
> = {
  id: "reveal-object",
  description: "Reveal and select a showfile object in its owning panel.",
};

export type RevealObjectCapability = typeof REVEAL_OBJECT_CAPABILITY;
