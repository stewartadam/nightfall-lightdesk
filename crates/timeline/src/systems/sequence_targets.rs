// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resolves which sequence cue each timeline navigation action lands on.

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

impl TimelineSequenceActionTargetInputs<'_, '_> {
    /// Returns whether any definition that can move a navigation target changed this frame.
    fn changed(&self) -> bool {
        self.timeline_data_provider.is_changed()
            || self.clip_change_query.iter().next().is_some()
            || self
                .sequence_data_provider
                .as_ref()
                .is_some_and(|provider| provider.is_changed())
            || self.cue_data_provider.is_changed()
            || self.fixture_data_provider.is_changed()
            || self.group_data_provider.is_changed()
    }
}

/// Recomputes the cue every Go, Back, and jump timeline action leaves its sequence on.
///
/// Runs only when timelines, clips, sequences, cues, fixtures, or groups change, and only
/// replaces the published targets when the result differs so clients are not re-sent identical
/// data.
pub fn update_timeline_sequence_action_targets_system(
    inputs: TimelineSequenceActionTargetInputs,
    mut removed_clips: RemovedComponents<Clip>,
    mut targets: ResMut<TimelineSequenceActionTargets>,
    mut initialized: Local<bool>,
) {
    let clips_removed = removed_clips.read().count() > 0;
    if *initialized && !clips_removed && !inputs.changed() {
        return;
    }
    *initialized = true;

    targets.set_if_neq(TimelineSequenceActionTargets {
        targets: resolve_timeline_sequence_action_targets(&inputs),
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

/// Replays every timeline definition and collects its navigation action targets.
fn resolve_timeline_sequence_action_targets(
    inputs: &TimelineSequenceActionTargetInputs,
) -> Vec<TimelineSequenceActionTarget> {
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

    let navigated_clip_uids = timelines
        .iter()
        .flat_map(|(_, actions)| actions.iter())
        .filter_map(|action| navigation_clip_uid(&action.action))
        .collect::<HashSet<_>>();
    let source_by_clip_uid = inputs
        .clips
        .iter()
        .filter_map(|clip| {
            planned_source_for_clip(clip).map(|source| (clip.identifiers.uid, source))
        })
        .collect::<HashMap<_, _>>();
    let duration_by_source = navigated_clip_uids
        .iter()
        .filter_map(|clip_uid| source_by_clip_uid.get(clip_uid).copied())
        .filter(|source| matches!(source, PlannedPlaybackSource::Sequence(_)))
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|source| {
            (
                source,
                playback_duration_profile_for_source(
                    source,
                    &inputs.cue_data_provider,
                    Some(sequence_data_provider),
                    &inputs.fixture_data_provider,
                    &inputs.selection_resolver,
                ),
            )
        })
        .collect();
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
                sequence_data_provider,
                inputs,
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
    sequence_data_provider: &DataProvider<Sequence>,
    inputs: &TimelineSequenceActionTargetInputs,
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
        let Ok(sequence) = sequence_data_provider.get(sequence_uid) else {
            continue;
        };
        let Some(mut playback) = SequenceTimelineSeekPlayback::from_sequence_uid(
            0,
            sequence_uid,
            sequence_data_provider,
            &inputs.cue_data_provider,
            &inputs.fixture_data_provider,
            &inputs.selection_resolver,
            interval.started_at_timeline,
        ) else {
            continue;
        };
        playback.replay_planned_interventions_until(interval, end, |intervention, position| {
            if intervention.kind == PlannedPlaybackInterventionKind::Stop {
                return;
            }
            let cue_uid = position
                .checked_sub(1)
                .and_then(|index| sequence.steps.get(index as usize))
                .map(|cue_uid| cue_uid.0);
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
