// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Systems for step-based FX evaluation

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::ParameterValue;
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    InstanceClock, InstanceClockDiscontinuity, InstancePosition, InstanceStatus,
};
use nightfall_selection::filter_existing_selection;

use crate::events::PreviewStepFxDefinition;
use crate::step_fx::{ActiveStepFx, StepFx, StepFxLanePhaseOffsets};

/// Active playback components sampled and re-anchored by the Step FX evaluator.
type StepFxEvaluationData = (
    Entity,
    &'static ActiveStepFx,
    Option<&'static InstanceClock>,
    Option<&'static mut StepFxLanePhaseOffsets>,
);

/// Evaluates all active step-based FX and generates layers for compositor
pub fn evaluate_step_fx(
    fx_query: Query<&StepFx>,
    preview_fx_query: Query<&PreviewStepFxDefinition>,
    mut active_fx_query: Query<StepFxEvaluationData, Without<ReleaseMarker>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    blueprint_data_provider: Res<DataProvider<Blueprint>>,
    parameter_query: Query<&Parameter>,
    selection_resolver: SpatialSelectionResolver,
    mut commands: Commands,
) {
    for (entity, active_fx, clock, mut lane_phase_offsets) in active_fx_query.iter_mut() {
        if !active_fx.is_playing {
            continue;
        }

        let reset_offsets = lane_phase_offsets
            .as_deref()
            .zip(clock)
            .is_some_and(|(offsets, clock)| phase_offsets_detect_reposition(offsets, clock));
        if reset_offsets {
            commands.entity(entity).remove::<StepFxLanePhaseOffsets>();
        } else if let (Some(offsets), Some(clock)) = (lane_phase_offsets.as_deref_mut(), clock) {
            offsets.last_clock_position = clock.position;
        }
        let lane_phase_offsets = (!reset_offsets)
            .then_some(lane_phase_offsets.as_deref())
            .flatten();

        let elapsed = step_fx_elapsed(active_fx, clock);

        // Get the StepFx definition
        let definition = fx_query.get(active_fx.fx_entity).or_else(|_| {
            preview_fx_query
                .get(active_fx.fx_entity)
                .map(|preview| &preview.0)
        });
        let Ok(step_fx) = definition else {
            tracing::warn!("ActiveStepFx references non-existent StepFx entity");
            continue;
        };

        let selection = filter_existing_selection(
            &selection_resolver.resolve(&step_fx.selection).into_value(),
            fixture_data_provider.as_ref(),
        );
        if selection.is_empty() {
            tracing::warn!(
                fx_id = step_fx.identifiers.id,
                selection = ?step_fx.selection,
                "StepFx selection resolved to empty set"
            );
            continue;
        }

        tracing::trace!(
            fx_id = step_fx.identifiers.id,
            elapsed_secs = elapsed.as_secs_f32(),
            fixture_count = selection.canonical_fixtures().len(),
            span_count = selection.iter_non_empty_indexes().count(),
            "Evaluating step FX"
        );

        // Create layer for this FX
        let mut layer = Layer::new(
            format!("StepFx: {}", step_fx.identifiers.label),
            active_fx.priority,
        );

        let span_count = selection.iter_non_empty_indexes().count();

        for (span_index, selection_index) in selection.iter_non_empty_indexes().enumerate() {
            for indexed_fixture in &selection_index.members {
                let fixture_ref = &indexed_fixture.fixture;
                // Whole-fixture selections address every element, including the sole element.
                if fixture_ref.index.is_none() {
                    if let Some(element_count) =
                        fixture_data_provider.element_count(fixture_ref.fixture_uid)
                    {
                        if element_count > 0 {
                            for idx in 1..=element_count {
                                let element_ref = FixtureRef {
                                    fixture_uid: fixture_ref.fixture_uid,
                                    index: Some(idx as u32),
                                };
                                apply_fx_to_fixture(
                                    step_fx,
                                    &element_ref,
                                    elapsed,
                                    lane_phase_offsets,
                                    span_index,
                                    span_count,
                                    selection_index.invert,
                                    &selection,
                                    &fixture_data_provider,
                                    &blueprint_data_provider,
                                    &parameter_query,
                                    &mut layer,
                                );
                            }
                            continue;
                        }
                    }
                }
                // Single-element fixture or specific element ref
                apply_fx_to_fixture(
                    step_fx,
                    fixture_ref,
                    elapsed,
                    lane_phase_offsets,
                    span_index,
                    span_count,
                    selection_index.invert,
                    &selection,
                    &fixture_data_provider,
                    &blueprint_data_provider,
                    &parameter_query,
                    &mut layer,
                );
            }
        }

        tracing::trace!(
            fx_id = step_fx.identifiers.id,
            absolute_params = layer.absolute.len(),
            relative_params = layer.relative.len(),
            "Generated layer for step FX"
        );
        // Insert layer component on the ActiveStepFx entity
        commands.entity(entity).insert(layer);
        let marker = ObjectRefMarker(ObjectRef::ByUid {
            object_type: ObjectType::StepFx,
            uid: step_fx.identifiers.uid,
        });
        commands.entity(entity).insert(marker);
        commands.entity(entity).insert(InstanceStatus {
            position: InstancePosition::Time { elapsed },
            source_activation_epoch_ms: None,
            transition_elapsed: Some(elapsed),
        });
    }
}

/// Detects clock movement that cannot be explained by the current frame delta.
fn phase_offsets_detect_reposition(
    offsets: &StepFxLanePhaseOffsets,
    clock: &InstanceClock,
) -> bool {
    if clock.discontinuity == InstanceClockDiscontinuity::Discontinuous {
        return true;
    }
    let expected = offsets.last_clock_position.saturating_add(clock.delta);
    clock.position != expected && !(clock.frozen && clock.position == offsets.last_clock_position)
}

/// Returns the effective elapsed time used to sample a step FX playback.
fn step_fx_elapsed(active_fx: &ActiveStepFx, clock: Option<&InstanceClock>) -> Duration {
    let base_elapsed = clock.map(|clock| clock.position).unwrap_or_default();
    Duration::from_secs_f64(base_elapsed.as_secs_f64() * f64::from(active_fx.rate.max(0.0)))
}

/// Apply FX sample values for a single fixture to a layer
fn apply_fx_to_fixture(
    step_fx: &StepFx,
    fixture_ref: &FixtureRef,
    elapsed: Duration,
    lane_phase_offsets: Option<&StepFxLanePhaseOffsets>,
    selection_index: usize,
    selection_index_count: usize,
    invert: bool,
    selection: &ResolvedSelection,
    fixture_data_provider: &FixtureDataProviderExt,
    blueprint_data_provider: &DataProvider<Blueprint>,
    parameter_query: &Query<&Parameter>,
    layer: &mut Layer,
) {
    let default_offsets = StepFxLanePhaseOffsets::default();
    let samples = step_fx.sample_for_selection_index_with_offsets_and_blueprints(
        elapsed,
        selection_index,
        selection_index_count,
        lane_phase_offsets.unwrap_or(&default_offsets),
        Some(blueprint_data_provider),
    );

    for sample in samples {
        let Some(resolved_parameter) = fixture_data_provider
            .try_parameter_for_logical_attribute(fixture_ref, &sample.attribute)
        else {
            continue;
        };
        let concrete_attribute = resolved_parameter.attribute;
        let parameter_entity = resolved_parameter.instance;

        let parameter = parameter_query.get(parameter_entity.entity()).ok();

        for value in [sample.absolute, sample.relative].into_iter().flatten() {
            let value = if invert && selection.should_invert_attribute(&concrete_attribute) {
                if let Some(parameter) = parameter {
                    value.inverted(
                        parameter.metadata.logical_min(),
                        parameter.metadata.logical_max(),
                        parameter.metadata.value_polarity,
                    )
                } else {
                    value.inverted(0.0, 255.0, concrete_attribute.value_polarity())
                }
            } else {
                value
            };
            let value = step_fx_output_value_for_parameter(value, parameter);

            if value.is_relative() {
                layer.relative.insert(parameter_entity, (value, None));
            } else {
                layer.absolute.insert(parameter_entity, (value, None));
            }
        }
    }
}

/// Convert Step FX absolute output to raw values when concrete parameter metadata is available.
fn step_fx_output_value_for_parameter(
    value: ParameterValue,
    parameter: Option<&Parameter>,
) -> ParameterValue {
    parameter.map_or(value, |parameter| {
        parameter.metadata.parameter_value_as_absolute(&value)
    })
}

/// Despawns step FX that are marked for release
pub fn despawn_step_fx(
    mut commands: Commands,
    mut active_fx_query: Query<(Entity, &ActiveStepFx, &ReleaseMarker)>,
) {
    for (entity, _active_fx, _) in active_fx_query.iter_mut() {
        tracing::debug!(entity=%entity, "Despawning active step FX");
        commands.entity(entity).despawn();
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::App;
    use bevy_ecs::system::RunSystemOnce;
    use moonshine_kind::prelude::Instance;
    use nightfall_dmx::prelude::Attribute;
    use nightfall_engine::prelude::DataProvider;

    use super::*;
    use crate::step_fx::{
        CurveType, FxDirection, FxLane, FxStep, FxTrack, Linear, StepFxPhase, StepFxTiming,
        StepFxTrackPhaseOffsets,
    };

    /// Verifies clock-backed Step FX elapsed time still honors the local Step FX rate.
    #[test]
    fn step_fx_elapsed_uses_instance_clock_position_and_local_rate() {
        let active_fx = ActiveStepFx {
            fx_entity: Entity::from_bits(42),
            priority: Priority::default(),
            rate: 2.0,
            is_playing: true,
        };
        let clock = InstanceClock {
            position: Duration::from_millis(750),
            ..Default::default()
        };

        let elapsed = step_fx_elapsed(&active_fx, Some(&clock));

        assert_eq!(elapsed, Duration::from_millis(1500));
    }

    /// Verifies unclocked Step FX elapsed time does not advance from host time.
    #[test]
    fn step_fx_elapsed_without_clock_uses_zero_elapsed() {
        let active_fx = ActiveStepFx {
            fx_entity: Entity::from_bits(42),
            priority: Priority::default(),
            rate: 2.0,
            is_playing: true,
        };

        let elapsed = step_fx_elapsed(&active_fx, None);

        assert_eq!(elapsed, Duration::ZERO);
    }

    /// Verifies a clock reposition discards corrections after schedulers clear its flag.
    #[test]
    fn evaluate_step_fx_clears_phase_offsets_after_clock_discontinuity() {
        let mut app = step_fx_test_app();
        let step_fx = intensity_step_fx(
            ParameterValue::AbsolutePercent { value: 0.25.into() },
            SpatialSelection::default(),
        );
        let fx_entity = app.world_mut().spawn(step_fx).id();
        let active_entity = app
            .world_mut()
            .spawn((
                ActiveStepFx {
                    fx_entity,
                    priority: Priority::default(),
                    rate: 1.0,
                    is_playing: true,
                },
                InstanceClock {
                    position: Duration::from_secs(5),
                    previous_position: Duration::from_secs(5),
                    discontinuity: InstanceClockDiscontinuity::Continuous,
                    ..Default::default()
                },
                StepFxLanePhaseOffsets::new(
                    vec![(
                        Attribute::Intensity,
                        StepFxTrackPhaseOffsets {
                            absolute: 0.25,
                            relative: 0.5,
                        },
                    )],
                    Duration::ZERO,
                ),
            ))
            .id();

        app.world_mut()
            .run_system_once(evaluate_step_fx)
            .expect("Step FX evaluator should run");

        assert!(
            app.world()
                .get::<StepFxLanePhaseOffsets>(active_entity)
                .is_none()
        );
    }

    /// Builds a single-step intensity FX that samples to the provided value.
    fn intensity_step_fx(value: ParameterValue, selection: SpatialSelection) -> StepFx {
        StepFx {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "test intensity step fx".to_string(),
            },
            selection,
            timing: StepFxTiming {
                beat_duration: Duration::from_secs(1),
            },
            phase: StepFxPhase {
                waypoints: vec![0.0],
                ..Default::default()
            },
            direction: FxDirection::Forward,
            cycle_scale: Default::default(),
            lanes: vec![FxLane {
                attribute: Attribute::Intensity,
                timing_override: None,
                phase_override: None,
                absolute: (!value.is_relative()).then(|| FxTrack {
                    steps: vec![FxStep {
                        uid: uuid::Uuid::new_v4(),
                        target: value,
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Linear(Linear {}),
                    }],
                }),
                relative: value.is_relative().then(|| FxTrack {
                    steps: vec![FxStep {
                        uid: uuid::Uuid::new_v4(),
                        target: value,
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Linear(Linear {}),
                    }],
                }),
            }],
        }
    }

    /// Adds a test fixture with one intensity parameter and returns its fixture and parameter refs.
    fn add_intensity_fixture(app: &mut App, id: u32) -> (FixtureRef, Instance<Parameter>) {
        let fixture_uid = uuid::Uuid::new_v4();
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(1),
        };
        let metadata = ParameterMetadata {
            attribute: Attribute::Intensity,
            ..Default::default()
        };
        let parameter = unsafe {
            Instance::<Parameter>::from_entity_unchecked(
                app.world_mut()
                    .spawn(Parameter {
                        metadata: metadata.clone(),
                        values: ParameterValues::default(),
                    })
                    .id(),
            )
        };

        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id,
                    uid: fixture_uid,
                    label: format!("fixture-{id}"),
                },
                elements: vec![FixtureElement {
                    label: "main".to_string(),
                    parameters: vec![metadata],
                }],
                ..Default::default()
            })
            .expect("test fixture should be stored");
        fixtures.add_parameter(fixture_ref.clone(), Attribute::Intensity, parameter);
        drop(fixtures);

        (fixture_ref, parameter)
    }

    /// Creates a minimal app world with resources needed by the Step FX evaluator.
    fn step_fx_test_app() -> App {
        let mut app = App::new();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(DataProvider::<Group>::default());
        app.insert_resource(DataProvider::<Blueprint>::default());
        app
    }

    /// Runs the Step FX evaluator once and returns the generated active layer entity.
    fn evaluate_test_step_fx(app: &mut App, step_fx: StepFx) -> Entity {
        let fx_entity = app.world_mut().spawn(step_fx).id();
        let active_entity = app
            .world_mut()
            .spawn(ActiveStepFx {
                fx_entity,
                priority: Priority::default(),
                rate: 1.0,
                is_playing: true,
            })
            .id();

        app.world_mut()
            .run_system_once(evaluate_step_fx)
            .expect("Step FX evaluator should run");

        active_entity
    }

    /// Verifies preview layers carry the source marker required by the compositor.
    #[test]
    fn evaluate_step_fx_attaches_compositor_source_marker_to_preview() {
        let mut app = step_fx_test_app();
        let (fixture_ref, _) = add_intensity_fixture(&mut app, 1);
        let step_fx = intensity_step_fx(
            ParameterValue::AbsolutePercent { value: 0.25.into() },
            SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
        );
        let definition_entity = app.world_mut().spawn(PreviewStepFxDefinition(step_fx)).id();
        let active_entity = app
            .world_mut()
            .spawn(ActiveStepFx {
                fx_entity: definition_entity,
                priority: Priority::default(),
                rate: 1.0,
                is_playing: true,
            })
            .id();

        app.world_mut()
            .run_system_once(evaluate_step_fx)
            .expect("Step FX evaluator should run");

        let active = app.world().entity(active_entity);
        assert!(active.contains::<Layer>());
        assert!(active.contains::<ObjectRefMarker>());
    }

    /// Verifies whole-fixture selections address a single fixture element during evaluation.
    #[test]
    fn evaluate_step_fx_expands_single_element_whole_fixture_selection() {
        let mut app = step_fx_test_app();
        let (_, parameter) = add_intensity_fixture(&mut app, 1);
        let step_fx = intensity_step_fx(
            ParameterValue::AbsolutePercent { value: 0.25.into() },
            SpatialSelection::identity(SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            })),
        );

        let active_entity = evaluate_test_step_fx(&mut app, step_fx);

        let layer = app
            .world()
            .entity(active_entity)
            .get::<Layer>()
            .expect("active Step FX should receive a generated layer");
        assert_eq!(
            layer.absolute.get(&parameter).map(|(value, _)| *value),
            Some(ParameterValue::Absolute { value: 63.75 })
        );
    }

    /// Verifies metadata-backed Step FX output stores absolute percent samples as raw values.
    #[test]
    fn evaluate_step_fx_emits_raw_absolute_values_for_absolute_percent_samples() {
        let mut app = step_fx_test_app();
        let (fixture_ref, parameter) = add_intensity_fixture(&mut app, 1);
        let step_fx = intensity_step_fx(
            ParameterValue::AbsolutePercent { value: 0.25.into() },
            SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
        );

        let active_entity = evaluate_test_step_fx(&mut app, step_fx);

        let layer = app
            .world()
            .entity(active_entity)
            .get::<Layer>()
            .expect("active Step FX should receive a generated layer");
        assert_eq!(
            layer.absolute.get(&parameter).map(|(value, _)| *value),
            Some(ParameterValue::Absolute { value: 63.75 })
        );
    }

    /// Verifies live Blueprint targets override their stored editable fallback at playback time.
    #[test]
    fn evaluate_step_fx_resolves_live_blueprint_target() {
        let mut app = step_fx_test_app();
        let (fixture_ref, parameter) = add_intensity_fixture(&mut app, 1);
        let blueprint_uid = uuid::Uuid::from_u128(0xb1e);
        let mut blueprint = Blueprint::default();
        blueprint.identifiers = Identifiers {
            id: 1,
            uid: blueprint_uid,
            label: "Live intensity".to_owned(),
        };
        blueprint.values.insert(
            Attribute::Intensity,
            ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.75.into() }),
        );
        app.world_mut()
            .resource_mut::<DataProvider<Blueprint>>()
            .add(blueprint)
            .expect("test Blueprint should be stored");
        let mut step_fx = intensity_step_fx(
            ParameterValue::AbsolutePercent { value: 0.25.into() },
            SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
        );
        step_fx.lanes[0].absolute.as_mut().unwrap().steps[0].blueprint_uid = Some(blueprint_uid);

        let active_entity = evaluate_test_step_fx(&mut app, step_fx);
        let layer = app
            .world()
            .entity(active_entity)
            .get::<Layer>()
            .expect("active Step FX should receive a generated layer");

        assert_eq!(
            layer.absolute.get(&parameter).map(|(value, _)| *value),
            Some(ParameterValue::Absolute { value: 191.25 })
        );
    }

    /// Verifies inverted Step FX output is converted after inversion has been applied.
    #[test]
    fn evaluate_step_fx_emits_raw_absolute_values_after_inversion() {
        let mut app = step_fx_test_app();
        let (first_fixture, first_parameter) = add_intensity_fixture(&mut app, 1);
        let (second_fixture, second_parameter) = add_intensity_fixture(&mut app, 2);
        let step_fx = intensity_step_fx(
            ParameterValue::AbsolutePercent { value: 0.25.into() },
            SpatialSelection::pipeline(
                SelectionExpr::Resolved(vec![first_fixture, second_fixture]),
                vec![SpatialClause::Invert {
                    mode: InvertMode::Index,
                    attrs: Some(vec![Attribute::Intensity]),
                }],
            ),
        );

        let active_entity = evaluate_test_step_fx(&mut app, step_fx);

        let layer = app
            .world()
            .entity(active_entity)
            .get::<Layer>()
            .expect("active Step FX should receive a generated layer");
        assert_eq!(
            layer
                .absolute
                .get(&first_parameter)
                .map(|(value, _)| *value),
            Some(ParameterValue::Absolute { value: 63.75 })
        );
        assert_eq!(
            layer
                .absolute
                .get(&second_parameter)
                .map(|(value, _)| *value),
            Some(ParameterValue::Absolute { value: 191.25 })
        );
    }

    /// Verifies relative percent output stays relative even when parameter metadata is available.
    #[test]
    fn step_fx_output_value_keeps_relative_percent_values() {
        let parameter = Parameter {
            metadata: ParameterMetadata::default(),
            values: ParameterValues::default(),
        };
        let value = ParameterValue::RelativePercent {
            offset: 0.25.into(),
        };

        let output = step_fx_output_value_for_parameter(value, Some(&parameter));

        assert_eq!(output, value);
    }

    /// Verifies absolute percent output is left unchanged when no parameter metadata is available.
    #[test]
    fn step_fx_output_value_keeps_absolute_percent_without_parameter_metadata() {
        let value = ParameterValue::AbsolutePercent { value: 0.25.into() };

        let output = step_fx_output_value_for_parameter(value, None);

        assert_eq!(output, value);
    }
}
