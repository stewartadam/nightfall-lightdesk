// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::Attribute;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
#[cfg(test)]
use nightfall_instances::InstanceClockSource;
use nightfall_instances::{
    ClipInstanceAttachment, InstanceClock, InstanceControls, InstanceDisplayKind, InstanceId,
    InstanceKind, InstanceMetadata, InstancePosition, InstanceStatus, reconcile_instance_options,
};
use nightfall_selection::filter_existing_selection;
use tracing::warn;
use uuid::Uuid;

use crate::{
    ActiveFxModuleIds, ActiveFxModuleTimings, FxModuleClipBindings, FxModuleComponent,
    FxModuleHost, FxModuleInitInput, FxModuleInstance, FxModuleLayer, FxModuleLayerInstruction,
    FxModuleRenderInput, FxModuleRuntimeError, FxModuleRuntimeNotification, SelectedCell,
    SelectedGrid, SelectedTarget, StoredFxModule, events::PreviewFxModule,
};

/// Module layers and clocks used to update release compositing.
type ReleasingModuleLayerData = (
    Entity,
    Option<&'static Layer>,
    Option<&'static InstanceClock>,
    Option<&'static mut LayerCompositingContext>,
);

/// Marker for layer entities owned by active fx module instances.
#[derive(Component)]
pub struct ActiveFxModuleLayer {
    /// Stored fx module UID that owns the layer.
    pub fx_module_uid: Uuid,
}

/// Runtime state for active fx module instances.
#[derive(Default)]
pub struct FxModuleRuntimeStates {
    states: HashMap<u32, ActiveFxModuleRuntime>,
}

impl FxModuleRuntimeStates {
    /// Re-key a live runtime after its stored definition moves to a new numeric ID.
    pub(crate) fn move_id(&mut self, id: u32, new_id: u32) {
        let Some(mut state) = self.states.remove(&id) else {
            return;
        };
        state.definition.identifiers.id = new_id;
        self.states.insert(new_id, state);
    }
}

/// Runtime state for active fx module preview entities.
#[derive(Default)]
pub struct PreviewFxModuleRuntimeStates {
    states: HashMap<Entity, PreviewFxModuleRuntime>,
}

/// Runtime handle for an FX module currently driving live output.
struct ActiveFxModuleRuntime {
    definition: StoredFxModule,
    instance: FxModuleInstance<FixtureMetadataHost>,
    layer_entity: Entity,
    instance_id: InstanceId,
    last_render_position: Option<Duration>,
}

/// Runtime handle for an FX module running in preview mode.
struct PreviewFxModuleRuntime {
    definition: StoredFxModule,
    instance: FxModuleInstance<FixtureMetadataHost>,
}

type ActivePreviewFxModuleQuery<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static PreviewFxModule,
        Option<&'static Layer>,
        Option<&'static InstanceClock>,
    ),
    Without<ReleaseMarker>,
>;

/// Snapshot host implementation for fixture metadata lookups during fx module rendering.
#[derive(Clone)]
pub struct FixtureMetadataHost {
    fixtures: HashMap<Uuid, Fixture>,
}

impl FixtureMetadataHost {
    /// Snapshot all currently known fixtures into a host lookup map.
    pub fn snapshot(fixture_data_provider: &FixtureDataProviderExt) -> Self {
        Self {
            fixtures: fixture_data_provider
                .inner
                .iter()
                .map(|entry| (entry.value().identifiers.uid, entry.value().clone()))
                .collect(),
        }
    }
}

impl FxModuleHost for FixtureMetadataHost {
    fn get_fixture(&self, fixture_uid: Uuid) -> Result<Option<Fixture>, crate::FxModuleError> {
        Ok(self.fixtures.get(&fixture_uid).cloned())
    }
}

/// Evaluate active fx module instances and emit compositor layers.
pub fn evaluate_fx_module(
    mut commands: Commands,
    mut active_fx_module_ids: ResMut<ActiveFxModuleIds>,
    mut active_fx_module_timings: Option<ResMut<ActiveFxModuleTimings>>,
    fx_module_data_provider: Res<DataProvider<StoredFxModule>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver,
    mut runtime_states: NonSendMut<FxModuleRuntimeStates>,
    clip_bindings: Res<FxModuleClipBindings>,
    mut attachments: MessageWriter<EventEnvelope<ClipInstanceAttachment>>,
    mut notifications: MessageWriter<NotificationEnvelope<FxModuleRuntimeNotification>>,
    existing_layers: Query<(Option<&Layer>, Option<&ReleaseMarker>), With<ActiveFxModuleLayer>>,
    mut instance_clocks: Query<&mut InstanceClock>,
) {
    let active_ids: Vec<u32> = active_fx_module_ids.0.iter().copied().collect();
    for fx_module_id in active_ids {
        let Ok(definition) = fx_module_data_provider
            .from_id(fx_module_id)
            .map(|definition| definition.clone())
        else {
            active_fx_module_ids.0.remove(&fx_module_id);
            if let Some(timings) = active_fx_module_timings.as_deref_mut() {
                timings.0.remove(&fx_module_id);
            }
            continue;
        };

        let should_recreate = runtime_states
            .states
            .get(&fx_module_id)
            .map(|state| state.definition != definition)
            .unwrap_or(true);
        let mut recreated = false;

        if should_recreate {
            let module_path = fx_module_path(&definition.module_name)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|error| format!("<unresolved: {error}>"));
            let reusable_runtime = runtime_states.states.remove(&fx_module_id).map(|state| {
                let layer_entity = state.layer_entity;
                let instance_id = state.instance_id;
                let _ = teardown_runtime_state(state);
                (layer_entity, instance_id)
            });

            match instantiate_runtime_state(
                &definition,
                &fixture_data_provider,
                reusable_runtime,
                &mut commands,
            ) {
                Ok(state) => {
                    runtime_states.states.insert(fx_module_id, state);
                    recreated = true;
                }
                Err(error) => {
                    warn!(
                        fx_module_id,
                        module_name = %definition.module_name,
                        module_path = %module_path,
                        "Failed to instantiate fx module runtime: {}",
                        error
                    );
                    notifications.write(NotificationEnvelope::detached(
                        FxModuleRuntimeNotification::InstantiationFailed {
                            fx_module_id,
                            module_name: definition.module_name.clone(),
                            error: error.to_string(),
                        },
                    ));
                    if let Some((layer_entity, _)) = reusable_runtime {
                        commands.entity(layer_entity).despawn();
                    }
                    active_fx_module_ids.0.remove(&fx_module_id);
                    if let Some(timings) = active_fx_module_timings.as_deref_mut() {
                        timings.0.remove(&fx_module_id);
                    }
                    continue;
                }
            }
        }

        let Some(state) = runtime_states.states.get_mut(&fx_module_id) else {
            continue;
        };
        let timed_clock = active_fx_module_timings
            .as_deref_mut()
            .and_then(|timings| timings.0.remove(&fx_module_id));
        let seeded_playback_timing = timed_clock
            .as_ref()
            .map(|clock| (clock.position, clock.delta));
        let has_timed_clock = timed_clock.is_some();
        if has_timed_clock {
            state.last_render_position = None;
        }
        if let Some(timed_clock) = timed_clock {
            if let Ok(mut clock) = instance_clocks.get_mut(state.layer_entity) {
                *clock = timed_clock;
            } else {
                commands.entity(state.layer_entity).insert(timed_clock);
            }
        }

        let existing_layer = existing_layers.get(state.layer_entity).ok();

        for binding in clip_bindings.0.values() {
            if binding.fx_module_id == fx_module_id {
                let mut entity_commands = commands.entity(state.layer_entity);
                reconcile_instance_options(
                    &mut entity_commands,
                    binding.start_context.instance_options,
                );
                attachments.write(EventEnvelope::detached(ClipInstanceAttachment {
                    clip_id: binding.start_context.clip_id,
                    instance_id: state.instance_id,
                    auto_release_on_stop: binding.start_context.auto_release_on_stop,
                }));
            }
        }

        let resolved_selection = selection_resolver
            .resolve(&definition.selection)
            .into_value();
        let selection =
            filter_existing_selection(&resolved_selection, fixture_data_provider.as_ref());
        let playback_timing = seeded_playback_timing.or_else(|| {
            instance_clocks
                .get(state.layer_entity)
                .ok()
                .map(|clock| (clock.position, clock.delta))
        });
        let playback_position = playback_timing.map(|(position, _)| position);
        let playback_delta = playback_timing.map(|(_, delta)| delta);
        let (elapsed_since_start, delta) = playback_position
            .map(|position| {
                let delta = playback_delta.unwrap_or_else(|| {
                    state
                        .last_render_position
                        .map(|previous| position.saturating_sub(previous))
                        .unwrap_or_default()
                });
                state.last_render_position = Some(position);
                (position, delta)
            })
            .unwrap_or_default();
        let render_input = FxModuleRenderInput {
            now_micros: unix_time_micros(),
            delta_micros: delta.as_micros().try_into().unwrap_or(u64::MAX),
            elapsed_since_start_micros: elapsed_since_start
                .as_micros()
                .try_into()
                .unwrap_or(u64::MAX),
            selection: build_selected_targets(
                selection.canonical_fixtures(),
                &fixture_data_provider,
            ),
            selection_grid: build_selected_grid(&resolved_selection, &fixture_data_provider),
        };

        let fx_module_layer = match state.instance.render(&render_input) {
            Ok(layer) => layer,
            Err(error) => {
                warn!(
                    fx_module_id,
                    module_name = %definition.module_name,
                    "FX Module render failed: {}",
                    error
                );
                FxModuleLayer::default()
            }
        };
        let mut layer =
            fx_module_layer_to_engine_layer(&definition, fx_module_layer, &fixture_data_provider);
        if !recreated {
            if let Some((Some(existing_layer), _)) = existing_layer {
                layer.activation_time = existing_layer.activation_time;
            }
        }

        let marker = ObjectRefMarker(ObjectRef::ByUid {
            object_type: ObjectType::FxModule,
            uid: definition.identifiers.uid,
        });
        let mut entity_commands = commands.entity(state.layer_entity);
        entity_commands.remove::<ReleaseMarker>();
        entity_commands.insert((
            layer,
            marker,
            InstanceStatus {
                position: InstancePosition::Time {
                    elapsed: elapsed_since_start,
                },
                source_activation_epoch_ms: None,
                transition_elapsed: Some(elapsed_since_start),
            },
        ));
        if let Some(position) = playback_position {
            entity_commands.insert(LayerCompositingContext {
                position,
                released_at: None,
            });
        } else {
            entity_commands.remove::<LayerCompositingContext>();
        }
    }
}

/// Evaluate active fx module preview entities and emit compositor layers.
pub fn evaluate_preview_fx_module(
    mut commands: Commands,
    previews: ActivePreviewFxModuleQuery,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver,
    mut runtime_states: NonSendMut<PreviewFxModuleRuntimeStates>,
) {
    for (entity, preview, existing_layer, clock) in previews.iter() {
        let definition = &preview.0;
        let should_recreate = runtime_states
            .states
            .get(&entity)
            .map(|state| state.definition != *definition)
            .unwrap_or(true);
        let mut recreated = false;

        if should_recreate {
            let module_path = fx_module_path(&definition.module_name)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|error| format!("<unresolved: {error}>"));
            if let Some(state) = runtime_states.states.remove(&entity) {
                let _ = teardown_preview_runtime_state(state);
            }

            match instantiate_preview_runtime_state(definition, &fixture_data_provider) {
                Ok(state) => {
                    runtime_states.states.insert(entity, state);
                    recreated = true;
                }
                Err(error) => {
                    warn!(
                        module_name = %definition.module_name,
                        module_path = %module_path,
                        "Failed to instantiate preview fx module runtime: {}",
                        error
                    );
                    continue;
                }
            }
        }

        let Some(state) = runtime_states.states.get_mut(&entity) else {
            continue;
        };

        let resolved_selection = selection_resolver
            .resolve(&definition.selection)
            .into_value();
        let selection =
            filter_existing_selection(&resolved_selection, fixture_data_provider.as_ref());
        let (elapsed_since_start, delta) = clock
            .map(|clock| (clock.position, clock.delta))
            .unwrap_or_default();
        let render_input = FxModuleRenderInput {
            now_micros: unix_time_micros(),
            delta_micros: delta.as_micros().try_into().unwrap_or(u64::MAX),
            elapsed_since_start_micros: elapsed_since_start
                .as_micros()
                .try_into()
                .unwrap_or(u64::MAX),
            selection: build_selected_targets(
                selection.canonical_fixtures(),
                &fixture_data_provider,
            ),
            selection_grid: build_selected_grid(&resolved_selection, &fixture_data_provider),
        };

        let fx_module_layer = match state.instance.render(&render_input) {
            Ok(layer) => layer,
            Err(error) => {
                warn!(
                    module_name = %definition.module_name,
                    "Preview fx module render failed: {}",
                    error
                );
                FxModuleLayer::default()
            }
        };
        let mut layer =
            fx_module_layer_to_engine_layer(definition, fx_module_layer, &fixture_data_provider);
        if !recreated {
            if let Some(existing_layer) = existing_layer {
                layer.activation_time = existing_layer.activation_time;
            }
        }

        let marker = ObjectRefMarker(ObjectRef::ByUid {
            object_type: ObjectType::FxModule,
            uid: definition.identifiers.uid,
        });
        commands.entity(entity).remove::<ReleaseMarker>().insert((
            layer,
            marker,
            LayerCompositingContext {
                position: elapsed_since_start,
                released_at: None,
            },
        ));
    }
}

/// Mark inactive fx module layers for release and tear down their runtimes.
pub fn cleanup_inactive_fx_module(
    mut commands: Commands,
    active_fx_module_ids: Res<ActiveFxModuleIds>,
    mut runtime_states: NonSendMut<FxModuleRuntimeStates>,
    mut layers: Query<(&mut Layer, Option<&InstanceClock>)>,
) {
    let inactive_ids: Vec<u32> = runtime_states
        .states
        .keys()
        .copied()
        .filter(|id| !active_fx_module_ids.0.contains(id))
        .collect();

    for inactive_id in inactive_ids {
        let Some(state) = runtime_states.states.remove(&inactive_id) else {
            continue;
        };

        let (release_position, compositing_context_position) =
            if let Ok((mut layer, clock)) = layers.get_mut(state.layer_entity) {
                let release_position = clock.map(|clock| clock.position).unwrap_or_default();
                mark_layer_transitions_for_release(&mut layer, release_position);
                (
                    release_position,
                    clock
                        .map(|clock| clock.position)
                        .unwrap_or(release_position),
                )
            } else {
                (Duration::ZERO, Duration::ZERO)
            };

        let mut entity_commands = commands.entity(state.layer_entity);
        entity_commands.insert(ReleaseMarker::default());
        entity_commands.insert(LayerCompositingContext {
            position: compositing_context_position,
            released_at: Some(release_position),
        });
        let _ = teardown_runtime_state(state);
    }
}

/// Tear down preview runtimes for preview entities that are no longer active.
pub fn cleanup_preview_fx_module_runtimes(
    previews: Query<Entity, With<PreviewFxModule>>,
    mut runtime_states: NonSendMut<PreviewFxModuleRuntimeStates>,
) {
    let active_preview_entities: HashSet<Entity> = previews.iter().collect();
    let stale_entities: Vec<Entity> = runtime_states
        .states
        .keys()
        .copied()
        .filter(|entity| !active_preview_entities.contains(entity))
        .collect();

    for entity in stale_entities {
        if let Some(state) = runtime_states.states.remove(&entity) {
            let _ = teardown_preview_runtime_state(state);
        }
    }
}

/// Remove released fx module layers after their release transitions finish.
pub fn cleanup_released_fx_module_layers(
    mut commands: Commands,
    mut layers: Query<ReleasingModuleLayerData, (With<ActiveFxModuleLayer>, With<ReleaseMarker>)>,
) {
    for (entity, layer, clock, compositing_context) in layers.iter_mut() {
        let release_duration = layer.map(max_layer_release_duration).unwrap_or_default();
        let release_elapsed = if let Some(mut compositing_context) = compositing_context {
            if let Some(clock) = clock {
                compositing_context.position = clock.position;
            }
            compositing_context
                .elapsed_since_release()
                .unwrap_or_default()
        } else {
            Duration::ZERO
        };
        if release_elapsed < release_duration {
            continue;
        }

        commands.entity(entity).despawn();
    }
}

fn instantiate_runtime_state(
    definition: &StoredFxModule,
    fixture_data_provider: &FixtureDataProviderExt,
    reusable_runtime: Option<(Entity, InstanceId)>,
    commands: &mut Commands,
) -> Result<ActiveFxModuleRuntime, FxModuleRuntimeError> {
    let component = FxModuleComponent::from_file(fx_module_path(&definition.module_name)?)?;
    let host = FixtureMetadataHost {
        fixtures: fixture_data_provider
            .inner
            .iter()
            .map(|entry| (entry.value().identifiers.uid, entry.value().clone()))
            .collect(),
    };
    let mut instance = component.instantiate(host)?;
    let config_json =
        serde_json::to_string(&definition.config).unwrap_or_else(|_| "{}".to_string());
    instance.init(&FxModuleInitInput {
        fx_instance_id: Uuid::new_v4(),
        label: definition.identifiers.label.clone(),
        config_json,
        random_seed: Some(random_seed_for_activation(definition)),
    })?;

    let instance_id = reusable_runtime
        .as_ref()
        .map(|(_, instance_id)| *instance_id)
        .unwrap_or_default();
    let layer_entity = reusable_runtime
        .map(|(entity, _)| entity)
        .unwrap_or_else(|| {
            commands
                .spawn(ActiveFxModuleLayer {
                    fx_module_uid: definition.identifiers.uid,
                })
                .id()
        });
    commands.entity(layer_entity).insert((
        ActiveFxModuleLayer {
            fx_module_uid: definition.identifiers.uid,
        },
        instance_id,
        InstanceMetadata::new(InstanceKind::Fx)
            .with_display_kind(InstanceDisplayKind::ModuleFx)
            .with_name(definition.identifiers.label.clone()),
        InstanceControls::default(),
        InstanceStatus::default(),
    ));

    Ok(ActiveFxModuleRuntime {
        definition: definition.clone(),
        instance,
        layer_entity,
        instance_id,
        last_render_position: None,
    })
}

fn instantiate_preview_runtime_state(
    definition: &StoredFxModule,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Result<PreviewFxModuleRuntime, FxModuleRuntimeError> {
    let component = FxModuleComponent::from_file(fx_module_path(&definition.module_name)?)?;
    let host = FixtureMetadataHost::snapshot(fixture_data_provider);
    let mut instance = component.instantiate(host)?;
    let config_json =
        serde_json::to_string(&definition.config).unwrap_or_else(|_| "{}".to_string());
    instance.init(&FxModuleInitInput {
        fx_instance_id: Uuid::new_v4(),
        label: definition.identifiers.label.clone(),
        config_json,
        random_seed: Some(random_seed_for_activation(definition)),
    })?;

    Ok(PreviewFxModuleRuntime {
        definition: definition.clone(),
        instance,
    })
}

fn teardown_runtime_state(mut state: ActiveFxModuleRuntime) -> Result<(), FxModuleRuntimeError> {
    state.instance.teardown()
}

fn teardown_preview_runtime_state(
    mut state: PreviewFxModuleRuntime,
) -> Result<(), FxModuleRuntimeError> {
    state.instance.teardown()
}

/// Materialize a guest FX module layer into an engine compositor layer.
pub fn fx_module_layer_to_engine_layer(
    definition: &StoredFxModule,
    fx_module_layer: FxModuleLayer,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Layer {
    let mut layer = Layer::new(
        format!("FxModule: {}", definition.identifiers.label),
        Priority(50),
    );

    for instruction in fx_module_layer.absolute {
        materialize_instruction(&mut layer, instruction, false, fixture_data_provider);
    }

    for instruction in fx_module_layer.relative {
        materialize_instruction(&mut layer, instruction, true, fixture_data_provider);
    }

    layer
}

fn materialize_instruction(
    layer: &mut Layer,
    instruction: FxModuleLayerInstruction,
    is_relative: bool,
    fixture_data_provider: &FixtureDataProviderExt,
) {
    for fixture_ref in target_fixture_refs(&instruction, fixture_data_provider) {
        let Some(resolved_parameter) = fixture_data_provider
            .try_parameter_for_logical_attribute(&fixture_ref, &instruction.attribute)
        else {
            continue;
        };
        let parameter = resolved_parameter.instance;

        let transition = instruction
            .materialized_transition
            .as_ref()
            .map(|transition| transition.to_engine(Duration::ZERO));
        let value = instruction.value;

        if is_relative {
            layer.relative.insert(parameter, (value, transition));
        } else {
            layer.absolute.insert(parameter, (value, transition));
        }
    }
}

fn target_fixture_refs(
    instruction: &FxModuleLayerInstruction,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Vec<FixtureRef> {
    if let Some(element_index) = instruction.element_index {
        return vec![FixtureRef {
            fixture_uid: instruction.fixture_uid,
            index: Some(element_index),
        }];
    }

    fixture_data_provider
        .element_count(instruction.fixture_uid)
        .map(|count| {
            (1..=count as u32)
                .map(|index| FixtureRef {
                    fixture_uid: instruction.fixture_uid,
                    index: Some(index),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Build FX module-facing selected targets from resolved fixture references.
pub fn build_selected_targets(
    selection: &[FixtureRef],
    fixture_data_provider: &FixtureDataProviderExt,
) -> Vec<SelectedTarget> {
    selection
        .iter()
        .filter_map(|fixture_ref| build_selected_target(fixture_ref, fixture_data_provider))
        .collect()
}

/// Build an FX module-facing grid from the resolved spatial selection projection.
pub fn build_selected_grid(
    selection: &ResolvedSelection,
    fixture_data_provider: &FixtureDataProviderExt,
) -> SelectedGrid {
    let Some(projection_bounds) = selection.projection_bounds() else {
        return SelectedGrid {
            width: selection.indexes().len() as u32,
            height: 0,
            depth: 0,
            cells: Vec::new(),
        };
    };
    let width = (projection_bounds.max_x - projection_bounds.min_x + 1).max(0) as u32;
    let height = projection_bounds.height();
    let depth = projection_bounds.depth();
    if width == 0 || height == 0 || depth == 0 {
        return SelectedGrid {
            width,
            height,
            depth,
            cells: Vec::new(),
        };
    }

    let min_x = projection_bounds.min_x;
    let min_y = projection_bounds.min_y;
    let min_z = projection_bounds.min_z;
    let mut cells = Vec::with_capacity((width * height * depth) as usize);

    for z in 0..depth {
        for y in 0..height {
            for x in 0..width {
                let targets = selection
                    .indexes()
                    .iter()
                    .flat_map(|selection_index| selection_index.members.iter())
                    .filter(|indexed_fixture| {
                        indexed_fixture.projected_coord.x - min_x == x as i32
                            && indexed_fixture.projected_coord.y - min_y == y as i32
                            && indexed_fixture.projected_coord.z - min_z == z as i32
                    })
                    .filter_map(|indexed_fixture| {
                        build_selected_target(&indexed_fixture.fixture, fixture_data_provider)
                    })
                    .collect();

                cells.push(SelectedCell { x, y, z, targets });
            }
        }
    }

    SelectedGrid {
        width,
        height,
        depth,
        cells,
    }
}

/// Build an FX module-facing selected target from a fixture reference.
fn build_selected_target(
    fixture_ref: &FixtureRef,
    fixture_data_provider: &FixtureDataProviderExt,
) -> Option<SelectedTarget> {
    let fixture = fixture_data_provider
        .inner
        .get(fixture_ref.fixture_uid)
        .ok()?;
    Some(SelectedTarget {
        fixture_uid: fixture_ref.fixture_uid,
        element_index: fixture_ref.index,
        available_attributes: available_attributes_for_target(&fixture, fixture_ref.index),
    })
}

fn available_attributes_for_target(
    fixture: &Fixture,
    element_index: Option<u32>,
) -> Vec<Attribute> {
    let mut attributes = Vec::new();

    match element_index.and_then(|index| fixture.elements.get(index.saturating_sub(1) as usize)) {
        Some(element) => {
            for parameter in &element.parameters {
                if !attributes.contains(&parameter.attribute) {
                    attributes.push(parameter.attribute.clone());
                }
            }
        }
        None => {
            for element in &fixture.elements {
                for parameter in &element.parameters {
                    if !attributes.contains(&parameter.attribute) {
                        attributes.push(parameter.attribute.clone());
                    }
                }
            }
        }
    }

    attributes
}

/// Resolve the deterministic random seed for an activation from stored config.
pub fn random_seed_for_activation(definition: &StoredFxModule) -> u64 {
    definition
        .config
        .get("rand")
        .or_else(|| definition.config.get("random_seed"))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_else(|| Uuid::new_v4().as_u128() as u64)
}

/// Resolves packaged FX modules before falling back to the installed application library.
pub fn fx_module_path(module_name: &str) -> Result<PathBuf, FxModuleRuntimeError> {
    let data_dir = nightfall::nightfall_data_dir().ok_or_else(|| {
        FxModuleRuntimeError::Validation(
            "could not determine Nightfall app data directory".to_string(),
        )
    })?;
    fx_module_path_in(
        module_name,
        nightfall::active_show_data_dir().as_deref(),
        &data_dir,
    )
}

/// Resolves a module against explicit show and library roots, rejecting traversal and escaping local links.
pub fn fx_module_path_in(
    module_name: &str,
    show_root: Option<&std::path::Path>,
    data_dir: &std::path::Path,
) -> Result<PathBuf, FxModuleRuntimeError> {
    use std::path::{Component, Path};
    if module_name.is_empty()
        || module_name.contains('\\')
        || Path::new(module_name).components().count() != 1
        || !matches!(
            Path::new(module_name).components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err(FxModuleRuntimeError::Validation(format!(
            "invalid FX module name: {module_name}"
        )));
    }
    let file_name = if module_name.ends_with(".wasm") {
        module_name.to_owned()
    } else {
        format!("{module_name}.wasm")
    };
    if let Some(root) = show_root {
        let local = root.join("fx-modules").join(&file_name);
        if local.exists() {
            let canonical_root = root
                .canonicalize()
                .map_err(|error| FxModuleRuntimeError::Validation(error.to_string()))?;
            let canonical = local
                .canonicalize()
                .map_err(|error| FxModuleRuntimeError::Validation(error.to_string()))?;
            if !canonical.starts_with(canonical_root) {
                return Err(FxModuleRuntimeError::Validation(
                    "FX module escapes the show directory".to_string(),
                ));
            }
            return Ok(canonical);
        }
    }
    Ok(data_dir.join("fx-modules").join(file_name))
}

fn unix_time_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_micros().try_into().unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn mark_layer_transitions_for_release(layer: &mut Layer, release_position: Duration) {
    for (_, transition) in layer.absolute.values_mut() {
        if let Some(transition) = transition {
            transition.mark_released_at_position_if_unset(release_position);
        }
    }

    for (_, transition) in layer.relative.values_mut() {
        if let Some(transition) = transition {
            transition.mark_released_at_position_if_unset(release_position);
        }
    }
}

fn max_layer_release_duration(layer: &Layer) -> Duration {
    layer
        .absolute
        .values()
        .chain(layer.relative.values())
        .filter_map(|(_, transition)| {
            transition
                .as_ref()
                .map(|transition| transition.delay_out.saturating_add(transition.fade_out))
        })
        .max()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    mod fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fx-module/tests/support/mod.rs"
        ));
    }

    use std::{
        sync::{Mutex, OnceLock},
        time::Instant,
    };

    use bevy_app::{App, Update};
    use bevy_ecs::{message::Messages, schedule::Schedule};
    use fixture::test_component_bytes;
    use moonshine_kind::prelude::Instance;
    use nightfall_dmx::prelude::ParameterValue;
    use uuid::Uuid;

    use super::*;

    /// Builds a pending active fx-module clock from source-local reconstruction anchors.
    fn active_fx_module_test_clock(started_at: Duration, position: Duration) -> InstanceClock {
        InstanceClock {
            source: InstanceClockSource::ExternalPosition,
            position: position.saturating_sub(started_at),
            ..Default::default()
        }
    }

    fn spawn_parameter(world: &mut World, attribute: Attribute) -> Instance<Parameter> {
        let parameter_entity = world
            .spawn(Parameter {
                metadata: ParameterMetadata {
                    attribute,
                    ..Default::default()
                },
                values: Default::default(),
            })
            .id();

        // SAFETY: parameter_entity was just spawned in this world with a Parameter component.
        unsafe { Instance::from_entity_unchecked(parameter_entity) }
    }

    fn seed_fixture_provider(
        world: &mut World,
        fixture: Fixture,
        parameters: Vec<(FixtureRef, Attribute, Instance<Parameter>)>,
    ) {
        let mut fixture_data_provider = world.resource_mut::<FixtureDataProviderExt>();
        fixture_data_provider
            .inner
            .add(fixture)
            .expect("fixture should be insertable");
        for (fixture_ref, attribute, parameter) in parameters {
            fixture_data_provider.add_parameter(fixture_ref, attribute, parameter);
        }
    }

    /// Verifies spatial projection cells are exposed to fx modules as a normalized grid.
    #[test]
    fn build_selected_grid_preserves_projection_rows_and_columns() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        let fixture_one_uid = Uuid::new_v4();
        let fixture_two_uid = Uuid::new_v4();
        fixture_data_provider
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id: 1,
                    uid: fixture_one_uid,
                    label: "fixture-1".to_string(),
                },
                elements: vec![FixtureElement {
                    label: "Element 1".to_string(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        ..Default::default()
                    }],
                }],
                ..Default::default()
            })
            .expect("fixture one should insert");
        fixture_data_provider
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id: 2,
                    uid: fixture_two_uid,
                    label: "fixture-2".to_string(),
                },
                elements: vec![FixtureElement {
                    label: "Element 1".to_string(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Red,
                        native_unit: Attribute::Red.native_unit(),
                        value_polarity: Attribute::Red.value_polarity(),
                        ..Default::default()
                    }],
                }],
                ..Default::default()
            })
            .expect("fixture two should insert");

        let fixture_one = FixtureRef {
            fixture_uid: fixture_one_uid,
            index: Some(1),
        };
        let fixture_two = FixtureRef {
            fixture_uid: fixture_two_uid,
            index: Some(1),
        };
        let selection = ResolvedSelection::new(
            vec![fixture_one.clone(), fixture_two.clone()],
            vec![
                SelectionIndex {
                    index: 0,
                    invert: false,
                    members: vec![IndexedFixture {
                        fixture: fixture_one,
                        projected_coord: ProjectedCoord { x: 4, y: 10, z: 0 },
                    }],
                },
                SelectionIndex {
                    index: 1,
                    invert: false,
                    members: vec![IndexedFixture {
                        fixture: fixture_two,
                        projected_coord: ProjectedCoord { x: 5, y: 11, z: 0 },
                    }],
                },
            ],
            None,
        );

        let grid = build_selected_grid(&selection, &fixture_data_provider);

        assert_eq!(grid.width, 2);
        assert_eq!(grid.height, 2);
        assert_eq!(grid.depth, 1);
        assert_eq!(grid.cells.len(), 4);
        assert_eq!(grid.cells[0].targets.len(), 1);
        assert_eq!(grid.cells[3].targets.len(), 1);
        assert_eq!(
            grid.cells[0].targets[0].available_attributes,
            vec![Attribute::Intensity]
        );
        assert_eq!(
            grid.cells[3].targets[0].available_attributes,
            vec![Attribute::Red]
        );
    }

    /// Verifies grouped selection indexes still expose each projected grid cell to fx modules.
    #[test]
    fn build_selected_grid_expands_projected_members_inside_grouped_indexes() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        let mut members = Vec::new();
        let mut expected_fixture_uids = Vec::new();

        for y in 0..3 {
            for x in 0..4 {
                let fixture_uid = Uuid::from_u128((y * 4 + x + 1) as u128);
                fixture_data_provider
                    .inner
                    .add(Fixture {
                        identifiers: Identifiers {
                            id: y * 4 + x + 1,
                            uid: fixture_uid,
                            label: format!("fixture-{fixture_uid}"),
                        },
                        elements: vec![FixtureElement {
                            label: "Element 1".to_string(),
                            parameters: vec![ParameterMetadata {
                                attribute: Attribute::Red,
                                native_unit: Attribute::Red.native_unit(),
                                value_polarity: Attribute::Red.value_polarity(),
                                ..Default::default()
                            }],
                        }],
                        ..Default::default()
                    })
                    .expect("fixture should insert");

                let fixture = FixtureRef {
                    fixture_uid,
                    index: Some(1),
                };
                members.push(IndexedFixture {
                    fixture,
                    projected_coord: ProjectedCoord {
                        x: x as i32,
                        y: y as i32,
                        z: 0,
                    },
                });
                expected_fixture_uids.push(fixture_uid);
            }
        }

        let selection = ResolvedSelection::new(
            members
                .iter()
                .map(|indexed_fixture| indexed_fixture.fixture.clone())
                .collect(),
            vec![SelectionIndex {
                index: 0,
                invert: false,
                members,
            }],
            None,
        );

        let grid = build_selected_grid(&selection, &fixture_data_provider);

        assert_eq!(grid.width, 4);
        assert_eq!(grid.height, 3);
        assert_eq!(grid.depth, 1);
        assert_eq!(grid.cells.len(), 12);
        for (cell, expected_fixture_uid) in grid.cells.iter().zip(expected_fixture_uids) {
            assert_eq!(cell.targets.len(), 1);
            assert_eq!(cell.targets[0].fixture_uid, expected_fixture_uid);
            assert_eq!(cell.targets[0].available_attributes, vec![Attribute::Red]);
        }
    }

    /// Verifies shifted Y and Z projection lanes remain visible when they contain no targets.
    #[test]
    fn build_selected_grid_preserves_empty_shifted_y_and_z_lanes() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        let fixture_uid = Uuid::new_v4();
        fixture_data_provider
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id: 1,
                    uid: fixture_uid,
                    label: "fixture-1".to_string(),
                },
                elements: vec![FixtureElement {
                    label: "Element 1".to_string(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        ..Default::default()
                    }],
                }],
                ..Default::default()
            })
            .expect("fixture should insert");

        let fixture = FixtureRef {
            fixture_uid,
            index: Some(1),
        };
        let selection = ResolvedSelection::with_projection_bounds(
            vec![fixture.clone()],
            vec![SelectionIndex {
                index: 0,
                invert: false,
                members: vec![IndexedFixture {
                    fixture,
                    projected_coord: ProjectedCoord { x: 0, y: 1, z: 1 },
                }],
            }],
            ProjectionBounds::new(0, 0, 0, 1, 0, 1),
            None,
        );

        let grid = build_selected_grid(&selection, &fixture_data_provider);

        assert_eq!(grid.width, 1);
        assert_eq!(grid.height, 2);
        assert_eq!(grid.depth, 2);
        assert_eq!(grid.cells.len(), 4);
        assert!(grid.cells[0].targets.is_empty());
        assert!(grid.cells[1].targets.is_empty());
        assert!(grid.cells[2].targets.is_empty());
        assert_eq!(grid.cells[3].targets.len(), 1);
        assert_eq!(grid.cells[3].x, 0);
        assert_eq!(grid.cells[3].y, 1);
        assert_eq!(grid.cells[3].z, 1);
        assert_eq!(
            grid.cells[3].targets[0].available_attributes,
            vec![Attribute::Intensity]
        );
    }

    #[test]
    fn materialization_ignores_unsupported_attributes() {
        let mut world = World::new();
        world.insert_resource(FixtureDataProviderExt::default());

        let fixture_uid = Uuid::new_v4();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_string(),
            },
            elements: vec![FixtureElement {
                label: "Element 1".to_string(),
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Red,
                    native_unit: Attribute::Red.native_unit(),
                    value_polarity: Attribute::Red.value_polarity(),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let red_parameter = spawn_parameter(&mut world, Attribute::Red);
        seed_fixture_provider(
            &mut world,
            fixture,
            vec![(
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                Attribute::Red,
                red_parameter,
            )],
        );

        let definition = StoredFxModule {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "fx-module".to_string(),
            },
            module_name: "sparkle".to_string(),
            selection: SelectionExpr::default().into(),
            config: Default::default(),
        };
        let layer = fx_module_layer_to_engine_layer(
            &definition,
            FxModuleLayer {
                absolute: vec![FxModuleLayerInstruction {
                    fixture_uid,
                    element_index: Some(1),
                    attribute: Attribute::Blue,
                    value: nightfall_dmx::prelude::ParameterValue::Absolute { value: 42.0 },
                    materialized_transition: None,
                }],
                relative: vec![],
            },
            world.resource::<FixtureDataProviderExt>(),
        );

        assert!(
            layer.absolute.is_empty(),
            "unsupported attribute should be ignored"
        );
    }

    #[test]
    fn max_layer_release_duration_includes_delay_out() {
        let mut world = World::new();
        let parameter = spawn_parameter(&mut world, Attribute::Intensity);
        let mut layer = Layer::new("FxModule: test".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (
                ParameterValue::Absolute { value: 1.0 },
                Some(MaterializedTransition {
                    delay_in: Duration::ZERO,
                    fade_in: Duration::ZERO,
                    curve_in: FadeCurve::Linear,
                    delay_out: Duration::from_millis(75),
                    fade_out: Duration::from_millis(125),
                    curve_out: FadeCurve::EaseInOut,
                    start_position: Duration::ZERO,
                    release_position: None,
                }),
            ),
        );

        assert_eq!(
            max_layer_release_duration(&layer),
            Duration::from_millis(200)
        );
    }

    #[test]
    fn materialization_resolves_intensity_to_virtual_intensity() {
        let mut world = World::new();
        world.insert_resource(FixtureDataProviderExt::default());

        let fixture_uid = Uuid::new_v4();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_string(),
            },
            elements: vec![FixtureElement {
                label: "Element 1".to_string(),
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::VirtualIntensity,
                    native_unit: Attribute::VirtualIntensity.native_unit(),
                    value_polarity: Attribute::VirtualIntensity.value_polarity(),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let virtual_intensity_parameter = spawn_parameter(&mut world, Attribute::VirtualIntensity);
        seed_fixture_provider(
            &mut world,
            fixture,
            vec![(
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                Attribute::VirtualIntensity,
                virtual_intensity_parameter,
            )],
        );

        let definition = StoredFxModule {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "fx-module".to_string(),
            },
            module_name: "sparkle".to_string(),
            selection: SelectionExpr::default().into(),
            config: Default::default(),
        };
        let layer = fx_module_layer_to_engine_layer(
            &definition,
            FxModuleLayer {
                absolute: vec![FxModuleLayerInstruction {
                    fixture_uid,
                    element_index: Some(1),
                    attribute: Attribute::Intensity,
                    value: nightfall_dmx::prelude::ParameterValue::Absolute { value: 42.0 },
                    materialized_transition: None,
                }],
                relative: vec![],
            },
            world.resource::<FixtureDataProviderExt>(),
        );

        assert_eq!(layer.absolute.len(), 1);
        assert!(
            layer.absolute.contains_key(&virtual_intensity_parameter),
            "intensity instructions should resolve to virtual intensity when the fixture has no native intensity parameter"
        );
    }

    #[test]
    fn materialization_expands_fixture_level_outputs_to_all_elements() {
        let mut world = World::new();
        world.insert_resource(FixtureDataProviderExt::default());

        let fixture_uid = Uuid::new_v4();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_string(),
            },
            elements: vec![
                FixtureElement {
                    label: "Element 1".to_string(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Red,
                        native_unit: Attribute::Red.native_unit(),
                        value_polarity: Attribute::Red.value_polarity(),
                        ..Default::default()
                    }],
                },
                FixtureElement {
                    label: "Element 2".to_string(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Red,
                        native_unit: Attribute::Red.native_unit(),
                        value_polarity: Attribute::Red.value_polarity(),
                        ..Default::default()
                    }],
                },
            ],
            ..Default::default()
        };
        let parameter_1 = spawn_parameter(&mut world, Attribute::Red);
        let parameter_2 = spawn_parameter(&mut world, Attribute::Red);
        seed_fixture_provider(
            &mut world,
            fixture,
            vec![
                (
                    FixtureRef {
                        fixture_uid,
                        index: Some(1),
                    },
                    Attribute::Red,
                    parameter_1,
                ),
                (
                    FixtureRef {
                        fixture_uid,
                        index: Some(2),
                    },
                    Attribute::Red,
                    parameter_2,
                ),
            ],
        );

        let definition = StoredFxModule {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "fx-module".to_string(),
            },
            module_name: "sparkle".to_string(),
            selection: SelectionExpr::default().into(),
            config: Default::default(),
        };
        let layer = fx_module_layer_to_engine_layer(
            &definition,
            FxModuleLayer {
                absolute: vec![FxModuleLayerInstruction {
                    fixture_uid,
                    element_index: None,
                    attribute: Attribute::Red,
                    value: nightfall_dmx::prelude::ParameterValue::Absolute { value: 128.0 },
                    materialized_transition: None,
                }],
                relative: vec![],
            },
            world.resource::<FixtureDataProviderExt>(),
        );

        assert_eq!(layer.absolute.len(), 2);
        assert!(layer.absolute.contains_key(&parameter_1));
        assert!(layer.absolute.contains_key(&parameter_2));
    }

    #[test]
    fn playback_preserves_state_while_definition_is_unchanged() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);

            app.update();
            assert_eq!(active_layer_absolute_value(&mut app), 5.0);

            app.update();
            assert_eq!(active_layer_absolute_value(&mut app), 6.0);
        });
    }

    /// Verifies moving a live runtime preserves its guest state and layer entity.
    #[test]
    fn moved_runtime_preserves_state_and_layer() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);

            app.update();
            assert_eq!(active_layer_absolute_value(&mut app), 5.0);
            let layer_entity = app
                .world_mut()
                .query_filtered::<Entity, With<ActiveFxModuleLayer>>()
                .single(app.world())
                .expect("active fx module layer should exist");

            let mut definition = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            definition.identifiers.id = 2;
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(definition)
                .expect("stored fx module should move by uid");
            app.world_mut()
                .resource_mut::<ActiveFxModuleIds>()
                .0
                .remove(&1);
            app.world_mut()
                .resource_mut::<ActiveFxModuleIds>()
                .0
                .insert(2);
            app.world_mut()
                .non_send_mut::<FxModuleRuntimeStates>()
                .move_id(1, 2);

            app.update();

            assert_eq!(active_layer_absolute_value(&mut app), 6.0);
            let layer_ref = app.world().entity(layer_entity);
            assert!(layer_ref.get::<ReleaseMarker>().is_none());
            assert_eq!(
                layer_ref
                    .get::<ActiveFxModuleLayer>()
                    .expect("active layer marker should remain")
                    .fx_module_uid,
                app.world()
                    .resource::<DataProvider<StoredFxModule>>()
                    .from_id(2)
                    .expect("moved definition should exist")
                    .identifiers
                    .uid
            );
        });
    }

    /// Verifies timeline reconstruction seeds active module elapsed time from InstanceClock.
    #[test]
    fn playback_uses_timeline_instance_clock_for_elapsed_status() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);
            app.insert_resource(ActiveFxModuleTimings(HashMap::from([(
                1,
                active_fx_module_test_clock(
                    Duration::from_millis(250),
                    Duration::from_millis(1_000),
                ),
            )])));

            app.update();

            let clock = app
                .world_mut()
                .query::<&InstanceClock>()
                .single(app.world())
                .expect("timed active fx module should have a playback clock");
            assert_eq!(clock.source, InstanceClockSource::ExternalPosition);
            assert_eq!(clock.position, Duration::from_millis(750));

            let status = app
                .world_mut()
                .query::<&InstanceStatus>()
                .single(app.world())
                .expect("timed active fx module should publish runtime status");
            assert_eq!(
                status.position,
                InstancePosition::Time {
                    elapsed: Duration::from_millis(750)
                }
            );
            let compositing_context = app
                .world_mut()
                .query::<&LayerCompositingContext>()
                .single(app.world())
                .expect("timed active fx module should expose a layer compositing context");
            assert_eq!(compositing_context.position, Duration::from_millis(750));
            assert_eq!(compositing_context.released_at, None);
        });
    }

    /// Verifies a timed activation reuses and reactivates a layer that was still releasing.
    #[test]
    fn playback_timed_activation_reactivates_released_layer() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);
            app.insert_resource(ActiveFxModuleTimings(HashMap::from([(
                1,
                active_fx_module_test_clock(Duration::ZERO, Duration::from_millis(500)),
            )])));

            app.update();

            let layer_entity = app
                .world_mut()
                .query_filtered::<Entity, With<ActiveFxModuleLayer>>()
                .single(app.world())
                .expect("active fx module layer should exist");
            app.world_mut().entity_mut(layer_entity).insert((
                ReleaseMarker::default(),
                LayerCompositingContext {
                    position: Duration::from_millis(500),
                    released_at: Some(Duration::from_millis(500)),
                },
            ));
            app.world_mut()
                .resource_mut::<ActiveFxModuleTimings>()
                .0
                .insert(
                    1,
                    active_fx_module_test_clock(
                        Duration::from_millis(250),
                        Duration::from_millis(1_000),
                    ),
                );

            app.update();

            let layer_ref = app.world().entity(layer_entity);
            assert!(
                layer_ref.get::<ReleaseMarker>().is_none(),
                "timed activation should clear stale release state"
            );
            let compositing_context = layer_ref
                .get::<LayerCompositingContext>()
                .expect("reactivated layer should publish a layer compositing context");
            assert_eq!(compositing_context.position, Duration::from_millis(750));
            assert_eq!(compositing_context.released_at, None);
            assert!(
                app.world().resource::<ActiveFxModuleIds>().0.contains(&1),
                "timed activation should keep the module active"
            );
        });
    }

    /// Verifies active module render input uses the authoritative playback-clock delta.
    #[test]
    fn playback_uses_instance_clock_for_render_delta() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);

            app.update();

            let mut definition = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            definition.config =
                HashMap::from([(String::from("mode"), String::from("delta-millis"))]);
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(definition)
                .expect("fx module config update should keep the same uid");

            let clock = InstanceClock {
                source: InstanceClockSource::ExternalPosition,
                position: Duration::from_millis(333),
                previous_position: Duration::from_millis(316),
                delta: Duration::from_millis(17),
                ..Default::default()
            };
            let layer_entity = app
                .world_mut()
                .query_filtered::<Entity, With<ActiveFxModuleLayer>>()
                .single(app.world())
                .expect("active fx module layer should exist");
            app.world_mut().entity_mut(layer_entity).insert(clock);

            app.update();

            assert_eq!(active_layer_absolute_value(&mut app), 17.0);
        });
    }

    /// Verifies active modules without a playback clock render from zero elapsed.
    #[test]
    fn playback_without_clock_uses_zero_elapsed() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);
            let mut definition = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            definition.config =
                HashMap::from([(String::from("mode"), String::from("elapsed-millis"))]);
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(definition)
                .expect("fx module config update should keep the same uid");

            app.update();
            app.update();

            assert_eq!(active_layer_absolute_value(&mut app), 0.0);
            let mut context_query = app.world_mut().query::<&LayerCompositingContext>();
            assert!(
                context_query.iter(app.world()).next().is_none(),
                "unclocked active fx modules should not publish layer compositing contexts"
            );
        });
    }

    /// Verifies active modules without a playback clock render from zero frame delta.
    #[test]
    fn playback_without_clock_uses_zero_delta() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);
            let mut definition = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            definition.config =
                HashMap::from([(String::from("mode"), String::from("delta-millis"))]);
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(definition)
                .expect("fx module config update should keep the same uid");

            app.update();
            app.update();

            assert_eq!(active_layer_absolute_value(&mut app), 0.0);
        });
    }

    /// Verifies stopping a clocked module stamps release transitions in playback-clock space.
    #[test]
    fn cleanup_inactive_fx_module_records_clocked_release_position() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);
            app.insert_resource(ActiveFxModuleTimings(HashMap::from([(
                1,
                active_fx_module_test_clock(
                    Duration::from_millis(250),
                    Duration::from_millis(1_150),
                ),
            )])));

            app.update();
            app.world_mut()
                .resource_mut::<ActiveFxModuleIds>()
                .0
                .remove(&1);
            app.update();

            let compositing_context = app
                .world_mut()
                .query_filtered::<&LayerCompositingContext, With<ReleaseMarker>>()
                .single(app.world())
                .expect("released fx module should keep a layer compositing context");
            assert_eq!(compositing_context.position, Duration::from_millis(900));
            assert_eq!(
                compositing_context.released_at,
                Some(Duration::from_millis(900))
            );
        });
    }

    /// Verifies stopping an unclocked module records deterministic zero release timing.
    #[test]
    fn cleanup_inactive_fx_module_without_clock_uses_zero_release_position() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);

            app.update();
            app.world_mut()
                .resource_mut::<ActiveFxModuleIds>()
                .0
                .remove(&1);
            app.update();

            let compositing_context = app
                .world_mut()
                .query_filtered::<&LayerCompositingContext, With<ReleaseMarker>>()
                .single(app.world())
                .expect(
                    "released unclocked fx module should keep a zero layer compositing context",
                );
            assert_eq!(compositing_context.position, Duration::ZERO);
            assert_eq!(compositing_context.released_at, Some(Duration::ZERO));
        });
    }

    /// Verifies released module cleanup advances stale layer compositing contexts from InstanceClock.
    #[test]
    fn cleanup_released_fx_module_layers_uses_instance_clock_position() {
        let mut world = World::new();
        let parameter = spawn_parameter(&mut world, Attribute::Intensity);
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(50),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_millis(50),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: Some(Duration::ZERO),
        };

        let mut layer = Layer::new("fx-module-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (ParameterValue::Absolute { value: 255.0 }, Some(transition)),
        );
        let mut clock = InstanceClock::default();
        clock.seek_to(Duration::from_millis(50));

        let entity = world
            .spawn((
                ActiveFxModuleLayer {
                    fx_module_uid: Uuid::new_v4(),
                },
                layer,
                ReleaseMarker::default(),
                clock,
                LayerCompositingContext {
                    position: Duration::ZERO,
                    released_at: Some(Duration::ZERO),
                },
            ))
            .id();

        let mut schedule = Schedule::default();
        schedule.add_systems(cleanup_released_fx_module_layers);
        schedule.run(&mut world);

        assert!(
            world.get_entity(entity).is_err(),
            "released fx module layer should despawn once playback-clock elapsed reaches release duration"
        );
    }

    /// Verifies unclocked module cleanup does not advance from ReleaseMarker wall time.
    #[test]
    fn cleanup_released_fx_module_layers_without_clock_uses_zero_release_elapsed() {
        let mut world = World::new();
        let parameter = spawn_parameter(&mut world, Attribute::Intensity);
        let mut layer = Layer::new("fx-module-layer".to_string(), Priority::default());
        layer.absolute.insert(
            parameter,
            (
                ParameterValue::Absolute { value: 255.0 },
                Some(MaterializedTransition {
                    delay_in: Duration::ZERO,
                    fade_in: Duration::ZERO,
                    curve_in: FadeCurve::Linear,
                    delay_out: Duration::ZERO,
                    fade_out: Duration::from_millis(100),
                    curve_out: FadeCurve::Linear,
                    start_position: Duration::ZERO,
                    release_position: None,
                }),
            ),
        );

        let entity = world
            .spawn((
                ActiveFxModuleLayer {
                    fx_module_uid: Uuid::new_v4(),
                },
                layer,
                ReleaseMarker {
                    start_time: Instant::now() - Duration::from_secs(10),
                },
            ))
            .id();

        let mut schedule = Schedule::default();
        schedule.add_systems(cleanup_released_fx_module_layers);
        schedule.run(&mut world);

        assert!(
            world.get_entity(entity).is_ok(),
            "unclocked fx module release should not clean up from wall-clock elapsed"
        );
    }

    #[test]
    fn config_edit_recreates_fx_module_instance_state() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);

            app.update();
            assert_eq!(active_layer_absolute_value(&mut app), 5.0);
            app.update();
            assert_eq!(active_layer_absolute_value(&mut app), 6.0);

            let existing = app
                .world()
                .resource::<DataProvider<StoredFxModule>>()
                .from_id(1)
                .expect("stored fx module should exist")
                .clone();
            let mut updated = existing.clone();
            updated
                .config
                .insert("mode".to_string(), "burst".to_string());
            app.world_mut()
                .resource_mut::<DataProvider<StoredFxModule>>()
                .add(updated)
                .expect("fx module update should keep the same uid");

            app.update();
            assert_eq!(active_layer_absolute_value(&mut app), 5.0);
        });
    }

    /// Verifies active fx module load failures notify callers and deactivate the module.
    #[test]
    fn runtime_instantiation_failure_emits_notification_and_deactivates_module() {
        with_missing_test_module_env("missing-sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);

            app.update();

            let notifications: Vec<_> = app
                .world_mut()
                .resource_mut::<Messages<NotificationEnvelope<FxModuleRuntimeNotification>>>()
                .drain()
                .collect();
            assert!(
                notifications.iter().any(|notification| {
                    matches!(
                        &notification.notification,
                        FxModuleRuntimeNotification::InstantiationFailed {
                            fx_module_id: 1,
                            module_name,
                            error,
                        } if module_name == "missing-sparkle" && !error.is_empty()
                    )
                }),
                "expected missing fx module runtime to emit an instantiation failure notification"
            );
            assert!(
                !app.world().resource::<ActiveFxModuleIds>().0.contains(&1),
                "failed fx module should be deactivated after the initialization error"
            );
        });
    }

    #[test]
    fn stop_then_start_recreates_fx_module_instance_state() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_playback_app(module_name);

            app.update();
            assert_eq!(active_layer_absolute_value(&mut app), 5.0);

            app.world_mut()
                .resource_mut::<ActiveFxModuleIds>()
                .0
                .remove(&1);
            app.update();

            app.world_mut()
                .resource_mut::<ActiveFxModuleIds>()
                .0
                .insert(1);
            app.update();

            assert_eq!(active_layer_absolute_value(&mut app), 5.0);
        });
    }

    #[test]
    fn preview_update_recreates_fx_module_instance_state() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_preview_app();

            app.world_mut()
                .resource_mut::<Messages<crate::FxModulePreviewUpdate>>()
                .write(crate::FxModulePreviewUpdate::StartPreview(StoredFxModule {
                    identifiers: Identifiers {
                        id: 1,
                        uid: Uuid::new_v4(),
                        label: "sparkle-preview".to_string(),
                    },
                    module_name: module_name.to_string(),
                    selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                        fixture_id: 1,
                        element_index: Some(1),
                    })
                    .into(),
                    config: HashMap::from([(String::from("rand"), String::from("5"))]),
                }));

            app.update();
            assert_eq!(active_preview_layer_absolute_value(&mut app), 5.0);

            app.world_mut()
                .resource_mut::<Messages<crate::FxModulePreviewUpdate>>()
                .write(crate::FxModulePreviewUpdate::UpdatePreview(
                    StoredFxModule {
                        identifiers: Identifiers {
                            id: 1,
                            uid: Uuid::new_v4(),
                            label: "sparkle-preview".to_string(),
                        },
                        module_name: module_name.to_string(),
                        selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                            fixture_id: 1,
                            element_index: Some(1),
                        })
                        .into(),
                        config: HashMap::from([
                            (String::from("rand"), String::from("5")),
                            (String::from("mode"), String::from("burst")),
                        ]),
                    },
                ));

            app.update();
            assert_eq!(active_preview_layer_absolute_value(&mut app), 5.0);

            app.world_mut()
                .resource_mut::<Messages<crate::FxModulePreviewUpdate>>()
                .write(crate::FxModulePreviewUpdate::StopPreview);
            app.update();

            let mut query = app
                .world_mut()
                .query_filtered::<&Layer, (With<PreviewFxModule>, Without<ReleaseMarker>)>();
            assert!(query.iter(app.world()).next().is_none());
        });
    }

    /// Verifies preview modules attach a playback clock and render elapsed from it.
    #[test]
    fn preview_uses_instance_clock_for_render_elapsed() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_preview_app();

            app.world_mut()
                .resource_mut::<Messages<crate::FxModulePreviewUpdate>>()
                .write(crate::FxModulePreviewUpdate::StartPreview(
                    preview_definition(
                        module_name,
                        HashMap::from([(String::from("mode"), String::from("elapsed-millis"))]),
                    ),
                ));

            app.update();
            assert_eq!(active_preview_layer_absolute_value(&mut app), 0.0);

            let preview_entity = active_preview_entity(&mut app);
            assert!(
                app.world().get::<InstanceClock>(preview_entity).is_some(),
                "preview fx modules should attach a playback clock"
            );
            app.world_mut()
                .entity_mut(preview_entity)
                .insert(InstanceClock {
                    source: InstanceClockSource::ExternalPosition,
                    position: Duration::from_millis(123),
                    previous_position: Duration::from_millis(106),
                    delta: Duration::from_millis(17),
                    ..Default::default()
                });

            app.update();

            assert_eq!(active_preview_layer_absolute_value(&mut app), 123.0);
            let compositing_context = app
                .world()
                .get::<LayerCompositingContext>(preview_entity)
                .expect("preview layer should publish a layer compositing context");
            assert_eq!(compositing_context.position, Duration::from_millis(123));
            assert_eq!(compositing_context.released_at, None);
        });
    }

    /// Verifies preview modules render frame delta from the attached playback clock.
    #[test]
    fn preview_uses_instance_clock_for_render_delta() {
        with_test_module_data_dir("sparkle", |module_name| {
            let mut app = setup_preview_app();

            app.world_mut()
                .resource_mut::<Messages<crate::FxModulePreviewUpdate>>()
                .write(crate::FxModulePreviewUpdate::StartPreview(
                    preview_definition(
                        module_name,
                        HashMap::from([(String::from("mode"), String::from("delta-millis"))]),
                    ),
                ));

            app.update();
            assert_eq!(active_preview_layer_absolute_value(&mut app), 0.0);

            let preview_entity = active_preview_entity(&mut app);
            app.world_mut()
                .entity_mut(preview_entity)
                .insert(InstanceClock {
                    source: InstanceClockSource::ExternalPosition,
                    position: Duration::from_millis(333),
                    previous_position: Duration::from_millis(316),
                    delta: Duration::from_millis(17),
                    ..Default::default()
                });

            app.update();

            assert_eq!(active_preview_layer_absolute_value(&mut app), 17.0);
        });
    }

    fn setup_playback_app(module_name: &str) -> App {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.insert_resource(DataProvider::<StoredFxModule>::default());
        app.insert_resource(ActiveFxModuleIds::default());
        app.insert_resource(FxModuleClipBindings::default());
        app.insert_resource(Messages::<EventEnvelope<ClipInstanceAttachment>>::default());
        app.insert_resource(
            Messages::<NotificationEnvelope<FxModuleRuntimeNotification>>::default(),
        );
        app.insert_non_send(FxModuleRuntimeStates::default());
        app.add_systems(
            Update,
            (cleanup_inactive_fx_module, evaluate_fx_module).chain(),
        );

        let fixture_uid = Uuid::new_v4();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_string(),
            },
            elements: vec![FixtureElement {
                label: "Element 1".to_string(),
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Intensity,
                    native_unit: Attribute::Intensity.native_unit(),
                    value_polarity: Attribute::Intensity.value_polarity(),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let intensity_parameter = spawn_parameter(app.world_mut(), Attribute::Intensity);
        seed_fixture_provider(
            app.world_mut(),
            fixture,
            vec![(
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                Attribute::Intensity,
                intensity_parameter,
            )],
        );

        let stored_fx_module = StoredFxModule {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "sparkle".to_string(),
            },
            module_name: module_name.to_string(),
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: Some(1),
            })
            .into(),
            config: HashMap::from([(String::from("rand"), String::from("5"))]),
        };
        app.world_mut()
            .resource_mut::<DataProvider<StoredFxModule>>()
            .add(stored_fx_module)
            .expect("store fx module definition");
        app.world_mut()
            .resource_mut::<ActiveFxModuleIds>()
            .0
            .insert(1);

        app
    }

    fn setup_preview_app() -> App {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.insert_non_send(PreviewFxModuleRuntimeStates::default());
        app.insert_resource(Messages::<crate::FxModulePreviewUpdate>::default());
        app.add_systems(
            Update,
            (
                crate::events::handle_preview_commands,
                evaluate_preview_fx_module,
                cleanup_preview_fx_module_runtimes,
            )
                .chain(),
        );

        let fixture_uid = Uuid::new_v4();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_string(),
            },
            elements: vec![FixtureElement {
                label: "Element 1".to_string(),
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Intensity,
                    native_unit: Attribute::Intensity.native_unit(),
                    value_polarity: Attribute::Intensity.value_polarity(),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let intensity_parameter = spawn_parameter(app.world_mut(), Attribute::Intensity);
        seed_fixture_provider(
            app.world_mut(),
            fixture,
            vec![(
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                Attribute::Intensity,
                intensity_parameter,
            )],
        );

        app
    }

    /// Returns a stored FX module definition for preview timing tests.
    fn preview_definition(module_name: &str, config: HashMap<String, String>) -> StoredFxModule {
        StoredFxModule {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "sparkle-preview".to_string(),
            },
            module_name: module_name.to_string(),
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: Some(1),
            })
            .into(),
            config,
        }
    }

    /// Returns the active preview FX module entity from the test app.
    fn active_preview_entity(app: &mut App) -> Entity {
        app.world_mut()
            .query_filtered::<Entity, (With<PreviewFxModule>, Without<ReleaseMarker>)>()
            .single(app.world())
            .expect("exactly one active preview fx module entity should exist")
    }

    fn active_layer_absolute_value(app: &mut App) -> f32 {
        let mut query = app
            .world_mut()
            .query_filtered::<&Layer, (With<ActiveFxModuleLayer>, Without<ReleaseMarker>)>();
        let layer = query
            .single(app.world())
            .expect("exactly one active fx module layer should exist");
        let (value, _) = layer
            .absolute
            .values()
            .next()
            .expect("fx module layer should have an absolute value");

        match value {
            nightfall_dmx::prelude::ParameterValue::Absolute { value } => *value,
            other => panic!("expected absolute value, got {:?}", other),
        }
    }

    fn active_preview_layer_absolute_value(app: &mut App) -> f32 {
        let mut query = app.world_mut().query_filtered::<&Layer, (
            With<PreviewFxModule>,
            With<ActiveFxModuleLayer>,
            Without<ReleaseMarker>,
        )>();
        let layer = query
            .single(app.world())
            .expect("exactly one active preview fx module layer should exist");
        let (value, _) = layer
            .absolute
            .values()
            .next()
            .expect("preview fx module layer should have an absolute value");

        match value {
            nightfall_dmx::prelude::ParameterValue::Absolute { value } => *value,
            other => panic!("expected absolute value, got {:?}", other),
        }
    }

    /// Runs a test with a temporary data directory containing the named fx module.
    fn with_test_module_data_dir(test_module_name: &str, test: impl FnOnce(&str)) {
        with_configured_fx_module_data_dir(test_module_name, true, test);
    }

    /// Runs a test with a temporary data directory that intentionally omits the named module.
    fn with_missing_test_module_env(test_module_name: &str, test: impl FnOnce(&str)) {
        with_configured_fx_module_data_dir(test_module_name, false, test);
    }

    /// Sets a serialized temporary fx module data directory for runtime loading tests.
    fn with_configured_fx_module_data_dir(
        test_module_name: &str,
        write_module: bool,
        test: impl FnOnce(&str),
    ) {
        static CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = CONFIG_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();

        let temp_root =
            std::env::temp_dir().join(format!("nightfall-fx-module-{}", Uuid::new_v4()));
        let module_dir = temp_root.join("fx-modules");
        std::fs::create_dir_all(&module_dir).expect("create module directory");
        if write_module {
            std::fs::write(
                module_dir.join(format!("{test_module_name}.wasm")),
                test_component_bytes(),
            )
            .expect("write module component");
        }

        nightfall::set_nightfall_data_dir(Some(temp_root.clone()));
        test(test_module_name);
        nightfall::set_nightfall_data_dir(None);

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}

#[cfg(test)]
mod showfile_path_tests {
    use super::fx_module_path_in;

    /// Packaged components override installed versions and aliases resolve to the same stable filename.
    #[test]
    fn packaged_modules_take_precedence_with_library_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let show = directory.path().join("show");
        let data = directory.path().join("data");
        std::fs::create_dir_all(show.join("fx-modules")).unwrap();
        std::fs::create_dir_all(data.join("fx-modules")).unwrap();
        std::fs::write(show.join("fx-modules/sparkle.wasm"), b"packaged").unwrap();
        std::fs::write(data.join("fx-modules/sparkle.wasm"), b"installed").unwrap();
        for name in ["sparkle", "sparkle.wasm"] {
            assert_eq!(
                std::fs::read(fx_module_path_in(name, Some(&show), &data).unwrap()).unwrap(),
                b"packaged"
            );
            assert_eq!(
                std::fs::read(fx_module_path_in(name, None, &data).unwrap()).unwrap(),
                b"installed"
            );
        }
        assert_eq!(
            fx_module_path_in("other", Some(&show), &data).unwrap(),
            data.join("fx-modules/other.wasm")
        );
        for name in ["", "..", "../private", "/private", "dir\\private"] {
            assert!(fx_module_path_in(name, Some(&show), &data).is_err());
        }
    }

    /// A show-local symlink cannot load executable content from outside the selected show directory.
    #[cfg(unix)]
    #[test]
    fn packaged_module_links_cannot_escape_the_show() {
        let directory = tempfile::tempdir().unwrap();
        let show = directory.path().join("show");
        std::fs::create_dir_all(show.join("fx-modules")).unwrap();
        let external = directory.path().join("external.wasm");
        std::fs::write(&external, b"external").unwrap();
        std::os::unix::fs::symlink(external, show.join("fx-modules/escape.wasm")).unwrap();
        assert!(fx_module_path_in("escape", Some(&show), directory.path()).is_err());
    }
}
