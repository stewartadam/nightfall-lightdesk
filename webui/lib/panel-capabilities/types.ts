// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface PanelCapabilityContract<
  Id extends string,
  Payload extends object,
  Metadata = undefined,
> {
  readonly id: Id;
  readonly description: string;
  readonly _payload?: Payload;
  readonly _metadata?: Metadata;
}

export type PanelCapabilityContractInstance = PanelCapabilityContract<
  string,
  object,
  unknown
>;

export type PanelCapabilityId = PanelCapabilityContractInstance["id"];

export type PanelCapabilityPayload<
  Contract extends PanelCapabilityContractInstance,
> = NonNullable<Contract["_payload"]>;

export type PanelCapabilityMetadata<
  Contract extends PanelCapabilityContractInstance,
> = Contract["_metadata"];

export type PanelCapabilityRequest<
  Contract extends PanelCapabilityContractInstance,
> = PanelCapabilityPayload<Contract> & {
  requestId: number;
};

export type PanelCapabilityHandler<
  Contract extends PanelCapabilityContractInstance,
> = (request: PanelCapabilityRequest<Contract>) => void;

export type PanelCapabilityPredicate<
  Contract extends PanelCapabilityContractInstance,
> = (payload: PanelCapabilityPayload<Contract>) => boolean;

export interface PanelCapabilityRegistrationOptions<
  Contract extends PanelCapabilityContractInstance,
> {
  accepts?: PanelCapabilityPredicate<Contract>;
  metadata?: PanelCapabilityMetadata<Contract>;
}

export interface PanelCapabilityRegistrationSnapshot<
  Contract extends PanelCapabilityContractInstance,
> {
  panelId: string;
  metadata?: PanelCapabilityMetadata<Contract>;
}
