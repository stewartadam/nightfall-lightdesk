// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Edge, Node } from "@dschz/solid-flow";
import type * as types from "../../../types";

export type PortMeta = {
  port: types.FlowPortDefinition;
  handleId: string;
  index: number;
  isConnected: boolean;
};

export type FlowNodeData = {
  label: string;
  nodeId: types.FlowNodeId;
  nodeKind: string;
  inputs: PortMeta[];
  outputs: PortMeta[];
  pulse: boolean;
};

export type FlowEdgeData = {
  edge: types.FlowEdgeDefinition;
  label?: string;
};

export type SolidFlowNode = Node<FlowNodeData, "flowNode">;
export type SolidFlowEdge = Edge<FlowEdgeData, "labeled">;
