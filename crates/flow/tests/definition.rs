// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::Identifiers;
use nightfall_flow::definition::FlowDefinition;
use nightfall_flow::protocol::{FlowDelta, FlowDeltaOp, FlowNodeUpdate, FlowPortUpdate};
use nightfall_flow::types::{
    FlowEdgeDefinition, FlowNodeDefinition, FlowNodePosition, FlowPortDefinition,
    FlowPortDirection, FlowPortRef, FlowPortType, FlowValue,
};

fn make_identifiers(id: u32, label: &str) -> Identifiers {
    Identifiers {
        id,
        label: label.to_string(),
        ..Default::default()
    }
}

fn make_port(
    port_id: u32,
    name: &str,
    direction: FlowPortDirection,
    port_type: FlowPortType,
    default_value: Option<FlowValue>,
) -> FlowPortDefinition {
    FlowPortDefinition {
        port_id,
        name: name.to_string(),
        direction,
        port_type,
        is_optional: false,
        default_value,
        enum_options: None,
    }
}

fn make_node(node_id: u32, ports: Vec<FlowPortDefinition>) -> FlowNodeDefinition {
    FlowNodeDefinition {
        node_id,
        kind: "test".to_string(),
        label: format!("Node {}", node_id),
        ports,
        position: None,
    }
}

fn make_edge(from_node: u32, from_port: u32, to_node: u32, to_port: u32) -> FlowEdgeDefinition {
    FlowEdgeDefinition {
        from: FlowPortRef {
            node_id: from_node,
            port_id: from_port,
        },
        to: FlowPortRef {
            node_id: to_node,
            port_id: to_port,
        },
    }
}

#[test]
fn test_apply_delta_add_nodes_and_edge() {
    let mut flow = FlowDefinition::new(make_identifiers(1, "Flow 1"));

    let node_a = make_node(
        10,
        vec![make_port(
            1,
            "Out",
            FlowPortDirection::Output,
            FlowPortType::Number,
            None,
        )],
    );
    let node_b = make_node(
        11,
        vec![make_port(
            1,
            "In",
            FlowPortDirection::Input,
            FlowPortType::Number,
            None,
        )],
    );
    let edge = make_edge(10, 1, 11, 1);

    let delta = FlowDelta {
        flow_id: 1,
        base_version: 0,
        ops: vec![
            FlowDeltaOp::AddNode(node_a),
            FlowDeltaOp::AddNode(node_b),
            FlowDeltaOp::AddEdge(edge),
        ],
    };

    let result = flow.apply_delta(&delta);
    assert!(result.errors.is_empty(), "Expected no delta errors");
    assert_eq!(flow.flow_version, 1);
    assert_eq!(flow.nodes.len(), 2);
    assert_eq!(flow.edges.len(), 1);
    assert_eq!(result.applied_version, 1);
}

#[test]
fn test_apply_delta_update_node_and_port() {
    let mut flow = FlowDefinition::new(make_identifiers(2, "Flow 2"));
    let node = make_node(
        20,
        vec![make_port(
            2,
            "Rate",
            FlowPortDirection::Input,
            FlowPortType::Number,
            Some(FlowValue::Number(1.0)),
        )],
    );
    let delta = FlowDelta {
        flow_id: 2,
        base_version: 0,
        ops: vec![FlowDeltaOp::AddNode(node)],
    };
    flow.apply_delta(&delta);

    let update_delta = FlowDelta {
        flow_id: 2,
        base_version: 1,
        ops: vec![
            FlowDeltaOp::UpdateNode(FlowNodeUpdate {
                node_id: 20,
                label: Some("New Label".to_string()),
                position: Some(FlowNodePosition { x: 5.0, y: -2.5 }),
            }),
            FlowDeltaOp::UpdatePortConfig(FlowPortUpdate {
                node_id: 20,
                port_id: 2,
                name: Some("Speed".to_string()),
                default_value: Some(FlowValue::Number(2.5)),
            }),
        ],
    };

    let result = flow.apply_delta(&update_delta);
    assert!(result.errors.is_empty(), "Expected no delta errors");
    assert_eq!(flow.flow_version, 2);

    let node = flow.nodes.iter().find(|n| n.node_id == 20).unwrap();
    assert_eq!(node.label, "New Label");
    assert_eq!(node.position, Some(FlowNodePosition { x: 5.0, y: -2.5 }));
    let port = node.ports.iter().find(|p| p.port_id == 2).unwrap();
    assert_eq!(port.name, "Speed");
    assert_eq!(port.default_value, Some(FlowValue::Number(2.5)));
}

#[test]
fn test_apply_delta_base_version_mismatch() {
    let mut flow = FlowDefinition::new(make_identifiers(3, "Flow 3"));
    let delta = FlowDelta {
        flow_id: 3,
        base_version: 1,
        ops: vec![],
    };

    let result = flow.apply_delta(&delta);
    assert_eq!(flow.flow_version, 0);
    assert_eq!(result.applied_version, 0);
    assert_eq!(result.errors.len(), 1);
    assert!(result.errors[0].op_index.is_none());
}

#[test]
fn test_apply_delta_edge_type_mismatch() {
    let mut flow = FlowDefinition::new(make_identifiers(4, "Flow 4"));
    let node_a = make_node(
        40,
        vec![make_port(
            1,
            "Out",
            FlowPortDirection::Output,
            FlowPortType::Number,
            None,
        )],
    );
    let node_b = make_node(
        41,
        vec![make_port(
            2,
            "In",
            FlowPortDirection::Input,
            FlowPortType::String,
            None,
        )],
    );

    let delta = FlowDelta {
        flow_id: 4,
        base_version: 0,
        ops: vec![
            FlowDeltaOp::AddNode(node_a),
            FlowDeltaOp::AddNode(node_b),
            FlowDeltaOp::AddEdge(make_edge(40, 1, 41, 2)),
        ],
    };

    let result = flow.apply_delta(&delta);
    assert_eq!(flow.flow_version, 1);
    assert_eq!(flow.edges.len(), 0);
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].op_index, Some(2));
}

#[test]
fn test_apply_delta_remove_node_cleans_edges() {
    let mut flow = FlowDefinition::new(make_identifiers(5, "Flow 5"));
    let node_a = make_node(
        50,
        vec![make_port(
            1,
            "Out",
            FlowPortDirection::Output,
            FlowPortType::Number,
            None,
        )],
    );
    let node_b = make_node(
        51,
        vec![make_port(
            1,
            "In",
            FlowPortDirection::Input,
            FlowPortType::Number,
            None,
        )],
    );

    let delta = FlowDelta {
        flow_id: 5,
        base_version: 0,
        ops: vec![
            FlowDeltaOp::AddNode(node_a),
            FlowDeltaOp::AddNode(node_b),
            FlowDeltaOp::AddEdge(make_edge(50, 1, 51, 1)),
        ],
    };
    flow.apply_delta(&delta);

    let remove_delta = FlowDelta {
        flow_id: 5,
        base_version: 1,
        ops: vec![FlowDeltaOp::RemoveNode { node_id: 50 }],
    };
    let result = flow.apply_delta(&remove_delta);

    assert!(result.errors.is_empty());
    assert_eq!(flow.flow_version, 2);
    assert_eq!(flow.nodes.len(), 1);
    assert!(flow.edges.is_empty());
}
