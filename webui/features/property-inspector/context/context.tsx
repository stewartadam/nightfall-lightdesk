// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createMemo,
  createSignal,
  onCleanup,
  type ParentComponent,
} from "solid-js";
import { usePanelCapabilityRegistry } from "../../../components/providers/panel-capabilities/context-core";
import { getLogger } from "../../../lib/logger";
import { RENDER_PROPERTIES_CAPABILITY } from "../../../lib/panel-capabilities";
import { createEffect } from "../../../lib/solid-compat";
import { useStore } from "../../../lib/use-nanostore";
import { dockApi } from "../../../state/appStores";
import {
  PropertiesContext,
  type PropertiesContextType,
  type PropertyProvider,
} from "./context-core";

const log = getLogger(import.meta.url);

/** Provides properties inspector state backed by panel capability metadata. */
export const PropertiesContextProvider: ParentComponent = (props) => {
  log.trace("mounting");
  onCleanup(() => log.trace("unmounting"));

  const capabilityRegistry = usePanelCapabilityRegistry();
  const registeredProviderDisposers = new Map<string, () => void>();
  const [activeProviderId, setActiveProviderId] = createSignal<
    string | undefined
  >();

  /** Returns properties-capable panel registrations keyed by panel ID. */
  const providerRegistrations = createMemo(() =>
    capabilityRegistry.getPanelCapabilityRegistrations(
      RENDER_PROPERTIES_CAPABILITY,
    ),
  );

  /** Returns the active properties provider with its registered metadata. */
  const activeProvider = createMemo<PropertyProvider | undefined>(() => {
    const id = activeProviderId();
    if (!id) return undefined;
    const metadata = providerRegistrations().get(id)?.metadata;
    return metadata ? { id, ...metadata } : undefined;
  });

  /** Registers a panel-owned properties renderer through the capability layer. */
  const registerProvider = (provider: PropertyProvider) => {
    registeredProviderDisposers.get(provider.id)?.();
    const unregisterCapability = capabilityRegistry.registerPanelCapability(
      provider.id,
      RENDER_PROPERTIES_CAPABILITY,
      () => {},
      {
        metadata: {
          label: provider.label,
          priority: provider.priority,
          component: provider.component,
        },
      },
    );
    registeredProviderDisposers.set(provider.id, unregisterCapability);

    return () => unregisterProvider(provider.id);
  };

  /** Removes a panel-owned properties renderer from the capability layer. */
  const unregisterProvider = (id: string) => {
    registeredProviderDisposers.get(id)?.();
    registeredProviderDisposers.delete(id);

    if (activeProviderId() === id) {
      setActiveProviderId(undefined);
    }
  };

  /** Activates a registered provider by panel ID. */
  const activateProvider = (id: string) => {
    if (providerRegistrations().has(id)) {
      setActiveProviderId(id);
    }
  };

  /** Deactivates a registered provider by panel ID. */
  const deactivateProvider = (id: string) => {
    if (activeProviderId() === id) {
      setActiveProviderId(undefined);
    }
  };

  const contextValue: PropertiesContextType = {
    activeProvider,
    registerProvider,
    unregisterProvider,
    activateProvider,
    deactivateProvider,
  };

  const $api = useStore(dockApi);
  const [lastInspectedPanelId, setLastInspectedPanelId] = createSignal<
    string | undefined
  >();

  /** Syncs the properties panel with Dockview active panel changes. */
  createEffect($api, (api) => {
    if (!api) return;
    const dispose = api.onDidActivePanelChange((event) => {
      const panelId = event.panel?.id;
      if (!panelId || panelId === "panel-PropertiesInspector") {
        return;
      }
      setLastInspectedPanelId(panelId);
      if (providerRegistrations().has(panelId)) {
        setActiveProviderId(panelId);
      } else {
        setActiveProviderId(undefined);
      }
    });
    return () => dispose.dispose();
  });

  /**
   * Handles panels that register their properties after Dockview restore or
   * after they became active. While the inspector itself is focused, the panel
   * it inspects is the last other panel that was active.
   */
  createEffect(
    () => {
      const api = $api();
      if (!api) return undefined;
      const currentPanelId = api.activePanel?.id;
      return {
        providers: providerRegistrations(),
        inspectedPanelId:
          currentPanelId === "panel-PropertiesInspector"
            ? lastInspectedPanelId()
            : currentPanelId,
        activeId: activeProviderId(),
      };
    },
    (state) => {
      if (
        state?.inspectedPanelId &&
        state.providers.has(state.inspectedPanelId) &&
        state.activeId !== state.inspectedPanelId
      ) {
        setActiveProviderId(state.inspectedPanelId);
      }
    },
  );

  onCleanup(() => {
    for (const unregister of registeredProviderDisposers.values()) {
      unregister();
    }
    registeredProviderDisposers.clear();
  });

  return (
    <PropertiesContext.Provider value={contextValue}>
      {props.children}
    </PropertiesContext.Provider>
  );
};
