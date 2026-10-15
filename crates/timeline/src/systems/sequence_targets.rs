// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resolves which sequence cue each timeline navigation action lands on.

use nightfall_cues::prelude::{SequenceTimelineStepTiming, stored_sequence_step_timings};
use nightfall_cues::websocket::{CueDefinitionChange, SequenceDefinitionChange};

use super::pause_sync::timeline_planning_actions;
use super::planner_adapter::{
    TimelinePlannerResolver, planned_source_for_clip, playback_duration_profile_for_source,
};
use super::*;
use crate::prelude::{TimelineSequenceActionTarget, TimelineSequenceActionTargets};

/// Definitions consulted while replaying timelines to resolve navigation action targets.
#[derive(SystemParam)]
pub struct TimelineSequenceActionTargetInputs<'w, 's> {
    /// Registered deterministic action capabilities consulted for authored actions.
    action_registry: Option<Res<'w, ActionRegistry>>,
    /// Authored timeline definitions whose navigation actions are resolved.
    timeline_data_provider: Res<'w, DataProvider<crate::prelude::Timeline>>,
    /// Clips that map navigation actions to their sequences.
    clips: Query<'w, 's, &'static Clip>,
    /// Change detector for clip source edits.
    clip_change_query: Query<'w, 's, (), Changed<Clip>>,
    /// Optional sequence definitions replayed for navigation actions.
    sequence_data_provider: Option<Res<'w, DataProvider<Sequence>>>,
    /// Cue definitions whose timing drives autonomous sequence advances.
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    /// Fixture data used to resolve cue durations.
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    /// Group definitions that spatial selection resolution reads for cue durations.
    group_data_provider: Res<'w, DataProvider<Group>>,
    /// Spatial resolver used to resolve cue durations.
    selection_resolver: SpatialSelectionResolver<'w>,
}

/// Change notifications that say which cue and sequence definitions were edited.
#[derive(SystemParam)]
pub struct TimelineSequenceDefinitionChanges<'w, 's> {
    /// Committed cue definition edits.
    cues: MessageReader<'w, 's, CueDefinitionChange>,
    /// Committed sequence definition edits.
    sequences: MessageReader<'w, 's, SequenceDefinitionChange>,
    /// Clips despawned since the last run.
    removed_clips: RemovedComponents<'w, 's, Clip>,
}

/// Replay inputs resolved for one sequence, reused across recomputes until its cues change.
struct ResolvedSequenceTiming {
    /// Whether the sequence wraps from its last step back to the first.
    wrap: bool,
    /// Cue UIDs in step order.
    steps: Vec<Uuid>,
    /// Seek replay timing of each step, or `None` when a step cue is missing.
    step_timings: Option<Vec<SequenceTimelineStepTiming>>,
    /// Planner extents of the whole sequence.
    duration_profile: PlaybackDurationProfile,
}

/// Per-system cache of resolved sequence timings and the sequences last navigated.
#[derive(Default)]
pub struct TimelineSequenceActionTargetCache {
    /// Whether targets were computed at least once.
    initialized: bool,
    /// Resolved timing per sequence UID.
    sequences: HashMap<Uuid, ResolvedSequenceTiming>,
    /// Sequences played by clips that a Go, Back, or jump action steered on the last recompute.
    navigated_sequences: HashSet<Uuid>,
}

impl TimelineSequenceActionTargetCache {
    /// Drops cached timing for the given sequences and any cached sequence containing the
    /// given cues, returning whether a navigated sequence was affected.
    fn invalidate(&mut self, sequence_uids: &[Uuid], cue_uids: &[Uuid]) -> bool {
        let stale = self
            .sequences
            .iter()
            .filter(|(sequence_uid, timing)| {
                sequence_uids.contains(sequence_uid)
                    || timing
                        .steps
                        .iter()
                        .any(|cue_uid| cue_uids.contains(cue_uid))
            })
            .map(|(sequence_uid, _)| *sequence_uid)
            .collect::<Vec<_>>();
        for sequence_uid in &stale {
            self.sequences.remove(sequence_uid);
        }
        sequence_uids
            .iter()
            .chain(&stale)
            .any(|sequence_uid| self.navigated_sequences.contains(sequence_uid))
    }
}

/// Recomputes the cue every Go, Back, and jump timeline action leaves its sequence on.
///
/// Timeline and clip edits always recompute. Cue and sequence edits only recompute when they
/// touch a sequence a navigation action steers, and resolved sequence timings are cached so a
/// sequence restarted many times on a timeline is resolved once. Fixture and group edits, and
/// bulk replacements such as a showfile load, drop the cache. Published targets are only
/// replaced when the result differs so clients are not re-sent identical data.
pub fn update_timeline_sequence_action_targets_system(
    inputs: TimelineSequenceActionTargetInputs,
    mut changes: TimelineSequenceDefinitionChanges,
    mut targets: ResMut<TimelineSequenceActionTargets>,
    mut cache: Local<TimelineSequenceActionTargetCache>,
) {
    let changed_cues = changes
        .cues
        .read()
        .map(|change| match change {
            CueDefinitionChange::Updated(cue) => cue.identifiers.uid,
            CueDefinitionChange::Removed { uid } => *uid,
        })
        .collect::<Vec<_>>();
    let changed_sequences = changes
        .sequences
        .read()
        .map(|change| match change {
            SequenceDefinitionChange::Updated(sequence) => sequence.identifiers.uid,
            SequenceDefinitionChange::Removed { uid } => *uid,
        })
        .collect::<Vec<_>>();
    let clips_removed = changes.removed_clips.read().count() > 0;

    let sequences_changed = inputs
        .sequence_data_provider
        .as_ref()
        .is_some_and(|provider| provider.is_changed());
    let bulk_definition_change = (inputs.cue_data_provider.is_changed() && changed_cues.is_empty())
        || (sequences_changed && changed_sequences.is_empty());
    let timing_inputs_changed = inputs.fixture_data_provider.is_changed()
        || inputs.group_data_provider.is_changed()
        || bulk_definition_change;
    if timing_inputs_changed {
        cache.sequences.clear();
    }
    let navigated_definition_changed = cache.invalidate(&changed_sequences, &changed_cues);
    let structure_changed = !cache.initialized
        || inputs.timeline_data_provider.is_changed()
        || inputs.clip_change_query.iter().next().is_some()
        || clips_removed;
    if !structure_changed && !timing_inputs_changed && !navigated_definition_changed {
        return;
    }
    cache.initialized = true;

    targets.set_if_neq(TimelineSequenceActionTargets {
        targets: resolve_timeline_sequence_action_targets(&inputs, &mut cache),
    });
}

/// Returns the clip a navigation action steers, or `None` for any other action.
fn navigation_clip_uid(action: &ActionKind) -> Option<Uuid> {
    match action {
        ActionKind::AdvanceSequence(uid)
        | ActionKind::BackSequence(uid)
        | ActionKind::JumpToCue { uid, .. } => Some(*uid),
        _ => None,
    }
}

/// Returns the cached replay inputs for a sequence, resolving and caching them when missing.
fn resolved_sequence_timing<'a>(
    cache: &'a mut HashMap<Uuid, ResolvedSequenceTiming>,
    sequence_uid: Uuid,
    sequence_data_provider: &DataProvider<Sequence>,
    inputs: &TimelineSequenceActionTargetInputs,
) -> Option<&'a ResolvedSequenceTiming> {
    if !cache.contains_key(&sequence_uid) {
        let sequence = sequence_data_provider.get(sequence_uid).ok()?;
        let timing = ResolvedSequenceTiming {
            wrap: sequence.wrap,
            steps: sequence.steps.iter().map(|cue_uid| cue_uid.0).collect(),
            step_timings: stored_sequence_step_timings(
                &sequence,
                &inputs.cue_data_provider,
                &inputs.fixture_data_provider,
                &inputs.selection_resolver,
            ),
            duration_profile: playback_duration_profile_for_source(
                PlannedPlaybackSource::Sequence(sequence_uid),
                &inputs.cue_data_provider,
                Some(sequence_data_provider),
                &inputs.fixture_data_provider,
                &inputs.selection_resolver,
            ),
        };
        cache.insert(sequence_uid, timing);
    }
    cache.get(&sequence_uid)
}

/// Replays every timeline definition and collects its navigation action targets.
fn resolve_timeline_sequence_action_targets(
    inputs: &TimelineSequenceActionTargetInputs,
    cache: &mut TimelineSequenceActionTargetCache,
) -> Vec<TimelineSequenceActionTarget> {
    cache.navigated_sequences.clear();
    let Some(sequence_data_provider) = inputs.sequence_data_provider.as_deref() else {
        return Vec::new();
    };
    let timelines = inputs
        .timeline_data_provider
        .iter()
        .filter_map(|timeline| {
            let planning_actions =
                timeline_planning_actions(timeline.value(), inputs.action_registry.as_deref())
                    .collect::<Vec<_>>();
            planning_actions
                .iter()
                .any(|action| navigation_clip_uid(&action.action).is_some())
                .then(|| (timeline.value().identifiers.uid, planning_actions))
        })
        .collect::<Vec<_>>();
    if timelines.is_empty() {
        return Vec::new();
    }

    let source_by_clip_uid = inputs
        .clips
        .iter()
        .filter_map(|clip| {
            planned_source_for_clip(clip).map(|source| (clip.identifiers.uid, source))
        })
        .collect::<HashMap<_, _>>();
    cache.navigated_sequences = timelines
        .iter()
        .flat_map(|(_, actions)| actions.iter())
        .filter_map(|action| navigation_clip_uid(&action.action))
        .filter_map(|clip_uid| match source_by_clip_uid.get(&clip_uid) {
            Some(PlannedPlaybackSource::Sequence(sequence_uid)) => Some(*sequence_uid),
            _ => None,
        })
        .collect();
    let navigated_sequences = &cache.navigated_sequences;
    cache
        .sequences
        .retain(|sequence_uid, _| navigated_sequences.contains(sequence_uid));
    let mut duration_by_source = HashMap::new();
    for sequence_uid in cache.navigated_sequences.clone() {
        if let Some(timing) = resolved_sequence_timing(
            &mut cache.sequences,
            sequence_uid,
            sequence_data_provider,
            inputs,
        ) {
            duration_by_source.insert(
                PlannedPlaybackSource::Sequence(sequence_uid),
                timing.duration_profile,
            );
        }
    }
    let resolver = TimelinePlannerResolver {
        source_by_clip_uid,
        duration_by_source,
    };

    let mut targets = timelines
        .into_iter()
        .flat_map(|(timeline_uid, planning_actions)| {
            timeline_sequence_action_targets(
                timeline_uid,
                planning_actions,
                &cache.sequences,
                &resolver,
            )
        })
        .collect::<Vec<_>>();
    targets.sort_by(|left, right| {
        (left.timeline_uid, &left.track_id, &left.action_id).cmp(&(
            right.timeline_uid,
            &right.track_id,
            &right.action_id,
        ))
    });
    targets
}

/// Replays one timeline's audible actions in position order to resolve its navigation targets.
///
/// Uses the same planner and sequence replay as seeking, so autonomous follow and wait cues
/// between actions advance the sequence exactly as playback would.
fn timeline_sequence_action_targets(
    timeline_uid: Uuid,
    planning_actions: Vec<TimelinePlanningAction>,
    sequences: &HashMap<Uuid, ResolvedSequenceTiming>,
    resolver: &TimelinePlannerResolver,
) -> Vec<TimelineSequenceActionTarget> {
    let end = planning_actions
        .iter()
        .map(|action| action.position)
        .max()
        .unwrap_or_default();
    let plan = plan_timeline_at(timeline_uid, end, planning_actions, resolver);

    let mut targets = Vec::new();
    for interval in &plan.instances {
        let PlannedPlaybackSource::Sequence(sequence_uid) = interval.source else {
            continue;
        };
        if interval.explicit_interventions.is_empty() {
            continue;
        }
        let Some(timing) = sequences.get(&sequence_uid) else {
            continue;
        };
        let Some(step_timings) = timing.step_timings.clone() else {
            continue;
        };
        let Some(mut playback) = SequenceTimelineSeekPlayback::from_step_timings(
            0,
            timing.wrap,
            interval.started_at_timeline,
            step_timings,
        ) else {
            continue;
        };
        playback.replay_planned_interventions_until(interval, end, |intervention, position| {
            if intervention.kind == PlannedPlaybackInterventionKind::Stop {
                return;
            }
            let cue_uid = position
                .checked_sub(1)
                .and_then(|index| timing.steps.get(index as usize))
                .copied();
            targets.push(TimelineSequenceActionTarget {
                timeline_uid,
                track_id: intervention.owner.track_id.clone(),
                action_id: intervention.owner.action_id.clone(),
                sequence_uid,
                cue_uid,
            });
        });
    }
    targets
}
