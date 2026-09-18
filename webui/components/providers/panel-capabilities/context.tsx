// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** @jsxImportSource solid-js */
import type { ParentComponent } from "solid-js";
import {
  createPanelCapabilityRegistry,
  PanelCapabilityRegistryContext,
} from "./context-core";

export {
  createPanelCapabilityRegistry,
  type PanelCapabilityDeclarationStatus,
  type PanelCapabilityHandler,
  type PanelCapabilityPayload,
  type PanelCapabilityRegistrationOptions,
  type PanelCapabilityRegistry,
  type PanelCapabilityRequest,
  panelCapabilityDeclarationStatus,
  type ShowfileObjectRevealPayload,
  usePanelCapability,
  usePanelCapabilityRegistry,
  useRevealObjectCapability,
} from "./context-core";

/** Provides typed panel-to-panel capability dispatch for panel-owned UI work. */
export const PanelCapabilityRegistryProvider: ParentComponent = (props) => {
  const registry = createPanelCapabilityRegistry();

  return (
    <PanelCapabilityRegistryContext.Provider value={registry}>
      {props.children}
    </PanelCapabilityRegistryContext.Provider>
  );
};
