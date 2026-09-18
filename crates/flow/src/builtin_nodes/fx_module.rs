// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! FX Module flow node implementation.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nightfall::prelude::{FixtureRef, ResolvedSelection};
use nightfall_compositor::prelude::Layer;
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_fx_module::instances::{
    FixtureMetadataHost, build_selected_grid, build_selected_targets,
    fx_module_layer_to_engine_layer, fx_module_path, random_seed_for_activation,
};
use nightfall_fx_module::prelude::{
    FxModuleComponent, FxModuleInitInput, FxModuleInstance, FxModuleRenderInput,
    FxModuleRuntimeError, StoredFxModule,
};
use nightfall_selection::filter_existing_selection;
use tracing::warn;
use uuid::Uuid;

use crate::nodes::{
    FlowNode, FlowNodeContext, FlowNodeDescriptor, FlowNodeFactory, FlowPortValues,
};
use crate::types::{
    FlowLayerSummary, FlowNodeDefinition, FlowNodeId, FlowPortDefinition, FlowPortDirection,
    FlowPortId, FlowPortType, FlowValue,
};

/// Node kind identifier for the fx module node.
pub const FX_MODULE_KIND: &str = "fx_module";
/// Port id for the stored fx module object id input.
pub const FX_MODULE_IN_ID: FlowPortId = 1;
/// Port id for the optional selection override input.
pub const FX_MODULE_IN_SELECTION: FlowPortId = 2;
/// Port id for the fx module layer output.
pub const FX_MODULE_OUT_LAYER: FlowPortId = 3;

/// Factory for creating fx module nodes.
pub struct FxModuleFactory;

impl FlowNodeFactory for FxModuleFactory {
    fn descriptor(&self) -> FlowNodeDescriptor {
        FlowNodeDescriptor {
            kind: FX_MODULE_KIND.to_string(),
            label: "FX Module".to_string(),
            category: crate::nodes::FlowNodeCategory::Generator,
            ports: vec![
                FlowPortDefinition {
                    port_id: FX_MODULE_IN_ID,
                    name: "FX Module".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Int,
                    is_optional: false,
                    default_value: Some(FlowValue::Int(1)),
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: FX_MODULE_IN_SELECTION,
                    name: "Selection".to_string(),
                    direction: FlowPortDirection::Input,
                    port_type: FlowPortType::Selection,
                    is_optional: true,
                    default_value: None,
                    enum_options: None,
                },
                FlowPortDefinition {
                    port_id: FX_MODULE_OUT_LAYER,
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
        Box::new(FxModuleNode)
    }
}

/// A node that renders a stored fx module object into a layer.
pub struct FxModuleNode;

impl FlowNode for FxModuleNode {
    fn execute(
        &mut self,
        inputs: &FlowPortValues,
        outputs: &mut FlowPortValues,
        _input_triggers: &crate::nodes::FlowTriggerValues,
        _output_triggers: &mut crate::nodes::FlowTriggerValues,
        _ctx: &FlowNodeContext,
    ) -> Result<(), String> {
        let fx_module_id = match inputs.get(&FX_MODULE_IN_ID) {
            Some(FlowValue::Int(id)) => *id,
            _ => 1,
        };
        let label = match inputs.get(&FX_MODULE_IN_SELECTION) {
            Some(FlowValue::Selection(selection)) => {
                format!("FX Module {}: {}", fx_module_id, selection)
            }
            _ => format!("FX Module {}", fx_module_id),
        };

        outputs.insert(
            FX_MODULE_OUT_LAYER,
            FlowValue::LayerSummary(FlowLayerSummary { label }),
        );
        Ok(())
    }

    fn is_pure(&self) -> bool {
        false
    }
}

/// Runtime data held by the flow node while an FX module instance is active.
pub(crate) struct FlowFxModuleRuntime {
    definition: StoredFxModule,
    instance: FxModuleInstance<FixtureMetadataHost>,
    started_at: Duration,
    last_render_at: Option<Duration>,
}

pub(crate) fn build_fx_module_layer(
    node_def: &FlowNodeDefinition,
    inputs: &FlowPortValues,
    selection_resolver: &SpatialSelectionResolver,
    fx_module_data_provider: &DataProvider<StoredFxModule>,
    fixture_data_provider: &FixtureDataProviderExt,
    runtime_states: &mut HashMap<FlowNodeId, FlowFxModuleRuntime>,
    render_position: Duration,
    playback_position: Option<Duration>,
    playback_delta: Option<Duration>,
) -> Option<Layer> {
    let fx_module_id = match inputs.get(&FX_MODULE_IN_ID) {
        Some(FlowValue::Int(id)) if *id > 0 => *id as u32,
        Some(FlowValue::Int(id)) => {
            warn!(
                node_id = node_def.node_id,
                fx_module_id = *id,
                "FX Module id must be positive"
            );
            if let Some(state) = runtime_states.remove(&node_def.node_id) {
                let _ = teardown_fx_module_runtime(state);
            }
            return None;
        }
        _ => {
            if let Some(state) = runtime_states.remove(&node_def.node_id) {
                let _ = teardown_fx_module_runtime(state);
            }
            return None;
        }
    };

    let Ok(stored_definition) = fx_module_data_provider
        .from_id(fx_module_id)
        .map(|definition| definition.clone())
    else {
        if let Some(state) = runtime_states.remove(&node_def.node_id) {
            let _ = teardown_fx_module_runtime(state);
        }
        return None;
    };

    let mut effective_definition = stored_definition;
    if let Some(FlowValue::Selection(selection)) = inputs.get(&FX_MODULE_IN_SELECTION) {
        effective_definition.selection = selection.clone();
    }

    let should_recreate = runtime_states
        .get(&node_def.node_id)
        .map(|state| state.definition != effective_definition)
        .unwrap_or(true);
    if should_recreate {
        if let Some(state) = runtime_states.remove(&node_def.node_id) {
            let _ = teardown_fx_module_runtime(state);
        }
        let started_at = playback_position
            .map(|position| render_position.saturating_sub(position))
            .unwrap_or(render_position);
        match instantiate_fx_module_runtime(
            &effective_definition,
            fixture_data_provider,
            started_at,
        ) {
            Ok(state) => {
                runtime_states.insert(node_def.node_id, state);
            }
            Err(error) => {
                warn!(
                    node_id = node_def.node_id,
                    fx_module_id,
                    module_name = %effective_definition.module_name,
                    "Failed to instantiate flow fx module runtime: {}",
                    error
                );
                return None;
            }
        }
    }

    let state = runtime_states.get_mut(&node_def.node_id)?;

    let resolved_selection = selection_resolver
        .resolve(&effective_definition.selection)
        .into_value();
    let selection = filter_existing_selection(&resolved_selection, fixture_data_provider);
    let render_input = FxModuleRenderInput {
        now_micros: unix_time_micros(),
        delta_micros: playback_delta
            .or_else(|| {
                state
                    .last_render_at
                    .map(|previous| render_position.saturating_sub(previous))
            })
            .unwrap_or_default()
            .as_micros()
            .try_into()
            .unwrap_or(u64::MAX),
        elapsed_since_start_micros: render_position
            .saturating_sub(state.started_at)
            .as_micros()
            .try_into()
            .unwrap_or(u64::MAX),
        selection: build_selected_targets(
            &fx_module_selection_targets(&selection),
            fixture_data_provider,
        ),
        selection_grid: build_selected_grid(&resolved_selection, fixture_data_provider),
    };

    let fx_module_layer = match state.instance.render(&render_input) {
        Ok(layer) => layer,
        Err(error) => {
            warn!(
                node_id = node_def.node_id,
                fx_module_id,
                module_name = %effective_definition.module_name,
                "Flow fx module render failed: {}",
                error
            );
            Default::default()
        }
    };
    state.last_render_at = Some(render_position);

    Some(fx_module_layer_to_engine_layer(
        &effective_definition,
        fx_module_layer,
        fixture_data_provider,
    ))
}

/// Return legacy selected targets in resolved-index order for modules that do not read the grid.
fn fx_module_selection_targets(selection: &ResolvedSelection) -> Vec<FixtureRef> {
    selection
        .iter_non_empty_indexes()
        .flat_map(|index| index.members.iter().map(|member| member.fixture.clone()))
        .collect()
}

pub(crate) fn teardown_fx_module_runtime(
    mut runtime: FlowFxModuleRuntime,
) -> Result<(), FxModuleRuntimeError> {
    runtime.instance.teardown()
}

fn instantiate_fx_module_runtime(
    definition: &StoredFxModule,
    fixture_data_provider: &FixtureDataProviderExt,
    started_at: Duration,
) -> Result<FlowFxModuleRuntime, FxModuleRuntimeError> {
    let component = FxModuleComponent::from_file(fx_module_path(&definition.module_name)?)?;
    let mut instance =
        component.instantiate(FixtureMetadataHost::snapshot(fixture_data_provider))?;
    let config_json =
        serde_json::to_string(&definition.config).unwrap_or_else(|_| "{}".to_string());
    instance.init(&FxModuleInitInput {
        fx_instance_id: Uuid::new_v4(),
        label: definition.identifiers.label.clone(),
        config_json,
        random_seed: Some(random_seed_for_activation(definition)),
    })?;

    Ok(FlowFxModuleRuntime {
        definition: definition.clone(),
        instance,
        started_at,
        last_render_at: None,
    })
}

fn unix_time_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::{IndexedFixture, ProjectedCoord, SelectionIndex};

    use super::*;

    /// Builds a fixture reference for fx module selection-order tests.
    fn fixture_ref(id: u128) -> FixtureRef {
        FixtureRef {
            fixture_uid: Uuid::from_u128(id),
            index: Some(1),
        }
    }

    /// Builds a projected fixture member for fx module selection-order tests.
    fn indexed_fixture(id: u128, x: i32) -> IndexedFixture {
        IndexedFixture {
            fixture: fixture_ref(id),
            projected_coord: ProjectedCoord { x, y: 0, z: 0 },
        }
    }

    /// Legacy fx-module selected targets follow resolved spatial index order.
    #[test]
    fn fx_module_selection_targets_preserve_resolved_index_order() {
        let first = fixture_ref(1);
        let second = fixture_ref(2);
        let third = fixture_ref(3);
        let selection = ResolvedSelection::new(
            vec![first.clone(), second.clone(), third.clone()],
            vec![
                SelectionIndex {
                    index: 0,
                    invert: false,
                    members: vec![indexed_fixture(3, 0)],
                },
                SelectionIndex {
                    index: 1,
                    invert: false,
                    members: vec![indexed_fixture(1, 1), indexed_fixture(2, 1)],
                },
            ],
            None,
        );

        assert_eq!(
            fx_module_selection_targets(&selection),
            vec![third, first, second]
        );
    }
}
