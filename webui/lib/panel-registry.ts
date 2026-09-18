// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Component Registry
 *
 * This file maintains a registry of components that can be used in the dockview layout.
 * Components must be registered here before they can be used in the dockview.
 */

import type { DockviewPanelApi } from "dockview";
import type { Component } from "solid-js";
import type { AppIcon } from "../components/ui/icon";
import { getLogger } from "./logger";
import type { PanelDefinition } from "./panel-definitions";
import { withPanelFocus } from "./panel-focus-wrapper";

const log = getLogger(import.meta.url);

// Base props that all components will receive
export interface BasePanelComponentProps {
  /** Unique identifier for the component instance */
  id: string;
  /** Dockview panel API for panel-local focus and title updates. */
  panelApi?: DockviewPanelApi;
  /** Additional parameters passed when the component is created */
  params?: Record<string, unknown>;
  /** Index signature to allow additional properties */
  [key: string]: unknown;
}

// Type for Solid components
type SolidComponent<
  P extends BasePanelComponentProps = BasePanelComponentProps,
> = Component<P>;

/**
 * Union type of all possible component types
 */
type AnyComponent<P extends BasePanelComponentProps = BasePanelComponentProps> =
  SolidComponent<P>;

/**
 * Interface for component registration
 */
export interface ComponentRegistration<
  P extends BasePanelComponentProps = BasePanelComponentProps,
> {
  component: AnyComponent<P>;
  /** Optional display name for the component */
  displayName?: string;
  /** Icon to represent the component in the UI */
  icon?: AppIcon;
  /** Optional description of the component's purpose */
  description?: string;
  /** Whether to show the component in the palette */
  showInPalette?: boolean;
}

const defaultOptions: Partial<ComponentRegistration<BasePanelComponentProps>> =
  {
    showInPalette: true,
  };

// Map of component names to component implementations
const componentRegistry = new Map<
  string,
  ComponentRegistration<BasePanelComponentProps>
>();

/**
 * Register a Solid component for use in the dockview layout
 * @param name The unique identifier for this component type
 * @param component The Solid component to render
 * @param options Additional registration options (displayName, description)
 */
export function registerSolidComponent<P extends BasePanelComponentProps>(
  name: string,
  displayName: string,
  component: SolidComponent<P>,
  icon?: AppIcon,
  options?: Omit<Partial<ComponentRegistration<P>>, "component">,
): void {
  if (componentRegistry.has(name)) {
    log.warn(
      `Component '${name}' is already registered. It will be overwritten.`,
    );
  }

  // Wrap the component with panel focus tracking
  const wrappedComponent = withPanelFocus(component as any, {
    componentName: name,
  }) as SolidComponent<BasePanelComponentProps>;

  componentRegistry.set(name, {
    component: wrappedComponent,
    displayName,
    icon,
    ...defaultOptions,
    ...options,
  });
}

/**
 * Register a Solid component from the shared panel definition metadata.
 * @param definition The source-of-truth panel identity and UI metadata
 * @param component The Solid component to render for the definition
 */
export function registerPanelComponent(
  definition: PanelDefinition,
  component: SolidComponent<any>,
): void {
  registerSolidComponent(
    definition.componentName,
    definition.title,
    component,
    definition.icon,
    {
      showInPalette: definition.showInPalette,
    },
  );
}

/**
 * Get a component registration by name from the registry
 * @param name The component name to lookup
 * @returns The component registration or undefined if not found
 */
export function getComponentRegistration<
  P extends BasePanelComponentProps = BasePanelComponentProps,
>(name: string): ComponentRegistration<P> | undefined {
  return componentRegistry.get(name) as ComponentRegistration<P> | undefined;
}

/**
 * Get all registered component names
 * @returns Array of registered component names
 */
export function getComponentNames(): string[] {
  return Array.from(componentRegistry.keys());
}
