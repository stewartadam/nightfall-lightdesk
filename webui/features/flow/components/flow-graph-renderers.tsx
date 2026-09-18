// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  BaseEdge,
  type ConnectionLineComponentProps,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  getBezierPath,
  Handle,
  type NodeProps,
  NodeToolbar,
  type NodeTypes,
  Position,
  useViewport,
} from "@dschz/solid-flow";
import { createMemo, For, Show } from "solid-js";
import { MenuSurface } from "../../../components/ui/menu";
import { Button } from "../../../components/ui/visual-language/button";
import type * as types from "../../../types/index";
import { useFlowContextOptional } from "../context/flow-context";
import { useNodeHandlers } from "../controllers/graph-controller";
import type { FlowEdgeData, FlowNodeData } from "../model/graph-types";
import {
  portColorHex,
  portTypeLabel,
  resolveAttributeValue,
  resolveNumberValue,
  resolveSelectionValue,
} from "../model/utils";
import {
  AttributeEditor,
  EnumEditor,
  NumberEditor,
  SelectionEditor,
} from "./inline-editors";

const GENERATOR_NODE_KINDS = new Set([
  "metronome",
  "selection",
  "color_picker",
]);

/**
 * Renders one input or output port row with its handle, value preview, and optional inline editor.
 */
function FlowPortRow(props: {
  nodeId: types.FlowNodeId;
  port: types.FlowPortDefinition;
  align: "left" | "right";
  isConnected: boolean;
  handleId: string;
  nodeKind: string;
  onUpdatePortDefault: (
    port: types.FlowPortDefinition,
    value: types.FlowValue,
  ) => void;
}) {
  const flowContext = useFlowContextOptional();
  const showSelectionEditor = createMemo(
    () =>
      props.port.direction === "input" &&
      props.port.port_type === "selection" &&
      !props.isConnected,
  );
  const showAttributeEditor = createMemo(
    () =>
      props.port.direction === "input" &&
      props.port.port_type === "attribute" &&
      !props.isConnected,
  );
  const showEnumEditor = createMemo(
    () =>
      props.port.direction === "input" &&
      props.port.port_type === "int" &&
      props.port.enum_options &&
      props.port.enum_options.length > 0 &&
      !props.isConnected,
  );
  const showNumberEditor = createMemo(
    () =>
      props.port.direction === "input" &&
      (props.port.port_type === "number" ||
        (props.port.port_type === "int" && !showEnumEditor())) &&
      !props.isConnected,
  );

  const isInput = () => props.port.direction === "input";

  const isGenerator = () => GENERATOR_NODE_KINDS.has(props.nodeKind);

  const showHandle = () => !(isInput() && isGenerator());

  const isTrigger = () => props.port.port_type === "trigger";

  const shapeColor = () => portColorHex(props.port.port_type);

  /** Check if this port has an inline editor (enum, number, selection, or attribute) */
  const hasInlineEditor = createMemo(
    () =>
      showEnumEditor() ||
      showNumberEditor() ||
      showSelectionEditor() ||
      showAttributeEditor(),
  );

  return (
    <>
      {/* Label column */}
      <div
        class={`relative flex flex-col text-[11px] ${
          props.align === "right" ? "text-right" : ""
        }`}
      >
        <span class="relative text-neutral-200">
          <Show when={showHandle()}>
            <Handle
              type={isInput() ? "target" : "source"}
              position={isInput() ? Position.Left : Position.Right}
              id={props.handleId}
              style={{
                position: "absolute",
                top: "50%",
                [isInput() ? "left" : "right"]: "-19px",
                width: isTrigger() ? "0px" : "12px",
                height: isTrigger() ? "0px" : "12px",
                "min-width": isTrigger() ? "0px" : "12px",
                "min-height": isTrigger() ? "0px" : "12px",
                "border-radius": isTrigger() ? "0" : "9999px",
                "border-left": isTrigger()
                  ? "7px solid transparent"
                  : undefined,
                "border-right": isTrigger()
                  ? "7px solid transparent"
                  : undefined,
                "border-bottom": isTrigger()
                  ? `12px solid ${shapeColor()}`
                  : undefined,
                "border-top": isTrigger() ? "none" : undefined,
                background: isTrigger() ? "transparent" : shapeColor(),
                transform: "translateY(-50%)",
              }}
            />
          </Show>
          {props.port.name}
        </span>
        <span class="text-[10px] text-neutral-400">
          {portTypeLabel(props.port.port_type)}
        </span>
      </div>
      {/* Control column */}
      <div
        class={`flex items-center text-[11px] ${
          props.align === "right" ? "justify-start" : "justify-end"
        }`}
      >
        <Show when={showSelectionEditor()}>
          <SelectionEditor
            value={resolveSelectionValue(props.port)}
            onCommit={(value) =>
              props.onUpdatePortDefault(props.port, {
                type: "Selection",
                data: value,
              })
            }
          />
        </Show>
        <Show when={showAttributeEditor()}>
          <AttributeEditor
            value={resolveAttributeValue(props.port)}
            onCommit={(value) =>
              props.onUpdatePortDefault(props.port, {
                type: "AttributeLabel",
                data: value,
              })
            }
          />
        </Show>
        <Show when={showEnumEditor()}>
          <EnumEditor
            value={resolveNumberValue(props.port)}
            port={props.port}
            onCommit={(value) =>
              props.onUpdatePortDefault(props.port, {
                type: "Int",
                data: value,
              })
            }
          />
        </Show>
        <Show when={showNumberEditor()}>
          <NumberEditor
            value={
              flowContext && props.port.port_id !== undefined
                ? ((flowContext.getDisplayValue(
                    props.nodeId,
                    props.port.port_id,
                    props.port.default_value,
                  )?.data as number) ?? resolveNumberValue(props.port))
                : resolveNumberValue(props.port)
            }
            port={props.port}
            onInput={
              flowContext && props.port.port_id !== undefined
                ? (value) => {
                    const flowValue: types.FlowValue = {
                      type: props.port.port_type === "int" ? "Int" : "Number",
                      data:
                        props.port.port_type === "int"
                          ? Math.round(value)
                          : value,
                    };
                    flowContext.updateValue(
                      props.nodeId,
                      props.port.port_id!,
                      flowValue,
                    );
                  }
                : undefined
            }
            onCommit={(value) => {
              if (flowContext && props.port.port_id !== undefined) {
                // Flush any pending debounced update immediately
                flowContext.flushPending(props.nodeId, props.port.port_id);
              } else {
                // Fallback for when not using FlowContext
                props.onUpdatePortDefault(props.port, {
                  type: props.port.port_type === "int" ? "Int" : "Number",
                  data:
                    props.port.port_type === "int" ? Math.round(value) : value,
                });
              }
            }}
          />
        </Show>
        {/* Empty placeholder if no editor to maintain grid alignment */}
        <Show when={!hasInlineEditor()}>
          <span />
        </Show>
      </div>
    </>
  );
}

/**
 * Renders a flow node card with editable ports and the selected-node toolbar actions.
 */
function FlowNodeCard(props: NodeProps<FlowNodeData, "flowNode">) {
  const handlers = useNodeHandlers();

  const stopPropagation = (e: MouseEvent | PointerEvent | KeyboardEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      class={`relative min-w-[240px] rounded-lg border bg-neutral-900 text-neutral-100 shadow-lg overflow-visible ${
        props.data.pulse ? "border-red-500" : "border-neutral-700"
      } ${props.selected ? "ring-2 ring-sky-400/60" : ""}`}
    >
      <NodeToolbar
        isVisible={props.selected ?? false}
        position="top"
        nodeId={props.id}
      >
        <MenuSurface
          class="flex items-center gap-1 nodrag"
          onPointerDown={stopPropagation}
          onClick={stopPropagation}
          onKeyDown={stopPropagation}
        >
          <Button
            size="compact"
            variant="subtle"
            onClick={() => handlers.onCutNode(props.data.nodeId)}
          >
            Cut
          </Button>
          <Button
            size="compact"
            variant="subtle"
            onClick={() => handlers.onDuplicateNode(props.data.nodeId)}
          >
            Duplicate
          </Button>
          <Button
            size="compact"
            variant="danger"
            onClick={() => handlers.onDeleteNode(props.data.nodeId)}
          >
            Delete
          </Button>
        </MenuSurface>
      </NodeToolbar>
      <div class="flow-node-drag border-b border-neutral-700 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {props.data.label}
      </div>
      <div class="grid grid-cols-2 gap-4 px-3 py-3">
        <Show when={!GENERATOR_NODE_KINDS.has(props.data.nodeKind)}>
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
            <For each={props.data.inputs}>
              {(entry) => (
                <FlowPortRow
                  nodeId={props.data.nodeId}
                  port={entry.port}
                  align="left"
                  isConnected={entry.isConnected}
                  handleId={entry.handleId}
                  nodeKind={props.data.nodeKind}
                  onUpdatePortDefault={(port, value) =>
                    handlers.onUpdatePortDefault(props.data.nodeId, port, value)
                  }
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={GENERATOR_NODE_KINDS.has(props.data.nodeKind)}>
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center" />
        </Show>
        <div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 items-center">
          <For each={props.data.outputs}>
            {(entry) => (
              <FlowPortRow
                nodeId={props.data.nodeId}
                port={entry.port}
                align="right"
                isConnected={entry.isConnected}
                handleId={entry.handleId}
                nodeKind={props.data.nodeKind}
                onUpdatePortDefault={(port, value) =>
                  handlers.onUpdatePortDefault(props.data.nodeId, port, value)
                }
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

/**
 * Draws a bezier edge and overlays its label in graph coordinates.
 */
function LabeledEdge(props: EdgeProps<FlowEdgeData, "labeled">) {
  const pathData = createMemo(() => {
    return getBezierPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition as Position,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: props.targetPosition as Position,
    });
  });

  return (
    <>
      <BaseEdge path={pathData()[0]} />
      <Show when={props.data?.label}>
        <EdgeLabelRenderer>
          <div
            class="nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${pathData()[1]}px,${pathData()[2]}px)`,
              background: "rgba(17, 24, 39, 0.9)",
              border: "1px solid rgba(75, 85, 99, 0.8)",
              "border-radius": "6px",
              padding: "2px 6px",
              "font-size": "10px",
              color: "#e5e7eb",
              "pointer-events": "none",
            }}
          >
            {props.data!.label}
          </div>
        </EdgeLabelRenderer>
      </Show>
    </>
  );
}

/**
 * Corrects solid-flow's connection preview coordinates while the viewport is panned or zoomed.
 */
export function FixedConnectionLine(props: ConnectionLineComponentProps) {
  const viewport = useViewport();

  const correctedTo = createMemo(() => {
    const vp = viewport();
    return {
      x: (props.toX - vp.x) / vp.zoom,
      y: (props.toY - vp.y) / vp.zoom,
    };
  });

  const pathData = createMemo(() => {
    const to = correctedTo();
    return getBezierPath({
      sourceX: props.fromX,
      sourceY: props.fromY,
      sourcePosition: props.fromPosition as Position,
      targetX: to.x,
      targetY: to.y,
      targetPosition: props.toPosition as Position,
    });
  });

  return (
    <path
      d={pathData()[0]}
      fill="none"
      stroke="#b1b1b7"
      stroke-width={1.5}
      class="solid-flow__connection-path animated"
    />
  );
}

// Solid Flow component registries for the custom node, edge, and connection preview renderers.
export const nodeTypes: NodeTypes = {
  flowNode: FlowNodeCard,
};

export const edgeTypes: EdgeTypes = {
  labeled: LabeledEdge,
};
