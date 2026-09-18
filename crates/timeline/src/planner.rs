// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Source-agnostic timeline planning helpers.

use std::collections::HashMap;
use std::time::Duration;

use nightfall_actions::{ActionReference, ActionRegistry};
use nightfall_playback_planner::{
    PlannedNoOp, PlannedNoOpReason, PlannedPlaybackInterval, PlannedPlaybackIntervention,
    PlannedPlaybackInterventionKind, PlannedPlaybackLifecycle, PlannedPlaybackRateChange,
    PlannedPlaybackSource, PlannedReleaseInterval, PlannedTimelineEvent, PlannedTimelineEventKind,
    PlaybackDurationProfile, PlaybackExtent, TimelinePlan, TimelinePlannerDiagnostic,
    TimelinePlannerDiagnosticSeverity, TimelinePlaybackActionOperation, TimelinePlaybackActionPlan,
    TimelinePlaybackOwner,
};
use uuid::Uuid;

use crate::timeline::ActionKind;

#[derive(Clone, Debug)]
pub(crate) struct TimelinePlanningAction {
    pub(crate) track_id: String,
    pub(crate) action_id: String,
    pub(crate) action: ActionKind,
    pub(crate) position: Duration,
    pub(crate) duration: Duration,
}

pub(crate) trait TimelinePlaybackSourceResolver {
    fn clip_source(&self, clip_uid: Uuid) -> Option<PlannedPlaybackSource>;

    fn duration_profile(&self, source: PlannedPlaybackSource) -> PlaybackDurationProfile;
}

pub(crate) fn plan_timeline_at(
    timeline_uid: Uuid,
    target_time: Duration,
    actions: impl IntoIterator<Item = TimelinePlanningAction>,
    resolver: &impl TimelinePlaybackSourceResolver,
    action_registry: Option<&ActionRegistry>,
) -> TimelinePlan {
    let mut plan = TimelinePlan {
        timeline_uid,
        target_time,
        ..Default::default()
    };
    let mut active_by_clip_uid: HashMap<Uuid, usize> = HashMap::new();
    let mut ordered_actions: Vec<_> = actions.into_iter().enumerate().collect();
    ordered_actions.sort_by_key(|(index, action)| (action.position, *index));

    for (_, action) in &ordered_actions {
        let action = action.clone();
        if action.position > target_time {
            continue;
        }

        let owner = owner_for_action(timeline_uid, &action);
        match action.action {
            ActionKind::FireCue(cue_uid) => {
                let source = PlannedPlaybackSource::Cue(cue_uid);
                plan.events.push(PlannedTimelineEvent {
                    owner: owner.clone(),
                    timeline_position: action.position,
                    kind: PlannedTimelineEventKind::Start(source),
                });
                push_started_interval(
                    &mut plan,
                    owner,
                    source,
                    action.position,
                    action.duration,
                    resolver,
                );
            }
            ActionKind::StartClip(clip_uid) => {
                let Some(source) = resolver.clip_source(clip_uid) else {
                    push_unresolved_source(&mut plan, owner, "start-clip");
                    continue;
                };
                plan.events.push(PlannedTimelineEvent {
                    owner: owner.clone(),
                    timeline_position: action.position,
                    kind: PlannedTimelineEventKind::Start(source),
                });
                if let Some(previous_interval_index) = active_by_clip_uid.remove(&clip_uid) {
                    complete_interval_at(&mut plan, previous_interval_index, action.position);
                }
                let interval_index = push_started_interval(
                    &mut plan,
                    owner,
                    source,
                    action.position,
                    Duration::ZERO,
                    resolver,
                );
                active_by_clip_uid.insert(clip_uid, interval_index);
            }
            ActionKind::StopClip(clip_uid) => {
                let Some(source) = resolver.clip_source(clip_uid) else {
                    push_unresolved_source(&mut plan, owner, "stop-clip");
                    continue;
                };
                plan.events.push(PlannedTimelineEvent {
                    owner: owner.clone(),
                    timeline_position: action.position,
                    kind: PlannedTimelineEventKind::Stop(source),
                });
                let Some(interval_index) = active_by_clip_uid.remove(&clip_uid) else {
                    push_missing_active_interval(&mut plan, owner, "stop-clip");
                    continue;
                };
                release_interval_at(&mut plan, interval_index, owner, action.position, resolver);
            }
            ActionKind::AdvanceSequence(clip_uid) => {
                push_intervention(
                    &mut plan,
                    &mut active_by_clip_uid,
                    clip_uid,
                    owner,
                    action.position,
                    PlannedPlaybackInterventionKind::SequenceGo,
                    "advance-sequence",
                    resolver,
                );
            }
            ActionKind::BackSequence(clip_uid) => {
                push_intervention(
                    &mut plan,
                    &mut active_by_clip_uid,
                    clip_uid,
                    owner,
                    action.position,
                    PlannedPlaybackInterventionKind::SequenceBack,
                    "back-sequence",
                    resolver,
                );
            }
            ActionKind::JumpToCue { uid, cue_index } => {
                push_intervention(
                    &mut plan,
                    &mut active_by_clip_uid,
                    uid,
                    owner,
                    action.position,
                    PlannedPlaybackInterventionKind::SequenceGotoCue(cue_index),
                    "jump-to-cue",
                    resolver,
                );
            }
            ActionKind::SetClipRate { uid, rate } => {
                push_rate_change(
                    &mut plan,
                    &active_by_clip_uid,
                    uid,
                    owner,
                    action.position,
                    rate,
                );
            }
            ActionKind::DeskEval(command) => {
                push_unsupported_desk_eval(&mut plan, owner, &command);
            }
            ActionKind::RegisteredAction(registered_action) => {
                plan_registered_action(
                    &mut plan,
                    &mut active_by_clip_uid,
                    &registered_action,
                    owner,
                    action.position,
                    resolver,
                    action_registry,
                );
            }
        }
    }

    plan
}

fn owner_for_action(timeline_uid: Uuid, action: &TimelinePlanningAction) -> TimelinePlaybackOwner {
    TimelinePlaybackOwner {
        timeline_uid,
        track_id: action.track_id.clone(),
        action_id: action.action_id.clone(),
    }
}

/// Applies deterministic planning supplied by a domain's registered action capability.
fn plan_registered_action(
    plan: &mut TimelinePlan,
    active_by_owner_uid: &mut HashMap<Uuid, usize>,
    action: &ActionReference,
    owner: TimelinePlaybackOwner,
    timeline_position: Duration,
    resolver: &impl TimelinePlaybackSourceResolver,
    action_registry: Option<&ActionRegistry>,
) {
    let Some(action_registry) = action_registry else {
        push_unsupported_registered_action(plan, owner, action.id.as_str(), None);
        return;
    };
    let capability = match action_registry.resolve_capability::<TimelinePlaybackActionPlan>(action)
    {
        Ok(Some(capability)) => capability,
        Ok(None) => {
            push_unsupported_registered_action(plan, owner, action.id.as_str(), None);
            return;
        }
        Err(error) => {
            push_unsupported_registered_action(
                plan,
                owner,
                action.id.as_str(),
                Some(&error.message),
            );
            return;
        }
    };

    let owner_uid = capability.owner_uid;
    match capability.operation {
        TimelinePlaybackActionOperation::Start => {
            let Some(source) = resolver.clip_source(owner_uid) else {
                push_unresolved_source(plan, owner, "registered-action-start");
                return;
            };
            plan.events.push(PlannedTimelineEvent {
                owner: owner.clone(),
                timeline_position,
                kind: PlannedTimelineEventKind::Start(source),
            });
            if let Some(previous_interval_index) = active_by_owner_uid.remove(&owner_uid) {
                complete_interval_at(plan, previous_interval_index, timeline_position);
            }
            let interval_index = push_started_interval(
                plan,
                owner,
                source,
                timeline_position,
                Duration::ZERO,
                resolver,
            );
            active_by_owner_uid.insert(owner_uid, interval_index);
        }
        TimelinePlaybackActionOperation::Stop => {
            let Some(source) = resolver.clip_source(owner_uid) else {
                push_unresolved_source(plan, owner, "registered-action-stop");
                return;
            };
            plan.events.push(PlannedTimelineEvent {
                owner: owner.clone(),
                timeline_position,
                kind: PlannedTimelineEventKind::Stop(source),
            });
            let Some(interval_index) = active_by_owner_uid.remove(&owner_uid) else {
                push_missing_active_interval(plan, owner, "registered-action-stop");
                return;
            };
            release_interval_at(plan, interval_index, owner, timeline_position, resolver);
        }
        TimelinePlaybackActionOperation::Intervene(kind) => push_intervention(
            plan,
            active_by_owner_uid,
            owner_uid,
            owner,
            timeline_position,
            kind,
            "registered-action-intervention",
            resolver,
        ),
    }
}

fn push_started_interval(
    plan: &mut TimelinePlan,
    owner: TimelinePlaybackOwner,
    source: PlannedPlaybackSource,
    started_at_timeline: Duration,
    action_duration: Duration,
    resolver: &impl TimelinePlaybackSourceResolver,
) -> usize {
    let profile = resolver.duration_profile(source);
    let action_end = started_at_timeline.saturating_add(action_duration);
    let mut interval = PlannedPlaybackInterval {
        owner,
        source,
        started_at_timeline,
        stopped_at_timeline: None,
        source_local_start: Duration::ZERO,
        release: None,
        rate_changes: Vec::new(),
        explicit_interventions: Vec::new(),
        lifecycle: PlannedPlaybackLifecycle::Active,
    };

    if action_duration > Duration::ZERO && plan.target_time >= action_end {
        apply_release_timing(
            &mut interval,
            action_end,
            action_end,
            profile,
            plan.target_time,
        );
    }

    if interval.is_noop_at(plan.target_time) {
        push_noop(
            &mut plan.no_ops,
            interval.owner.clone(),
            PlannedNoOpReason::ReleaseCompletedBeforeTarget,
        );
    }

    plan.instances.push(interval);
    plan.instances.len() - 1
}

fn release_interval_at(
    plan: &mut TimelinePlan,
    interval_index: usize,
    stop_owner: TimelinePlaybackOwner,
    stopped_at_timeline: Duration,
    resolver: &impl TimelinePlaybackSourceResolver,
) {
    let Some(interval) = plan.instances.get_mut(interval_index) else {
        return;
    };
    let profile = resolver.duration_profile(interval.source);
    interval.stopped_at_timeline = Some(stopped_at_timeline);
    apply_release_timing(
        interval,
        stopped_at_timeline,
        stopped_at_timeline,
        profile,
        plan.target_time,
    );

    if interval.is_noop_at(plan.target_time) {
        let interval_owner = interval.owner.clone();
        let intervention_owners = interval
            .explicit_interventions
            .iter()
            .map(|intervention| intervention.owner.clone())
            .collect::<Vec<_>>();
        push_noop(
            &mut plan.no_ops,
            interval_owner,
            PlannedNoOpReason::ReleaseCompletedBeforeTarget,
        );
        for owner in intervention_owners {
            push_noop(
                &mut plan.no_ops,
                owner,
                PlannedNoOpReason::ReleaseCompletedBeforeTarget,
            );
        }
        push_noop(
            &mut plan.no_ops,
            stop_owner,
            PlannedNoOpReason::ReleaseCompletedBeforeTarget,
        );
    }
}

fn complete_interval_at(
    plan: &mut TimelinePlan,
    interval_index: usize,
    completed_at_timeline: Duration,
) {
    let Some(interval) = plan.instances.get_mut(interval_index) else {
        return;
    };
    interval.stopped_at_timeline = Some(completed_at_timeline);
    interval.lifecycle = PlannedPlaybackLifecycle::Complete;

    let interval_owner = interval.owner.clone();
    let intervention_owners = interval
        .explicit_interventions
        .iter()
        .map(|intervention| intervention.owner.clone())
        .collect::<Vec<_>>();
    push_noop(
        &mut plan.no_ops,
        interval_owner,
        PlannedNoOpReason::CompletedBeforeTarget,
    );
    for owner in intervention_owners {
        push_noop(
            &mut plan.no_ops,
            owner,
            PlannedNoOpReason::CompletedBeforeTarget,
        );
    }
}

fn apply_release_timing(
    interval: &mut PlannedPlaybackInterval,
    released_at_timeline: Duration,
    source_snapshot_at_timeline: Duration,
    profile: PlaybackDurationProfile,
    target_time: Duration,
) {
    let release_completed_at_timeline = match profile.release {
        PlaybackExtent::Finite(duration) => Some(released_at_timeline.saturating_add(duration)),
        PlaybackExtent::Indefinite | PlaybackExtent::Unknown => None,
    };
    interval.release = Some(PlannedReleaseInterval {
        released_at_timeline,
        release_completed_at_timeline,
        source_snapshot_at_timeline,
    });
    interval.lifecycle = if interval.is_noop_at(target_time) {
        PlannedPlaybackLifecycle::Complete
    } else {
        PlannedPlaybackLifecycle::Releasing
    };
}

fn push_intervention(
    plan: &mut TimelinePlan,
    active_by_clip_uid: &mut HashMap<Uuid, usize>,
    clip_uid: Uuid,
    owner: TimelinePlaybackOwner,
    timeline_position: Duration,
    kind: PlannedPlaybackInterventionKind,
    code: &'static str,
    resolver: &impl TimelinePlaybackSourceResolver,
) {
    plan.events.push(PlannedTimelineEvent {
        owner: owner.clone(),
        timeline_position,
        kind: PlannedTimelineEventKind::Intervene(kind),
    });

    let interval_index = if let Some(interval_index) = active_by_clip_uid.get(&clip_uid) {
        *interval_index
    } else {
        let Some(source) = resolver.clip_source(clip_uid) else {
            push_missing_active_interval(plan, owner, code);
            return;
        };
        if !matches!(source, PlannedPlaybackSource::Sequence(_)) {
            push_missing_active_interval(plan, owner, code);
            return;
        };
        let interval_index = push_started_interval(
            plan,
            owner.clone(),
            source,
            timeline_position,
            Duration::ZERO,
            resolver,
        );
        active_by_clip_uid.insert(clip_uid, interval_index);
        interval_index
    };
    let Some(interval) = plan.instances.get_mut(interval_index) else {
        push_missing_active_interval(plan, owner, code);
        return;
    };
    interval
        .explicit_interventions
        .push(PlannedPlaybackIntervention {
            timeline_position,
            playback_position: interval.playback_position_at(timeline_position),
            kind,
            owner,
        });
}

fn push_unresolved_source(
    plan: &mut TimelinePlan,
    owner: TimelinePlaybackOwner,
    code: &'static str,
) {
    push_noop(
        &mut plan.no_ops,
        owner.clone(),
        PlannedNoOpReason::UnresolvedSource,
    );
    plan.diagnostics.push(TimelinePlannerDiagnostic {
        owner: Some(owner),
        severity: TimelinePlannerDiagnosticSeverity::Warning,
        code: code.to_owned(),
        message: "Timeline planner could not resolve the target playback source".to_owned(),
    });
}

fn push_missing_active_interval(
    plan: &mut TimelinePlan,
    owner: TimelinePlaybackOwner,
    code: &'static str,
) {
    plan.diagnostics.push(TimelinePlannerDiagnostic {
        owner: Some(owner),
        severity: TimelinePlannerDiagnosticSeverity::Info,
        code: code.to_owned(),
        message: "Timeline intervention had no active planned playback interval".to_owned(),
    });
}

fn push_rate_change(
    plan: &mut TimelinePlan,
    active_by_clip_uid: &HashMap<Uuid, usize>,
    clip_uid: Uuid,
    owner: TimelinePlaybackOwner,
    timeline_position: Duration,
    rate: f32,
) {
    let Some(interval_index) = active_by_clip_uid.get(&clip_uid).copied() else {
        push_missing_active_interval(plan, owner, "set-clip-rate");
        return;
    };
    let Some(interval) = plan.instances.get_mut(interval_index) else {
        push_missing_active_interval(plan, owner, "set-clip-rate");
        return;
    };
    let playback_position = interval.playback_position_at(timeline_position);
    interval
        .rate_changes
        .push(PlannedPlaybackRateChange::from_multiplier(
            owner,
            timeline_position,
            playback_position,
            rate,
        ));
}

/// Records that an opaque desk command cannot participate in deterministic planning.
fn push_unsupported_desk_eval(
    plan: &mut TimelinePlan,
    owner: TimelinePlaybackOwner,
    command: &str,
) {
    plan.diagnostics.push(TimelinePlannerDiagnostic {
        owner: Some(owner),
        severity: TimelinePlannerDiagnosticSeverity::Warning,
        code: "desk-eval-unsupported".to_owned(),
        message: format!(
            "Timeline planner skipped unsupported DeskEval during deterministic reconstruction: {command}"
        ),
    });
}

/// Records that a registered action lacks usable deterministic planning capability.
fn push_unsupported_registered_action(
    plan: &mut TimelinePlan,
    owner: TimelinePlaybackOwner,
    action_id: &str,
    detail: Option<&str>,
) {
    let detail = detail.map_or_else(String::new, |detail| format!(": {detail}"));
    plan.diagnostics.push(TimelinePlannerDiagnostic {
        owner: Some(owner),
        severity: TimelinePlannerDiagnosticSeverity::Warning,
        code: "registered-action-unsupported".to_owned(),
        message: format!(
            "Timeline planner skipped registered action '{action_id}' without deterministic planning capability{detail}"
        ),
    });
}

fn push_noop(
    no_ops: &mut Vec<PlannedNoOp>,
    owner: TimelinePlaybackOwner,
    reason: PlannedNoOpReason,
) {
    if no_ops
        .iter()
        .any(|no_op| no_op.owner == owner && no_op.reason == reason)
    {
        return;
    }
    no_ops.push(PlannedNoOp { owner, reason });
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use nightfall_actions::{ActionDescriptor, ActionId, ActionSurface, InvocationDispatch};
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    /// Arguments owned by the test domain action registration.
    #[derive(Deserialize)]
    struct TestTimelineArguments {
        owner_uid: Uuid,
    }

    struct TestResolver {
        source_by_clip: HashMap<Uuid, PlannedPlaybackSource>,
        profile_by_source: HashMap<PlannedPlaybackSource, PlaybackDurationProfile>,
    }

    impl TimelinePlaybackSourceResolver for TestResolver {
        fn clip_source(&self, clip_uid: Uuid) -> Option<PlannedPlaybackSource> {
            self.source_by_clip.get(&clip_uid).copied()
        }

        fn duration_profile(&self, source: PlannedPlaybackSource) -> PlaybackDurationProfile {
            self.profile_by_source
                .get(&source)
                .copied()
                .unwrap_or_else(PlaybackDurationProfile::unknown)
        }
    }

    fn action(id: &str, action: ActionKind, position_ms: u64) -> TimelinePlanningAction {
        TimelinePlanningAction {
            track_id: "track".to_owned(),
            action_id: id.to_owned(),
            action,
            position: Duration::from_millis(position_ms),
            duration: Duration::ZERO,
        }
    }

    /// Verifies a domain registration adds timeline planning without a timeline action-ID case.
    #[test]
    fn plan_uses_registered_deterministic_timeline_capability() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Sequence(Uuid::new_v4());
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::ZERO),
                ),
            )]),
        };
        let mut registry = ActionRegistry::default();
        registry.register::<TestTimelineArguments, _>(
            ActionDescriptor {
                id: ActionId::new("test-domain.timeline-start"),
                label: "Test-domain timeline start".to_owned(),
                allowed_surfaces: vec![ActionSurface::Timeline],
                argument_schema: json!({ "type": "object" }),
            },
            |_world, _arguments, _invocation| Ok(InvocationDispatch::Accepted),
        );
        registry.register_capability::<TestTimelineArguments, TimelinePlaybackActionPlan, _>(
            "test-domain.timeline-start",
            |arguments| {
                Ok(TimelinePlaybackActionPlan {
                    owner_uid: arguments.owner_uid,
                    operation: TimelinePlaybackActionOperation::Start,
                })
            },
        );

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(100),
            [action(
                "registered-start",
                ActionKind::RegisteredAction(ActionReference::new(
                    "test-domain.timeline-start",
                    json!({ "owner_uid": clip_uid }),
                )),
                100,
            )],
            &resolver,
            Some(&registry),
        );

        assert_eq!(plan.instances.len(), 1);
        assert_eq!(plan.instances[0].source, source);
        assert!(plan.diagnostics.is_empty());
    }

    /// Verifies that opaque desk commands report diagnostics without inventing plan state.
    #[test]
    fn plan_diagnoses_unsupported_desk_eval_without_materializing_playback() {
        let timeline_uid = Uuid::new_v4();
        let resolver = TestResolver {
            source_by_clip: HashMap::new(),
            profile_by_source: HashMap::new(),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(100),
            [action(
                "desk-eval",
                ActionKind::DeskEval("group 1 at 50".to_owned()),
                100,
            )],
            &resolver,
            None,
        );

        assert!(plan.events.is_empty());
        assert!(plan.instances.is_empty());
        assert!(plan.no_ops.is_empty());
        assert_eq!(plan.diagnostics.len(), 1);
        assert_eq!(
            plan.diagnostics[0]
                .owner
                .as_ref()
                .map(|owner| owner.action_id.as_str()),
            Some("desk-eval")
        );
        assert!(matches!(
            plan.diagnostics[0].severity,
            TimelinePlannerDiagnosticSeverity::Warning
        ));
        assert_eq!(plan.diagnostics[0].code, "desk-eval-unsupported");
        assert!(plan.diagnostics[0].message.contains("group 1 at 50"));
    }

    #[test]
    fn plan_collects_source_local_interventions_inside_active_clip_interval() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Sequence(sequence_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::from_millis(100)),
                ),
            )]),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(250),
            [
                action("start", ActionKind::StartClip(clip_uid), 100),
                action("go", ActionKind::AdvanceSequence(clip_uid), 250),
            ],
            &resolver,
            None,
        );

        assert_eq!(plan.instances.len(), 1);
        assert_eq!(plan.instances[0].explicit_interventions.len(), 1);
        assert_eq!(
            plan.instances[0].explicit_interventions[0].playback_position,
            Duration::from_millis(150)
        );
    }

    /// Verifies clip rate actions change planned source-local playback positions.
    #[test]
    fn plan_applies_clip_rate_changes_to_playback_position() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Sequence(sequence_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::ZERO),
                ),
            )]),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(300),
            [
                action("start", ActionKind::StartClip(clip_uid), 0),
                action(
                    "rate",
                    ActionKind::SetClipRate {
                        uid: clip_uid,
                        rate: 2.0,
                    },
                    100,
                ),
                action("go", ActionKind::AdvanceSequence(clip_uid), 300),
            ],
            &resolver,
            None,
        );

        assert_eq!(plan.instances.len(), 1);
        assert_eq!(
            plan.instances[0].playback_position_at(Duration::from_millis(300)),
            Duration::from_millis(500)
        );
        assert_eq!(
            plan.instances[0].playback_rate_at(Duration::from_millis(300)),
            2.0
        );
        assert_eq!(
            plan.instances[0].explicit_interventions[0].playback_position,
            Duration::from_millis(500)
        );
    }

    /// Verifies sequence navigation without an active interval plans the clip autostart.
    #[test]
    fn plan_creates_sequence_interval_for_navigation_autostart() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Sequence(sequence_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::ZERO),
                ),
            )]),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(300),
            [
                action(
                    "goto",
                    ActionKind::JumpToCue {
                        uid: clip_uid,
                        cue_index: 3,
                    },
                    100,
                ),
                action("back", ActionKind::BackSequence(clip_uid), 200),
            ],
            &resolver,
            None,
        );

        assert_eq!(plan.instances.len(), 1);
        assert_eq!(plan.instances[0].owner.action_id, "goto");
        assert_eq!(
            plan.instances[0].started_at_timeline,
            Duration::from_millis(100)
        );
        assert_eq!(plan.instances[0].explicit_interventions.len(), 2);
        assert_eq!(
            plan.instances[0].explicit_interventions[0].kind,
            PlannedPlaybackInterventionKind::SequenceGotoCue(3)
        );
        assert_eq!(
            plan.instances[0].explicit_interventions[0].playback_position,
            Duration::ZERO
        );
        assert_eq!(
            plan.instances[0].explicit_interventions[1].kind,
            PlannedPlaybackInterventionKind::SequenceBack
        );
        assert_eq!(
            plan.instances[0].explicit_interventions[1].playback_position,
            Duration::from_millis(100)
        );
    }

    /// Verifies navigation for non-sequence sources remains unsupported by the planner.
    #[test]
    fn plan_does_not_autostart_non_sequence_navigation() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let fx_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Fx(fx_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::ZERO),
                ),
            )]),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(100),
            [action("go", ActionKind::AdvanceSequence(clip_uid), 100)],
            &resolver,
            None,
        );

        assert!(plan.instances.is_empty());
        assert_eq!(plan.diagnostics.len(), 1);
        assert_eq!(plan.diagnostics[0].code, "advance-sequence");
    }

    /// Verifies a later start for one clip supersedes its prior planned interval.
    #[test]
    fn plan_completes_prior_interval_when_clip_restarts() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Sequence(sequence_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::ZERO),
                ),
            )]),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(300),
            [
                action("start-1", ActionKind::StartClip(clip_uid), 100),
                action("start-2", ActionKind::StartClip(clip_uid), 200),
            ],
            &resolver,
            None,
        );

        assert_eq!(plan.instances.len(), 2);
        assert_eq!(
            plan.instances[0].lifecycle,
            PlannedPlaybackLifecycle::Complete
        );
        assert_eq!(
            plan.instances[0].stopped_at_timeline,
            Some(Duration::from_millis(200))
        );
        assert_eq!(
            plan.instances[1].lifecycle,
            PlannedPlaybackLifecycle::Active
        );
        assert_eq!(plan.instances[1].owner.action_id, "start-2");
        assert!(
            plan.no_ops.iter().any(|no_op| {
                no_op.owner.action_id == "start-1"
                    && no_op.reason == PlannedNoOpReason::CompletedBeforeTarget
            }),
            "the superseded start should be marked as a completed aggregate no-op"
        );
    }

    #[test]
    fn plan_keeps_visual_duration_start_relevant_when_later_intervention_targets_clip() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Sequence(sequence_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::ZERO),
                ),
            )]),
        };
        let mut start = action("start", ActionKind::StartClip(clip_uid), 100);
        start.duration = Duration::from_millis(50);

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(300),
            [
                start,
                action("go", ActionKind::AdvanceSequence(clip_uid), 200),
            ],
            &resolver,
            None,
        );

        assert!(plan.no_ops.is_empty());
        assert_eq!(plan.instances.len(), 1);
        assert_eq!(
            plan.instances[0].lifecycle,
            PlannedPlaybackLifecycle::Active
        );
        assert_eq!(plan.instances[0].explicit_interventions.len(), 1);
    }

    #[test]
    fn plan_marks_stopped_interval_noop_after_release_tail() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let sequence_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Sequence(sequence_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::from_millis(100)),
                ),
            )]),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(351),
            [
                action("start", ActionKind::StartClip(clip_uid), 100),
                action("go", ActionKind::AdvanceSequence(clip_uid), 150),
                action("stop", ActionKind::StopClip(clip_uid), 250),
            ],
            &resolver,
            None,
        );

        assert_eq!(
            plan.instances[0].lifecycle,
            PlannedPlaybackLifecycle::Complete
        );
        assert_eq!(plan.no_ops.len(), 3);
        assert!(
            plan.no_ops
                .iter()
                .any(|no_op| no_op.owner.action_id == "start")
        );
        assert!(
            plan.no_ops
                .iter()
                .any(|no_op| no_op.owner.action_id == "go")
        );
        assert!(
            plan.no_ops
                .iter()
                .any(|no_op| no_op.owner.action_id == "stop")
        );
    }

    #[test]
    fn plan_marks_zero_release_fx_stop_noop_after_stop_position() {
        let timeline_uid = Uuid::new_v4();
        let clip_uid = Uuid::new_v4();
        let fx_uid = Uuid::new_v4();
        let source = PlannedPlaybackSource::Fx(fx_uid);
        let resolver = TestResolver {
            source_by_clip: HashMap::from([(clip_uid, source)]),
            profile_by_source: HashMap::from([(
                source,
                PlaybackDurationProfile::indefinite(
                    PlaybackExtent::Indefinite,
                    PlaybackExtent::Finite(Duration::ZERO),
                ),
            )]),
        };

        let plan = plan_timeline_at(
            timeline_uid,
            Duration::from_millis(251),
            [
                action("start", ActionKind::StartClip(clip_uid), 100),
                action("stop", ActionKind::StopClip(clip_uid), 250),
            ],
            &resolver,
            None,
        );

        assert_eq!(
            plan.instances[0].lifecycle,
            PlannedPlaybackLifecycle::Complete
        );
        assert_eq!(plan.no_ops.len(), 2);
        assert!(
            plan.no_ops
                .iter()
                .any(|no_op| no_op.owner.action_id == "start")
        );
        assert!(
            plan.no_ops
                .iter()
                .any(|no_op| no_op.owner.action_id == "stop")
        );
    }
}
