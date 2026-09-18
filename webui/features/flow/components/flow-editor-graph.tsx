// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  Background,
  Controls,
  SolidFlow,
  useSolidFlow,
  useUpdateNodeInternals,
} from "@dschz/solid-flow";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  createStore,
  produce,
  type SetStoreFunction,
  type Store,
} from "solid-js/store";
import "@dschz/solid-flow/styles";

import {
  MenuHeading,
  MenuItem,
  MenuSurface,
} from "../../../components/ui/menu";
import { applyFlowDelta } from "../../../lib/flow-service";
import {
  registerComponentFocus,
  useKeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { flows } from "../../../state/appStores";
import type * as types from "../../../types/index";

const log = getLogger(import.meta.url);

import { FlowContextProvider } from "../context/flow-context";
import {
  buildEdges,
  buildNodes,
  flowNeedsAutoLayout,
  performAutoLayout,
  setNodeHandlers,
} from "../controllers/graph-controller";
import { createFlowGraphInteractionController } from "../controllers/graph-interaction-controller";
import type { FlowNodeTemplate } from "../model/config/nodeTemplates";
import type { SolidFlowEdge, SolidFlowNode } from "../model/graph-types";
import {
  buildConnectedInputsSet,
  buildDeleteNodeOps,
  copyNodeToClipboard,
  duplicateNodeDefinition,
  edgeIdForDefinition,
  formatFlowValueLabel,
  getNextNodeId,
} from "../model/utils";
import {
  edgeTypes,
  FixedConnectionLine,
  nodeTypes,
} from "./flow-graph-renderers";

/**
 * Configures the Solid Flow graph for a single flow definition and reports node selection changes.
 */
export type FlowEditorGraphProps = {
  flowUid: string;
  flow?: types.FlowDefinition;
  availableNodes: FlowNodeTemplate[];
  portValues: () => Record<string, types.FlowValue>;
  triggerTicks: () => Record<number, number>;
  definitionsRevision?: number;
  runtimeTick?: number;
  class?: string;
  onSelectNode?: (nodeId: types.FlowNodeId | null) => void;
  nodeLabelOverrides?: Map<types.FlowNodeId, string>;
  selectedNodeId?: types.FlowNodeId | null;
  componentId?: string;
};

// Generator-like nodes provide their own live values, so their input defaults are hidden in the graph.

// Node cards receive graph mutation callbacks through this module-local context.
function AutoLayoutControl(props: {
  nodes: Store<SolidFlowNode[]>;
  edges: Store<SolidFlowEdge[]>;
  flow?: types.FlowDefinition;
  sendDelta: (ops: types.FlowDeltaOp[]) => void;
  setNodes: SetStoreFunction<SolidFlowNode[]>;
  onAutoLayoutReady?: (trigger: () => void) => void;
}) {
  const solidFlow = useSolidFlow<SolidFlowNode, SolidFlowEdge>();

  const onAutoLayout = () => {
    if (!props.flow) return;
    const layoutOps = performAutoLayout(
      props.nodes,
      props.edges,
      props.setNodes,
    );
    if (layoutOps.length > 0) {
      props.sendDelta(layoutOps);
      setTimeout(() => {
        solidFlow.fitView({ padding: 0.2, duration: 800 });
      }, 100);
    }
  };

  // Register the auto-layout trigger with parent component
  onMount(() => {
    props.onAutoLayoutReady?.(onAutoLayout);
  });

  return (
    <button
      type="button"
      onClick={onAutoLayout}
      class="solid-flow__controls-button"
      title="Auto Layout"
      aria-label="Auto layout graph"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        style={{ "max-width": "12px", "max-height": "12px" }}
      >
        <path d="M2 2h4v4H2V2zm8 0h4v4h-4V2zM2 10h4v4H2v-4zm8 0h4v4h-4v-4z" />
        <path
          d="M6 4h4M6 12h4M4 6v4M12 6v4"
          stroke="currentColor"
          stroke-width="1.5"
          fill="none"
        />
      </svg>
    </button>
  );
}

/**
 * Exposes Solid Flow hook helpers to the parent graph after the provider context is mounted.
 */
function SolidFlowBridge(props: {
  onReady: (bridge: {
    updateNodeInternals: (ids: string | string[]) => void;
    screenToFlowPosition: (position: { x: number; y: number }) => {
      x: number;
      y: number;
    };
  }) => void;
}) {
  const updateNodeInternals = useUpdateNodeInternals();
  const solidFlow = useSolidFlow<SolidFlowNode, SolidFlowEdge>();

  onMount(() => {
    props.onReady({
      updateNodeInternals,
      screenToFlowPosition: solidFlow.screenToFlowPosition,
    });
  });

  return null;
}

/**
 * Hosts the interactive flow graph, including node editing, connection handling, and auto-layout.
 */
export default function FlowEditorGraphSolid(props: FlowEditorGraphProps) {
  const [nodes, setNodes] = createStore<SolidFlowNode[]>([]);
  const [edges, setEdges] = createStore<SolidFlowEdge[]>([]);
  let containerRef: HTMLDivElement | undefined;
  let selectedNodeIdRef = props.selectedNodeId ?? null;
  let updateNodeInternalsRef: ((ids: string | string[]) => void) | null = null;
  const autoLayoutTriggerRef: { current: (() => void) | null } = {
    current: null,
  };
  const [pendingAutoLayout, setPendingAutoLayout] = createSignal(false);

  /** Port lookup for connection validation */
  const portLookup = createMemo(() => {
    const lookup = new Map<string, types.FlowPortDefinition>();
    nodes.forEach((node) => {
      node.data.inputs.forEach((entry) => {
        lookup.set(`${node.id}:${entry.handleId}`, entry.port);
      });
      node.data.outputs.forEach((entry) => {
        lookup.set(`${node.id}:${entry.handleId}`, entry.port);
      });
    });
    return lookup;
  });

  /** Edge definition lookup */
  const edgeDefinitionLookup = createMemo(() => {
    const lookup = new Map<string, types.FlowEdgeDefinition>();
    if (!props.flow) return lookup;
    props.flow.edges.forEach((edge) => {
      lookup.set(edgeIdForDefinition(edge), edge);
    });
    return lookup;
  });

  /** Output port types for edge labels */
  const outputPortTypes = createMemo(() => {
    if (!props.flow) return new Map<string, types.FlowPortType>();
    const map = new Map<string, types.FlowPortType>();
    for (const node of props.flow.nodes) {
      for (const port of node.ports) {
        if (port.direction === "output" && port.port_type) {
          map.set(`${node.node_id}:${port.port_id}`, port.port_type);
        }
      }
    }
    return map;
  });

  /** Returns the latest authoritative flow snapshot for graph mutations. */
  const currentFlow = (): types.FlowDefinition | undefined =>
    flows.get()[props.flowUid] ?? props.flow;

  /** Sends a delta and returns the store snapshot produced by the optimistic update. */
  const sendDelta = (
    ops: types.FlowDeltaOp[],
  ): types.FlowDefinition | undefined => {
    const flow = currentFlow();
    if (!flow) return undefined;
    const delta: types.FlowDelta = {
      flow_id: flow.identifiers.id,
      base_version: flow.flow_version,
      ops,
    };
    applyFlowDelta(props.flowUid, delta);
    return flows.get()[props.flowUid] ?? flow;
  };

  /** Rebuilds the rendered graph from an authoritative flow snapshot. */
  const rebuildGraphFromFlow = (flow: types.FlowDefinition) => {
    const connectedInputs = buildConnectedInputsSet(flow);
    setNodes(
      buildNodes(
        flow,
        connectedInputs,
        props.nodeLabelOverrides,
        selectedNodeIdRef,
      ),
    );
    setEdges(buildEdges(flow));
  };

  const interaction = createFlowGraphInteractionController({
    nodes,
    setNodes,
    edges,
    setEdges,
    currentFlow,
    sendDelta,
    rebuildGraphFromFlow,
    portLookup,
    edgeDefinitionLookup,
    container: () => containerRef,
    onSelectNode: props.onSelectNode,
    selectedNodeId: () => props.selectedNodeId ?? null,
  });

  /** Update port default value */
  const updatePortDefaultValue = (
    nodeId: types.FlowNodeId,
    portId: types.FlowPortId,
    value: types.FlowValue,
  ) => {
    const nodeIndex = nodes.findIndex((n) => n.data.nodeId === nodeId);
    if (nodeIndex === -1) return;

    setNodes(
      nodeIndex,
      "data",
      produce((data) => {
        for (const entry of data.inputs) {
          if (entry.port.port_id === portId) {
            entry.port.default_value = value;
            break;
          }
        }
        for (const entry of data.outputs) {
          if (entry.port.port_id === portId) {
            entry.port.default_value = value;
            break;
          }
        }
      }),
    );
  };

  const handleUpdatePortDefault = (
    nodeId: types.FlowNodeId,
    port: types.FlowPortDefinition,
    value: types.FlowValue,
  ) => {
    if (port.port_id === undefined) return;
    sendDelta([
      {
        type: "UpdatePortConfig",
        data: {
          node_id: nodeId,
          port_id: port.port_id,
          default_value: value,
        },
      },
    ]);
    updatePortDefaultValue(nodeId, port.port_id, value);
  };

  const deleteNode = (nodeId: types.FlowNodeId) => {
    const flow = currentFlow();
    if (!flow) return;
    const ops = buildDeleteNodeOps(nodeId, flow);
    sendDelta(ops);

    batch(() => {
      // Remove edges connected to this node
      const edgeIndicesToRemove: number[] = [];
      edges.forEach((edge, i) => {
        if (
          edge.data?.edge?.from.node_id === nodeId ||
          edge.data?.edge?.to.node_id === nodeId
        ) {
          edgeIndicesToRemove.push(i);
        }
      });
      // Remove in reverse order to maintain indices
      for (let i = edgeIndicesToRemove.length - 1; i >= 0; i--) {
        setEdges(produce((e) => e.splice(edgeIndicesToRemove[i], 1)));
      }

      // Remove the node
      const nodeIndex = nodes.findIndex((n) => n.data.nodeId === nodeId);
      if (nodeIndex !== -1) {
        setNodes(produce((n) => n.splice(nodeIndex, 1)));
      }
    });
  };

  const cutNode = async (nodeId: types.FlowNodeId) => {
    const flow = currentFlow();
    if (!flow) return;
    const sourceNode = flow.nodes.find((entry) => entry.node_id === nodeId);
    if (sourceNode) {
      await copyNodeToClipboard(sourceNode);
    }
    deleteNode(nodeId);
  };

  const copyNode = async (nodeId: types.FlowNodeId) => {
    const flow = currentFlow();
    if (!flow) return;
    const sourceNode = flow.nodes.find((entry) => entry.node_id === nodeId);
    if (sourceNode) {
      await copyNodeToClipboard(sourceNode);
    }
  };

  const duplicateNode = (nodeId: types.FlowNodeId) => {
    const flow = currentFlow();
    if (!flow) return;
    const sourceNode = flow.nodes.find((entry) => entry.node_id === nodeId);
    if (!sourceNode) return;

    const nextNodeId = getNextNodeId(flow);
    const newNode = duplicateNodeDefinition(sourceNode, nextNodeId);
    const nextFlow = sendDelta([{ type: "AddNode", data: newNode }]);

    if (nextFlow) {
      rebuildGraphFromFlow(nextFlow);
    }
  };

  // Set up node handlers context
  setNodeHandlers({
    onUpdatePortDefault: handleUpdatePortDefault,
    onCutNode: cutNode,
    onDuplicateNode: duplicateNode,
    onDeleteNode: deleteNode,
  });

  // Initialize nodes and edges when flow definition snapshots change.
  createEffect(
    on(
      () => [props.flow, props.definitionsRevision] as const,
      ([flow]) => {
        if (!flow) {
          setNodes([]);
          setEdges([]);
          setPendingAutoLayout(false);
          return;
        }
        const connectedInputs = buildConnectedInputsSet(flow);
        const builtNodes = buildNodes(
          flow,
          connectedInputs,
          props.nodeLabelOverrides,
          selectedNodeIdRef,
        );
        setNodes(builtNodes);
        setEdges(buildEdges(flow));

        // Check if this flow needs auto-layout (no existing position data)
        const needsLayout = flowNeedsAutoLayout(flow);
        setPendingAutoLayout(needsLayout);

        // Update node internals after a short delay to ensure DOM is ready
        setTimeout(() => {
          const nodeIds = builtNodes.map((n) => n.id);
          if (nodeIds.length > 0 && updateNodeInternalsRef) {
            updateNodeInternalsRef(nodeIds);
          }
        }, 50);
      },
    ),
  );

  // Trigger auto-layout when pending and nodes are measured
  createEffect(() => {
    if (!pendingAutoLayout()) return;
    if (nodes.length === 0) return;

    // Check if nodes have measurements (React Flow measures nodes after render)
    const allMeasured = nodes.every(
      (node) => node.measured?.width && node.measured?.height,
    );
    if (!allMeasured) return;

    // Trigger auto-layout after a short delay to ensure everything is ready
    setTimeout(() => {
      if (autoLayoutTriggerRef.current) {
        autoLayoutTriggerRef.current();
        setPendingAutoLayout(false);
      }
    }, 100);
  });

  // Update selection when selectedNodeId prop changes
  createEffect(() => {
    selectedNodeIdRef = props.selectedNodeId ?? null;
    interaction.syncSelectedNode(props.selectedNodeId ?? null);
  });

  // Update trigger pulses
  createEffect(() => {
    const ticks = props.triggerTicks();
    const now = Date.now();

    batch(() => {
      nodes.forEach((node, index) => {
        const tick = ticks[node.data.nodeId];
        const pulse = tick !== undefined && now - tick < 250;
        if (node.data.pulse !== pulse) {
          setNodes(index, "data", "pulse", pulse);
        }
      });
    });

    const timer = window.setTimeout(() => {
      batch(() => {
        nodes.forEach((node, index) => {
          if (node.data.pulse) {
            setNodes(index, "data", "pulse", false);
          }
        });
      });
    }, 260);

    onCleanup(() => window.clearTimeout(timer));
  });

  let edgeLabelRequestId = 0;

  /** Updates edge labels with the latest port values. */
  createEffect(() => {
    const portValues = props.portValues();
    const portTypes = outputPortTypes();
    const requestId = ++edgeLabelRequestId;

    void Promise.all(
      edges.map(async (edge) => {
        if (!edge.data?.edge) return;
        const portKey = `${edge.data.edge.from.node_id}:${edge.data.edge.from.port_id}`;
        const portValue = portValues[portKey];
        const portType = portTypes.get(portKey);
        return portValue && portType !== "layer"
          ? ((await formatFlowValueLabel(portValue)) ?? undefined)
          : undefined;
      }),
    ).then((labels) => {
      if (requestId !== edgeLabelRequestId) return;
      batch(() => {
        edges.forEach((edge, index) => {
          const label = labels[index];
          if (edge.data?.label !== label) {
            setEdges(index, "data", "label", label);
          }
        });
      });
    });
  });

  // Register component for focus tracking
  onMount(() => {
    log.trace("mounting");
    if (containerRef && props.componentId) {
      const unregister = registerComponentFocus(
        props.componentId,
        containerRef,
      );
      onCleanup(() => {
        log.trace("unmounting");
        unregister();
      });
    }
  });

  // Keyboard shortcuts
  useKeyboardShortcut({
    key: "$mod+c",
    handler: () => {
      if (nodes.length > 0) {
        const selectedNode = nodes.find((node) => node.selected);
        if (selectedNode) {
          copyNode(selectedNode.data.nodeId);
        }
      }
    },
    description: "Copy selected node",
    componentId: props.componentId,
    group: "Flow Editor",
  });

  useKeyboardShortcut({
    key: "$mod+v",
    handler: () => {
      void interaction.pasteNodeFromClipboard();
    },
    description: "Paste node from clipboard",
    componentId: props.componentId,
    group: "Flow Editor",
  });

  // Render
  return (
    <Show
      when={props.flow}
      fallback={
        <div
          class="flex h-full w-full items-center justify-center text-sm text-neutral-500"
          data-component="FlowEditorGraph"
        >
          No flow selected
        </div>
      }
    >
      <FlowContextProvider
        flowUid={props.flowUid}
        flowVersion={props.flow!.flow_version}
        onPortValueUpdate={updatePortDefaultValue}
      >
        <div
          class={`flex h-full w-full flex-col bg-neutral-950 text-neutral-100 ${props.class ?? ""}`}
          data-component="FlowEditorGraph"
        >
          <div
            class="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-sm"
            data-slot="toolbar"
          >
            <div class="font-semibold">{props.flow!.identifiers.label}</div>
            <div class="text-xs text-neutral-400">
              v{props.flow!.flow_version} · {props.flow!.nodes.length} nodes ·{" "}
              {props.flow!.edges.length} edges
            </div>
          </div>
          <div
            ref={containerRef}
            class="relative min-h-0 flex-1"
            data-slot="graph"
          >
            <SolidFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              connectionLineComponent={FixedConnectionLine}
              onNodeDragStop={interaction.onNodeDragStop}
              onPaneClick={interaction.onPaneClick}
              onPaneContextMenu={interaction.onPaneContextMenu}
              onNodeClick={interaction.onNodeClick}
              onEdgeClick={interaction.onEdgeClick}
              onSelectionChange={interaction.onSelectionChange}
              onConnect={interaction.onConnect}
              isValidConnection={interaction.isValidConnection}
              onNodesDelete={interaction.onNodesDelete}
              onEdgesDelete={interaction.onEdgesDelete}
              deleteKey={["Backspace", "Delete"]}
              fitView
              proOptions={{ hideAttribution: true }}
              class="bg-neutral-950"
            >
              <SolidFlowBridge
                onReady={(bridge) => {
                  updateNodeInternalsRef = bridge.updateNodeInternals;
                  interaction.setScreenToFlowPosition(
                    bridge.screenToFlowPosition,
                  );
                }}
              />
              <Background patternColor="#1f2937" gap={24} />
              <Controls
                afterControls={
                  <AutoLayoutControl
                    nodes={nodes}
                    edges={edges}
                    flow={props.flow}
                    sendDelta={sendDelta}
                    setNodes={setNodes}
                    onAutoLayoutReady={(trigger) => {
                      autoLayoutTriggerRef.current = trigger;
                    }}
                  />
                }
              />
              <Show when={interaction.menuPosition()}>
                <MenuSurface
                  class="absolute z-10 overflow-y-auto"
                  style={{
                    width: "min(200px, calc(100% - 8px))",
                    "max-height": "min(320px, calc(100% - 8px))",
                    left: `min(${interaction.menuPosition()!.x}px, max(4px, calc(100% - 204px)))`,
                    top: `min(${interaction.menuPosition()!.y}px, max(4px, calc(100% - 324px)))`,
                  }}
                >
                  <MenuHeading>Add Node</MenuHeading>
                  <div class="flex flex-col gap-1">
                    <Show
                      when={props.availableNodes.length > 0}
                      fallback={
                        <div class="px-2 py-1 text-neutral-500">
                          No templates available
                        </div>
                      }
                    >
                      <For each={props.availableNodes}>
                        {(template) => (
                          <MenuItem
                            onClick={() => interaction.onAddNode(template)}
                          >
                            {template.label}
                          </MenuItem>
                        )}
                      </For>
                    </Show>
                  </div>
                </MenuSurface>
              </Show>
            </SolidFlow>
          </div>
        </div>
      </FlowContextProvider>
    </Show>
  );
}
