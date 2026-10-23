// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  flowDefinitionsRevision,
  flowNodeTemplates,
  flowPortValues,
  flows,
  flowTriggerTicks,
  pushToast,
} from "../../state/appStores";
import type * as flowTypes from "../../types/index";
import { applyFlowDeltaToDefinition } from "../flow-delta";
import { createLogger, getLogger } from "../logger";
import { setStoreAction, setStoreKeyAction } from "../nanostore-action";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);
const flowLog = createLogger("flow");

/** Registers flow definition, graph delta, acknowledgement, and runtime value handlers. */
export function registerFlowHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("FlowDefinitions", (message) => {
    setStoreAction(
      flows,
      "Receive FlowDefinitions",
      arrayToUidMap(message.data),
    );
    setStoreAction(
      flowDefinitionsRevision,
      "Advance Flow Definitions Revision",
      flowDefinitionsRevision.get() + 1,
    );
  });

  registry.register("FlowNodeTemplates", (message) => {
    setStoreAction(
      flowNodeTemplates,
      "Receive FlowNodeTemplates",
      message.data,
    );
  });

  registry.register("FlowCommand", (message) => {
    handleFlowCommand(message.data as unknown as flowTypes.FlowCommand);
  });

  registry.register("FlowDelta", (message) => {
    handleFlowDelta(message.data as unknown as flowTypes.FlowDelta);
  });

  registry.register("FlowAck", (message) => {
    handleFlowAck(message.data as unknown as flowTypes.FlowAck);
  });

  registry.register("FlowSnapshot", (message) => {
    handleFlowSnapshot(message.data as unknown as flowTypes.FlowSnapshot);
  });

  registry.register("FlowPortValueDelta", (message) => {
    const delta = message.data as unknown as flowTypes.FlowPortValueDelta;
    updateFlowPortValue(
      delta.flow_id,
      delta.node_id,
      delta.port_id,
      delta.value,
    );
  });

  registry.register("FlowTriggerDelta", (message) => {
    handleFlowTriggerDelta(
      message.data as unknown as flowTypes.FlowTriggerDelta,
    );
  });
}

/** Ignores optimistic flow CRUD commands in favor of backend provider snapshots. */
function handleFlowCommand(command: flowTypes.FlowCommand) {
  log.trace("Handling FlowCommand:", command);

  // CRUD commands (StoreFlow, RenameFlow, DeleteFlow) are not processed here.
  // Instead, we receive full FlowDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  log.trace(
    "Ignoring FlowCommand (handled via FlowDefinitions):",
    command.type,
  );
}

/**
 * Applies a backend flow delta when it matches the local base version.
 *
 * Deltas with stale or future base versions are skipped so the UI does not
 * apply edits onto the wrong graph revision.
 */
function handleFlowDelta(delta: flowTypes.FlowDelta) {
  const flowMap = flows.get();
  const flowEntry = Object.entries(flowMap).find(
    ([, flow]) => flow.identifiers.id === delta.flow_id,
  );
  if (!flowEntry) {
    log.warn(`Flow ${delta.flow_id} not found for delta`);
    return;
  }
  const [flowUid, flow] = flowEntry;
  if (flow.flow_version !== delta.base_version) {
    return;
  }
  const result = applyFlowDeltaToDefinition(flow, delta);
  if (result.errors.length > 0) {
    result.errors.forEach((message) => {
      pushToast("error", message);
    });
  }
  if (result.applied) {
    setStoreKeyAction(flows, "Apply Backend Flow Delta", flowUid, result.flow);
  }
}

/**
 * Reports backend flow acknowledgement errors and repairs the local version marker.
 */
function handleFlowAck(ack: flowTypes.FlowAck) {
  if (ack.errors.length > 0) {
    flowLog.warn("Flow ack errors", ack);
    ack.errors.forEach((err) => {
      pushToast("error", err.message);
    });
    // On error, sync version from backend to recover.
    // Note: local data may be out of sync - a page refresh may be needed.
    const flowMap = flows.get();
    const flowEntry = Object.entries(flowMap).find(
      ([, flow]) => flow.identifiers.id === ack.flow_id,
    );
    if (flowEntry) {
      const localVersion = flowEntry[1].flow_version;
      if (ack.applied_version !== localVersion) {
        flowLog.warn(
          `Version desync detected (local=${localVersion} backend=${ack.applied_version}). ` +
            "Syncing version, but data may be stale. Refresh if issues persist.",
        );
        setStoreKeyAction(
          flows,
          "Repair Flow Ack Version",
          `${flowEntry[0]}.flow_version`,
          ack.applied_version,
        );
      }
    }
  }
  // On success: do nothing - optimistic update already set the version correctly.
  // Updating here could cause version to go backwards if ACKs arrive out of order.
}

/** Stores the latest runtime value for a single flow node port. */
function updateFlowPortValue(
  flowId: number,
  nodeId: number,
  portId: number,
  value: flowTypes.FlowValue,
) {
  const current = flowPortValues.get();
  const flowValues = current[flowId] ?? {};
  const portKey = `${nodeId}:${portId}`;
  setStoreAction(flowPortValues, "Receive Flow Port Value", {
    ...current,
    [flowId]: {
      ...flowValues,
      [portKey]: value,
    },
  });
}

/** Replaces all known runtime port values for one flow from a backend snapshot. */
function handleFlowSnapshot(snapshot: flowTypes.FlowSnapshot) {
  const flowValues: Record<string, flowTypes.FlowValue> = {};
  for (const port of snapshot.ports) {
    flowValues[`${port.node_id}:${port.port_id}`] = port.value;
  }
  const current = flowPortValues.get();
  setStoreAction(flowPortValues, "Receive FlowSnapshot", {
    ...current,
    [snapshot.flow_id]: flowValues,
  });
}

/** Records the timestamp of a flow trigger pulse so the UI can animate it. */
function handleFlowTriggerDelta(delta: flowTypes.FlowTriggerDelta) {
  const current = flowTriggerTicks.get();
  const flowTicks = current[delta.flow_id] ?? {};
  setStoreAction(flowTriggerTicks, "Receive FlowTriggerDelta", {
    ...current,
    [delta.flow_id]: {
      ...flowTicks,
      [delta.node_id]: Date.now(),
    },
  });
}
