// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Input } from "../../../components/ui/form-controls";
import { getLogger } from "../../../lib/logger";
import * as types from "../../../types";
import type * as flowTypes from "../../../types/index";
import { WaveformEditor } from "../../fx";
import LayerView from "../../layers";
import type { FlowContextType } from "../context/flow-context";
import { formatNodeKindLabel, portTypeLabel } from "../model/utils";
import { FlowPortDefaultEditor } from "./flow-port-default-editor";

const log = getLogger(import.meta.url);

// Waveform node port IDs (must match backend builtin_nodes.rs)
const WAVEFORM_IN_KIND = 1;
const WAVEFORM_IN_RATE = 2;
const WAVEFORM_IN_AMPLITUDE = 3;
const WAVEFORM_IN_PHASE = 4;
const WAVEFORM_IN_BASE = 5;
const WAVEFORM_IN_DUTY_CYCLE = 6;

/**
 * Builds a waveform preview from live port values, falling back to node defaults.
 */
function buildWaveformFromPorts(
  node: flowTypes.FlowNodeDefinition,
  portValues: () => { [portRef: string]: flowTypes.FlowValue },
): flowTypes.FlowWaveform {
  const nodeId = node.node_id;
  const values = portValues();

  const getPortValue = (portId: number): flowTypes.FlowValue | undefined => {
    return values[`${nodeId}:${portId}`];
  };

  const getPortDefault = (portId: number): flowTypes.FlowValue | undefined => {
    return (
      node.ports.find((p) => p.port_id === portId)?.default_value ?? undefined
    );
  };

  const getNumber = (portId: number, fallback: number): number => {
    const live = getPortValue(portId);
    if (live?.type === "Number") return live.data;
    const def = getPortDefault(portId);
    if (def?.type === "Number") return def.data;
    return fallback;
  };

  const getWaveformKind = (
    portId: number,
    fallback: flowTypes.WaveformKind,
  ): flowTypes.WaveformKind => {
    const live = getPortValue(portId);
    if (live?.type === "WaveformKind") return live.data;
    const def = getPortDefault(portId);
    if (def?.type === "WaveformKind") return def.data;
    return fallback;
  };

  const kind = getWaveformKind(WAVEFORM_IN_KIND, types.WaveformKind.Sin);

  return {
    kind,
    rate_secs: getNumber(WAVEFORM_IN_RATE, 1.0),
    amplitude: getNumber(WAVEFORM_IN_AMPLITUDE, 1.0),
    phase: getNumber(WAVEFORM_IN_PHASE, 0.0),
    base: getNumber(WAVEFORM_IN_BASE, 0.0),
    duty_cycle: getNumber(WAVEFORM_IN_DUTY_CYCLE, 1.0),
  };
}

/**
 * Renders editable properties, port defaults, and previews for the selected flow node.
 */
export function FlowNodeProperties(props: {
  node: () => flowTypes.FlowNodeDefinition | undefined;
  connectedInputs: () => Set<string>;
  portValues: () => { [portRef: string]: flowTypes.FlowValue };
  flow: () => flowTypes.FlowDefinition | undefined;
  layerStack: () => types.OutboundLayerState[];
  flowContext: FlowContextType;
  onRename: (nodeId: flowTypes.FlowNodeId, label: string) => void;
}) {
  const [labelDraft, setLabelDraft] = createSignal("");
  type LayerPreview =
    | { status: "missingPort" }
    | { status: "disconnected" }
    | { status: "waiting"; sourceNode: flowTypes.FlowNodeDefinition }
    | {
        status: "ready";
        layer: types.OutboundLayerState;
        sourceNode: flowTypes.FlowNodeDefinition;
      };

  const getLayerPreview = (
    node: flowTypes.FlowNodeDefinition,
  ): LayerPreview | null => {
    const flowDef = props.flow();
    if (
      !flowDef ||
      node.kind.toLowerCase().replace(/-/g, "_") !== "render_layer"
    ) {
      return null;
    }

    const layerPort = node.ports.find(
      (port) =>
        port.direction === "input" && port.port_type?.toLowerCase() === "layer",
    );
    if (!layerPort) {
      return { status: "missingPort" };
    }

    const edge = flowDef.edges.find(
      (entry) =>
        entry.to.node_id === node.node_id &&
        entry.to.port_id === layerPort.port_id,
    );
    if (!edge) {
      return { status: "disconnected" };
    }

    const sourceNode = flowDef.nodes.find(
      (entry) => entry.node_id === edge.from.node_id,
    );
    if (!sourceNode) {
      return { status: "disconnected" };
    }

    const creatorPattern = flowDef.identifiers.label;
    const layer = props.layerStack().find((l) => l.creator === creatorPattern);

    if (!layer) {
      log.warn(
        "Layer not found in stack",
        "looking for:",
        creatorPattern,
        "available:",
        props.layerStack().map((l) => l.creator),
      );
      return { status: "waiting", sourceNode };
    }

    return { status: "ready", layer, sourceNode };
  };

  createEffect(() => {
    const node = props.node();
    setLabelDraft(node?.label ?? "");
  });

  const commitLabel = () => {
    const node = props.node();
    if (!node) return;
    const nextLabel = labelDraft().trim();
    if (!nextLabel || nextLabel === node.label) return;
    props.onRename(node.node_id, nextLabel);
  };

  return (
    <div class="flex flex-col gap-4 p-3 text-sm text-neutral-200">
      <Show
        when={props.node()}
        fallback={
          <div class="text-xs text-neutral-500">Select a node to edit.</div>
        }
      >
        {(node) => (
          <>
            <div class="text-xs uppercase tracking-wide text-neutral-400">
              Node Properties
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs text-neutral-400">Type</label>
              <div class="text-sm text-neutral-100">
                {formatNodeKindLabel(node().kind)}
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs text-neutral-400">Label</label>
              <Input
                density="compact"
                value={labelDraft()}
                onInput={(event) =>
                  setLabelDraft((event.target as HTMLInputElement).value)
                }
                onBlur={commitLabel}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitLabel();
                  }
                }}
              />
            </div>
            <div class="border-t border-neutral-800 pt-3">
              <div class="text-xs uppercase tracking-wide text-neutral-400">
                Inputs
              </div>
              <Show
                when={node().kind === "waveform"}
                fallback={
                  <div class="mt-2 flex flex-col gap-3">
                    <For
                      each={node().ports.filter(
                        (port) => port.direction === "input",
                      )}
                    >
                      {(port) => {
                        const isConnected = () =>
                          props
                            .connectedInputs()
                            .has(`${node().node_id}:${port.port_id}`);
                        return (
                          <div class="rounded border border-neutral-800 bg-neutral-900/60 p-2">
                            <div class="flex items-center justify-between text-xs text-neutral-300">
                              <div class="font-medium">{port.name}</div>
                              <div class="text-[10px] uppercase text-neutral-500">
                                {portTypeLabel(port.port_type)}
                              </div>
                            </div>
                            <div class="mt-2">
                              <Show
                                when={!isConnected()}
                                fallback={
                                  <div class="text-xs text-neutral-500">
                                    Connected
                                  </div>
                                }
                              >
                                <FlowPortDefaultEditor
                                  port={port}
                                  disabled={isConnected()}
                                  onCommit={(value) => {
                                    if (port.port_id !== undefined) {
                                      props.flowContext.updateValue(
                                        node().node_id,
                                        port.port_id,
                                        value,
                                        true, // immediate commit for properties panel
                                      );
                                    }
                                  }}
                                  nodeKind={node().kind}
                                />
                              </Show>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                }
              >
                {/* Waveform node: show unified waveform editor with per-field disable */}
                {(() => {
                  const nodeId = node().node_id;

                  const isPortConnected = (portId: number) =>
                    props.connectedInputs().has(`${nodeId}:${portId}`);

                  const waveformData = createMemo(() =>
                    buildWaveformFromPorts(node(), props.portValues),
                  );

                  const disabledFields = createMemo(() => ({
                    kind: isPortConnected(WAVEFORM_IN_KIND),
                    rate: isPortConnected(WAVEFORM_IN_RATE),
                    amplitude: isPortConnected(WAVEFORM_IN_AMPLITUDE),
                    phase: isPortConnected(WAVEFORM_IN_PHASE),
                    base: isPortConnected(WAVEFORM_IN_BASE),
                    dutyCycle: isPortConnected(WAVEFORM_IN_DUTY_CYCLE),
                  }));

                  const handleKindChange = (kind: flowTypes.WaveformKind) => {
                    if (disabledFields().kind) return;
                    props.flowContext.updateValue(
                      nodeId,
                      WAVEFORM_IN_KIND,
                      { type: "WaveformKind", data: kind },
                      true,
                    );
                  };

                  const handleWaveformChange = (
                    updates: Partial<flowTypes.FlowWaveform>,
                  ) => {
                    if (
                      updates.rate_secs !== undefined &&
                      !disabledFields().rate
                    ) {
                      props.flowContext.updateValue(
                        nodeId,
                        WAVEFORM_IN_RATE,
                        { type: "Number", data: updates.rate_secs },
                        true,
                      );
                    }
                    if (
                      updates.phase !== undefined &&
                      !disabledFields().phase
                    ) {
                      props.flowContext.updateValue(
                        nodeId,
                        WAVEFORM_IN_PHASE,
                        { type: "Number", data: updates.phase },
                        true,
                      );
                    }
                    if (
                      updates.amplitude !== undefined &&
                      !disabledFields().amplitude
                    ) {
                      props.flowContext.updateValue(
                        nodeId,
                        WAVEFORM_IN_AMPLITUDE,
                        { type: "Number", data: updates.amplitude },
                        true,
                      );
                    }
                    if (updates.base !== undefined && !disabledFields().base) {
                      props.flowContext.updateValue(
                        nodeId,
                        WAVEFORM_IN_BASE,
                        { type: "Number", data: updates.base },
                        true,
                      );
                    }
                    if (
                      updates.duty_cycle !== undefined &&
                      !disabledFields().dutyCycle
                    ) {
                      props.flowContext.updateValue(
                        nodeId,
                        WAVEFORM_IN_DUTY_CYCLE,
                        { type: "Number", data: updates.duty_cycle },
                        true,
                      );
                    }
                  };

                  return (
                    <div class="mt-2">
                      <WaveformEditor
                        waveform={waveformData()}
                        onWaveformChange={handleWaveformChange}
                        onKindChange={handleKindChange}
                        disabledFields={disabledFields()}
                      />
                    </div>
                  );
                })()}
              </Show>
            </div>
            {(() => {
              const currentNode = node();
              if (currentNode.kind !== "render_layer") return null;
              const preview = getLayerPreview(currentNode);
              if (!preview) return null;

              return (
                <div class="border-t border-neutral-800 pt-3">
                  <div class="text-xs uppercase tracking-wide text-neutral-400">
                    Layer Preview
                    {"sourceNode" in preview && preview.sourceNode && (
                      <span class="text-[10px] text-neutral-500">
                        {` · ${preview.sourceNode.label}`}
                      </span>
                    )}
                  </div>
                  {preview.status === "ready" && (
                    <div class="mt-2">
                      <LayerView
                        layer={preview.layer}
                        layerIndex={0}
                        panelId={`flow-render-layer-${currentNode.node_id}`}
                      />
                    </div>
                  )}
                  {preview.status !== "ready" && (
                    <div class="mt-2 text-neutral-500">
                      {preview.status === "waiting" && "sourceNode" in preview
                        ? `Waiting for layer data from ${
                            preview.sourceNode?.label ?? "the source node"
                          }.`
                        : preview.status === "disconnected"
                          ? "Connect a layer output to the Render Layer node."
                          : "Render Layer node has no layer input configured."}
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        )}
      </Show>
    </div>
  );
}
