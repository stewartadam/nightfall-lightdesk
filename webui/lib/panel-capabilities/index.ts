// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelFocusCapability } from "./focus";
import { PANEL_FOCUS_CAPABILITY } from "./focus";
import type { RenderPropertiesCapability } from "./properties";
import { RENDER_PROPERTIES_CAPABILITY } from "./properties";
import type { RevealObjectCapability } from "./reveal-object";
import { REVEAL_OBJECT_CAPABILITY } from "./reveal-object";

export {
  PANEL_FOCUS_CAPABILITY,
  type PanelFocusCapability,
} from "./focus";
export {
  RENDER_PROPERTIES_CAPABILITY,
  type RenderPropertiesCapability,
  type RenderPropertiesMetadata,
} from "./properties";
export {
  REVEAL_OBJECT_CAPABILITY,
  type RevealObjectCapability,
} from "./reveal-object";
export type KnownPanelCapability =
  | PanelFocusCapability
  | RenderPropertiesCapability
  | RevealObjectCapability;
export type PanelCapabilityId = KnownPanelCapability["id"];
export const KNOWN_PANEL_CAPABILITY_IDS = [
  PANEL_FOCUS_CAPABILITY.id,
  RENDER_PROPERTIES_CAPABILITY.id,
  REVEAL_OBJECT_CAPABILITY.id,
] as const satisfies readonly PanelCapabilityId[];

/** Returns whether a string identifies a static panel capability contract. */
export function isPanelCapabilityId(id: string): id is PanelCapabilityId {
  return (KNOWN_PANEL_CAPABILITY_IDS as readonly string[]).includes(id);
}

export type {
  PanelCapabilityContract,
  PanelCapabilityContractInstance,
  PanelCapabilityHandler,
  PanelCapabilityMetadata,
  PanelCapabilityPayload,
  PanelCapabilityPredicate,
  PanelCapabilityRegistrationOptions,
  PanelCapabilityRegistrationSnapshot,
  PanelCapabilityRequest,
} from "./types";
