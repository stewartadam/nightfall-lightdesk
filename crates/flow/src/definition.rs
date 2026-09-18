// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Flow definition model and delta application helpers.

use nightfall::prelude::{HasIdentifiers, Identifiers};
use nightfall_selection::{
    SelectionValidatedEntity, SpatialSelectionResolution, selection_validation_warnings,
};
use serde::{Deserialize, Serialize};

use crate::protocol::{FlowDefinitionSnapshot, FlowDelta, FlowDeltaError, FlowDeltaOp};
use crate::types::{
    FlowEdgeDefinition, FlowId, FlowNodeDefinition, FlowNodeId, FlowPortDefinition, FlowPortId,
    FlowPortType, FlowValue, FlowVersion,
};

/// Stored flow definition with identifiers and versioning.
#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct FlowDefinition {
    /// Flow identifiers.
    pub identifiers: Identifiers,
    /// Definition version.
    pub flow_version: FlowVersion,
    /// Nodes in the flow.
    pub nodes: Vec<FlowNodeDefinition>,
    /// Edges between nodes.
    pub edges: Vec<FlowEdgeDefinition>,
}

impl HasIdentifiers for FlowDefinition {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

impl SelectionValidatedEntity for FlowDefinition {
    /// Return validation warnings for selections stored in flow node default values.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        let flow_id = self.identifiers.id;
        self.nodes
            .iter()
            .flat_map(|node| {
                let node_id = node.node_id;
                node.ports.iter().flat_map(move |port| {
                    let Some(FlowValue::Selection(selection)) = &port.default_value else {
                        return Vec::new();
                    };

                    let port_id = port.port_id;
                    selection_validation_warnings(selection, resolver)
                        .into_iter()
                        .map(move |warning| {
                            format!(
                                "Flow {} node {} port {}: {}",
                                flow_id, node_id, port_id, warning
                            )
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect()
    }
}

impl FlowDefinition {
    /// Create a new, empty flow definition.
    pub fn new(identifiers: Identifiers) -> Self {
        Self {
            identifiers,
            flow_version: 0,
            nodes: Vec::new(),
            edges: Vec::new(),
        }
    }

    /// Return the FlowId for this definition.
    pub fn flow_id(&self) -> FlowId {
        self.identifiers.id
    }

    /// Build a protocol snapshot for UI sync.
    pub fn to_snapshot(&self) -> FlowDefinitionSnapshot {
        FlowDefinitionSnapshot {
            flow_id: self.flow_id(),
            flow_version: self.flow_version,
            nodes: self.nodes.clone(),
            edges: self.edges.clone(),
        }
    }

    /// Apply a FlowDelta, returning the updated version and any errors.
    pub fn apply_delta(&mut self, delta: &FlowDelta) -> FlowDeltaApplyResult {
        let mut errors = Vec::new();
        let mut changed = false;

        if delta.flow_id != self.flow_id() {
            errors.push(FlowDeltaError {
                op_index: None,
                message: format!(
                    "Delta rejected by backend: flow_id mismatch (delta={} backend={})",
                    delta.flow_id,
                    self.flow_id()
                ),
            });
            return FlowDeltaApplyResult {
                applied_version: self.flow_version,
                errors,
            };
        }

        if delta.base_version != self.flow_version {
            errors.push(FlowDeltaError {
                op_index: None,
                message: format!(
                    "Delta rejected by backend: base_version mismatch (delta={} backend={})",
                    delta.base_version, self.flow_version
                ),
            });
            return FlowDeltaApplyResult {
                applied_version: self.flow_version,
                errors,
            };
        }

        for (op_index, op) in delta.ops.iter().enumerate() {
            let result = match op {
                FlowDeltaOp::AddNode(node) => self.apply_add_node(node),
                FlowDeltaOp::UpdateNode(update) => self.apply_update_node(update),
                FlowDeltaOp::RemoveNode { node_id } => self.apply_remove_node(*node_id),
                FlowDeltaOp::AddEdge(edge) => self.apply_add_edge(edge),
                FlowDeltaOp::RemoveEdge(edge) => self.apply_remove_edge(edge),
                FlowDeltaOp::UpdatePortConfig(update) => self.apply_update_port(update),
            };

            if let Err(message) = result {
                errors.push(FlowDeltaError {
                    op_index: Some(op_index as u32),
                    message,
                });
            } else {
                changed = true;
            }
        }

        if changed {
            self.flow_version = self.flow_version.saturating_add(1);
        }

        FlowDeltaApplyResult {
            applied_version: self.flow_version,
            errors,
        }
    }

    fn apply_add_node(&mut self, node: &FlowNodeDefinition) -> Result<(), String> {
        if self.nodes.iter().any(|n| n.node_id == node.node_id) {
            return Err(format!("node_id {} already exists", node.node_id));
        }

        let mut seen_ports = std::collections::HashSet::new();
        for port in &node.ports {
            if !seen_ports.insert(port.port_id) {
                return Err(format!(
                    "node {} has duplicate port_id {}",
                    node.node_id, port.port_id
                ));
            }
            if let Some(value) = &port.default_value {
                if !port.port_type.matches_value(value) {
                    return Err(format!(
                        "default value type mismatch for node {} port {}",
                        node.node_id, port.port_id
                    ));
                }
            }
        }

        self.nodes.push(node.clone());
        Ok(())
    }

    fn apply_update_node(
        &mut self,
        update: &crate::protocol::FlowNodeUpdate,
    ) -> Result<(), String> {
        let node = self
            .nodes
            .iter_mut()
            .find(|n| n.node_id == update.node_id)
            .ok_or_else(|| format!("node {} not found", update.node_id))?;

        if let Some(label) = &update.label {
            node.label = label.clone();
        }
        if let Some(position) = update.position {
            node.position = Some(position);
        }

        Ok(())
    }

    fn apply_remove_node(&mut self, node_id: FlowNodeId) -> Result<(), String> {
        let index = self
            .nodes
            .iter()
            .position(|node| node.node_id == node_id)
            .ok_or_else(|| format!("node {} not found", node_id))?;

        self.nodes.swap_remove(index);
        self.edges
            .retain(|edge| edge.from.node_id != node_id && edge.to.node_id != node_id);

        Ok(())
    }

    fn apply_add_edge(&mut self, edge: &FlowEdgeDefinition) -> Result<(), String> {
        if self.edges.iter().any(|e| e == edge) {
            return Err("edge already exists".to_string());
        }

        let (from_port, to_port) = self.resolve_edge_ports(edge)?;
        if from_port.direction != crate::types::FlowPortDirection::Output {
            return Err("edge 'from' port is not an output".to_string());
        }
        if to_port.direction != crate::types::FlowPortDirection::Input {
            return Err("edge 'to' port is not an input".to_string());
        }
        if from_port.port_type != to_port.port_type {
            return Err("edge port types do not match".to_string());
        }

        self.edges.push(edge.clone());
        Ok(())
    }

    fn apply_remove_edge(&mut self, edge: &FlowEdgeDefinition) -> Result<(), String> {
        let Some(index) = self.edges.iter().position(|e| e == edge) else {
            return Err("edge not found".to_string());
        };
        self.edges.swap_remove(index);
        Ok(())
    }

    fn apply_update_port(
        &mut self,
        update: &crate::protocol::FlowPortUpdate,
    ) -> Result<(), String> {
        let port = self
            .nodes
            .iter_mut()
            .find(|n| n.node_id == update.node_id)
            .and_then(|node| node.ports.iter_mut().find(|p| p.port_id == update.port_id))
            .ok_or_else(|| format!("node {} port {} not found", update.node_id, update.port_id))?;

        if let Some(name) = &update.name {
            port.name = name.clone();
        }
        if let Some(default_value) = &update.default_value {
            if !port.port_type.matches_value(default_value) {
                return Err("default value type mismatch".to_string());
            }
            port.default_value = Some(default_value.clone());
        }

        Ok(())
    }

    fn resolve_edge_ports(
        &self,
        edge: &FlowEdgeDefinition,
    ) -> Result<(&FlowPortDefinition, &FlowPortDefinition), String> {
        let from_port = self
            .find_port(edge.from.node_id, edge.from.port_id)
            .ok_or_else(|| "edge 'from' port not found".to_string())?;
        let to_port = self
            .find_port(edge.to.node_id, edge.to.port_id)
            .ok_or_else(|| "edge 'to' port not found".to_string())?;
        Ok((from_port, to_port))
    }

    /// Find a port definition by node and port id.
    pub fn find_port(
        &self,
        node_id: FlowNodeId,
        port_id: FlowPortId,
    ) -> Option<&FlowPortDefinition> {
        self.nodes
            .iter()
            .find(|node| node.node_id == node_id)
            .and_then(|node| node.ports.iter().find(|port| port.port_id == port_id))
    }
}

/// Result of applying a FlowDelta to a FlowDefinition.
#[derive(Clone, Debug, PartialEq)]
pub struct FlowDeltaApplyResult {
    /// Updated flow version after applying ops.
    pub applied_version: FlowVersion,
    /// Collected errors, if any.
    pub errors: Vec<FlowDeltaError>,
}

impl FlowPortType {}
