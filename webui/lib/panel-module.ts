// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Component } from "solid-js";
import type { AppIcon } from "../components/ui/icon";
import {
  PANEL_FOCUS_CAPABILITY,
  type PanelCapabilityId,
} from "./panel-capabilities";

export type PanelSingletonPolicy = "singleton";

export type PanelComponentLoader = () => Promise<{
  readonly default: Component<any>;
}>;

export interface PanelDefinition {
  readonly panelId: string;
  readonly componentName: string;
  readonly title: string;
  /** Minimum expanded dock-group width in CSS pixels, including its header. */
  readonly minWidth: number;
  /** Minimum expanded dock-group height in CSS pixels, including its header. */
  readonly minHeight: number;
  readonly icon?: AppIcon;
  readonly capabilities?: readonly PanelCapabilityId[];
  readonly showInPalette: boolean;
  readonly singleton: PanelSingletonPolicy;
  readonly shortcut?: string;
}

export interface PanelModule extends PanelDefinition {
  readonly loadComponent: PanelComponentLoader;
  readonly focusable?: boolean;
}

/** Preserves literal panel metadata while marking a module as a panel descriptor. */
export function definePanel<const Module extends PanelModule>(
  module: Module,
): Module {
  return module;
}

/** Projects a panel-owned module descriptor into Dockview-facing metadata. */
export function panelDefinitionFromModule(
  module: PanelModule,
): PanelDefinition {
  const defaultCapabilities =
    module.focusable === false ? [] : [PANEL_FOCUS_CAPABILITY.id];

  return {
    panelId: module.panelId,
    componentName: module.componentName,
    title: module.title,
    minWidth: module.minWidth,
    minHeight: module.minHeight,
    icon: module.icon,
    capabilities: [...defaultCapabilities, ...(module.capabilities ?? [])],
    showInPalette: module.showInPalette,
    singleton: module.singleton,
    shortcut: module.shortcut,
  };
}
