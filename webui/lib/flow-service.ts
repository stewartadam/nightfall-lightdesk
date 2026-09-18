// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { flows, pushToast } from "../state/appStores";
import type * as types from "../types/index";
import { engineRuntime } from "./engine-runtime";
import { applyFlowDeltaToDefinition } from "./flow-delta";
import { getLogger } from "./logger";
import { setStoreKeyAction } from "./nanostore-action";

const log = getLogger(import.meta.url);

export function createDefaultFlow(
  id: number,
  label?: string,
): types.FlowDefinition {
  return {
    identifiers: {
      id,
      uid: crypto.randomUUID(),
      label: label ?? `Flow ${id}`,
    },
    flow_version: 0,
    nodes: [],
    edges: [],
  };
}

export function storeFlow(flow: types.FlowDefinition): void {
  const command: types.FlowCommand = {
    type: "StoreFlow",
    data: flow,
  };
  engineRuntime.sendCommand({ module: "FlowCommand", command });
  log.info(`Stored flow ${flow.identifiers.id}:`, flow);
}
export function deleteFlow(id: number): void {
  const command: types.FlowCommand = {
    type: "DeleteFlow",
    data: id,
  };
  engineRuntime.sendCommand({ module: "FlowCommand", command });
  log.info(`Deleted flow ${id}`);
}

export function applyFlowDelta(flowUid: string, delta: types.FlowDelta): void {
  const flowMap = flows.get();
  const flow = flowMap[flowUid];
  if (!flow) {
    log.warn(`Missing flow for delta ${delta.flow_id}`);
    return;
  }

  const rebasedDelta =
    delta.base_version === flow.flow_version
      ? delta
      : { ...delta, base_version: flow.flow_version };

  const result = applyFlowDeltaToDefinition(flow, rebasedDelta);
  if (result.errors.length > 0) {
    result.errors.forEach((message) => {
      pushToast("error", message);
    });
  }

  if (!result.applied) {
    return;
  }

  setStoreKeyAction(flows, "Apply Flow Delta", flowUid, result.flow);

  const command: types.FlowCommand = {
    type: "ApplyDelta",
    data: rebasedDelta,
  };
  engineRuntime.sendCommand({ module: "FlowCommand", command });
}
