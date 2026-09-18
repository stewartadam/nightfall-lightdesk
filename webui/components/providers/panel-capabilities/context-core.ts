// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Core panel capability registry context shared by TSX providers and hooks.
 *
 * This non-JSX module keeps registry hooks outside Solid's rendered-component
 * refresh registry. Vite can still cache-bust this dependency when only an
 * importer is hot-updated, so the context identity is also retained explicitly
 * through Vite's per-module hot data.
 */
import {
  type Context,
  createContext,
  createEffect,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";
import {
  type PanelCapabilityContractInstance,
  type PanelCapabilityHandler,
  type PanelCapabilityPayload,
  type PanelCapabilityRegistrationOptions,
  type PanelCapabilityRequest,
  REVEAL_OBJECT_CAPABILITY,
  type RevealObjectCapability,
} from "../../../lib/panel-capabilities";
import {
  createPanelCapabilityRegistry,
  type PanelCapabilityDeclarationStatus,
  type PanelCapabilityRegistry,
  panelCapabilityDeclarationStatus,
} from "../../../lib/panel-capability-registry";

import { useWorkspaceActivity } from "../../../lib/workspace-activity";

export type {
  PanelCapabilityHandler,
  PanelCapabilityPayload,
  PanelCapabilityRegistrationOptions,
  PanelCapabilityRequest,
};
export {
  createPanelCapabilityRegistry,
  type PanelCapabilityDeclarationStatus,
  type PanelCapabilityRegistry,
  panelCapabilityDeclarationStatus,
};

export type ShowfileObjectRevealPayload =
  PanelCapabilityPayload<RevealObjectCapability>;

type PanelCapabilityRegistryHotData = {
  panelCapabilityRegistryContext?: Context<PanelCapabilityRegistry | undefined>;
};

const hotData = import.meta.hot?.data as
  | PanelCapabilityRegistryHotData
  | undefined;

export const PanelCapabilityRegistryContext =
  hotData?.panelCapabilityRegistryContext ??
  createContext<PanelCapabilityRegistry>();

if (hotData) {
  // Importer-only updates can re-evaluate this module without disposing it first.
  hotData.panelCapabilityRegistryContext ??= PanelCapabilityRegistryContext;
}

/** Returns the app-wide typed panel capability registry. */
export function usePanelCapabilityRegistry(): PanelCapabilityRegistry {
  const context = useContext(PanelCapabilityRegistryContext);
  if (!context) {
    throw new Error(
      "usePanelCapabilityRegistry must be used within PanelCapabilityRegistryProvider",
    );
  }
  return context;
}

/** Registers a typed capability handler for the lifetime of the owning panel. */
export function usePanelCapability<
  Contract extends PanelCapabilityContractInstance,
>(
  panelId: string,
  capability: Contract,
  handler: PanelCapabilityHandler<Contract>,
  options?: PanelCapabilityRegistrationOptions<Contract>,
): void {
  const { registerPanelCapability } = usePanelCapabilityRegistry();
  const workspaceActive = useWorkspaceActivity();
  /** Prevents hidden copies of a panel from receiving active-workspace requests. */
  createEffect(() => {
    if (!workspaceActive()) return;
    const unregister = untrack(() =>
      registerPanelCapability(panelId, capability, handler, options),
    );
    onCleanup(unregister);
  });
}

/** Registers a reveal-object handler for compatibility with existing panels. */
export function useRevealObjectCapability(
  panelId: string,
  handler: PanelCapabilityHandler<RevealObjectCapability>,
  options?: PanelCapabilityRegistrationOptions<RevealObjectCapability>,
): void {
  usePanelCapability(panelId, REVEAL_OBJECT_CAPABILITY, handler, options);
}
