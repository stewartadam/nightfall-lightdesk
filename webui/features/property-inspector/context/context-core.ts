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
  type JSX,
  onCleanup,
  useContext,
} from "solid-js";
import type { RenderPropertiesMetadata } from "../../../lib/panel-capabilities";
import { createEffect } from "../../../lib/solid-compat";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { revealPropertiesPanel } from "./reveal-properties-panel";

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
  let unregister: (() => void) | undefined;
  /**
   * Registers while the workspace is active and unregisters when it goes inactive. A label change
   * re-registers in place, updating metadata without clearing selection when the inspector has focus.
   */
  createEffect(
    () =>
      workspaceActive()
        ? { label: typeof label === "function" ? label() : label }
        : undefined,
    (state) => {
      if (!state) {
        unregister?.();
        unregister = undefined;
        return;
      }
      unregister = context.registerProvider({
        id,
        label: state.label,
        priority,
        component,
      });
    },
  );
  onCleanup(() => unregister?.());

  return {
    activate: () => context.activateProvider(id),
    deactivate: () => context.deactivateProvider(id),
    /**
     * Shows this provider in Properties and brings the Properties panel into view, the way a
     * card's settings button does, returning focus to `sourcePanelId` when Properties lives
     * in an edge group.
     */
    reveal: (sourcePanelId: string) => {
      context.activateProvider(id);
      revealPropertiesPanel(sourcePanelId);
    },
  };
};
