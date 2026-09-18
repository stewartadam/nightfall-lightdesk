// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { batch } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import "@dschz/solid-flow/styles";
import { getLogger } from "../../../lib/logger";
import type * as types from "../../../types/index";

const log = getLogger(import.meta.url);

import type { SolidFlowEdge, SolidFlowNode } from "../model/graph-types";
import {
  buildNodeDimensions,
  calculateBestLayout,
  centerToTopLeft,
  edgeIdForDefinition,
  portHandleId,
} from "../model/utils";
export type NodeHandlers = {
  onUpdatePortDefault: (
    nodeId: types.FlowNodeId,
    port: types.FlowPortDefinition,
    value: types.FlowValue,
  ) => void;
  onCutNode: (nodeId: types.FlowNodeId) => void;
  onDuplicateNode: (nodeId: types.FlowNodeId) => void;
  onDeleteNode: (nodeId: types.FlowNodeId) => void;
};

let nodeHandlersContext: NodeHandlers = {
  onUpdatePortDefault: () => {},
  onCutNode: () => {},
  onDuplicateNode: () => {},
  onDeleteNode: () => {},
};

export function setNodeHandlers(handlers: NodeHandlers) {
  nodeHandlersContext = handlers;
}

export function useNodeHandlers(): NodeHandlers {
  return nodeHandlersContext;
}

/**
 * Checks whether a flow needs first-load layout because every node lacks saved position data.
 */
export function flowNeedsAutoLayout(flow: types.FlowDefinition): boolean {
  if (flow.nodes.length === 0) return false;
  // A flow needs auto-layout if ALL nodes lack position data
  return flow.nodes.every((node) => node.position == null);
}

export function buildNodes(
  flow: types.FlowDefinition,
  connectedInputs: Set<string>,
  labelOverrides?: Map<types.FlowNodeId, string>,
  selectedNodeId?: types.FlowNodeId | null,
): SolidFlowNode[] {
  const selectedIds =
    selectedNodeId !== undefined && selectedNodeId !== null
      ? new Set([selectedNodeId])
      : new Set<number>();

  return flow.nodes.map((node, index) => {
    const inputs = node.ports
      .filter((port) => port.direction === "input")
      .map((port, portIndex) => ({
        port,
        handleId: portHandleId(port.port_id),
        index: portIndex,
        isConnected: connectedInputs.has(`${node.node_id}:${port.port_id}`),
      }));
    const outputs = node.ports
      .filter((port) => port.direction === "output")
      .map((port, portIndex) => ({
        port,
        handleId: portHandleId(port.port_id),
        index: portIndex,
        isConnected: false,
      }));

    const position = node.position ?? {
      x: 80 + (index % 3) * 280,
      y: 60 + Math.floor(index / 3) * 220,
    };

    return {
      id: `node-${node.node_id}`,
      type: "flowNode" as const,
      position: { x: position.x, y: position.y },
      selected: selectedIds.has(node.node_id),
      dragHandle: ".flow-node-drag",
      data: {
        label: labelOverrides?.get(node.node_id) ?? node.label,
        nodeId: node.node_id,
        nodeKind: node.kind,
        inputs,
        outputs,
        pulse: false,
      },
    };
  });
}

export function buildEdges(flow: types.FlowDefinition): SolidFlowEdge[] {
  return flow.edges.map((edge) => {
    return {
      id: edgeIdForDefinition(edge),
      source: `node-${edge.from.node_id}`,
      target: `node-${edge.to.node_id}`,
      sourceHandle: portHandleId(edge.from.port_id),
      targetHandle: portHandleId(edge.to.port_id),
      type: "labeled" as const,
      data: { edge },
    };
  });
}

/**
 * Perform auto-layout on nodes. Returns the layout operations to send to backend.
 * Requires nodes to have measurements for best results.
 */
export function performAutoLayout(
  nodes: SolidFlowNode[],
  edges: SolidFlowEdge[],
  setNodes: SetStoreFunction<SolidFlowNode[]>,
): types.FlowDeltaOp[] {
  if (nodes.length === 0) return [];

  // Convert to layout format
  const layoutNodes = nodes.map((node) => ({
    id: node.id,
    measured: node.measured,
  }));
  const layoutEdges = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));

  // Calculate best layout
  const result = calculateBestLayout(layoutNodes, layoutEdges);
  const nodeDimensions = buildNodeDimensions(layoutNodes);
  const topLeftPositions = centerToTopLeft(result.positions, nodeDimensions);

  log.info(
    "Auto-layout selected",
    result.algorithmName,
    "with",
    result.crossings,
    "crossings",
  );

  // Apply layout
  const layoutOps: types.FlowDeltaOp[] = [];

  batch(() => {
    nodes.forEach((node, index) => {
      const newPosition = topLeftPositions.get(node.id);
      if (!newPosition) return;

      const nodeIdMatch = node.id.match(/^node-(\d+)$/);
      if (!nodeIdMatch) return;

      const nodeId = Number.parseInt(nodeIdMatch[1] ?? "", 10);

      layoutOps.push({
        type: "UpdateNode",
        data: {
          node_id: nodeId,
          position: newPosition,
        },
      });

      setNodes(index, "position", newPosition);
    });
  });

  return layoutOps;
}
