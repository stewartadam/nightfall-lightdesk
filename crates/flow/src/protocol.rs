// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! UI <-> backend protocol types for flow graphs.

use serde::{Deserialize, Serialize};

use crate::nodes::FlowNodeDescriptor;
use crate::types::{
    FlowEdgeDefinition, FlowId, FlowNodeDefinition, FlowNodeId, FlowNodePosition, FlowPortId,
    FlowPortRef, FlowPortVersion, FlowSeq, FlowValue, FlowVersion,
};

/// Node templates sent to frontend during resync.
pub type FlowNodeTemplates = Vec<FlowNodeDescriptor>;

/// Full definition snapshot for a flow.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowDefinitionSnapshot {
    /// Flow identifier.
    pub flow_id: FlowId,
    /// Definition version.
    pub flow_version: FlowVersion,
    /// Nodes in the flow.
    pub nodes: Vec<FlowNodeDefinition>,
    /// Edges between nodes.
    pub edges: Vec<FlowEdgeDefinition>,
}

/// Flow definition delta made of discrete operations.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowDelta {
    /// Flow identifier.
    pub flow_id: FlowId,
    /// Base version to apply ops against.
    pub base_version: FlowVersion,
    /// Operations to apply.
    pub ops: Vec<FlowDeltaOp>,
}

/// An individual change operation in a FlowDelta.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum FlowDeltaOp {
    /// Add a new node.
    AddNode(FlowNodeDefinition),
    /// Update node metadata (label, position).
    UpdateNode(FlowNodeUpdate),
    /// Remove a node by id.
    RemoveNode {
        /// The id of the node to remove
        node_id: FlowNodeId,
    },
    /// Add an edge.
    AddEdge(FlowEdgeDefinition),
    /// Remove an edge.
    RemoveEdge(FlowEdgeDefinition),
    /// Update a port's configuration.
    UpdatePortConfig(FlowPortUpdate),
}

/// Partial update for a node.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowNodeUpdate {
    /// Target node id.
    pub node_id: FlowNodeId,
    /// Updated label, if any.
    pub label: Option<String>,
    /// Updated position, if any.
    pub position: Option<FlowNodePosition>,
}

/// Partial update for a port.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowPortUpdate {
    /// Target node id.
    pub node_id: FlowNodeId,
    /// Target port id.
    pub port_id: FlowPortId,
    /// Updated port name, if any.
    pub name: Option<String>,
    /// Updated default value, if any.
    pub default_value: Option<FlowValue>,
}

/// Full runtime snapshot for a flow (rarely needed).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowSnapshot {
    /// Flow identifier.
    pub flow_id: FlowId,
    /// Definition version.
    pub flow_version: FlowVersion,
    /// Port runtime values.
    pub ports: Vec<FlowPortRuntimeValue>,
}

/// Runtime value for a specific port.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowPortRuntimeValue {
    /// Node id.
    pub node_id: FlowNodeId,
    /// Port id.
    pub port_id: FlowPortId,
    /// Port version.
    pub port_version: FlowPortVersion,
    /// Current value.
    pub value: FlowValue,
}

/// Delta for a single port value.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowPortValueDelta {
    /// Flow identifier.
    pub flow_id: FlowId,
    /// Definition version.
    pub flow_version: FlowVersion,
    /// Node id.
    pub node_id: FlowNodeId,
    /// Port id.
    pub port_id: FlowPortId,
    /// Port version.
    pub port_version: FlowPortVersion,
    /// Updated value.
    pub value: FlowValue,
}

/// Delta for a Trigger port event.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowTriggerDelta {
    /// Flow identifier.
    pub flow_id: FlowId,
    /// Definition version.
    pub flow_version: FlowVersion,
    /// Node id.
    pub node_id: FlowNodeId,
    /// Port id.
    pub port_id: FlowPortId,
    /// Monotonic event sequence.
    pub seq: FlowSeq,
    /// Count of events since last update.
    pub count: u32,
}

/// Acknowledgement for a flow delta.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowAck {
    /// Flow identifier.
    pub flow_id: FlowId,
    /// Version the client based changes on.
    pub base_version: FlowVersion,
    /// Version after applying ops.
    pub applied_version: FlowVersion,
    /// Optional errors per op.
    pub errors: Vec<FlowDeltaError>,
}

/// Error information for a single delta op.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowDeltaError {
    /// Index into FlowDelta.ops, or None for a flow-level error.
    pub op_index: Option<u32>,
    /// Error message.
    pub message: String,
}

/// Helper for edge-specific updates (optional future use).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct FlowEdgeRef {
    /// Output port reference.
    pub from: FlowPortRef,
    /// Input port reference.
    pub to: FlowPortRef,
}
