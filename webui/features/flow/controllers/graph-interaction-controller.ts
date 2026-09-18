// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, batch, createSignal } from "solid-js";
import { produce, type SetStoreFunction, type Store } from "solid-js/store";
import type * as types from "../../../types/index";
import type { FlowNodeTemplate } from "../model/config/nodeTemplates";
import type { SolidFlowEdge, SolidFlowNode } from "../model/graph-types";
import {
  edgeDefinitionFromId,
  edgeIdForDefinition,
  getNextNodeId,
  readNodeFromClipboard,
  toPortRef,
} from "../model/utils";

interface FlowGraphInteractionControllerOptions {
  nodes: Store<SolidFlowNode[]>;
  setNodes: SetStoreFunction<SolidFlowNode[]>;
  edges: Store<SolidFlowEdge[]>;
  setEdges: SetStoreFunction<SolidFlowEdge[]>;
  currentFlow: () => types.FlowDefinition | undefined;
  sendDelta: (ops: types.FlowDeltaOp[]) => types.FlowDefinition | undefined;
  rebuildGraphFromFlow: (flow: types.FlowDefinition) => void;
  portLookup: Accessor<Map<string, types.FlowPortDefinition>>;
  edgeDefinitionLookup: Accessor<Map<string, types.FlowEdgeDefinition>>;
  container: () => HTMLDivElement | undefined;
  onSelectNode?: (nodeId: types.FlowNodeId | null) => void;
  selectedNodeId: () => types.FlowNodeId | null;
}

interface FlowGraphConnection {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** Coordinates graph pointer, selection, connection, deletion, and paste mutations. */
export const createFlowGraphInteractionController = (
  options: FlowGraphInteractionControllerOptions,
) => {
  const [menuPosition, setMenuPosition] = createSignal<{
    x: number;
    y: number;
  } | null>(null);
  let lastPointerPosition: { x: number; y: number } | null = null;
  let selectedNodeId = options.selectedNodeId();
  let screenToFlowPosition:
    | ((position: { x: number; y: number }) => { x: number; y: number })
    | null = null;

  /** Supplies the screen-to-flow projection after Solid Flow mounts. */
  const setScreenToFlowPosition = (
    project:
      | ((position: { x: number; y: number }) => { x: number; y: number })
      | null,
  ) => {
    screenToFlowPosition = project;
  };

  /** Mirrors external node selection into graph node presentation state. */
  const syncSelectedNode = (nodeId: types.FlowNodeId | null) => {
    selectedNodeId = nodeId;
    batch(() => {
      options.nodes.forEach((node, index) => {
        const selected = nodeId !== null && node.data.nodeId === nodeId;
        if (node.selected !== selected) {
          options.setNodes(index, "selected", selected);
        }
      });
    });
  };

  /** Persists a node's final graph position after dragging ends. */
  const onNodeDragStop = (params: {
    targetNode: SolidFlowNode | null;
    nodes: SolidFlowNode[];
  }) => {
    if (!options.currentFlow() || !params.targetNode) return;
    const node = params.targetNode;
    const nodeIdMatch = node.id.match(/^node-(\d+)$/);
    if (!nodeIdMatch) return;
    options.sendDelta([
      {
        type: "UpdateNode",
        data: {
          node_id: Number.parseInt(nodeIdMatch[1] ?? "", 10),
          position: { x: node.position.x, y: node.position.y },
        },
      },
    ]);
  };

  /** Closes the context menu, clears node selection, and remembers pointer position. */
  const onPaneClick = (params: { event: MouseEvent }) => {
    if (!options.currentFlow()) return;
    if (menuPosition()) {
      setMenuPosition(null);
      lastPointerPosition = {
        x: params.event.clientX,
        y: params.event.clientY,
      };
      return;
    }
    if (selectedNodeId !== null) {
      selectedNodeId = null;
      options.onSelectNode?.(null);
    }
    lastPointerPosition = {
      x: params.event.clientX,
      y: params.event.clientY,
    };
  };

  /** Opens the node template menu at the pointer's graph-container position. */
  const onPaneContextMenu = (params: { event: PointerEvent }) => {
    if (!options.currentFlow()) return;
    params.event.preventDefault();
    lastPointerPosition = {
      x: params.event.clientX,
      y: params.event.clientY,
    };
    const container = options.container();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setMenuPosition({
      x: params.event.clientX - rect.left,
      y: params.event.clientY - rect.top,
    });
  };

  /** Selects the clicked flow node and closes the add-node menu. */
  const onNodeClick = (params: { node: SolidFlowNode }) => {
    setMenuPosition(null);
    options.onSelectNode?.(params.node.data.nodeId);
  };

  /** Clears node selection when an edge becomes the active graph object. */
  const onEdgeClick = () => {
    setMenuPosition(null);
    syncSelectedNode(null);
    options.onSelectNode?.(null);
  };

  /** Publishes Solid Flow selection changes without echoing controlled updates. */
  const onSelectionChange = (params: {
    nodes: SolidFlowNode[];
    edges: SolidFlowEdge[];
  }) => {
    const selected = params.nodes[0];
    const nextId = selected ? selected.data.nodeId : null;
    if (selectedNodeId === nextId) return;
    if (options.selectedNodeId() === nextId) {
      selectedNodeId = nextId;
      return;
    }
    selectedNodeId = nextId;
    options.onSelectNode?.(nextId);
  };

  /** Adds a compatible connection to backend and rendered graph state. */
  const onConnect = (connection: FlowGraphConnection & { id: string }) => {
    if (!options.currentFlow()) return;
    const from = toPortRef(connection.source, connection.sourceHandle);
    const to = toPortRef(connection.target, connection.targetHandle);
    if (!from || !to) return;

    const edge: types.FlowEdgeDefinition = { from, to };
    options.sendDelta([{ type: "AddEdge", data: edge }]);
    options.setEdges(
      produce((edges) => {
        edges.push({
          id: edgeIdForDefinition(edge),
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          type: "labeled" as const,
          data: { edge },
        });
      }),
    );
  };

  /** Accepts connections only from outputs to inputs of the same port type. */
  const isValidConnection = (connection: FlowGraphConnection) => {
    const lookup = options.portLookup();
    const sourcePort = lookup.get(
      `${connection.source}:${connection.sourceHandle ?? ""}`,
    );
    const targetPort = lookup.get(
      `${connection.target}:${connection.targetHandle ?? ""}`,
    );
    if (!sourcePort || !targetPort) return false;
    if (sourcePort.direction !== "output") return false;
    if (targetPort.direction !== "input") return false;
    return sourcePort.port_type === targetPort.port_type;
  };

  /** Deletes graph nodes and rebuilds rendered state from the optimistic snapshot. */
  const onNodesDelete = (deletedNodes: SolidFlowNode[]) => {
    if (!options.currentFlow()) return;
    const ops: types.FlowDeltaOp[] = [];
    for (const node of deletedNodes) {
      const nodeIdMatch = node.id.match(/^node-(\d+)$/);
      if (!nodeIdMatch) continue;
      ops.push({
        type: "RemoveNode",
        data: { node_id: Number.parseInt(nodeIdMatch[1] ?? "", 10) },
      });
    }
    if (ops.length === 0) return;

    selectedNodeId = null;
    options.onSelectNode?.(null);
    const nextFlow = options.sendDelta(ops);
    if (nextFlow) options.rebuildGraphFromFlow(nextFlow);
  };

  /** Deletes graph edges while preserving the exact backend edge identity. */
  const onEdgesDelete = (deletedEdges: SolidFlowEdge[]) => {
    if (!options.currentFlow()) return;
    syncSelectedNode(null);
    options.onSelectNode?.(null);

    const ops: types.FlowDeltaOp[] = [];
    const edgeIdsToRemove = new Set<string>();
    for (const edge of deletedEdges) {
      const flowEdge =
        edge.data?.edge ??
        options.edgeDefinitionLookup().get(edge.id) ??
        edgeDefinitionFromId(edge.id);
      if (!flowEdge) continue;
      ops.push({
        type: "RemoveEdge",
        data: { from: { ...flowEdge.from }, to: { ...flowEdge.to } },
      });
      edgeIdsToRemove.add(edge.id);
    }

    if (edgeIdsToRemove.size > 0) {
      options.setEdges(
        produce((edges) => {
          for (let index = edges.length - 1; index >= 0; index--) {
            if (edgeIdsToRemove.has(edges[index].id)) edges.splice(index, 1);
          }
        }),
      );
    }
    if (ops.length > 0) options.sendDelta(ops);
  };

  /** Adds a node template at the open context-menu position. */
  const onAddNode = (template: FlowNodeTemplate) => {
    const flow = options.currentFlow();
    const menu = menuPosition();
    if (!flow || !menu) return;
    const container = options.container();
    let position = { x: menu.x, y: menu.y };
    if (screenToFlowPosition && container) {
      const rect = container.getBoundingClientRect();
      position = screenToFlowPosition({
        x: rect.left + menu.x,
        y: rect.top + menu.y,
      });
    }

    const newNode: types.FlowNodeDefinition = {
      node_id: getNextNodeId(flow),
      kind: template.kind,
      label: template.label,
      ports: template.ports.map((port) => ({ ...port })),
      position: { x: position.x, y: position.y },
    };
    const nextFlow = options.sendDelta([{ type: "AddNode", data: newNode }]);
    if (nextFlow) options.rebuildGraphFromFlow(nextFlow);
    setMenuPosition(null);
  };

  /** Pastes a copied node at the last pointer position or a stable fallback. */
  const pasteNodeFromClipboard = async () => {
    const flow = options.currentFlow();
    if (!flow) return;
    const payload = await readNodeFromClipboard();
    if (!payload) return;

    const position = lastPointerPosition ?? { x: 100, y: 100 };
    const newNode: types.FlowNodeDefinition = {
      node_id: getNextNodeId(flow),
      kind: payload.node.kind,
      label: payload.node.label,
      ports: payload.node.ports.map((port) => ({
        ...port,
        default_value: port.default_value
          ? { ...port.default_value }
          : undefined,
      })),
      position: { x: position.x, y: position.y },
    };
    const nextFlow = options.sendDelta([{ type: "AddNode", data: newNode }]);
    if (nextFlow) options.rebuildGraphFromFlow(nextFlow);
  };

  return {
    menuPosition,
    setScreenToFlowPosition,
    syncSelectedNode,
    onNodeDragStop,
    onPaneClick,
    onPaneContextMenu,
    onNodeClick,
    onEdgeClick,
    onSelectionChange,
    onConnect,
    isValidConnection,
    onNodesDelete,
    onEdgesDelete,
    onAddNode,
    pasteNodeFromClipboard,
  };
};
