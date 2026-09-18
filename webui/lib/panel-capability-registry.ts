// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { getLogger } from "./logger";
import {
  isPanelCapabilityId,
  type PanelCapabilityContractInstance,
  type PanelCapabilityHandler,
  type PanelCapabilityPayload,
  type PanelCapabilityRegistrationOptions,
  type PanelCapabilityRegistrationSnapshot,
  type PanelCapabilityRequest,
} from "./panel-capabilities";
import {
  findPanelDefinitionById,
  panelDefinitionHasCapability,
} from "./panel-definitions";

const log = getLogger(import.meta.url);

interface StoredPanelCapabilityRegistration {
  handler: (
    request: PanelCapabilityRequest<PanelCapabilityContractInstance>,
  ) => void;
  accepts?: (
    payload: PanelCapabilityPayload<PanelCapabilityContractInstance>,
  ) => boolean;
  metadata?: unknown;
}

type PanelCapabilityHandlers = Record<
  string,
  StoredPanelCapabilityRegistration | undefined
>;

interface PendingPanelCapabilityRequest {
  capability: PanelCapabilityContractInstance;
  request: PanelCapabilityRequest<PanelCapabilityContractInstance>;
}

export interface PanelCapabilityRegistry {
  registerPanelCapability: <Contract extends PanelCapabilityContractInstance>(
    panelId: string,
    capability: Contract,
    handler: PanelCapabilityHandler<Contract>,
    options?: PanelCapabilityRegistrationOptions<Contract>,
  ) => () => void;
  invokePanelCapability: <Contract extends PanelCapabilityContractInstance>(
    panelId: string,
    capability: Contract,
    payload: PanelCapabilityPayload<Contract>,
  ) => number;
  getPanelCapabilityRegistrations: <
    Contract extends PanelCapabilityContractInstance,
  >(
    capability: Contract,
  ) => ReadonlyMap<string, PanelCapabilityRegistrationSnapshot<Contract>>;
}

export type PanelCapabilityDeclarationStatus =
  | "declared"
  | "dynamic-capability"
  | "undeclared-capability"
  | "unknown-panel";

/** Returns the pending queue key for a panel capability. */
function panelCapabilityKey(
  panelId: string,
  capability: PanelCapabilityContractInstance,
): string {
  return `${panelId}:${capability.id}`;
}

/** Returns whether a registration accepts a dispatch payload. */
function panelCapabilityRegistrationAccepts<
  Contract extends PanelCapabilityContractInstance,
>(
  registration: StoredPanelCapabilityRegistration,
  payload: PanelCapabilityPayload<Contract>,
): boolean {
  return registration.accepts?.(payload) !== false;
}

/** Returns whether a static panel definition declares a capability contract. */
export function panelCapabilityDeclarationStatus(
  panelId: string,
  capability: PanelCapabilityContractInstance,
): PanelCapabilityDeclarationStatus {
  const definition = findPanelDefinitionById(panelId);
  if (!definition) {
    return "unknown-panel";
  }

  if (!isPanelCapabilityId(capability.id)) {
    return "dynamic-capability";
  }

  if (panelDefinitionHasCapability(definition, capability.id)) {
    return "declared";
  }

  return "undeclared-capability";
}

/** Warns when a static panel definition does not declare a capability. */
function warnIfPanelDoesNotDeclareCapability(
  panelId: string,
  capability: PanelCapabilityContractInstance,
): void {
  const status = panelCapabilityDeclarationStatus(panelId, capability);
  if (status !== "undeclared-capability") return;

  const definition = findPanelDefinitionById(panelId);
  if (!definition) return;

  log.warn(
    `Panel ${panelId} registered or invoked undeclared capability ${capability.id}`,
    {
      componentName: definition.componentName,
      declaredCapabilities: definition.capabilities ?? [],
    },
  );
}

/** Creates the panel capability registry used by the provider. */
export function createPanelCapabilityRegistry(): PanelCapabilityRegistry {
  const registry = new Map<string, PanelCapabilityHandlers>();
  const pendingRequests = new Map<string, PendingPanelCapabilityRequest[]>();
  const [registryRevision, setRegistryRevision] = createSignal(0);
  let nextRequestId = 1;

  /** Marks reactive registry readers stale after registration changes. */
  const bumpRegistryRevision = () => {
    setRegistryRevision((revision) => revision + 1);
  };

  /** Delivers any queued requests now that a panel has registered a handler. */
  const drainPendingRequests = <
    Contract extends PanelCapabilityContractInstance,
  >(
    panelId: string,
    capability: Contract,
    registration: StoredPanelCapabilityRegistration,
  ) => {
    const key = panelCapabilityKey(panelId, capability);
    const queued = pendingRequests.get(key);
    if (!queued) return;

    pendingRequests.delete(key);
    for (const pending of queued) {
      const request = pending.request as PanelCapabilityRequest<Contract>;
      if (!panelCapabilityRegistrationAccepts(registration, request)) {
        continue;
      }
      registration.handler(request);
    }
  };

  /** Registers a named capability handler owned by a panel. */
  const registerPanelCapability = <
    Contract extends PanelCapabilityContractInstance,
  >(
    panelId: string,
    capability: Contract,
    handler: PanelCapabilityHandler<Contract>,
    options: PanelCapabilityRegistrationOptions<Contract> = {},
  ): (() => void) => {
    warnIfPanelDoesNotDeclareCapability(panelId, capability);
    const panelHandlers = { ...(registry.get(panelId) ?? {}) };
    const registration: StoredPanelCapabilityRegistration = {
      handler: handler as StoredPanelCapabilityRegistration["handler"],
      accepts: options.accepts as
        | StoredPanelCapabilityRegistration["accepts"]
        | undefined,
      metadata: options.metadata,
    };
    panelHandlers[capability.id] = registration;
    registry.set(panelId, panelHandlers);
    bumpRegistryRevision();
    drainPendingRequests(panelId, capability, registration);

    return () => {
      const panelHandlers = { ...(registry.get(panelId) ?? {}) };
      if (panelHandlers[capability.id] !== registration) return;

      delete panelHandlers[capability.id];
      if (Object.keys(panelHandlers).length === 0) {
        registry.delete(panelId);
      } else {
        registry.set(panelId, panelHandlers);
      }
      bumpRegistryRevision();
    };
  };

  /** Invokes a named capability on a target panel when that panel exposes it. */
  const invokePanelCapability = <
    Contract extends PanelCapabilityContractInstance,
  >(
    panelId: string,
    capability: Contract,
    payload: PanelCapabilityPayload<Contract>,
  ): number => {
    warnIfPanelDoesNotDeclareCapability(panelId, capability);
    const requestId = nextRequestId++;
    const request = {
      ...payload,
      requestId,
    } as PanelCapabilityRequest<Contract>;
    const registration = registry.get(panelId)?.[capability.id];
    if (registration) {
      if (panelCapabilityRegistrationAccepts(registration, payload)) {
        registration.handler(request);
      }
      return requestId;
    }

    const key = panelCapabilityKey(panelId, capability);
    const queued = pendingRequests.get(key) ?? [];
    queued.push({
      capability,
      request:
        request as PanelCapabilityRequest<PanelCapabilityContractInstance>,
    });
    pendingRequests.set(key, queued);
    return requestId;
  };

  /** Returns registered panels for a capability with typed metadata. */
  const getPanelCapabilityRegistrations = <
    Contract extends PanelCapabilityContractInstance,
  >(
    capability: Contract,
  ): ReadonlyMap<string, PanelCapabilityRegistrationSnapshot<Contract>> => {
    registryRevision();
    const registrations = new Map<
      string,
      PanelCapabilityRegistrationSnapshot<Contract>
    >();
    for (const [panelId, panelHandlers] of registry) {
      const registration = panelHandlers[capability.id];
      if (!registration) continue;
      registrations.set(panelId, {
        panelId,
        metadata:
          registration.metadata as PanelCapabilityRegistrationSnapshot<Contract>["metadata"],
      });
    }
    return registrations;
  };

  return {
    registerPanelCapability,
    invokePanelCapability,
    getPanelCapabilityRegistrations,
  };
}
