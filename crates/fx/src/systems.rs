// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Systems for step-based FX evaluation

use std::{ops::Range, time::Duration};

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::ParameterValue;
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    InstanceClock, InstanceClockDiscontinuity, InstancePosition, InstanceStatus, Timebase,
};
#[cfg(not(target_arch = "wasm32"))]
use orx_parallel::*;

use crate::events::PreviewStepFxDefinition;
use crate::materialized_fx::MaterializedFx;
use crate::step_fx::{ActiveStepFx, FxLaneSample, StepFx, StepFxLanePhaseOffsets};

/// Active playback components sampled and re-anchored by the Step FX evaluator.
type StepFxEvaluationData = (
    Entity,
    &'static ActiveStepFx,
    Option<&'static InstanceClock>,
    Option<&'static mut StepFxLanePhaseOffsets>,
);

/// Number of selected fixtures sampled by one parallel work item.
///
/// A fixture takes well under a microsecond, so fixtures are grouped to keep scheduling and
/// allocation small next to the work, while one large FX still splits across threads.
const FIXTURES_PER_WORK_ITEM: usize = 32;

/// Fewest selected fixtures, over all playing step FX, that are sampled in parallel.
///
/// Waking the worker threads costs tens of microseconds, which is more than sampling a small rig
/// on one thread.
#[cfg(not(target_arch = "wasm32"))]
const MIN_PARALLEL_FIXTURES: usize = 128;

/// A playing step FX that is ready to sample this frame.
struct StepFxPlayback<'a> {
    /// Playback entity that receives the layer.
    entity: Entity,
    /// Definition being played.
    step_fx: &'a StepFx,
    /// Priority of the playback's layer.
    priority: Priority,
    /// Playback position the FX is sampled at.
    elapsed: Duration,
    /// Lane phase offsets kept from a re-anchored launch, or the default offsets when there are
    /// none or a reposition discarded them.
    lane_phase_offsets: &'a StepFxLanePhaseOffsets,
    /// Selection resolved against the rig.
    selection: &'a ResolvedSelection,
    /// Number of non-empty spans in the selection, which spreads the FX phase.
    span_count: usize,
}

/// A run of members of one selection span.
struct SpanSegment<'a> {
    /// Position of the span among the selection's non-empty spans.
    span_index: usize,
    /// The span.
    span: &'a SelectionIndex,
    /// Indexes of the members to sample.
    members: Range<usize>,
}

/// Consecutive selected fixtures of one playback, sampled together on one thread.
struct StepFxWorkItem<'a> {
    /// Index of the playback in the frame's playback list.
    playback: usize,
    /// The members to sample, in selection order.
    segments: Vec<SpanSegment<'a>>,
}

/// Read-only rig data used to turn step FX samples into parameter assertions.
struct StepFxRig<'a, 'w, 's> {
    /// Patched fixtures and their parameter index.
    fixtures: &'a FixtureDataProviderExt,
    /// Blueprints that step targets may reference.
    blueprints: &'a DataProvider<Blueprint>,
    /// Parameter components, read for their value metadata.
    parameters: &'a Query<'w, 's, &'static Parameter>,
}

/// One value a step FX asserts on a parameter.
type StepFxAssertion = (ParameterRef, ParameterValue);

/// Evaluates all active step-based FX and generates layers for compositor
///
/// Resolved selections are cached per active FX and resolved again only when the FX selection,
/// the patched fixtures or the groups change, since resolution dominates evaluation cost.
///
/// Sampling and parameter lookup run in parallel on native targets, split into runs of selected
/// fixtures so that both many small FX and one large FX use every core. Each run's assertions are
/// collected in input order and inserted into the layers on the system's thread, so every layer
/// is identical to a sequential evaluation.
pub fn evaluate_step_fx(
    fx_query: Query<&StepFx>,
    preview_fx_query: Query<&PreviewStepFxDefinition>,
    mut active_fx_query: Query<StepFxEvaluationData, Without<ReleaseMarker>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    blueprint_data_provider: Res<DataProvider<Blueprint>>,
    parameter_query: Query<&'static Parameter>,
    selection_resolver: SpatialSelectionResolver,
    mut selection_cache: Local<ResolvedSelectionCache<Entity>>,
    mut commands: Commands,
) {
    selection_cache.retain(|entity| active_fx_query.contains(*entity));

    // Re-anchoring lane phase offsets is the only write to playback components, so it runs before
    // everything else reads them.
    let mut playing = Vec::new();
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
        playing.push((entity, reset_offsets));
    }

    // Resolving fills the selection cache, so every selection is resolved before sampling borrows
    // the cache.
    let default_offsets = StepFxLanePhaseOffsets::default();
    let mut resolved = Vec::with_capacity(playing.len());
    for (entity, reset_offsets) in playing {
        let Ok((_, active_fx, clock, lane_phase_offsets)) = active_fx_query.get(entity) else {
            continue;
        };
        let definition = fx_query.get(active_fx.fx_entity).or_else(|_| {
            preview_fx_query
                .get(active_fx.fx_entity)
                .map(|preview| &preview.0)
        });
        let Ok(step_fx) = definition else {
            tracing::warn!("ActiveStepFx references non-existent StepFx entity");
            continue;
        };

        let selection = selection_cache.resolve(entity, &step_fx.selection, &selection_resolver);
        if selection.is_empty() {
            tracing::warn!(
                fx_id = step_fx.identifiers.id,
                selection = ?step_fx.selection,
                "StepFx selection resolved to empty set"
            );
            continue;
        }
        resolved.push((
            entity,
            step_fx,
            active_fx.priority,
            step_fx_elapsed(active_fx, clock),
            lane_phase_offsets
                .filter(|_| !reset_offsets)
                .unwrap_or(&default_offsets),
        ));
    }

    let playbacks: Vec<StepFxPlayback> = resolved
        .into_iter()
        .filter_map(|(entity, step_fx, priority, elapsed, lane_phase_offsets)| {
            let selection = selection_cache.get(&entity)?;
            let span_count = selection.iter_non_empty_indexes().count();
            tracing::trace!(
                fx_id = step_fx.identifiers.id,
                elapsed_secs = elapsed.as_secs_f32(),
                fixture_count = selection.canonical_fixtures().len(),
                span_count,
                "Evaluating step FX"
            );
            Some(StepFxPlayback {
                entity,
                step_fx,
                priority,
                elapsed,
                lane_phase_offsets,
                selection,
                span_count,
            })
        })
        .collect();
    let work_items = plan_work_items(&playbacks);

    let rig = StepFxRig {
        fixtures: &fixture_data_provider,
        blueprints: &blueprint_data_provider,
        parameters: &parameter_query,
    };
    let sample = |item: &StepFxWorkItem| sample_work_item(item, &playbacks[item.playback], &rig);
    #[cfg(target_arch = "wasm32")]
    let sampled: Vec<Vec<StepFxAssertion>> = work_items.iter().map(sample).collect();
    #[cfg(not(target_arch = "wasm32"))]
    let sampled: Vec<Vec<StepFxAssertion>> = {
        let fixture_count: usize = work_items
            .iter()
            .flat_map(|item| &item.segments)
            .map(|segment| segment.members.len())
            .sum();
        if fixture_count >= MIN_PARALLEL_FIXTURES {
            work_items.par().map(sample).collect()
        } else {
            work_items.iter().map(sample).collect()
        }
    };

    let mut layers: Vec<Layer> = playbacks
        .iter()
        .map(|playback| {
            Layer::new(
                format!("StepFx: {}", playback.step_fx.identifiers.label),
                playback.priority,
            )
        })
        .collect();
    for (item, assertions) in work_items.iter().zip(sampled) {
        let layer = &mut layers[item.playback];
        for (parameter, value) in assertions {
            if value.is_relative() {
                layer.relative.insert(parameter, (value, None));
            } else {
                layer.absolute.insert(parameter, (value, None));
            }
        }
    }

    for (playback, layer) in playbacks.iter().zip(layers) {
        tracing::trace!(
            fx_id = playback.step_fx.identifiers.id,
            absolute_params = layer.absolute.len(),
            relative_params = layer.relative.len(),
            "Generated layer for step FX"
        );
        let marker = ObjectRefMarker(ObjectRef::ByUid {
            object_type: ObjectType::StepFx,
            uid: playback.step_fx.identifiers.uid,
        });
        let status = InstanceStatus {
            position: InstancePosition::Time {
                elapsed: playback.elapsed,
            },
            source_activation_epoch_ms: None,
            transition_elapsed: Some(playback.elapsed),
        };
        commands
            .entity(playback.entity)
            .insert((layer, marker, status));
    }
}

/// Splits the selections of all playbacks into work items of at most
/// [`FIXTURES_PER_WORK_ITEM`] fixtures, in selection order, so a span with many members can be
/// spread over several threads.
fn plan_work_items<'a>(playbacks: &[StepFxPlayback<'a>]) -> Vec<StepFxWorkItem<'a>> {
    let mut items = Vec::new();
    for (playback_index, playback) in playbacks.iter().enumerate() {
        let mut segments = Vec::new();
        let mut fixtures_in_item = 0;
        for (span_index, span) in playback.selection.iter_non_empty_indexes().enumerate() {
            let mut start = 0;
            while start < span.members.len() {
                let end = span
                    .members
                    .len()
                    .min(start + FIXTURES_PER_WORK_ITEM - fixtures_in_item);
                segments.push(SpanSegment {
                    span_index,
                    span,
                    members: start..end,
                });
                fixtures_in_item += end - start;
                start = end;
                if fixtures_in_item == FIXTURES_PER_WORK_ITEM {
                    items.push(StepFxWorkItem {
                        playback: playback_index,
                        segments: std::mem::take(&mut segments),
                    });
                    fixtures_in_item = 0;
                }
            }
        }
        if !segments.is_empty() {
            items.push(StepFxWorkItem {
                playback: playback_index,
                segments,
            });
        }
    }
    items
}

/// Samples one work item and returns the parameter assertions it produces, in the order a
/// sequential evaluation would insert them.
fn sample_work_item(
    item: &StepFxWorkItem,
    playback: &StepFxPlayback,
    rig: &StepFxRig,
) -> Vec<StepFxAssertion> {
    // One read guard per work item: taking the lock per lookup makes the threads contend on it.
    let parameter_index = rig.fixtures.parameter_index();
    let mut assertions = Vec::new();
    for segment in &item.segments {
        // A sample depends on the span, not on the fixture, so one sample serves every member.
        let samples = playback
            .step_fx
            .sample_for_selection_index_with_offsets_and_blueprints(
                playback.elapsed,
                segment.span_index,
                playback.span_count,
                playback.lane_phase_offsets,
                Some(rig.blueprints),
            );
        for indexed_fixture in &segment.span.members[segment.members.clone()] {
            let fixture_ref = &indexed_fixture.fixture;
            // Whole-fixture selections address every element, including the sole element.
            let element_count = fixture_ref
                .index
                .is_none()
                .then(|| rig.fixtures.element_count(fixture_ref.fixture_uid))
                .flatten()
                .filter(|count| *count > 0);
            if let Some(element_count) = element_count {
                for idx in 1..=element_count {
                    let element_ref = FixtureRef {
                        fixture_uid: fixture_ref.fixture_uid,
                        index: Some(idx as u32),
                    };
                    apply_samples_to_element(
                        playback,
                        &samples,
                        &element_ref,
                        segment.span.invert,
                        rig,
                        &parameter_index,
                        &mut assertions,
                    );
                }
            } else {
                // Single-element fixture or specific element ref
                apply_samples_to_element(
                    playback,
                    &samples,
                    fixture_ref,
                    segment.span.invert,
                    rig,
                    &parameter_index,
                    &mut assertions,
                );
            }
        }
    }
    assertions
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
    Duration::from_secs_f64(base_elapsed.as_secs_f64() * f64::from(active_fx.speed.max(0.0)))
}

/// Appends the assertions a span's samples make on one fixture element, inverting values where
/// the selection span asks for it and converting absolute values to the parameter's raw range.
fn apply_samples_to_element(
    playback: &StepFxPlayback,
    samples: &[FxLaneSample],
    fixture_ref: &FixtureRef,
    invert: bool,
    rig: &StepFxRig,
    parameter_index: &ParameterIndex,
    assertions: &mut Vec<StepFxAssertion>,
) {
    for sample in samples {
        let Some((concrete_attribute, parameter_entity)) =
            parameter_index.parameter_for_logical_attribute(fixture_ref, &sample.attribute)
        else {
            continue;
        };

        let parameter = rig.parameters.get(parameter_entity.entity()).ok();

        for value in [sample.absolute, sample.relative].into_iter().flatten() {
            let value = if invert
                && playback
                    .selection
                    .should_invert_attribute(concrete_attribute)
            {
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
            assertions.push((
                parameter_entity.into(),
                step_fx_output_value_for_parameter(value, parameter),
            ));
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

/// Copies each FX playback's timebase from its definition onto the playback entity.
///
/// The clock systems read the [`Timebase`] component to decide whether a playback follows the
/// show tempo. A Step FX switched between Seconds and Beats changes while it plays; a waveform
/// effect picks up the change the next time it starts.
pub fn sync_fx_instance_timebase(
    mut commands: Commands,
    waveform_fx: Query<(Entity, &MaterializedFx, Option<&Timebase>)>,
    active_step_fx: Query<(Entity, &ActiveStepFx, Option<&Timebase>)>,
    step_fx_definitions: Query<&StepFx>,
    preview_step_fx_definitions: Query<&PreviewStepFxDefinition>,
) {
    let waveform_timebases = waveform_fx
        .iter()
        .map(|(entity, fx, current)| (entity, fx.fx.timebase, current));
    let step_timebases = active_step_fx
        .iter()
        .filter_map(|(entity, active_fx, current)| {
            let definition = step_fx_definitions
                .get(active_fx.fx_entity)
                .or_else(|_| {
                    preview_step_fx_definitions
                        .get(active_fx.fx_entity)
                        .map(|preview| &preview.0)
                })
                .ok()?;
            Some((entity, definition.timebase, current))
        });
    for (entity, timebase, current) in waveform_timebases.chain(step_timebases) {
        if current != Some(&timebase) {
            commands.entity(entity).insert(timebase);
        }
    }
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
    use nightfall_fixture_model::prelude::*;

    use super::*;
    use crate::step_fx::{
        CurveType, FxDirection, FxLane, FxStep, FxTrack, Linear, StepFxPhase, StepFxTiming,
        StepFxTrackPhaseOffsets,
    };

    /// Verifies clock-backed Step FX elapsed time still honors the local Step FX speed.
    #[test]
    fn step_fx_elapsed_uses_instance_clock_position_and_local_speed() {
        let active_fx = ActiveStepFx {
            fx_entity: Entity::from_bits(42),
            priority: Priority::default(),
            speed: 2.0,
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
            speed: 2.0,
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
                    speed: 1.0,
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
            timebase: Default::default(),
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

        (fixture_ref, parameter)
    }

    /// Spawns a playing Step FX in an app that keeps the evaluator (and its selection cache) across
    /// updates, returning the definition and active entities.
    fn schedule_cached_step_fx(app: &mut App, step_fx: StepFx) -> (Entity, Entity) {
        app.add_systems(bevy_app::Update, evaluate_step_fx);
        let fx_entity = app.world_mut().spawn(step_fx).id();
        let active_entity = app
            .world_mut()
            .spawn(ActiveStepFx {
                fx_entity,
                priority: Priority::default(),
                speed: 1.0,
                is_playing: true,
            })
            .id();
        (fx_entity, active_entity)
    }

    /// Returns the entities of the parameters written by the active Step FX layer.
    fn layer_parameters(app: &App, active_entity: Entity) -> Vec<Entity> {
        app.world()
            .entity(active_entity)
            .get::<Layer>()
            .expect("active Step FX should receive a generated layer")
            .absolute
            .keys()
            .map(|parameter| parameter.entity())
            .collect()
    }

    /// Stores group 1 selecting exactly `fixture_ref`, replacing any earlier group 1.
    fn store_group(app: &mut App, group_uid: uuid::Uuid, fixture_ref: FixtureRef) {
        let mut groups = app.world_mut().resource_mut::<DataProvider<Group>>();
        let _ = groups.remove(&group_uid);
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 1,
                    uid: group_uid,
                    label: "group".to_string(),
                },
                selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture_ref])),
                description: String::new(),
            })
            .expect("test group should be stored");
    }

    /// Verifies a cached selection is resolved again when the Step FX selection is edited.
    #[test]
    fn evaluate_step_fx_re_resolves_selection_after_definition_change() {
        let mut app = step_fx_test_app();
        let (first_ref, first_parameter) = add_intensity_fixture(&mut app, 1);
        let (second_ref, second_parameter) = add_intensity_fixture(&mut app, 2);
        let (fx_entity, active_entity) = schedule_cached_step_fx(
            &mut app,
            intensity_step_fx(
                ParameterValue::AbsolutePercent { value: 0.25.into() },
                SpatialSelection::identity(SelectionExpr::Resolved(vec![first_ref])),
            ),
        );

        app.update();
        assert_eq!(
            layer_parameters(&app, active_entity),
            vec![first_parameter.entity()]
        );

        app.world_mut()
            .get_mut::<StepFx>(fx_entity)
            .expect("step FX definition should exist")
            .selection = SpatialSelection::identity(SelectionExpr::Resolved(vec![second_ref]));
        app.update();
        assert_eq!(
            layer_parameters(&app, active_entity),
            vec![second_parameter.entity()]
        );
    }

    /// Verifies a cached group selection follows edits to the group it references.
    #[test]
    fn evaluate_step_fx_re_resolves_selection_after_group_change() {
        let mut app = step_fx_test_app();
        let (first_ref, first_parameter) = add_intensity_fixture(&mut app, 1);
        let (second_ref, second_parameter) = add_intensity_fixture(&mut app, 2);
        let group_uid = uuid::Uuid::new_v4();
        store_group(&mut app, group_uid, first_ref);
        let (_, active_entity) = schedule_cached_step_fx(
            &mut app,
            intensity_step_fx(
                ParameterValue::AbsolutePercent { value: 0.25.into() },
                SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(1))),
            ),
        );

        app.update();
        assert_eq!(
            layer_parameters(&app, active_entity),
            vec![first_parameter.entity()]
        );

        store_group(&mut app, group_uid, second_ref);
        app.update();
        assert_eq!(
            layer_parameters(&app, active_entity),
            vec![second_parameter.entity()]
        );
    }

    /// Verifies a selection of one fixture per span, large enough to sample in parallel, gives
    /// every fixture the value its own span samples, so splitting into work items never shifts
    /// phases or reorders spans.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn evaluate_step_fx_samples_each_span_when_selection_spans_many_work_items() {
        assert_eq!(assert_parallel_layer_matches_span_samples(Vec::new()), 1);
    }

    /// Verifies spans of several fixtures, split across work item boundaries, still give every
    /// member the value of its span.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn evaluate_step_fx_samples_spans_split_across_work_items() {
        let largest_span = assert_parallel_layer_matches_span_samples(vec![SpatialClause::Group {
            axis: Axis::X,
            amount: 3,
        }]);
        assert!(
            largest_span > 1,
            "grouping should put several fixtures in a span"
        );
    }

    /// Evaluates a two-step intensity FX, with the default phase spread, over enough fixtures to
    /// sample in parallel and with the selection shaped by `clauses`, then asserts every member
    /// of every span carries the value sampled for that span. Returns the size of the largest
    /// span.
    #[cfg(not(target_arch = "wasm32"))]
    fn assert_parallel_layer_matches_span_samples(clauses: Vec<SpatialClause>) -> usize {
        let mut app = step_fx_test_app();
        let fixture_count = MIN_PARALLEL_FIXTURES.max(FIXTURES_PER_WORK_ITEM * 2) + 5;
        let fixtures: std::collections::HashMap<FixtureRef, Instance<Parameter>> = (1
            ..=fixture_count as u32)
            .map(|id| add_intensity_fixture(&mut app, id))
            .collect();
        let mut fixture_refs: Vec<_> = fixtures.keys().cloned().collect();
        fixture_refs.sort_by_key(|fixture_ref| fixture_ref.fixture_uid);
        let selection = SpatialSelection::pipeline(SelectionExpr::Resolved(fixture_refs), clauses);
        let mut step_fx = intensity_step_fx(
            ParameterValue::AbsolutePercent { value: 0.0.into() },
            selection.clone(),
        );
        step_fx.phase = StepFxPhase::default();
        let track = step_fx.lanes[0]
            .absolute
            .as_mut()
            .expect("absolute intensity track");
        let mut full = track.steps[0].clone();
        full.uid = uuid::Uuid::new_v4();
        full.target = ParameterValue::AbsolutePercent { value: 1.0.into() };
        track.steps.push(full);

        let active_entity = evaluate_test_step_fx(&mut app, step_fx.clone());
        let resolved = app
            .world_mut()
            .run_system_once(move |resolver: SpatialSelectionResolver| {
                resolver.resolve(&selection).into_value()
            })
            .expect("selection should resolve");

        let layer = app
            .world()
            .entity(active_entity)
            .get::<Layer>()
            .expect("active Step FX should receive a generated layer");
        assert_eq!(layer.absolute.len(), fixture_count);
        let spans: Vec<_> = resolved.iter_non_empty_indexes().collect();
        let mut distinct_values = Vec::new();
        for (span_index, span) in spans.iter().enumerate() {
            let sample = step_fx
                .sample_for_selection_index_with_offsets_and_blueprints(
                    Duration::ZERO,
                    span_index,
                    spans.len(),
                    &StepFxLanePhaseOffsets::default(),
                    None,
                )
                .remove(0);
            for member in &span.members {
                let parameter = fixtures[&member.fixture];
                let metadata = app
                    .world()
                    .get::<Parameter>(parameter.entity())
                    .expect("test parameter should exist");
                let expected = step_fx_output_value_for_parameter(
                    sample.absolute.expect("absolute sample"),
                    Some(metadata),
                );
                let actual = layer.absolute.get(parameter).map(|(value, _)| *value);
                assert_eq!(actual, Some(expected), "span {span_index}");
                if !distinct_values.contains(&expected) {
                    distinct_values.push(expected);
                }
            }
        }
        assert!(
            distinct_values.len() > 1,
            "the phase spread should give spans different values"
        );
        spans
            .iter()
            .map(|span| span.members.len())
            .max()
            .unwrap_or(0)
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
                speed: 1.0,
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
                speed: 1.0,
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
            layer.absolute.get(parameter).map(|(value, _)| *value),
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
            layer.absolute.get(parameter).map(|(value, _)| *value),
            Some(ParameterValue::Absolute { value: 63.75 })
        );
    }

    /// Verifies live Blueprint targets override their stored editable fallback at playback time.
    #[test]
    fn evaluate_step_fx_resolves_live_blueprint_target() {
        let mut app = step_fx_test_app();
        let (fixture_ref, parameter) = add_intensity_fixture(&mut app, 1);
        let blueprint_uid = uuid::Uuid::from_u128(0xb1e);
        let mut blueprint = Blueprint {
            identifiers: Identifiers {
                id: 1,
                uid: blueprint_uid,
                label: "Live intensity".to_owned(),
            },
            ..Default::default()
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
            layer.absolute.get(parameter).map(|(value, _)| *value),
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
            layer.absolute.get(first_parameter).map(|(value, _)| *value),
            Some(ParameterValue::Absolute { value: 63.75 })
        );
        assert_eq!(
            layer
                .absolute
                .get(second_parameter)
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
