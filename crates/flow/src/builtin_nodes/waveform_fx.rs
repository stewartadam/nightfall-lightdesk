// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Waveform FX node implementation.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use nightfall::prelude::{FixtureRef, Priority, ResolvedSelection, SelectionExpr};
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_selection::prelude::*;
use nightfall_waveform::prelude::*;

use super::waveform::default_waveform_value;
use crate::nodes::{FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory};
use crate::types::{
    FlowLayerSummary, FlowNodeDefinition, FlowNodeId, FlowPortDefinition, FlowPortDirection,
    FlowPortId, FlowPortType, FlowValue, FlowWaveform,
};

/// Node kind identifier for the waveform FX node.
pub const WAVEFORM_FX_KIND: &str = "waveform_fx";
/// Port id for the waveform FX selection input.
pub const WAVEFORM_FX_IN_SELECTION: FlowPortId = 1;
/// Port id for the waveform FX waveform input.
pub const WAVEFORM_FX_IN_WAVEFORM: FlowPortId = 2;
/// Port id for the waveform FX attribute input.
pub const WAVEFORM_FX_IN_ATTRIBUTE: FlowPortId = 3;
/// Port id for the waveform FX layer output.
pub const WAVEFORM_FX_OUT_LAYER: FlowPortId = 4;

/// Factory for creating waveform FX nodes.
pub struct WaveformFxFactory;

impl FlowNodeFactory for WaveformFxFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: WAVEFORM_FX_KIND.to_string(),
            label: "Waveform FX".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: WAVEFORM_FX_IN_SELECTION,
                    name: "Selection".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Selection,
                    is_optional: true,
                    default_value: Some(FlowValue::Selection(SelectionExpr::default().into())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_FX_IN_WAVEFORM,
                    name: "Waveform".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Waveform,
                    is_optional: true,
                    default_value: Some(default_waveform_value()),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_FX_IN_ATTRIBUTE,
                    name: "Attribute".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Attribute,
                    is_optional: true,
                    default_value: Some(FlowValue::AttributeLabel("Intensity".to_string())),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: WAVEFORM_FX_OUT_LAYER,
                    name: "Layer".to_string(),
                    direction: FlowPortDirection::Output,
                    port_type: FlowPortType::Layer,
                    is_optional: false,
                    default_value: None,
                    enum_options: None,
                },
            ],
        }
    }

    fn create(&self) -> Box<dyn FlowNode> {
        Box::new(WaveformFxNode)
    }
}

/// A node that creates waveform FX layer outputs.
pub struct WaveformFxNode;

impl FlowNode for WaveformFxNode {
    fn execute(
        &mut self,
        inputs: &crate::nodes::FlowPortValues,
        outputs: &mut crate::nodes::FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let selection = match inputs.get(&WAVEFORM_FX_IN_SELECTION) {
            Some(FlowValue::Selection(selection)) => selection.to_string(),
            _ => "Selection".to_string(),
        };
        let attribute_labels = match inputs.get(&WAVEFORM_FX_IN_ATTRIBUTE) {
            Some(FlowValue::AttributeLabel(label)) => vec![label.clone()],
            Some(FlowValue::AttributeLabels(labels)) => labels.clone(),
            _ => vec!["Attribute".to_string()],
        };
        let attribute_label = attribute_labels.join(", ");

        outputs.insert(
            WAVEFORM_FX_OUT_LAYER,
            FlowValue::LayerSummary(FlowLayerSummary {
                label: format!("Waveform FX: {} {}", selection, attribute_label),
            }),
        );
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }
}

/// Build a waveform layer from node inputs and state.
pub fn build_waveform_layer(
    node_def: &FlowNodeDefinition,
    frame_delta: std::time::Duration,
    inputs: &crate::nodes::FlowPortValues,
    selection_resolver: &SpatialSelectionResolver,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_cache: &mut HashMap<FlowNodeId, HashSet<FixtureRef>>,
    attribute_cache: &mut HashMap<FlowNodeId, HashSet<String>>,
    phase_cache: &mut HashMap<FlowNodeId, f32>,
    layer_creator: &str,
) -> Option<Layer> {
    let selection = match inputs.get(&WAVEFORM_FX_IN_SELECTION) {
        Some(FlowValue::Selection(selection)) => selection.clone(),
        _ => SelectionExpr::default().into(),
    };
    let waveform = match inputs.get(&WAVEFORM_FX_IN_WAVEFORM) {
        Some(FlowValue::Waveform(waveform)) => *waveform,
        _ => default_flow_waveform(),
    };
    let attribute_labels = match inputs.get(&WAVEFORM_FX_IN_ATTRIBUTE) {
        Some(FlowValue::AttributeLabel(label)) => vec![label.clone()],
        Some(FlowValue::AttributeLabels(labels)) => labels.clone(),
        _ => vec!["Intensity".to_string()],
    };

    let resolved_selection = filter_existing_selection(
        &selection_resolver.resolve(&selection).into_value(),
        fixture_data_provider,
    );
    let selection_indexes = waveform_selection_indexes(&resolved_selection);
    let current_set: HashSet<FixtureRef> = selection_indexes
        .iter()
        .flat_map(|index| index.iter().cloned())
        .collect();
    let previous_set = selection_cache.get(&node_def.node_id);
    let previous_attribute_set = attribute_cache.get(&node_def.node_id);
    let current_attribute_set: HashSet<String> = attribute_labels.iter().cloned().collect();
    let removed: Vec<FixtureRef> = previous_set
        .map(|set| set.difference(&current_set).cloned().collect())
        .unwrap_or_default();
    let removed_attributes: Vec<String> = previous_attribute_set
        .map(|set| set.difference(&current_attribute_set).cloned().collect())
        .unwrap_or_default();

    let rate_secs = waveform.rate_secs.max(0.001);
    let step = frame_delta.as_secs_f32() / rate_secs;
    let next_phase = (phase_cache.get(&node_def.node_id).copied().unwrap_or(0.0) + step).fract();
    phase_cache.insert(node_def.node_id, next_phase);

    let samples = sample_waveform(&waveform, selection_indexes.len(), next_phase);

    let mut layer = Layer::new(layer_creator.to_string(), Priority::default());

    for attribute_label in &attribute_labels {
        let attribute =
            Attribute::from_str(attribute_label).unwrap_or_else(|_| Attribute::Custom {
                label: attribute_label.clone(),
            });

        for (selection_index, sampled_value) in selection_indexes.iter().zip(samples.iter()) {
            for element_ref in selection_index {
                let Some(resolved_parameter) = fixture_data_provider
                    .try_parameter_for_logical_attribute(element_ref, &attribute)
                else {
                    continue;
                };
                let parameter = resolved_parameter.instance;

                layer.absolute.insert(
                    parameter,
                    (
                        ParameterValue::Absolute {
                            value: *sampled_value,
                        },
                        None,
                    ),
                );
            }
        }

        for element_ref in &removed {
            let Some(resolved_parameter) =
                fixture_data_provider.try_parameter_for_logical_attribute(element_ref, &attribute)
            else {
                continue;
            };
            let parameter = resolved_parameter.instance;
            layer
                .absolute
                .insert(parameter, (ParameterValue::Absolute { value: 0.0 }, None));
        }
    }

    if !removed_attributes.is_empty() {
        let targets: Vec<FixtureRef> = previous_set
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        for attribute_label in &removed_attributes {
            let attribute =
                Attribute::from_str(attribute_label).unwrap_or_else(|_| Attribute::Custom {
                    label: attribute_label.clone(),
                });
            for element_ref in &targets {
                let Some(resolved_parameter) = fixture_data_provider
                    .try_parameter_for_logical_attribute(element_ref, &attribute)
                else {
                    continue;
                };
                let parameter = resolved_parameter.instance;
                layer
                    .absolute
                    .insert(parameter, (ParameterValue::Absolute { value: 0.0 }, None));
            }
        }
    }

    if current_set.is_empty() {
        selection_cache.remove(&node_def.node_id);
    } else {
        selection_cache.insert(node_def.node_id, current_set);
    }

    if current_attribute_set.is_empty() {
        attribute_cache.remove(&node_def.node_id);
    } else {
        attribute_cache.insert(node_def.node_id, current_attribute_set);
    }

    if layer.absolute.is_empty() && layer.relative.is_empty() {
        None
    } else {
        Some(layer)
    }
}

/// Return selected fixtures grouped by the resolved index that drives waveform sampling.
fn waveform_selection_indexes(selection: &ResolvedSelection) -> Vec<Vec<FixtureRef>> {
    selection
        .iter_non_empty_indexes()
        .map(|index| {
            index
                .members
                .iter()
                .map(|member| member.fixture.clone())
                .collect()
        })
        .collect()
}

/// Sample a waveform at a given phase, returning intensity values for each selection index.
fn sample_waveform(
    waveform: &FlowWaveform,
    fixture_count: usize,
    percent: f32,
) -> Vec<ParameterDmxValue> {
    if fixture_count == 0 {
        return Vec::new();
    }

    let spacing = std::f32::consts::PI * 2.0 / fixture_count as f32;
    let duty_cycle = waveform.duty_cycle.unwrap_or(1.0).clamp(0.0, 1.0);
    let amplitude = waveform.amplitude.max(0.0);

    (0..fixture_count)
        .map(|index| {
            let phase =
                waveform.phase + spacing * index as f32 + 2.0 * std::f32::consts::PI * percent;
            let normalized = sample_waveform_radians(waveform.kind, phase, duty_cycle);
            let mut value = waveform.base + amplitude * normalized;
            value = value.clamp(0.0, 1.0);
            value = value.clamp(0.0, 1.0);
            f64::from((value * 255.0).round().clamp(0.0, 255.0))
        })
        .collect()
}

fn default_flow_waveform() -> FlowWaveform {
    FlowWaveform {
        kind: WaveformKind::Sin,
        rate_secs: 1.0,
        amplitude: 1.0,
        phase: 0.0,
        base: 0.0,
        duty_cycle: None,
    }
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::{IndexedFixture, ProjectedCoord, SelectionIndex};
    use uuid::Uuid;

    use super::*;

    /// Builds a fixture reference for waveform selection-index tests.
    fn fixture_ref(id: u128) -> FixtureRef {
        FixtureRef {
            fixture_uid: Uuid::from_u128(id),
            index: Some(1),
        }
    }

    /// Builds a projected fixture member for waveform selection-index tests.
    fn indexed_fixture(id: u128, x: i32) -> IndexedFixture {
        IndexedFixture {
            fixture: fixture_ref(id),
            projected_coord: ProjectedCoord { x, y: 0, z: 0 },
        }
    }

    /// Waveform FX samples one value per resolved spatial index and applies it to grouped members.
    #[test]
    fn waveform_selection_indexes_preserve_resolved_groups() {
        let first = fixture_ref(1);
        let second = fixture_ref(2);
        let third = fixture_ref(3);
        let selection = ResolvedSelection::new(
            vec![first.clone(), second.clone(), third.clone()],
            vec![
                SelectionIndex {
                    index: 0,
                    invert: false,
                    members: vec![indexed_fixture(2, 0), indexed_fixture(3, 0)],
                },
                SelectionIndex {
                    index: 1,
                    invert: false,
                    members: Vec::new(),
                },
                SelectionIndex {
                    index: 2,
                    invert: false,
                    members: vec![indexed_fixture(1, 2)],
                },
            ],
            None,
        );

        assert_eq!(
            waveform_selection_indexes(&selection),
            vec![vec![second, third], vec![first]]
        );
    }
}
