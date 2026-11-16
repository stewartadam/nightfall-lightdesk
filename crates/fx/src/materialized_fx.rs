// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Logic for Materialized FX

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_instances::{
    InstanceClock, InstanceControls, InstanceId, InstanceKind, InstanceMetadata, InstancePosition,
    InstanceStatus, Owner,
};
use nightfall_selection_runtime::{ResolvedSelectionCache, SpatialSelectionResolver};
#[cfg(not(target_arch = "wasm32"))]
use orx_parallel::*;
use smart_default::SmartDefault;

use crate::fx::{Fx, FxWaveform};

/// Materialized fx
#[derive(Component, SmartDefault)]
pub struct MaterializedFx {
    /// The priority of the fx. Higher is rendered last.
    pub priority: Priority,
    /// The fx that this materialized fx is based on
    pub fx: Fx,
}

impl HasIdentifiers for MaterializedFx {
    fn identifiers(&self) -> &Identifiers {
        &self.fx.identifiers
    }
}

impl MaterializedFx {
    /// Creates a layer with fixture instructions at a source-local elapsed time.
    ///
    /// `resolved_selection` is this FX's selection already resolved and filtered to existing
    /// fixtures; callers rendering every frame keep it in a [`ResolvedSelectionCache`].
    pub fn to_layer_at_elapsed(
        &self,
        resolved_selection: &ResolvedSelection,
        fixture_data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<&Parameter>,
        elapsed: Duration,
    ) -> Layer {
        let mut layer = Layer::new(self.identifiers().label.clone(), self.priority);
        layer.priority = self.priority;

        let render_attribute = |(attribute, waveform): (&Attribute, &FxWaveform)| {
            let mut acc = (Vec::new(), Vec::new());
            // A cycle shorter than a microsecond is held at its start rather than dividing by zero.
            let cycle_micros = waveform.cycle_length.as_micros().max(1);
            let remaining = elapsed.as_micros() % cycle_micros;
            let ratio = remaining as f32 / cycle_micros as f32;
            let samples = waveform.sample(resolved_selection, Percentage::from(ratio));

            for (selection_index, sampled_value) in
                std::iter::zip(resolved_selection.iter_non_empty_indexes(), samples.iter())
            {
                for indexed_fixture in &selection_index.members {
                    let target_element_refs: Vec<FixtureRef> =
                        if let Some(index) = indexed_fixture.fixture.index {
                            vec![FixtureRef {
                                fixture_uid: indexed_fixture.fixture.fixture_uid,
                                index: Some(index),
                            }]
                        } else {
                            fixture_data_provider
                                .element_count(indexed_fixture.fixture.fixture_uid)
                                .map(|count| {
                                    (1..=count as u32)
                                        .map(|idx| FixtureRef {
                                            fixture_uid: indexed_fixture.fixture.fixture_uid,
                                            index: Some(idx),
                                        })
                                        .collect()
                                })
                                .unwrap_or_default()
                        };

                    for target_element_ref in target_element_refs {
                        let Some(resolved_parameter) = fixture_data_provider
                            .try_parameter_for_logical_attribute(&target_element_ref, attribute)
                        else {
                            continue;
                        };
                        let concrete_attribute = resolved_parameter.attribute;
                        let parameter = resolved_parameter.instance;
                        // Waveforms sample a fraction of the range; without the parameter's
                        // metadata there is no range to scale it to.
                        let Ok(parameter_ref) = parameter_query.get(parameter.entity()) else {
                            continue;
                        };
                        let metadata = &parameter_ref.metadata;

                        let mut value = waveform.output_value(*sampled_value, metadata);
                        if selection_index.invert
                            && resolved_selection.should_invert_attribute(&concrete_attribute)
                        {
                            value = value.inverted(
                                metadata.logical_min(),
                                metadata.logical_max(),
                                metadata.value_polarity,
                            );
                        }

                        let instruction = (parameter, (value, None));

                        if waveform.is_relative {
                            acc.1.push(instruction);
                        } else {
                            acc.0.push(instruction);
                        }
                    }
                }
            }

            acc
        };

        #[cfg(target_arch = "wasm32")]
        let (absolute_instructions, relative_instructions): (Vec<_>, Vec<_>) =
            self.fx.attributes.iter().map(render_attribute).fold(
                (Vec::new(), Vec::new()),
                |mut a, b| {
                    a.0.extend(b.0);
                    a.1.extend(b.1);
                    a
                },
            );

        #[cfg(not(target_arch = "wasm32"))]
        let (absolute_instructions, relative_instructions): (Vec<_>, Vec<_>) = self
            .fx
            .attributes
            .iter()
            .iter_into_par()
            // https://github.com/orxfun/orx-parallel/issues/51
            .map(render_attribute)
            .reduce(|mut a, b| {
                a.0.extend(b.0);
                a.1.extend(b.1);
                a
            })
            .unwrap_or((Vec::new(), Vec::new()));

        // Extend the layer with the collected instructions
        layer.absolute.extend(absolute_instructions);
        layer.relative.extend(relative_instructions);

        layer
    }

    /// Generates a materialized fx from fx definition.
    pub fn materialize(fx: &Fx, priority: Priority) -> Self {
        Self {
            fx: fx.clone(),
            priority,
        }
    }
}

/// Context from directly materializing a reconstructed classic FX playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaterializedFxReconstructionHandle {
    /// Entity containing the reconstructed `MaterializedFx`.
    pub fx_entity: Entity,
    /// Runtime playback ID attached to the reconstructed FX.
    pub instance_id: InstanceId,
}

/// Directly materializes classic FX playback reconstruction for an clip.
pub fn spawn_reconstructed_fx_for_clip(
    commands: &mut Commands,
    clip_uid: uuid::Uuid,
    priority: Priority,
    fx: &Fx,
    instance_clock: InstanceClock,
) -> MaterializedFxReconstructionHandle {
    let mfx = MaterializedFx::materialize(fx, priority);
    let owner = Owner(clip_uid);
    let marker = ObjectRefMarker(ObjectRef::ByUid {
        object_type: ObjectType::Fx,
        uid: fx.identifiers().uid,
    });
    let instance_id = InstanceId::new();
    let instance_metadata =
        InstanceMetadata::new(InstanceKind::Fx).with_name(fx.identifiers().label.clone());
    let instance_controls = InstanceControls::default();
    let fx_entity = commands
        .spawn((
            mfx,
            owner,
            marker,
            instance_id,
            instance_metadata,
            instance_controls,
            instance_clock,
        ))
        .id();

    MaterializedFxReconstructionHandle {
        fx_entity,
        instance_id,
    }
}

/// System that paints materialized fx to layers
///
/// Selections are resolved once per FX entity and reused across frames until the FX selection,
/// the patched fixtures or the groups change.
pub fn paint_materialized_fx(
    mut query: Query<(
        Entity,
        &MaterializedFx,
        Option<&Layer>,
        Option<&InstanceClock>,
    )>,
    selection_resolver: SpatialSelectionResolver,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<&Parameter>,
    mut selection_cache: Local<ResolvedSelectionCache<Entity>>,
    mut commands: Commands,
) {
    selection_cache.retain(|entity| query.contains(*entity));
    query
        .iter_mut()
        .for_each(|(entity, mfx, existing_layer, clock)| {
            let elapsed = clock.map(|clock| clock.position).unwrap_or_default();
            let marker = ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Fx,
                uid: mfx.identifiers().uid,
            });
            let resolved_selection =
                selection_cache.resolve(entity, &mfx.fx.selection, &selection_resolver);
            let mut new_layer = mfx.to_layer_at_elapsed(
                resolved_selection,
                &fixture_data_provider,
                &parameter_query,
                elapsed,
            );
            if let Some(existing_layer) = existing_layer {
                new_layer.activation_time = existing_layer.activation_time;
            }
            let status = InstanceStatus {
                position: InstancePosition::Time { elapsed },
                source_activation_epoch_ms: None,
                transition_elapsed: Some(elapsed),
            };
            commands.entity(entity).insert((new_layer, marker, status));
        });
}

/// Despawns cues that are due done releasing.
pub fn despawn_materialized_fx(
    mut commands: Commands,
    mut mfxs: Query<(Entity, &mut MaterializedFx, &ReleaseMarker)>,
) {
    for (entity, mfx, _) in mfxs.iter_mut() {
        tracing::debug!(entity=%entity, uid=%mfx.identifiers().uid, "Despawning fx '{}'", mfx.identifiers().label);
        commands.entity(entity).despawn();
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };

    use bevy_app::prelude::*;
    use bevy_ecs::{system::SystemState, world::World};
    use moonshine_kind::prelude::Instance;
    use nightfall_engine::prelude::DataProvider;
    use nightfall_fixture_model::prelude::*;
    use nightfall_waveform::prelude::WaveformKind;
    use uuid::Uuid;

    use super::*;
    use crate::prelude::{FxWaveform, FxWaveformParams};

    fn spawn_parameter(world: &mut World, attribute: Attribute) -> Instance<Parameter> {
        let parameter_entity = world
            .spawn(Parameter {
                metadata: ParameterMetadata {
                    attribute,
                    resolution: DmxValueResolution::Coarse,
                    ..Default::default()
                },
                values: Default::default(),
            })
            .id();

        // SAFETY: parameter_entity was spawned in this world with a Parameter component.
        unsafe { Instance::from_entity_unchecked(parameter_entity) }
    }

    #[test]
    fn fixture_level_selection_expands_to_all_elements() {
        let mut world = World::new();
        world.insert_resource(FixtureDataProviderExt::default());
        world.insert_resource(DataProvider::<Group>::default());

        let fixture_uid = Uuid::new_v4();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "fixture-1".to_owned(),
            },
            make: "test".to_owned(),
            model: "multi-element".to_owned(),
            mode: "default".to_owned(),
            elements: vec![
                FixtureElement {
                    label: "Pixel 1".to_owned(),
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Red,
                        native_unit: Attribute::Red.native_unit(),
                        value_polarity: Attribute::Red.value_polarity(),
                        ..Default::default()
                    }],
                },
                FixtureElement {
                    label: "Pixel 2".to_owned(),
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

        {
            let mut fixture_data_provider = world.resource_mut::<FixtureDataProviderExt>();
            fixture_data_provider
                .inner
                .add(fixture)
                .expect("fixture should be insertable");
            fixture_data_provider.add_parameter(
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                Attribute::Red,
                parameter_1,
            );
            fixture_data_provider.add_parameter(
                FixtureRef {
                    fixture_uid,
                    index: Some(2),
                },
                Attribute::Red,
                parameter_2,
            );
        }

        let fx = Fx {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "test-fx".to_owned(),
            },
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            })
            .into(),
            attributes: HashMap::from([(
                Attribute::Red,
                FxWaveform {
                    params: FxWaveformParams {
                        kind: WaveformKind::Sin,
                        min: Percentage::from(0.0),
                        max: Percentage::from(1.0),
                        duty_cycle: 1.0,
                    },
                    phase_range: (0.0, 2.0 * std::f32::consts::PI),
                    cycle_length: Duration::from_secs(2),
                    width: Percentage::from(1.0),
                    is_relative: false,
                },
            )]),
            timebase: Default::default(),
        };

        let materialized_fx = MaterializedFx::materialize(&fx, Priority::default());
        let mut system_state: SystemState<(
            SpatialSelectionResolver,
            Res<FixtureDataProviderExt>,
            Query<&Parameter>,
        )> = SystemState::new(&mut world);
        let (selection_resolver, fixture_data_provider, parameter_query) = system_state
            .get(&world)
            .expect("test system parameters should be available");

        let mut selection_cache = ResolvedSelectionCache::default();
        let resolved_selection =
            selection_cache.resolve((), &materialized_fx.fx.selection, &selection_resolver);
        let layer = materialized_fx.to_layer_at_elapsed(
            resolved_selection,
            &fixture_data_provider,
            &parameter_query,
            Duration::ZERO,
        );

        assert_eq!(layer.absolute.len(), 2);
        assert!(layer.absolute.contains_key(parameter_1));
        assert!(layer.absolute.contains_key(parameter_2));
    }

    /// Renders a one-fixture Pan FX with a full-range sine at `elapsed` and returns the value
    /// it outputs for that fixture's Pan parameter.
    fn render_pan_sine(is_relative: bool, elapsed: Duration) -> ParameterValue {
        let mut world = World::new();
        world.insert_resource(FixtureDataProviderExt::default());
        world.insert_resource(DataProvider::<Group>::default());

        let fixture_uid = Uuid::new_v4();
        let pan_metadata = ParameterMetadata {
            attribute: Attribute::Pan,
            native_unit: Attribute::Pan.native_unit(),
            value_polarity: Attribute::Pan.value_polarity(),
            resolution: DmxValueResolution::Coarse,
            ..Default::default()
        };
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid: fixture_uid,
                label: "mover".to_owned(),
            },
            elements: vec![FixtureElement {
                label: "Head".to_owned(),
                parameters: vec![pan_metadata.clone()],
            }],
            ..Default::default()
        };
        let pan = world
            .spawn(Parameter {
                metadata: pan_metadata,
                values: Default::default(),
            })
            .id();
        // SAFETY: pan was spawned in this world with a Parameter component.
        let pan: Instance<Parameter> = unsafe { Instance::from_entity_unchecked(pan) };
        {
            let mut provider = world.resource_mut::<FixtureDataProviderExt>();
            provider.inner.add(fixture).expect("fixture should insert");
            provider.add_parameter(
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                Attribute::Pan,
                pan,
            );
        }

        let fx = Fx {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "pan-sweep".to_owned(),
            },
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            })
            .into(),
            attributes: HashMap::from([(
                Attribute::Pan,
                FxWaveform {
                    params: FxWaveformParams {
                        kind: WaveformKind::Sin,
                        min: Percentage::from(0.0),
                        max: Percentage::from(1.0),
                        duty_cycle: 1.0,
                    },
                    phase_range: (0.0, 2.0 * std::f32::consts::PI),
                    cycle_length: Duration::from_secs(4),
                    width: Percentage::from(1.0),
                    is_relative,
                },
            )]),
            timebase: Default::default(),
        };

        let materialized_fx = MaterializedFx::materialize(&fx, Priority::default());
        let mut system_state: SystemState<(
            SpatialSelectionResolver,
            Res<FixtureDataProviderExt>,
            Query<&Parameter>,
        )> = SystemState::new(&mut world);
        let (selection_resolver, fixture_data_provider, parameter_query) = system_state
            .get(&world)
            .expect("test system parameters should be available");
        let mut selection_cache = ResolvedSelectionCache::default();
        let resolved_selection =
            selection_cache.resolve((), &materialized_fx.fx.selection, &selection_resolver);
        let layer = materialized_fx.to_layer_at_elapsed(
            resolved_selection,
            &fixture_data_provider,
            &parameter_query,
            elapsed,
        );

        let instructions = if is_relative {
            &layer.relative
        } else {
            &layer.absolute
        };
        instructions.get(pan).expect("the FX should drive pan").0
    }

    /// Returns the number an absolute or relative raw value carries, failing on percentages.
    fn raw_number(value: ParameterValue) -> f32 {
        match value {
            ParameterValue::Absolute { value } | ParameterValue::Relative { offset: value } => {
                value
            }
            other => panic!("expected a raw value, got {other:?}"),
        }
    }

    /// Verifies a full-range sine on a signed Pan sweeps from the negative logical end to the
    /// positive one, instead of only covering centre to max.
    #[test]
    fn signed_pan_sine_sweeps_both_ends() {
        let peak = render_pan_sine(false, Duration::from_secs(1));
        let trough = render_pan_sine(false, Duration::from_secs(3));
        assert!(matches!(peak, ParameterValue::Absolute { .. }));
        assert!((raw_number(peak) - 127.5).abs() < 1e-3, "{peak:?}");
        assert!((raw_number(trough) + 127.5).abs() < 1e-3, "{trough:?}");
    }

    /// Verifies a relative sine moves Pan both down and up from its programmed position.
    #[test]
    fn relative_pan_sine_moves_both_ways() {
        let peak = render_pan_sine(true, Duration::from_secs(1));
        let trough = render_pan_sine(true, Duration::from_secs(3));
        assert!(matches!(peak, ParameterValue::Relative { .. }));
        assert!((raw_number(peak) - 127.5).abs() < 1e-3, "{peak:?}");
        assert!((raw_number(trough) + 127.5).abs() < 1e-3, "{trough:?}");
    }

    #[test]
    fn paint_materialized_fx_preserves_existing_activation_time() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.add_systems(Update, paint_materialized_fx);

        let mut existing_layer = Layer::new("existing".to_owned(), Priority::default());
        let original_activation = Instant::now() - Duration::from_secs(5);
        existing_layer.activation_time = original_activation;

        let entity = app
            .world_mut()
            .spawn((MaterializedFx::default(), existing_layer))
            .id();

        app.update();

        let layer = app
            .world()
            .entity(entity)
            .get::<Layer>()
            .expect("layer should exist after painting");
        assert_eq!(layer.activation_time, original_activation);
    }

    /// Verifies unclocked FX rendering samples zero elapsed.
    #[test]
    fn paint_materialized_fx_without_clock_uses_zero_elapsed() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.add_systems(Update, paint_materialized_fx);

        let entity = app.world_mut().spawn((MaterializedFx::default(),)).id();

        app.update();

        let status = app
            .world()
            .entity(entity)
            .get::<InstanceStatus>()
            .expect("paint should publish runtime status");
        assert_eq!(
            status.position,
            InstancePosition::Time {
                elapsed: Duration::ZERO
            }
        );
    }

    /// Verifies clocked FX renders from InstanceClock elapsed.
    #[test]
    fn paint_materialized_fx_uses_instance_clock_elapsed_without_shift() {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.add_systems(Update, paint_materialized_fx);

        let entity = app
            .world_mut()
            .spawn((
                MaterializedFx::default(),
                InstanceClock {
                    position: Duration::from_millis(700),
                    ..Default::default()
                },
            ))
            .id();

        app.update();

        let status = app
            .world()
            .entity(entity)
            .get::<InstanceStatus>()
            .expect("paint should publish runtime status");
        assert_eq!(
            status.position,
            InstancePosition::Time {
                elapsed: Duration::from_millis(700)
            }
        );
    }
}
