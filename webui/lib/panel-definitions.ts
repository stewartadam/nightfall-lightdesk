// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelCapabilityId } from "./panel-capabilities";
import { PANEL_MODULES } from "./panel-manifest";
import {
  type PanelDefinition,
  panelDefinitionFromModule,
} from "./panel-module";

export type { PanelDefinition };

export type PanelComponentName =
  (typeof PANEL_MODULES)[number]["componentName"];
export type PanelId = (typeof PANEL_MODULES)[number]["panelId"];

export const PANEL_DEFINITIONS = PANEL_MODULES.map(
  panelDefinitionFromModule,
) as readonly PanelDefinition[];

const panelDefinitionsByName = new Map<string, PanelDefinition>(
  PANEL_DEFINITIONS.map((definition) => [definition.componentName, definition]),
);

const panelDefinitionsById = new Map<string, PanelDefinition>(
  PANEL_DEFINITIONS.map((definition) => [definition.panelId, definition]),
);

/** Returns the panel definition for a Dockview component name, when known. */
export function findPanelDefinitionByName(
  componentName: string,
): PanelDefinition | undefined {
  return panelDefinitionsByName.get(componentName);
}

/** Returns the required panel definition for a Dockview component name. */
export function panelDefinitionByName(
  componentName: PanelComponentName,
): PanelDefinition {
  const definition = findPanelDefinitionByName(componentName);
  if (!definition) {
    throw new Error(`Unknown panel component: ${componentName}`);
  }
  return definition;
}

/** Returns the panel definition for a Dockview panel ID, when known. */
export function findPanelDefinitionById(
  panelId: string,
): PanelDefinition | undefined {
  return panelDefinitionsById.get(panelId);
}

/** Returns whether a panel definition declares support for a capability. */
export function panelDefinitionHasCapability(
  definition: PanelDefinition,
  capability: PanelCapabilityId,
): boolean {
  return definition.capabilities?.includes(capability) ?? false;
}

/** Returns definitions that statically declare support for a capability. */
export function panelDefinitionsForCapability(
  capability: PanelCapabilityId,
): readonly PanelDefinition[] {
  return PANEL_DEFINITIONS.filter((definition) =>
    panelDefinitionHasCapability(definition, capability),
  );
}

/** Returns definitions that should be exposed as open-panel commands. */
export function panelDefinitionsForPalette(): readonly PanelDefinition[] {
  return PANEL_DEFINITIONS.filter((definition) => definition.showInPalette);
}
