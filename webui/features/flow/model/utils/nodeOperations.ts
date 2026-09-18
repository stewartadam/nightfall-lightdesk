// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Node operation utilities for flow editor.
 * Handles clipboard operations, node duplication, and edge management.
 */

import { pushToast } from "../../../../state/appStores";
import type {
  FlowDefinition,
  FlowDeltaOp,
  FlowEdgeDefinition,
  FlowNodeDefinition,
  FlowNodeId,
  FlowPortRef,
} from "../../../../types/index";
import { parsePortHandleId } from "./portUtils";

/**
 * Clipboard payload format for flow nodes.
 */
export type FlowNodeClipboardPayload = {
  type: "flow-node";
  node: FlowNodeDefinition;
};

/**
 * Generate an edge ID from an edge definition.
 */
export function edgeIdForDefinition(edge: FlowEdgeDefinition): string {
  return `edge-${edge.from.node_id}-${edge.from.port_id}-${edge.to.node_id}-${edge.to.port_id}`;
}

/**
 * Parse an edge definition from an edge ID string.
 * Returns null if the ID is invalid.
 */
export function edgeDefinitionFromId(id: string): FlowEdgeDefinition | null {
  const match = id.match(/edge-(\d+)-(\d+)-(\d+)-(\d+)$/);
  if (!match) return null;
  return {
    from: {
      node_id: Number.parseInt(match[1] ?? "", 10),
      port_id: Number.parseInt(match[2] ?? "", 10),
    },
    to: {
      node_id: Number.parseInt(match[3] ?? "", 10),
      port_id: Number.parseInt(match[4] ?? "", 10),
    },
  };
}

/**
 * Convert a node ID string and handle ID to a port reference.
 * Returns null if either ID is invalid.
 */
export function toPortRef(
  nodeId: string,
  handleId?: string | null,
): FlowPortRef | null {
  const portId = parsePortHandleId(handleId);
  if (portId === null) return null;
  const nodeMatch = nodeId.match(/^node-(\d+)$/);
  if (!nodeMatch) return null;
  return {
    node_id: Number.parseInt(nodeMatch[1] ?? "", 10),
    port_id: portId,
  };
}

/**
 * Find all edges connected to a node (both incoming and outgoing).
 */
function findConnectedEdges(
  nodeId: FlowNodeId,
  edges: FlowEdgeDefinition[],
): FlowEdgeDefinition[] {
  return edges.filter(
    (edge) => edge.from.node_id === nodeId || edge.to.node_id === nodeId,
  );
}

/**
 * Build delta operations to delete a node and its connected edges.
 */
export function buildDeleteNodeOps(
  nodeId: FlowNodeId,
  flow: FlowDefinition,
): FlowDeltaOp[] {
  const connectedEdges = findConnectedEdges(nodeId, flow.edges);
  const ops: FlowDeltaOp[] = connectedEdges.map((edge) => ({
    type: "RemoveEdge",
    data: { from: { ...edge.from }, to: { ...edge.to } },
  }));
  ops.push({
    type: "RemoveNode",
    data: { node_id: nodeId },
  });
  return ops;
}

/**
 * Get the next available node ID for a flow.
 */
export function getNextNodeId(flow: FlowDefinition): FlowNodeId {
  return flow.nodes.reduce((max, node) => Math.max(max, node.node_id), 0) + 1;
}

/**
 * Create a duplicate of a node with a new ID and offset position.
 */
export function duplicateNodeDefinition(
  sourceNode: FlowNodeDefinition,
  nextNodeId: FlowNodeId,
  offset: { x: number; y: number } = { x: 40, y: 40 },
): FlowNodeDefinition {
  const position = sourceNode.position ?? { x: 0, y: 0 };
  return {
    node_id: nextNodeId,
    kind: sourceNode.kind,
    label: sourceNode.label,
    ports: sourceNode.ports.map((port) => ({
      ...port,
      default_value: port.default_value ? { ...port.default_value } : undefined,
    })),
    position: { x: position.x + offset.x, y: position.y + offset.y },
  };
}

/**
 * Copy a node to the clipboard.
 */
export async function copyNodeToClipboard(
  node: FlowNodeDefinition,
): Promise<boolean> {
  if (!navigator?.clipboard?.writeText) {
    pushToast("error", "Clipboard access unavailable");
    return false;
  }

  const payload: FlowNodeClipboardPayload = {
    type: "flow-node",
    node,
  };

  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    pushToast("success", "Node copied to clipboard");
    return true;
  } catch {
    pushToast("error", "Failed to copy node to clipboard");
    return false;
  }
}

/**
 * Read a node from the clipboard.
 * Returns null if clipboard is empty or contains invalid data.
 */
export async function readNodeFromClipboard(): Promise<FlowNodeClipboardPayload | null> {
  if (!navigator?.clipboard?.readText) {
    pushToast("error", "Clipboard access unavailable");
    return null;
  }

  try {
    const text = await navigator.clipboard.readText();
    const payload = JSON.parse(text) as unknown;

    // Validate payload structure
    if (
      typeof payload === "object" &&
      payload !== null &&
      "type" in payload &&
      payload.type === "flow-node" &&
      "node" in payload &&
      typeof payload.node === "object"
    ) {
      return payload as FlowNodeClipboardPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a set of connected input ports for a flow.
 * Format: "nodeId:portId"
 */
export function buildConnectedInputsSet(flow: FlowDefinition): Set<string> {
  return new Set(
    flow.edges.map((edge) => `${edge.to.node_id}:${edge.to.port_id}`),
  );
}
