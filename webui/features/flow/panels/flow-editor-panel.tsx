// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
} from "solid-js";
import { Button } from "../../../components/ui/visual-language/button";
import { applyFlowDelta } from "../../../lib/flow-service";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  flowDefinitionsRevision,
  flowPortValues,
  flows,
  flowTriggerTicks,
  layerStack,
} from "../../../state/appStores";
import type * as flowTypes from "../../../types/index";
import { usePropertiesInspector } from "../../property-inspector";
import { getAvailableNodeTemplates } from "..";
import type { FlowEditorGraphProps } from "../components/flow-editor-graph";
import FlowEditorGraph from "../components/flow-editor-graph";
import { FlowNodeProperties } from "../components/flow-node-properties";
import {
  createFlowContextValue,
  FlowContextProvider,
} from "../context/flow-context";
import { formatNodeKindLabel } from "../model/utils";

const log = getLogger(import.meta.url);

export interface FlowEditorPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialFlowUid: string;
}

/**
 * Renders the flow editor error boundary fallback with retry controls.
 */
function ErrorDisplay(props: { error: Error; reset: () => void }) {
  log.error("Flow editor error:", props.error);
  return (
    <div class="flex h-full w-full items-center justify-center bg-neutral-950 text-sm text-neutral-300">
      <div class="max-w-2xl rounded border border-neutral-800 bg-neutral-900 px-4 py-3 shadow">
        <div class="text-base font-semibold text-neutral-100">
          Flow editor failed
        </div>
        <div class="mt-2 text-xs text-red-400 font-mono">
          {props.error.name}: {props.error.message}
        </div>
        <pre class="mt-2 text-xs text-neutral-400 max-h-96 overflow-auto whitespace-pre-wrap">
          {props.error.stack}
        </pre>
        <Button size="compact" class="mt-3" onClick={() => props.reset()}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function FlowEditorGraphWithErrorBoundary(props: FlowEditorGraphProps) {
  return (
    <ErrorBoundary
      fallback={(err, reset) => <ErrorDisplay error={err} reset={reset} />}
    >
      <FlowEditorGraph {...props} />
    </ErrorBoundary>
  );
}

/**
 * Hosts the flow graph editor and its properties inspector integration.
 */
export default function FlowEditorPanel(props: FlowEditorPanelProps) {
  log.trace("mounting");
  const $flows = useStore(flows);
  const $flowDefinitionsRevision = useStore(flowDefinitionsRevision);
  const $layerStack = useStore(layerStack);
  const panelId = props.initialPanelId ?? props.id;

  const flow = createMemo(() => $flows()[props.initialFlowUid]);
  const flowId = createMemo(() => flow()?.identifiers.id ?? null);
  const flowVersion = createMemo(() => flow()?.flow_version ?? 0);

  // Create shared flow context value for optimistic updates
  // This is shared between the graph (via Provider) and properties panel (via props)
  const flowContext = createFlowContextValue({
    flowUid: props.initialFlowUid,
    flowVersion,
  });

  const [selectedNodeId, setSelectedNodeId] =
    createSignal<flowTypes.FlowNodeId | null>(null);
  const [labelOverrides, setLabelOverrides] = createSignal(
    new Map<flowTypes.FlowNodeId, string>(),
  );
  const selectedNode = createMemo(() => {
    const nodeId = selectedNodeId();
    if (nodeId === null) return undefined;
    return flow()?.nodes.find((node) => node.node_id === nodeId);
  });

  createEffect(() => {
    const nodeId = selectedNodeId();
    if (nodeId === null) return;
    const currentFlow = flow();
    if (!currentFlow) return;
    const stillExists = currentFlow.nodes.some(
      (node) => node.node_id === nodeId,
    );
    if (!stillExists) setSelectedNodeId(null);
  });

  createEffect(() => {
    const currentFlow = flow();
    if (!currentFlow) return;
    const nextOverrides = new Map(labelOverrides());
    let changed = false;
    for (const [nodeId, label] of nextOverrides) {
      const node = currentFlow.nodes.find((entry) => entry.node_id === nodeId);
      if (!node || node.label === label) {
        nextOverrides.delete(nodeId);
        changed = true;
      }
    }
    if (changed) setLabelOverrides(nextOverrides);
  });

  const portValuesStore = useStore(flowPortValues);
  const triggerTicksStore = useStore(flowTriggerTicks);

  const portValues = createMemo(() => {
    const id = flowId();
    if (id === null) return {};
    return portValuesStore()[id] ?? {};
  });

  const triggerTicks = createMemo(() => {
    const id = flowId();
    if (id === null) return {};
    return triggerTicksStore()[id] ?? {};
  });

  const connectedInputs = createMemo(() => {
    const currentFlow = flow();
    if (!currentFlow) return new Set<string>();
    return new Set(
      currentFlow.edges.map((edge) => `${edge.to.node_id}:${edge.to.port_id}`),
    );
  });

  const availableNodes = createMemo(() => {
    const allNodes: Array<{
      kind: string;
      ports: flowTypes.FlowPortDefinition[];
    }> = [];
    for (const flowEntry of Object.values($flows())) {
      for (const node of flowEntry.nodes) {
        allNodes.push({ kind: node.kind, ports: node.ports });
      }
    }
    return getAvailableNodeTemplates(allNodes, formatNodeKindLabel);
  });

  const updateNodeLabel = (nodeId: flowTypes.FlowNodeId, label: string) => {
    // Read directly from store to get the latest version
    const storeFlow = $flows()[props.initialFlowUid];
    if (!storeFlow) return;
    setLabelOverrides((prev) => {
      const next = new Map(prev);
      next.set(nodeId, label);
      return next;
    });
    applyFlowDelta(props.initialFlowUid, {
      flow_id: storeFlow.identifiers.id,
      base_version: storeFlow.flow_version,
      ops: [
        {
          type: "UpdateNode",
          data: {
            node_id: nodeId,
            label,
          },
        },
      ],
    });
  };

  usePropertiesInspector(
    panelId,
    `Flow ${flow()?.identifiers.id ?? "unknown"}`,
    () => (
      <FlowNodeProperties
        node={selectedNode}
        connectedInputs={connectedInputs}
        portValues={portValues}
        flow={flow}
        layerStack={$layerStack}
        flowContext={flowContext}
        onRename={updateNodeLabel}
      />
    ),
    { priority: 10, autoActivate: true },
  );

  return (
    <FlowContextProvider value={flowContext}>
      <FlowEditorGraphWithErrorBoundary
        flowUid={props.initialFlowUid}
        flow={flow()}
        availableNodes={availableNodes()}
        portValues={portValues}
        triggerTicks={triggerTicks}
        definitionsRevision={$flowDefinitionsRevision()}
        runtimeTick={0}
        class="h-full w-full"
        onSelectNode={setSelectedNodeId}
        selectedNodeId={selectedNodeId()}
        nodeLabelOverrides={labelOverrides()}
        componentId={panelId}
      />
    </FlowContextProvider>
  );
}
