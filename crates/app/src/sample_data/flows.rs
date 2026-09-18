// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Seed built-in sample flows and clips in deterministic order.
pub(super) fn add_flows(world: &mut World) {
    let mut system_state: SystemState<(
        Commands,
        ResMut<DataProvider<FlowDefinition>>,
        Res<FlowNodeRegistry>,
    )> = SystemState::new(world);
    let (mut commands, mut flow_data_provider, registry) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    let metronome_flow = build_metronome_flow(&registry);
    let chase_flow = build_red_chase_flow(&registry);

    flow_data_provider
        .add(metronome_flow)
        .expect("sample data should not have duplicate IDs");
    flow_data_provider
        .add(chase_flow)
        .expect("sample data should not have duplicate IDs");

    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 24,
            label: "Flow: Metronome Alternator".to_owned(),
            uid: Uuid::from_str("4d2f83c4-1305-44b0-92bb-7650ce4e28c4").unwrap(),
        },
        source: Some(Source::Flow(
            Uuid::from_str("c4dcd5fa-2231-4bdf-8d91-486efef2990e").unwrap(),
        )),
        ..Default::default()
    });
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 25,
            label: "Flow: Modulated Chase".to_owned(),
            uid: Uuid::from_str("5441e177-f7d9-49e3-9c3c-7f0e804964f6").unwrap(),
        },
        source: Some(Source::Flow(
            Uuid::from_str("c9ff2525-d0e2-4b4c-a5a0-1e50d90b6e32").unwrap(),
        )),
        ..Default::default()
    });

    system_state.apply(world);
}

/// Build the alternating metronome demonstration flow from registered nodes.
fn build_metronome_flow(registry: &FlowNodeRegistry) -> FlowDefinition {
    let metronome = flow_node_with_defaults(
        registry,
        1,
        flow_nodes::METRONOME_KIND,
        "Metronome",
        &[(flow_nodes::METRONOME_IN_RATE, FlowValue::Number(60.0))],
    );
    let left_selection = flow_node_with_defaults(
        registry,
        2,
        flow_nodes::CONSTANT_SELECTION_KIND,
        "Left Group",
        &[(
            flow_nodes::SELECTION_IN,
            FlowValue::Selection(SelectionExpr::Group(GroupRefExpr::ById(1)).into()),
        )],
    );
    let right_selection = flow_node_with_defaults(
        registry,
        3,
        flow_nodes::CONSTANT_SELECTION_KIND,
        "Right Group",
        &[(
            flow_nodes::SELECTION_IN,
            FlowValue::Selection(SelectionExpr::Group(GroupRefExpr::ById(2)).into()),
        )],
    );
    let toggle = flow_node_with_defaults(
        registry,
        4,
        flow_nodes::TOGGLE_SELECTION_KIND,
        "Toggle",
        &[],
    );
    let fx = flow_node_with_defaults(
        registry,
        5,
        flow_nodes::WAVEFORM_FX_KIND,
        "Metronome FX",
        &[
            (
                flow_nodes::WAVEFORM_FX_IN_ATTRIBUTE,
                FlowValue::AttributeLabels(vec![
                    "Red".to_string(),
                    "Green".to_string(),
                    "Blue".to_string(),
                ]),
            ),
            (
                flow_nodes::WAVEFORM_FX_IN_WAVEFORM,
                FlowValue::Waveform(FlowWaveform {
                    kind: WaveformKind::Square,
                    rate_secs: 1.0,
                    amplitude: 0.0,
                    phase: 0.0,
                    base: 1.0,
                    duty_cycle: None,
                }),
            ),
        ],
    );
    let render_metronome = flow_node_with_defaults(
        registry,
        6,
        flow_nodes::RENDER_LAYER_KIND,
        "Render Metronome Layer",
        &[],
    );

    FlowDefinition {
        identifiers: Identifiers {
            id: 1,
            label: "Flow: Metronome Alternator".to_string(),
            uid: Uuid::from_str("c4dcd5fa-2231-4bdf-8d91-486efef2990e").unwrap(),
        },
        flow_version: 0,
        nodes: vec![
            metronome,
            left_selection,
            right_selection,
            toggle,
            fx,
            render_metronome,
        ],
        edges: vec![
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 1,
                    port_id: flow_nodes::METRONOME_OUT_TRIGGER,
                },
                to: FlowPortRef {
                    node_id: 4,
                    port_id: flow_nodes::TOGGLE_IN_TRIGGER,
                },
            },
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 2,
                    port_id: flow_nodes::SELECTION_OUT,
                },
                to: FlowPortRef {
                    node_id: 4,
                    port_id: flow_nodes::TOGGLE_IN_A,
                },
            },
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 3,
                    port_id: flow_nodes::SELECTION_OUT,
                },
                to: FlowPortRef {
                    node_id: 4,
                    port_id: flow_nodes::TOGGLE_IN_B,
                },
            },
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 4,
                    port_id: flow_nodes::TOGGLE_OUT,
                },
                to: FlowPortRef {
                    node_id: 5,
                    port_id: flow_nodes::WAVEFORM_FX_IN_SELECTION,
                },
            },
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 5,
                    port_id: flow_nodes::WAVEFORM_FX_OUT_LAYER,
                },
                to: FlowPortRef {
                    node_id: 6,
                    port_id: flow_nodes::RENDER_LAYER_IN_LAYER,
                },
            },
        ],
    }
}

/// Build the red chase demonstration flow from registered nodes.
fn build_red_chase_flow(registry: &FlowNodeRegistry) -> FlowDefinition {
    let selection = flow_node_with_defaults(
        registry,
        1,
        flow_nodes::CONSTANT_SELECTION_KIND,
        "Groups 3-10",
        &[(
            flow_nodes::SELECTION_IN,
            FlowValue::Selection(
                SelectionExpr::Group(GroupRefExpr::RangeById { start: 3, end: 10 }).into(),
            ),
        )],
    );
    // Waveform that defines the LFO shape for rate modulation
    let rate_lfo_waveform = flow_node_with_defaults(
        registry,
        2,
        flow_nodes::WAVEFORM_KIND,
        "Rate LFO Shape",
        &[
            (
                flow_nodes::WAVEFORM_IN_KIND,
                FlowValue::WaveformKind(WaveformKind::Sin),
            ),
            (flow_nodes::WAVEFORM_IN_RATE, FlowValue::Number(4.0)),
            (flow_nodes::WAVEFORM_IN_AMPLITUDE, FlowValue::Number(1.5)), // Modulate rate by +/- 1.5s
            (flow_nodes::WAVEFORM_IN_BASE, FlowValue::Number(0.5)),      // Center around 0.5
        ],
    );
    // Oscillator samples the LFO waveform to produce a numerical value over time
    let rate_oscillator = flow_node_with_defaults(
        registry,
        3,
        flow_nodes::OSCILLATOR_KIND,
        "Rate Oscillator",
        &[],
    );
    // Main FX waveform whose rate is modulated by the oscillator output
    let fx_waveform = flow_node_with_defaults(
        registry,
        4,
        flow_nodes::WAVEFORM_KIND,
        "FX Waveform",
        &[(
            flow_nodes::WAVEFORM_IN_KIND,
            FlowValue::WaveformKind(WaveformKind::Sawtooth),
        )],
    );
    let fx = flow_node_with_defaults(
        registry,
        5,
        flow_nodes::WAVEFORM_FX_KIND,
        "Green Chase",
        &[(
            flow_nodes::WAVEFORM_FX_IN_ATTRIBUTE,
            FlowValue::AttributeLabel("Green".to_string()),
        )],
    );
    let render_chase = flow_node_with_defaults(
        registry,
        6,
        flow_nodes::RENDER_LAYER_KIND,
        "Render Chase Layer",
        &[],
    );

    FlowDefinition {
        identifiers: Identifiers {
            id: 2,
            label: "Flow: Modulated Chase".to_string(),
            uid: Uuid::from_str("c9ff2525-d0e2-4b4c-a5a0-1e50d90b6e32").unwrap(),
        },
        flow_version: 0,
        nodes: vec![
            selection,
            rate_lfo_waveform,
            rate_oscillator,
            fx_waveform,
            fx,
            render_chase,
        ],
        edges: vec![
            // Selection -> FX
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 1,
                    port_id: flow_nodes::SELECTION_OUT,
                },
                to: FlowPortRef {
                    node_id: 5,
                    port_id: flow_nodes::WAVEFORM_FX_IN_SELECTION,
                },
            },
            // Rate LFO Shape -> Rate Oscillator
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 2,
                    port_id: flow_nodes::WAVEFORM_OUT,
                },
                to: FlowPortRef {
                    node_id: 3,
                    port_id: flow_nodes::OSCILLATOR_IN_WAVEFORM,
                },
            },
            // Rate Oscillator -> FX Waveform Rate
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 3,
                    port_id: flow_nodes::OSCILLATOR_OUT_VALUE,
                },
                to: FlowPortRef {
                    node_id: 4,
                    port_id: flow_nodes::WAVEFORM_IN_RATE,
                },
            },
            // FX Waveform -> FX
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 4,
                    port_id: flow_nodes::WAVEFORM_OUT,
                },
                to: FlowPortRef {
                    node_id: 5,
                    port_id: flow_nodes::WAVEFORM_FX_IN_WAVEFORM,
                },
            },
            // FX -> Render Layer
            FlowEdgeDefinition {
                from: FlowPortRef {
                    node_id: 5,
                    port_id: flow_nodes::WAVEFORM_FX_OUT_LAYER,
                },
                to: FlowPortRef {
                    node_id: 6,
                    port_id: flow_nodes::RENDER_LAYER_IN_LAYER,
                },
            },
        ],
    }
}

/// Instantiate a registered flow node and apply its sample input defaults.
fn flow_node_with_defaults(
    registry: &FlowNodeRegistry,
    node_id: FlowNodeId,
    kind: &str,
    label: &str,
    defaults: &[(FlowPortId, FlowValue)],
) -> FlowNodeDefinition {
    let descriptor = registry
        .descriptor(kind)
        .unwrap_or_else(|| panic!("Flow node kind '{}' is not registered", kind));
    let mut node = FlowNodeDefinition {
        node_id,
        kind: kind.to_string(),
        label: label.to_string(),
        ports: descriptor.ports,
        position: None,
    };
    for (port_id, value) in defaults {
        if let Some(port) = node.ports.iter_mut().find(|port| port.port_id == *port_id) {
            port.default_value = Some(value.clone());
        }
    }
    node
}
