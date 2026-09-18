// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";

export type FlowDeltaApplyResult = {
  flow: types.FlowDefinition;
  errors: string[];
  applied: boolean;
};

const samePortRef = (a: types.FlowPortRef, b: types.FlowPortRef): boolean =>
  a.node_id === b.node_id && a.port_id === b.port_id;

const sameEdge = (
  a: types.FlowEdgeDefinition,
  b: types.FlowEdgeDefinition,
): boolean => samePortRef(a.from, b.from) && samePortRef(a.to, b.to);

const findPort = (
  flow: types.FlowDefinition,
  nodeId: types.FlowNodeId,
  portId: types.FlowPortId,
): types.FlowPortDefinition | undefined => {
  const node = flow.nodes.find((entry) => entry.node_id === nodeId);
  return node?.ports.find((port) => port.port_id === portId);
};

export function applyFlowDeltaToDefinition(
  flow: types.FlowDefinition,
  delta: types.FlowDelta,
): FlowDeltaApplyResult {
  const errors: string[] = [];

  if (delta.flow_id !== flow.identifiers.id) {
    errors.push(
      `Delta rejected by webui: flow_id mismatch (delta=${delta.flow_id} webui=${flow.identifiers.id})`,
    );
    return { flow, errors, applied: false };
  }

  if (delta.base_version !== flow.flow_version) {
    errors.push(
      `Delta rejected by webui: base_version mismatch (delta=${delta.base_version} webui=${flow.flow_version})`,
    );
    return { flow, errors, applied: false };
  }

  let changed = false;
  const nextFlow: types.FlowDefinition = {
    ...flow,
    nodes: flow.nodes.map((node) => ({ ...node, ports: [...node.ports] })),
    edges: flow.edges.map((edge) => ({
      ...edge,
      from: { ...edge.from },
      to: { ...edge.to },
    })),
  };

  delta.ops.forEach((op, opIndex) => {
    switch (op.type) {
      case "AddNode": {
        if (nextFlow.nodes.some((node) => node.node_id === op.data.node_id)) {
          errors.push(`op ${opIndex}: node ${op.data.node_id} already exists`);
          return;
        }
        nextFlow.nodes = [...nextFlow.nodes, op.data];
        changed = true;
        break;
      }
      case "UpdateNode": {
        const index = nextFlow.nodes.findIndex(
          (node) => node.node_id === op.data.node_id,
        );
        if (index === -1) {
          errors.push(`op ${opIndex}: node ${op.data.node_id} not found`);
          return;
        }
        const existing = nextFlow.nodes[index];
        nextFlow.nodes[index] = {
          ...existing,
          label: op.data.label ?? existing.label,
          position: op.data.position ?? existing.position,
        };
        changed = true;
        break;
      }
      case "RemoveNode": {
        const index = nextFlow.nodes.findIndex(
          (node) => node.node_id === op.data.node_id,
        );
        if (index === -1) {
          errors.push(`op ${opIndex}: node ${op.data.node_id} not found`);
          return;
        }
        nextFlow.nodes = nextFlow.nodes.filter(
          (node) => node.node_id !== op.data.node_id,
        );
        nextFlow.edges = nextFlow.edges.filter(
          (edge) =>
            edge.from.node_id !== op.data.node_id &&
            edge.to.node_id !== op.data.node_id,
        );
        changed = true;
        break;
      }
      case "AddEdge": {
        if (nextFlow.edges.some((edge) => sameEdge(edge, op.data))) {
          return;
        }
        const fromPort = findPort(
          nextFlow,
          op.data.from.node_id,
          op.data.from.port_id,
        );
        const toPort = findPort(
          nextFlow,
          op.data.to.node_id,
          op.data.to.port_id,
        );
        if (!fromPort || !toPort) {
          errors.push(`op ${opIndex}: edge ports not found`);
          return;
        }
        if (fromPort.direction !== "output" || toPort.direction !== "input") {
          errors.push(`op ${opIndex}: invalid port directions`);
          return;
        }
        nextFlow.edges = [...nextFlow.edges, op.data];
        changed = true;
        break;
      }
      case "RemoveEdge": {
        const before = nextFlow.edges.length;
        nextFlow.edges = nextFlow.edges.filter(
          (edge) => !sameEdge(edge, op.data),
        );
        if (nextFlow.edges.length === before) {
          errors.push(`op ${opIndex}: edge not found`);
          return;
        }
        changed = true;
        break;
      }
      case "UpdatePortConfig": {
        const nodeIndex = nextFlow.nodes.findIndex(
          (node) => node.node_id === op.data.node_id,
        );
        if (nodeIndex === -1) {
          errors.push(`op ${opIndex}: node ${op.data.node_id} not found`);
          return;
        }
        const node = nextFlow.nodes[nodeIndex];
        const portIndex = node.ports.findIndex(
          (port) => port.port_id === op.data.port_id,
        );
        if (portIndex === -1) {
          errors.push(`op ${opIndex}: port ${op.data.port_id} not found`);
          return;
        }
        const port = node.ports[portIndex];
        node.ports[portIndex] = {
          ...port,
          name: op.data.name ?? port.name,
          default_value: op.data.default_value ?? port.default_value,
        };
        nextFlow.nodes[nodeIndex] = { ...node };
        changed = true;
        break;
      }
    }
  });

  if (changed) {
    nextFlow.flow_version = nextFlow.flow_version + 1;
  }

  return { flow: nextFlow, errors, applied: changed };
}
