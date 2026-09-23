// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Component, createComponent, lazy } from "solid-js";
import { gateExperimentalFlowPanel } from "../features/flow/panels/experimental-flow-panel";
import { isExperimentalFlowPanel } from "./experimental-features";
import { PANEL_MODULES } from "./panel-manifest";
import { type PanelModule, panelDefinitionFromModule } from "./panel-module";
import { registerPanelComponent } from "./panel-registry";

/** Resolves a panel component implementation from its descriptor-owned loader. */
function resolvePanelComponent(panelModule: PanelModule): Component<any> {
  /** Owns each lazy resource per mount so retiring a workspace cannot strand another panel. */
  const Panel: Component<any> = (props) =>
    createComponent(lazy(panelModule.loadComponent), props);
  return isExperimentalFlowPanel(panelModule.componentName)
    ? gateExperimentalFlowPanel(Panel)
    : Panel;
}

/** Registers every manifest panel component with the Dockview component registry. */
export function registerAllComponents(): void {
  for (const panelModule of PANEL_MODULES) {
    registerPanelComponent(
      panelDefinitionFromModule(panelModule),
      resolvePanelComponent(panelModule),
    );
  }
}
