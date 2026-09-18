// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Core property inspector context shared by TSX providers and panel hooks.
 *
 * This non-JSX module exists to keep the property context identity and hook
 * exports outside Solid's hot module replacement boundary for rendered
 * components. If these exports live in the TSX inspector provider module, HMR
 * can reload the component file and recreate context-level objects while panels
 * still hold references from the previous module instance, which breaks
 * property provider registration during development.
 */
import {
  type Accessor,
  createContext,
  createEffect,
  type JSX,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";
import type { RenderPropertiesMetadata } from "../../../lib/panel-capabilities";

import { useWorkspaceActivity } from "../../../lib/workspace-activity";

export interface PropertyProvider extends RenderPropertiesMetadata {
  id: string;
}

export interface PropertiesContextType {
  activeProvider: Accessor<PropertyProvider | undefined>;
  registerProvider: (provider: PropertyProvider) => () => void;
  unregisterProvider: (id: string) => void;
  activateProvider: (id: string) => void;
  deactivateProvider: (id: string) => void;
}

export const PropertiesContext = createContext<PropertiesContextType>();

/** Returns the current properties inspector context. */
export const usePropertiesContext = () => {
  const context = useContext(PropertiesContext);
  if (!context) {
    throw new Error(
      "usePropertiesContext must be used within a PropertiesProvider",
    );
  }
  return context;
};

/** Registers a panel as a properties inspector provider. */
export const usePropertiesInspector = (
  id: string,
  label: string | Accessor<string>,
  component: () => JSX.Element,
  options: { priority?: number; autoActivate?: boolean } = {},
) => {
  const context = usePropertiesContext();
  const { priority = 0 } = options;

  const workspaceActive = useWorkspaceActivity();
  /** Exposes properties only for panels in the active workspace. */
  createEffect(() => {
    if (!workspaceActive()) return;
    let unregister: (() => void) | undefined;
    /** Updates metadata without clearing selection when the inspector itself has focus. */
    createEffect(() => {
      const currentLabel = typeof label === "function" ? label() : label;
      unregister = untrack(() =>
        context.registerProvider({
          id,
          label: currentLabel,
          priority,
          component,
        }),
      );
    });
    onCleanup(() => unregister?.());
  });

  return {
    activate: () => context.activateProvider(id),
    deactivate: () => context.deactivateProvider(id),
  };
};
