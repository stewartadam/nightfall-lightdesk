// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::system::SystemParam;
use moonshine_kind::prelude::Instance;
use nightfall_compositor::prelude::{FinalLayerOutput, ParameterRef};
use nightfall_cues::prelude::LookaheadCandidateAssertion;
use nightfall_dmx::prelude::Attribute;
use nightfall_lookahead::{
    FixtureFootprint, Lookahead, LookaheadAssertion, LookaheadAssertions as LookaheadAssertionSet,
    LookaheadReason, PlaybackFootprint,
};

use super::planner_adapter::planned_source_for_clip;
use super::*;
use crate::prelude::{
    Action, Timeline, TimelineLookaheadActionBlocker, TimelineLookaheadActionStatus,
    TimelineLookaheadActionStatusKind, TimelineLookaheadActionStatuses, TimelineLookaheadMode,
};

/// Lookahead providers and change ticks used to invalidate cached projections.
type LookaheadProviderData = (
    Entity,
    Ref<'static, MaterializedLookaheadCandidates>,
    Option<Ref<'static, LookaheadAssertionSet>>,
    Option<Ref<'static, LookaheadFixtureDarknessSnapshot>>,
);

/// Maximum blocker records carried in runtime status payloads for one timeline action.
const MAX_TIMELINE_LOOKAHEAD_STATUS_BLOCKERS: usize = 1;

/// Identifies one timeline action whose source can provide lookahead assertions.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct TimelineLookaheadKey {
    /// Timeline definition UID that owns the source request.
    timeline_uid: Uuid,
    /// Timeline track that owns the source request.
    track_id: String,
    /// Timeline action that owns the source request.
    action_id: String,
}

/// Timeline-owned source request that a materialized provider can populate.
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub struct TimelineLookahead {
    /// Timeline definition UID that owns this source request.
    pub timeline_uid: Uuid,
    /// Timeline track that owns this source request.
    pub track_id: String,
    /// Timeline action that owns this source request.
    pub action_id: String,
    /// Planned source represented by this provider entity.
    pub source: PlannedPlaybackSource,
    /// Timeline-local position where normal activation will start.
    pub starts_at_timeline: Duration,
}

/// Materialized source capable of producing timeline lookahead assertions.
#[derive(Component)]
pub enum MaterializedLookaheadProvider {
    /// Sequence-backed lookahead provider.
    Sequence(MaterializedSequence),
}

/// Current-output-independent assertions that a materialized provider may preactivate.
#[derive(Component, Clone, Debug, PartialEq)]
pub struct MaterializedLookaheadCandidates {
    /// Candidate assertions filtered later against current global output darkness.
    candidates: Vec<LookaheadCandidateAssertion>,
}

/// Semantic darkness state for the fixtures used by one lookahead provider.
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub struct LookaheadFixtureDarknessSnapshot {
    /// Stable per-fixture darkness entries used to invalidate assertion filtering.
    entries: Vec<LookaheadFixtureDarknessEntry>,
}

/// Darkness state for one candidate fixture.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LookaheadFixtureDarknessEntry {
    /// Fixture or element whose intensity controls candidate eligibility.
    fixture_ref: FixtureRef,
    /// Resolved intensity parameter, when the fixture exposes one.
    intensity_parameter: Option<ParameterRef>,
    /// Whether the fixture is dark enough for preactivation lookahead.
    is_dark: bool,
}

/// Context needed to resolve source fixture footprints.
struct FixtureFootprintContext<'a> {
    /// Sequence definitions for sequence-backed sources.
    sequence_data_provider: Option<&'a DataProvider<Sequence>>,
    /// Cue definitions for cue-backed sources.
    cue_data_provider: &'a DataProvider<Cue>,
    /// Classic FX definitions for selection-based source footprints.
    fx_data_provider: Option<&'a DataProvider<Fx>>,
    /// Fixture metadata and parameter ownership lookups.
    fixture_data_provider: &'a FixtureDataProviderExt,
    /// Selection resolver used for FX-style source footprints.
    selection_resolver: &'a SpatialSelectionResolver<'a>,
}

/// Caches expensive footprint lookups during one timeline assertion aggregation pass.
#[derive(Default)]
struct TimelineLookaheadFootprintCache {
    /// Authored timeline action footprints keyed by stable action identity.
    action_footprints: HashMap<TimelineLookaheadKey, FixtureFootprint>,
    /// Planned source footprints keyed by source identity.
    source_footprints: HashMap<PlannedPlaybackSource, FixtureFootprint>,
    /// Clip UID to planned source lookups.
    clip_sources: HashMap<Uuid, Option<PlannedPlaybackSource>>,
}

impl TimelineLookaheadFootprintCache {
    /// Drops cached footprints after source, timeline, or fixture definitions change.
    fn clear(&mut self) {
        self.action_footprints.clear();
        self.source_footprints.clear();
        self.clip_sources.clear();
    }
}

/// Marker for a timeline-owned layer that carries aggregated lookahead assertions.
#[derive(Component, Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimelineLookaheadLayer {
    /// Timeline definition UID that owns this lookahead layer.
    pub timeline_uid: Uuid,
}

/// Tracks whether timeline lookahead layers need to be rebuilt.
#[derive(Default)]
pub(crate) struct TimelineLookaheadLayerRunState {
    /// Last timeline position bucket and entity shape used for aggregation.
    signature: TimelineLookaheadLayerSignature,
    /// Reusable footprint cache retained across position-only lookahead rebuilds.
    footprint_cache: TimelineLookaheadFootprintCache,
    /// Whether aggregation has run at least once.
    initialized: bool,
}

/// Cheap summary of timeline and entity state that affects lookahead aggregation.
#[derive(Default, PartialEq, Eq)]
struct TimelineLookaheadLayerSignature {
    /// Timeline-local action position buckets keyed by timeline UID.
    timelines: Vec<TimelineLookaheadTimelineSignature>,
    /// Number of source providers that can contribute assertions.
    provider_count: usize,
    /// Number of clips consulted while resolving source footprints.
    clip_count: usize,
    /// Number of step FX consulted while resolving source footprints.
    step_fx_count: usize,
}

/// Timeline-local lookahead state that changes only when action eligibility can change.
#[derive(PartialEq, Eq)]
struct TimelineLookaheadTimelineSignature {
    /// Timeline definition UID.
    timeline_uid: Uuid,
    /// Whether this timeline currently publishes lookahead action statuses.
    statuses_enabled: bool,
    /// Whether this timeline currently materializes a live lookahead layer.
    layer_enabled: bool,
    /// Count of authored actions at or before the current timeline-local position.
    elapsed_action_count: usize,
}

/// Read-only dependencies for rebuilding timeline-owned lookahead layers.
#[derive(SystemParam)]
pub struct TimelineLookaheadLayerInputs<'w, 's> {
    /// Registered deterministic action capabilities consulted for authored actions.
    action_registry: Option<Res<'w, ActionRegistry>>,
    /// Materialized timelines that can own lookahead providers and layers.
    timeline_query: Query<'w, 's, Ref<'static, MaterializedTimeline>>,
    /// Authored timeline definitions used to invalidate aggregation after timeline edits.
    timeline_data_provider: Option<Res<'w, DataProvider<Timeline>>>,
    /// Timecode generators used to derive timeline-local positions.
    timecode_query: Query<'w, 's, (Entity, Ref<'static, TimecodeGenerator>)>,
    /// Source-owned assertions produced by materialized lookahead providers.
    providers: Query<
        'w,
        's,
        (
            Ref<'static, TimelineLookahead>,
            Ref<'static, LookaheadAssertionSet>,
        ),
    >,
    /// Clips consulted while resolving planned source footprints.
    clips: Query<'w, 's, &'static Clip>,
    /// Change detector for clip source edits.
    clip_change_query: Query<'w, 's, (), Changed<Clip>>,
    /// Optional sequence definitions for sequence-backed lookahead sources.
    sequence_data_provider: Option<Res<'w, DataProvider<Sequence>>>,
    /// Cue definitions used while resolving source footprints.
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    /// Optional classic FX definitions used while resolving source footprints.
    fx_data_provider: Option<Res<'w, DataProvider<Fx>>>,
    /// Fixture definitions and parameter ownership lookups.
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    /// Group definitions used by spatial selection resolution.
    group_data_provider: Res<'w, DataProvider<Group>>,
    /// Spatial selection resolver used for FX-style footprints.
    selection_resolver: SpatialSelectionResolver<'w>,
    /// Parameter components used while materializing cue and sequence footprints.
    parameter_read_query: Query<'w, 's, InstanceRef<'static, Parameter>>,
    /// Runtime step FX components used while resolving source footprints.
    step_fx_query: Query<'w, 's, &'static StepFx>,
    /// Change detector for step FX edits.
    step_fx_change_query: Query<'w, 's, (), Changed<StepFx>>,
}

/// Reconciles provider entities for upcoming sources that may preactivate before timeline starts.
pub fn update_timeline_lookahead_sources_system(
    timeline_query: Query<&MaterializedTimeline>,
    timecode_query: Query<(Entity, &TimecodeGenerator)>,
    clips: Query<&Clip>,
    sequence_data_provider: Option<Res<DataProvider<Sequence>>>,
    cue_data_provider: Res<DataProvider<Cue>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    group_data_provider: Res<DataProvider<Group>>,
    selection_resolver: SpatialSelectionResolver,
    parameter_read_query: Query<InstanceRef<Parameter>>,
    mut provider_query: Query<(Entity, &TimelineLookahead)>,
    mut commands: Commands,
) {
    let timecode_times = timecode_times_by_uid(&timecode_query);
    let mut existing_providers = timeline_lookahead_sources_by_key(&mut provider_query);
    let mut active_provider_keys = HashSet::new();
    let provider_definitions_changed = sequence_data_provider
        .as_ref()
        .is_some_and(|provider| provider.is_changed())
        || cue_data_provider.is_changed()
        || fixture_data_provider.is_changed()
        || group_data_provider.is_changed();

    for timeline in timeline_query.iter() {
        if !timeline_lookahead_statuses_enabled(timeline, &timecode_times) {
            continue;
        }
        let timecode_time = timecode_times
            .get(&timeline.timeline.timecode_uid)
            .copied()
            .unwrap_or_default();
        let timeline_position = timeline_lookahead_position(timeline, timecode_time);

        for source in upcoming_lookahead_sources(timeline, timeline_position, &clips) {
            let key = source.key();
            let existing_provider = existing_providers.remove(&key);

            if let Some((entity, existing_source)) = existing_provider.as_ref()
                && existing_source.source == source.source
                && !provider_definitions_changed
            {
                active_provider_keys.insert(key.clone());
                if existing_source != &source {
                    commands.entity(*entity).insert(source);
                }
                continue;
            }

            let Some((provider, candidates)) = materialize_lookahead_provider_for_source(
                source.source,
                sequence_data_provider.as_deref(),
                &cue_data_provider,
                &fixture_data_provider,
                &selection_resolver,
                &parameter_read_query,
            ) else {
                if let Some((entity, _)) = existing_provider {
                    commands.entity(entity).despawn();
                }
                continue;
            };

            active_provider_keys.insert(key);
            if let Some((entity, existing_source)) = existing_provider {
                let mut entity_commands = commands.entity(entity);
                if existing_source != source {
                    entity_commands.insert(source);
                }
                entity_commands.insert((provider, candidates));
            } else {
                commands.spawn((source, provider, candidates));
            }
        }
    }

    for (key, (entity, _)) in existing_providers {
        if !active_provider_keys.contains(&key) {
            commands.entity(entity).despawn();
        }
    }
}

/// Populates source-owned lookahead assertions on materialized provider entities.
pub fn populate_materialized_lookahead_assertions_system(
    providers: Query<LookaheadProviderData>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    final_layer_output: Res<FinalLayerOutput>,
    parameter_query: Query<InstanceRef<Parameter>>,
    mut commands: Commands,
) {
    let provider_inputs_changed =
        fixture_data_provider.is_changed() || final_layer_output.is_changed();

    for (entity, candidates, current_assertions, current_snapshot) in providers.iter() {
        if !provider_inputs_changed
            && !candidates.is_changed()
            && current_assertions.is_some()
            && current_snapshot.is_some()
        {
            continue;
        }

        let darkness_snapshot = lookahead_fixture_darkness_snapshot_for_candidates(
            &candidates.candidates,
            &fixture_data_provider,
            &final_layer_output,
            &parameter_query,
        );
        let darkness_changed = current_snapshot.as_deref() != Some(&darkness_snapshot);
        if darkness_changed {
            commands.entity(entity).insert(darkness_snapshot.clone());
        }
        if !darkness_changed && !candidates.is_changed() && current_assertions.is_some() {
            continue;
        }

        let assertions =
            lookahead_assertions_for_dark_candidates(&candidates.candidates, &darkness_snapshot);
        if current_assertions.as_deref() != Some(&assertions) {
            commands.entity(entity).insert(assertions);
        }
    }
}

/// Updates timeline-owned lookahead layers from provider-produced assertions.
pub fn update_timeline_lookahead_layers_system(
    inputs: TimelineLookaheadLayerInputs,
    mut layer_query: Query<(
        Entity,
        &TimelineLookaheadLayer,
        Option<&LookaheadAssertionSet>,
    )>,
    mut action_statuses: ResMut<TimelineLookaheadActionStatuses>,
    mut run_state: Local<TimelineLookaheadLayerRunState>,
    mut commands: Commands,
) {
    let timecode_times = timecode_times_by_uid_ref(&inputs.timecode_query);
    let signature = timeline_lookahead_layer_signature(
        &inputs.timeline_query,
        &timecode_times,
        inputs.providers.iter().count(),
        inputs.clips.iter().count(),
        inputs.step_fx_query.iter().count(),
    );
    let provider_changed = inputs
        .providers
        .iter()
        .any(|(source, assertions)| source.is_changed() || assertions.is_changed());
    let timeline_definitions_changed = inputs
        .timeline_data_provider
        .as_ref()
        .is_some_and(|provider| provider.is_changed());
    let clip_changed = inputs.clip_change_query.iter().next().is_some();
    let step_fx_changed = inputs.step_fx_change_query.iter().next().is_some();
    let provider_definitions_changed = inputs
        .sequence_data_provider
        .as_ref()
        .is_some_and(|provider| provider.is_changed())
        || inputs.cue_data_provider.is_changed()
        || inputs
            .fx_data_provider
            .as_ref()
            .is_some_and(|provider| provider.is_changed())
        || inputs.fixture_data_provider.is_changed()
        || inputs.group_data_provider.is_changed();
    let clip_count_changed =
        run_state.initialized && run_state.signature.clip_count != signature.clip_count;
    let step_fx_count_changed =
        run_state.initialized && run_state.signature.step_fx_count != signature.step_fx_count;
    let footprint_cache_invalidated = timeline_definitions_changed
        || clip_changed
        || clip_count_changed
        || step_fx_changed
        || step_fx_count_changed
        || provider_definitions_changed;
    let needs_rebuild = !run_state.initialized
        || run_state.signature != signature
        || timeline_definitions_changed
        || provider_changed
        || clip_changed
        || step_fx_changed
        || provider_definitions_changed;
    if !needs_rebuild {
        return;
    }
    if footprint_cache_invalidated {
        run_state.footprint_cache.clear();
    }

    let mut existing_layers = timeline_lookahead_layers_by_uid(&mut layer_query);
    let mut active_layer_uids = HashSet::new();
    let (assertions_by_timeline, next_action_statuses) = aggregate_provider_assertions_by_timeline(
        &inputs.timeline_query,
        &timecode_times,
        &inputs.providers,
        &inputs.clips,
        inputs.action_registry.as_deref(),
        inputs.sequence_data_provider.as_deref(),
        &inputs.cue_data_provider,
        inputs.fx_data_provider.as_deref(),
        &inputs.fixture_data_provider,
        &inputs.selection_resolver,
        &inputs.parameter_read_query,
        &inputs.step_fx_query,
        &mut run_state.footprint_cache,
    );
    if action_statuses.statuses != next_action_statuses {
        action_statuses.statuses = next_action_statuses;
    }
    run_state.initialized = true;
    run_state.signature = signature;

    for timeline in inputs.timeline_query.iter() {
        let timeline_uid = timeline.timeline.identifiers.uid;
        if !timeline_lookahead_layer_enabled(&timeline, &timecode_times) {
            continue;
        }
        let Some(assertions) = assertions_by_timeline.get(&timeline_uid) else {
            continue;
        };
        if assertions.assertions.is_empty() {
            continue;
        }

        active_layer_uids.insert(timeline_uid);
        let existing_layer = existing_layers.remove(&timeline_uid);
        if let Some((_, existing_assertions)) = &existing_layer {
            if !timeline_definitions_changed && existing_assertions.as_ref() == Some(assertions) {
                continue;
            }
        }

        let mut layer = Layer::new(
            format!("{} Lookahead", timeline.timeline.identifiers.label),
            Priority::default(),
        );
        assertions.apply_to_layer(&mut layer);
        let layer_bundle = (
            TimelineLookaheadLayer { timeline_uid },
            ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Timeline,
                uid: timeline_uid,
            }),
            layer,
            assertions.clone(),
        );
        if let Some((entity, _)) = existing_layer {
            commands.entity(entity).insert(layer_bundle);
        } else {
            commands.spawn(layer_bundle);
        }
    }

    for (timeline_uid, (entity, _)) in existing_layers {
        if !active_layer_uids.contains(&timeline_uid) {
            commands.entity(entity).despawn();
        }
    }
}

/// Builds lookahead candidates for a not-yet-started timeline provider.
fn preactivation_lookahead_candidates_for_timeline_provider(
    provider: &MaterializedLookaheadProvider,
    fixture_data_provider: &FixtureDataProviderExt,
    parameter_query: &Query<InstanceRef<Parameter>>,
) -> MaterializedLookaheadCandidates {
    let candidates = match provider {
        MaterializedLookaheadProvider::Sequence(sequence) => sequence
            .preactivation_lookahead_candidates(
                fixture_data_provider,
                parameter_query,
                InstanceOptions {
                    lookahead_enabled: Some(true),
                },
            ),
    };
    MaterializedLookaheadCandidates { candidates }
}

/// Builds a semantic darkness snapshot for the fixtures referenced by lookahead candidates.
fn lookahead_fixture_darkness_snapshot_for_candidates(
    candidates: &[LookaheadCandidateAssertion],
    fixture_data_provider: &FixtureDataProviderExt,
    final_layer_output: &FinalLayerOutput,
    parameter_query: &Query<InstanceRef<Parameter>>,
) -> LookaheadFixtureDarknessSnapshot {
    let mut fixture_refs = candidates
        .iter()
        .map(|candidate| candidate.fixture_ref.clone())
        .collect::<Vec<_>>();
    fixture_refs.sort_by(compare_fixture_refs);
    fixture_refs.dedup();

    let entries = fixture_refs
        .into_iter()
        .map(|fixture_ref| {
            let (intensity_parameter, is_dark) = lookahead_fixture_darkness(
                &fixture_ref,
                fixture_data_provider,
                final_layer_output,
                parameter_query,
            );
            LookaheadFixtureDarknessEntry {
                fixture_ref,
                intensity_parameter,
                is_dark,
            }
        })
        .collect();
    LookaheadFixtureDarknessSnapshot { entries }
}

/// Compares fixture refs in a stable order for snapshot equality.
fn compare_fixture_refs(left: &FixtureRef, right: &FixtureRef) -> std::cmp::Ordering {
    left.fixture_uid
        .cmp(&right.fixture_uid)
        .then_with(|| left.index.cmp(&right.index))
}

/// Returns the resolved intensity parameter and dark state for one candidate fixture.
fn lookahead_fixture_darkness(
    fixture_ref: &FixtureRef,
    fixture_data_provider: &FixtureDataProviderExt,
    final_layer_output: &FinalLayerOutput,
    parameter_query: &Query<InstanceRef<Parameter>>,
) -> (Option<ParameterRef>, bool) {
    let Some(intensity_parameter) = fixture_data_provider
        .try_parameter_for_logical_attribute(fixture_ref, &Attribute::Intensity)
    else {
        return (None, true);
    };
    let parameter = ParameterRef::from(intensity_parameter.instance);
    let Ok(parameter_ref) = parameter_query.get(parameter.entity()) else {
        return (Some(parameter), false);
    };

    let output_value = if final_layer_output.0.absolute.contains_key(parameter)
        || final_layer_output.0.relative.contains_key(parameter)
    {
        final_layer_output.0.get_effective_value(parameter)
    } else {
        parameter_ref.get_default_value()
    };
    (Some(parameter), output_value <= 0.0)
}

/// Filters precomputed candidates through a previously computed darkness snapshot.
fn lookahead_assertions_for_dark_candidates(
    candidates: &[LookaheadCandidateAssertion],
    snapshot: &LookaheadFixtureDarknessSnapshot,
) -> LookaheadAssertionSet {
    let mut assertions = LookaheadAssertionSet::default();
    for candidate in candidates {
        let is_dark = snapshot
            .entries
            .iter()
            .any(|entry| entry.fixture_ref == candidate.fixture_ref && entry.is_dark);
        if !is_dark {
            continue;
        }
        assertions.assertions.push(LookaheadAssertion {
            parameter: candidate.parameter,
            value: candidate.value,
            reason: LookaheadReason::Lookahead,
        });
    }
    assertions
}

impl Lookahead for MaterializedLookaheadProvider {
    fn lookahead_assertions(
        &self,
        rendered_layer: Option<&Layer>,
        fixture_data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
    ) -> LookaheadAssertionSet {
        match self {
            MaterializedLookaheadProvider::Sequence(sequence) => sequence.lookahead_assertions(
                rendered_layer,
                fixture_data_provider,
                parameter_query,
                instance_options,
            ),
        }
    }
}

impl PlaybackFootprint for MaterializedLookaheadProvider {
    fn playback_footprint(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
    ) -> FixtureFootprint {
        match self {
            MaterializedLookaheadProvider::Sequence(sequence) => {
                sequence.playback_footprint(fixture_data_provider)
            }
        }
    }
}

/// Returns the fixture footprint a planned playback source may assert.
fn planned_source_playback_footprint(
    source: PlannedPlaybackSource,
    context: &FixtureFootprintContext<'_>,
    step_fx_query: &Query<&StepFx>,
    parameter_read_query: &Query<InstanceRef<Parameter>>,
    footprint_cache: &mut TimelineLookaheadFootprintCache,
) -> FixtureFootprint {
    if let Some(footprint) = footprint_cache.source_footprints.get(&source) {
        return footprint.clone();
    }

    let footprint = match source {
        PlannedPlaybackSource::Cue(cue_uid) => context
            .cue_data_provider
            .get(cue_uid)
            .ok()
            .map(|cue| {
                let mcue = MaterializedCue::materialize(
                    &cue,
                    context.fixture_data_provider,
                    parameter_read_query,
                    context.selection_resolver,
                );
                FixtureFootprint::Known(layer_asserted_fixture_uids(
                    &mcue.values,
                    context.fixture_data_provider,
                ))
            })
            .unwrap_or(FixtureFootprint::Unknown),
        PlannedPlaybackSource::Sequence(sequence_uid) => {
            let Some(sequence_data_provider) = context.sequence_data_provider else {
                return FixtureFootprint::Unknown;
            };
            sequence_data_provider
                .get(sequence_uid)
                .ok()
                .map(|sequence| {
                    let mut fixtures = HashSet::new();
                    for cue_uid in &sequence.steps {
                        let cue_uid: Uuid = (*cue_uid).into();
                        match planned_source_playback_footprint(
                            PlannedPlaybackSource::Cue(cue_uid),
                            context,
                            step_fx_query,
                            parameter_read_query,
                            footprint_cache,
                        ) {
                            FixtureFootprint::Known(cue_fixtures) => {
                                fixtures.extend(cue_fixtures);
                            }
                            FixtureFootprint::Unknown => return FixtureFootprint::Unknown,
                        }
                    }
                    FixtureFootprint::Known(fixtures)
                })
                .unwrap_or(FixtureFootprint::Unknown)
        }
        PlannedPlaybackSource::Fx(fx_uid) => context
            .fx_data_provider
            .and_then(|provider| provider.get(fx_uid).ok())
            .map(|fx| selection_fixture_footprint(&fx.selection, context))
            .unwrap_or(FixtureFootprint::Unknown),
        PlannedPlaybackSource::StepFx(step_fx_uid) => step_fx_query
            .iter()
            .find(|step_fx| step_fx.identifiers.uid == step_fx_uid)
            .map(|step_fx| selection_fixture_footprint(&step_fx.selection, context))
            .unwrap_or(FixtureFootprint::Unknown),
        PlannedPlaybackSource::FxModule(_) => FixtureFootprint::Unknown,
        PlannedPlaybackSource::Flow(_) => FixtureFootprint::Unknown,
    };
    footprint_cache
        .source_footprints
        .insert(source, footprint.clone());
    footprint
}

/// Returns the fixture footprint an authored timeline action may assert.
fn timeline_action_playback_footprint(
    timeline_action: &Action,
    context: &FixtureFootprintContext<'_>,
    clips: &Query<&Clip>,
    action_registry: Option<&ActionRegistry>,
    step_fx_query: &Query<&StepFx>,
    parameter_read_query: &Query<InstanceRef<Parameter>>,
    footprint_cache: &mut TimelineLookaheadFootprintCache,
) -> FixtureFootprint {
    match timeline_action.action {
        ActionKind::FireCue(cue_uid) => planned_source_playback_footprint(
            PlannedPlaybackSource::Cue(cue_uid),
            context,
            step_fx_query,
            parameter_read_query,
            footprint_cache,
        ),
        ActionKind::StartClip(clip_uid)
        | ActionKind::AdvanceSequence(clip_uid)
        | ActionKind::BackSequence(clip_uid) => {
            cached_planned_source_for_clip_uid(clip_uid, clips, footprint_cache)
                .map(|source| {
                    planned_source_playback_footprint(
                        source,
                        context,
                        step_fx_query,
                        parameter_read_query,
                        footprint_cache,
                    )
                })
                .unwrap_or(FixtureFootprint::Unknown)
        }
        ActionKind::StopClip(_) | ActionKind::SetClipRate { .. } => FixtureFootprint::empty(),
        ActionKind::JumpToCue { uid, .. } => {
            cached_planned_source_for_clip_uid(uid, clips, footprint_cache)
                .map(|source| {
                    planned_source_playback_footprint(
                        source,
                        context,
                        step_fx_query,
                        parameter_read_query,
                        footprint_cache,
                    )
                })
                .unwrap_or(FixtureFootprint::Unknown)
        }
        ActionKind::DeskEval(_) => FixtureFootprint::Unknown,
        ActionKind::RegisteredAction(_) => {
            normalized_registered_action_kind(&timeline_action.action, action_registry)
                .map(|action_kind| Action {
                    action: action_kind,
                    ..timeline_action.clone()
                })
                .map(|normalized_action| {
                    timeline_action_playback_footprint(
                        &normalized_action,
                        context,
                        clips,
                        action_registry,
                        step_fx_query,
                        parameter_read_query,
                        footprint_cache,
                    )
                })
                .unwrap_or(FixtureFootprint::Unknown)
        }
    }
}

impl TimelineLookahead {
    /// Builds a stable reconciliation key for this source request.
    fn key(&self) -> TimelineLookaheadKey {
        TimelineLookaheadKey {
            timeline_uid: self.timeline_uid,
            track_id: self.track_id.clone(),
            action_id: self.action_id.clone(),
        }
    }
}

/// Returns current timecode positions keyed by timecode UID.
fn timecode_times_by_uid(
    timecode_query: &Query<(Entity, &TimecodeGenerator)>,
) -> HashMap<Uuid, Duration> {
    timecode_query
        .iter()
        .map(|(_, timecode)| {
            (
                timecode.timecode.identifiers.uid,
                timecode.state.current_time,
            )
        })
        .collect()
}

/// Returns current timecode positions keyed by timecode UID from change-aware query refs.
fn timecode_times_by_uid_ref(
    timecode_query: &Query<(Entity, Ref<TimecodeGenerator>)>,
) -> HashMap<Uuid, Duration> {
    timecode_query
        .iter()
        .map(|(_, timecode)| {
            (
                timecode.timecode.identifiers.uid,
                timecode.state.current_time,
            )
        })
        .collect()
}

/// Builds a cheap signature for timeline lookahead aggregation inputs.
fn timeline_lookahead_layer_signature(
    timeline_query: &Query<Ref<MaterializedTimeline>>,
    timecode_times: &HashMap<Uuid, Duration>,
    provider_count: usize,
    clip_count: usize,
    step_fx_count: usize,
) -> TimelineLookaheadLayerSignature {
    let mut timelines = timeline_query
        .iter()
        .map(|timeline| {
            let timecode_time = timecode_times
                .get(&timeline.timeline.timecode_uid)
                .copied()
                .unwrap_or_default();
            let timeline_position = timeline_lookahead_position(&timeline, timecode_time);
            TimelineLookaheadTimelineSignature {
                timeline_uid: timeline.timeline.identifiers.uid,
                statuses_enabled: timeline_lookahead_statuses_enabled(&timeline, timecode_times),
                layer_enabled: timeline_lookahead_layer_enabled(&timeline, timecode_times),
                elapsed_action_count: elapsed_timeline_action_count(&timeline, timeline_position),
            }
        })
        .collect::<Vec<_>>();
    timelines.sort_by_key(|timeline| timeline.timeline_uid);
    TimelineLookaheadLayerSignature {
        timelines,
        provider_count,
        clip_count,
        step_fx_count,
    }
}

/// Counts authored timeline actions at or before the current timeline-local position.
fn elapsed_timeline_action_count(
    timeline: &MaterializedTimeline,
    timeline_position: Duration,
) -> usize {
    timeline
        .timeline
        .tracks
        .iter()
        .flat_map(|track| &track.actions)
        .filter(|action| action.position <= timeline_position)
        .count()
}

/// Returns whether a timeline currently requests lookahead status evaluation.
fn timeline_lookahead_statuses_enabled(
    timeline: &MaterializedTimeline,
    timecode_times: &HashMap<Uuid, Duration>,
) -> bool {
    timeline.timeline.lookahead == TimelineLookaheadMode::Enabled
        && timecode_times.contains_key(&timeline.timeline.timecode_uid)
}

/// Returns whether a timeline should materialize an active lookahead layer.
fn timeline_lookahead_layer_enabled(
    timeline: &MaterializedTimeline,
    timecode_times: &HashMap<Uuid, Duration>,
) -> bool {
    timeline.is_active && timeline_lookahead_statuses_enabled(timeline, timecode_times)
}

/// Returns the timeline-local position used when evaluating lookahead badges.
fn timeline_lookahead_position(
    timeline: &MaterializedTimeline,
    timecode_time: Duration,
) -> Duration {
    if timeline.is_active {
        timecode_time.saturating_sub(timeline.timeline.timecode_start)
    } else {
        Duration::ZERO
    }
}

/// Returns existing source provider entities keyed by their timeline action owner.
fn timeline_lookahead_sources_by_key(
    provider_query: &mut Query<(Entity, &TimelineLookahead)>,
) -> HashMap<TimelineLookaheadKey, (Entity, TimelineLookahead)> {
    provider_query
        .iter_mut()
        .map(|(entity, source)| (source.key(), (entity, source.clone())))
        .collect()
}

/// Returns existing timeline lookahead layer entities keyed by timeline UID.
fn timeline_lookahead_layers_by_uid(
    layer_query: &mut Query<(
        Entity,
        &TimelineLookaheadLayer,
        Option<&LookaheadAssertionSet>,
    )>,
) -> HashMap<Uuid, (Entity, Option<LookaheadAssertionSet>)> {
    layer_query
        .iter_mut()
        .map(|(entity, marker, assertions)| (marker.timeline_uid, (entity, assertions.cloned())))
        .collect()
}

/// Materializes a provider component for a supported planned source.
fn materialize_lookahead_provider_for_source(
    source: PlannedPlaybackSource,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    cue_data_provider: &Res<DataProvider<Cue>>,
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    selection_resolver: &SpatialSelectionResolver,
    parameter_read_query: &Query<InstanceRef<Parameter>>,
) -> Option<(
    MaterializedLookaheadProvider,
    MaterializedLookaheadCandidates,
)> {
    match source {
        PlannedPlaybackSource::Sequence(sequence_uid) => {
            let sequence = sequence_data_provider?.get(sequence_uid).ok()?;
            let materialized_sequence = MaterializedSequence::materialize(
                &sequence,
                cue_data_provider,
                fixture_data_provider,
                parameter_read_query,
                selection_resolver,
            );
            let provider = MaterializedLookaheadProvider::Sequence(materialized_sequence);
            let candidates = preactivation_lookahead_candidates_for_timeline_provider(
                &provider,
                fixture_data_provider,
                parameter_read_query,
            );
            Some((provider, candidates))
        }
        PlannedPlaybackSource::Cue(_)
        | PlannedPlaybackSource::Fx(_)
        | PlannedPlaybackSource::StepFx(_)
        | PlannedPlaybackSource::FxModule(_)
        | PlannedPlaybackSource::Flow(_) => None,
    }
}

/// Collects upcoming timeline sources that can be reconciled into provider entities.
fn upcoming_lookahead_sources(
    timeline: &MaterializedTimeline,
    timeline_position: Duration,
    clips: &Query<&Clip>,
) -> Vec<TimelineLookahead> {
    let solo_mode = timeline.timeline.tracks.iter().any(|track| track.solo);
    let mut sources = Vec::new();

    for track in &timeline.timeline.tracks {
        if track.muted || (solo_mode && !track.solo) {
            continue;
        }
        for action in &track.actions {
            if action.position <= timeline_position {
                continue;
            }
            let ActionKind::StartClip(clip_uid) = action.action else {
                continue;
            };
            let Some(source) = planned_source_for_clip_uid(clip_uid, clips) else {
                continue;
            };
            sources.push((
                action.position,
                TimelineLookahead {
                    timeline_uid: timeline.timeline.identifiers.uid,
                    track_id: track.id.clone(),
                    action_id: action.id.clone(),
                    source,
                    starts_at_timeline: action.position,
                },
            ));
        }
    }

    sources.sort_by_key(|(position, _)| *position);
    sources.into_iter().map(|(_, source)| source).collect()
}

/// Resolves a planned playback source for a clip UID.
fn planned_source_for_clip_uid(
    clip_uid: Uuid,
    clips: &Query<&Clip>,
) -> Option<PlannedPlaybackSource> {
    clips
        .iter()
        .find(|clip| clip.identifiers.uid == clip_uid)
        .and_then(planned_source_for_clip)
}

/// Resolves a planned playback source for a clip UID with per-aggregation caching.
fn cached_planned_source_for_clip_uid(
    clip_uid: Uuid,
    clips: &Query<&Clip>,
    footprint_cache: &mut TimelineLookaheadFootprintCache,
) -> Option<PlannedPlaybackSource> {
    *footprint_cache
        .clip_sources
        .entry(clip_uid)
        .or_insert_with(|| planned_source_for_clip_uid(clip_uid, clips))
}

/// Aggregates provider-owned lookahead assertions by owning timeline.
fn aggregate_provider_assertions_by_timeline(
    timelines: &Query<Ref<MaterializedTimeline>>,
    timecode_times: &HashMap<Uuid, Duration>,
    providers: &Query<(Ref<TimelineLookahead>, Ref<LookaheadAssertionSet>)>,
    clips: &Query<&Clip>,
    action_registry: Option<&ActionRegistry>,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    cue_data_provider: &DataProvider<Cue>,
    fx_data_provider: Option<&DataProvider<Fx>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    parameter_read_query: &Query<InstanceRef<Parameter>>,
    step_fx_query: &Query<&StepFx>,
    footprint_cache: &mut TimelineLookaheadFootprintCache,
) -> (
    HashMap<Uuid, LookaheadAssertionSet>,
    Vec<TimelineLookaheadActionStatus>,
) {
    let mut assertions_by_timeline: HashMap<Uuid, LookaheadAssertionSet> = HashMap::new();
    let mut inserted_parameters_by_timeline: HashMap<Uuid, HashSet<Instance<Parameter>>> =
        HashMap::new();
    let timelines_by_uid = timelines
        .iter()
        .map(|timeline| (timeline.timeline.identifiers.uid, timeline))
        .collect::<HashMap<_, _>>();
    let mut next_action_statuses = Vec::new();

    let mut provider_assertions = providers.iter().collect::<Vec<_>>();
    provider_assertions.sort_by_key(|(source, _)| source.starts_at_timeline);

    for (source, assertions) in provider_assertions {
        if assertions.assertions.is_empty() {
            continue;
        }

        let Some(timeline) = timelines_by_uid.get(&source.timeline_uid) else {
            continue;
        };
        let timecode_time = timecode_times
            .get(&timeline.timeline.timecode_uid)
            .copied()
            .unwrap_or_default();
        let timeline_position = timeline_lookahead_position(timeline, timecode_time);
        let blocking_actions = timeline_source_assertion_blockers(
            timeline,
            timeline_position,
            &source,
            &assertions,
            clips,
            action_registry,
            sequence_data_provider,
            cue_data_provider,
            fx_data_provider,
            fixture_data_provider,
            selection_resolver,
            parameter_read_query,
            step_fx_query,
            footprint_cache,
        );
        if !blocking_actions.is_empty() {
            next_action_statuses.push(TimelineLookaheadActionStatus {
                timeline_uid: source.timeline_uid,
                track_id: source.track_id.clone(),
                action_id: source.action_id.clone(),
                kind: TimelineLookaheadActionStatusKind::BlockedByInterveningFixtureAssertions,
                blocking_actions,
            });
            continue;
        }

        let layer_enabled = timeline_lookahead_layer_enabled(timeline, timecode_times);
        let inserted_parameters = inserted_parameters_by_timeline
            .entry(source.timeline_uid)
            .or_default();
        let timeline_assertions = assertions_by_timeline
            .entry(source.timeline_uid)
            .or_default();
        let mut asserted = false;
        if layer_enabled {
            for assertion in &assertions.assertions {
                if inserted_parameters.insert(assertion.parameter) {
                    timeline_assertions.assertions.push(*assertion);
                    asserted = true;
                }
            }
        }
        let kind = if asserted {
            TimelineLookaheadActionStatusKind::Asserted
        } else {
            TimelineLookaheadActionStatusKind::Ready
        };
        next_action_statuses.push(TimelineLookaheadActionStatus {
            timeline_uid: source.timeline_uid,
            track_id: source.track_id.clone(),
            action_id: source.action_id.clone(),
            kind,
            blocking_actions,
        });
    }

    next_action_statuses.sort_by(|left, right| {
        (left.timeline_uid, &left.track_id, &left.action_id).cmp(&(
            right.timeline_uid,
            &right.track_id,
            &right.action_id,
        ))
    });
    (assertions_by_timeline, next_action_statuses)
}

/// Returns intervening actions whose fixture footprint conflicts with a future source.
fn timeline_source_assertion_blockers(
    timeline: &MaterializedTimeline,
    timeline_position: Duration,
    source: &TimelineLookahead,
    assertions: &LookaheadAssertionSet,
    clips: &Query<&Clip>,
    action_registry: Option<&ActionRegistry>,
    sequence_data_provider: Option<&DataProvider<Sequence>>,
    cue_data_provider: &DataProvider<Cue>,
    fx_data_provider: Option<&DataProvider<Fx>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    parameter_read_query: &Query<InstanceRef<Parameter>>,
    step_fx_query: &Query<&StepFx>,
    footprint_cache: &mut TimelineLookaheadFootprintCache,
) -> Vec<TimelineLookaheadActionBlocker> {
    let assertion_fixture_footprint =
        assertion_fixture_footprint(assertions, fixture_data_provider);
    if assertion_fixture_footprint.is_empty() {
        return Vec::new();
    }
    let assertion_fixture_uids = match assertion_fixture_footprint {
        FixtureFootprint::Known(assertion_fixture_uids) => assertion_fixture_uids,
        FixtureFootprint::Unknown => {
            return timeline_intervening_action_blockers(timeline, timeline_position, source);
        }
    };
    let context = FixtureFootprintContext {
        sequence_data_provider,
        cue_data_provider,
        fx_data_provider,
        fixture_data_provider,
        selection_resolver,
    };

    let solo_mode = timeline.timeline.tracks.iter().any(|track| track.solo);
    let mut blockers = Vec::new();
    for track in &timeline.timeline.tracks {
        if track.muted || (solo_mode && !track.solo) {
            continue;
        }
        for action in &track.actions {
            if action.position <= timeline_position || action.position >= source.starts_at_timeline
            {
                continue;
            }
            let key = TimelineLookaheadKey {
                timeline_uid: timeline.timeline.identifiers.uid,
                track_id: track.id.clone(),
                action_id: action.id.clone(),
            };
            let footprint = if let Some(footprint) = footprint_cache.action_footprints.get(&key) {
                footprint.clone()
            } else {
                let footprint = timeline_action_playback_footprint(
                    action,
                    &context,
                    clips,
                    action_registry,
                    step_fx_query,
                    parameter_read_query,
                    footprint_cache,
                );
                footprint_cache
                    .action_footprints
                    .insert(key, footprint.clone());
                footprint
            };
            if footprint.blocks(&assertion_fixture_uids) {
                blockers.push(TimelineLookaheadActionBlocker {
                    track_id: track.id.clone(),
                    action_id: action.id.clone(),
                });
                if blockers.len() >= MAX_TIMELINE_LOOKAHEAD_STATUS_BLOCKERS {
                    return blockers;
                }
            }
        }
    }

    blockers
}

/// Returns every active intervening action when a source's assertion footprint is unknown.
fn timeline_intervening_action_blockers(
    timeline: &MaterializedTimeline,
    timeline_position: Duration,
    source: &TimelineLookahead,
) -> Vec<TimelineLookaheadActionBlocker> {
    let solo_mode = timeline.timeline.tracks.iter().any(|track| track.solo);
    let mut blockers = Vec::new();
    for track in &timeline.timeline.tracks {
        if track.muted || (solo_mode && !track.solo) {
            continue;
        }
        for action in &track.actions {
            if action.position <= timeline_position || action.position >= source.starts_at_timeline
            {
                continue;
            }
            blockers.push(TimelineLookaheadActionBlocker {
                track_id: track.id.clone(),
                action_id: action.id.clone(),
            });
            if blockers.len() >= MAX_TIMELINE_LOOKAHEAD_STATUS_BLOCKERS {
                return blockers;
            }
        }
    }
    blockers
}

/// Returns the fixture footprint targeted by concrete lookahead assertions.
fn assertion_fixture_footprint(
    assertions: &LookaheadAssertionSet,
    fixture_data_provider: &FixtureDataProviderExt,
) -> FixtureFootprint {
    FixtureFootprint::Known(
        assertions
            .assertions
            .iter()
            .filter_map(|assertion| {
                fixture_data_provider
                    .try_fixture_ref_for_parameter(&assertion.parameter)
                    .map(|fixture_ref| fixture_ref.fixture_uid)
            })
            .collect(),
    )
}

/// Returns the fixture footprint for a resolved spatial selection.
fn selection_fixture_footprint(
    selection: &SpatialSelection,
    context: &FixtureFootprintContext<'_>,
) -> FixtureFootprint {
    let resolved_selection = context.selection_resolver.resolve(selection).into_value();
    let filtered_selection =
        filter_existing_selection(&resolved_selection, context.fixture_data_provider);
    FixtureFootprint::Known(
        filtered_selection
            .canonical_fixtures()
            .iter()
            .map(|fixture_ref| fixture_ref.fixture_uid)
            .collect(),
    )
}

/// Collects fixture UIDs for parameters asserted by a materialized layer.
fn layer_asserted_fixture_uids(
    layer: &Layer,
    fixture_data_provider: &FixtureDataProviderExt,
) -> HashSet<Uuid> {
    layer
        .absolute
        .keys()
        .chain(layer.relative.keys())
        .filter_map(|parameter| {
            fixture_data_provider
                .try_fixture_ref_for_parameter(&parameter_instance(parameter))
                .map(|fixture_ref| fixture_ref.fixture_uid)
        })
        .collect()
}

/// Converts an erased compositor parameter reference for fixture data-provider lookup.
fn parameter_instance(parameter: ParameterRef) -> Instance<Parameter> {
    // SAFETY: This helper only creates a key for a fallible fixture data-provider lookup.
    // Missing or non-parameter entities are handled by the caller receiving `None`.
    unsafe { Instance::from_entity_unchecked(parameter.entity()) }
}
