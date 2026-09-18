// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Deterministic timeline seek planning and materializer routing.

use super::*;

/// Source definitions and runtime indexes used to build deterministic reconstruction plans.
#[derive(SystemParam)]
pub struct TimelineSeekPlanningParams<'w, 's> {
    /// Cue definitions used to resolve cue and sequence duration profiles.
    pub(super) cue_data_provider: Res<'w, DataProvider<Cue>>,
    /// Optional sequence definitions used to resolve planner instance sources.
    pub(super) sequence_data_provider: Option<Res<'w, DataProvider<Sequence>>>,
    /// Optional classic FX definitions used to determine direct replacement support.
    pub(super) fx_data_provider: Option<Res<'w, DataProvider<Fx>>>,
    /// Fixture data used to resolve cue and sequence duration profiles.
    pub(super) fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    /// Spatial resolver used to derive source duration profiles.
    pub(super) selection_resolver: SpatialSelectionResolver<'w>,
    /// Clips available for source and owner resolution.
    pub(super) exec_query: Query<'w, 's, (Entity, &'static Clip)>,
    /// Step FX instances used to determine direct replacement support.
    pub(super) step_fx_query: Query<'w, 's, (Entity, &'static StepFx)>,
}

/// Immutable authored action data captured before reconstruction mutates runtime state.
pub(super) type TimelineActionSnapshot = (String, String, ActionKind, Duration, Duration);

/// Closed-world registry for timeline seek materializers.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct TimelineSeekMaterializerRegistry;

impl TimelineSeekMaterializerRegistry {
    /// Returns whether the source is reconstructed from a planned instance interval.
    pub(super) fn materializes_planned_interval(
        self,
        source: PlannedPlaybackSource,
        lifecycle: PlannedPlaybackLifecycle,
        is_noop_at_target: bool,
    ) -> bool {
        self.planned_interval_kind(source).is_some()
            && matches!(
                lifecycle,
                PlannedPlaybackLifecycle::Active | PlannedPlaybackLifecycle::Releasing
            )
            && !is_noop_at_target
    }

    /// Returns whether the evaluated instance should be reconstructed as a fire cue.
    pub(super) fn materializes_evaluated_fire_cue(self, instance: &EvaluatedInstanceState) -> bool {
        self.evaluated_fire_cue_kind(instance.source).is_some()
    }

    /// Returns whether the evaluated instance should be reconstructed by a clip materializer.
    pub(super) fn materializes_active_evaluated_clip(
        self,
        instance: &EvaluatedInstanceState,
        expected_kind: PlannedPlaybackSourceKind,
    ) -> bool {
        instance.lifecycle == PlannedPlaybackLifecycle::Active
            && self.evaluated_clip_kind(instance.source) == Some(expected_kind)
    }

    /// Returns whether the materializer preserves the existing direct instance link.
    pub(super) fn preserves_direct_playback_link(self, source: PlannedPlaybackSource) -> bool {
        matches!(source.kind(), PlannedPlaybackSourceKind::FxModule)
    }

    /// Returns the planned-interval materializer source kind, when supported.
    fn planned_interval_kind(
        self,
        source: PlannedPlaybackSource,
    ) -> Option<PlannedPlaybackSourceKind> {
        match source.kind() {
            PlannedPlaybackSourceKind::Sequence => Some(PlannedPlaybackSourceKind::Sequence),
            PlannedPlaybackSourceKind::Cue
            | PlannedPlaybackSourceKind::Fx
            | PlannedPlaybackSourceKind::StepFx
            | PlannedPlaybackSourceKind::FxModule
            | PlannedPlaybackSourceKind::Flow => None,
        }
    }

    /// Returns the evaluated fire-cue materializer source kind, when supported.
    fn evaluated_fire_cue_kind(
        self,
        source: PlannedPlaybackSource,
    ) -> Option<PlannedPlaybackSourceKind> {
        match source.kind() {
            PlannedPlaybackSourceKind::Cue => Some(PlannedPlaybackSourceKind::Cue),
            PlannedPlaybackSourceKind::Sequence
            | PlannedPlaybackSourceKind::Fx
            | PlannedPlaybackSourceKind::StepFx
            | PlannedPlaybackSourceKind::FxModule
            | PlannedPlaybackSourceKind::Flow => None,
        }
    }

    /// Returns the evaluated clip materializer source kind, when supported.
    fn evaluated_clip_kind(
        self,
        source: PlannedPlaybackSource,
    ) -> Option<PlannedPlaybackSourceKind> {
        match source.kind() {
            PlannedPlaybackSourceKind::Fx => Some(PlannedPlaybackSourceKind::Fx),
            PlannedPlaybackSourceKind::StepFx => Some(PlannedPlaybackSourceKind::StepFx),
            PlannedPlaybackSourceKind::FxModule => Some(PlannedPlaybackSourceKind::FxModule),
            PlannedPlaybackSourceKind::Flow => Some(PlannedPlaybackSourceKind::Flow),
            PlannedPlaybackSourceKind::Cue | PlannedPlaybackSourceKind::Sequence => None,
        }
    }
}

/// Deterministic plan and reconciliation indexes for one timeline reconstruction.
pub(super) struct TimelineReconstructionPlan {
    /// Authored actions at or before the reconstruction target.
    pub(super) timeline_actions_before_target: Vec<TimelineActionSnapshot>,
    /// Clip UID associated with each authored start owner.
    pub(super) clip_uid_by_start_owner: HashMap<(String, String), Uuid>,
    /// Clip UID associated with every planner-supported authored owner.
    pub(super) clip_uid_by_owner: HashMap<(String, String), Uuid>,
    /// Source-agnostic instance plan evaluated at the target position.
    pub(super) timeline_plan: nightfall_playback_planner::TimelinePlan,
    /// Materializer-facing evaluated instance state.
    pub(super) evaluated_timeline_state: nightfall_playback_planner::EvaluatedTimelineState,
    /// Aggregate owners whose instance completed before the target.
    pub(super) completed_noop_actions: HashSet<(String, String)>,
    /// Clips whose runtime instance can be replaced without a stop command.
    pub(super) directly_replaced_clip_entities: HashSet<Entity>,
    /// Clips whose source materializer owns replacement of the direct instance link.
    pub(super) preserve_direct_playback_link_clip_entities: HashSet<Entity>,
    /// Clips that have evaluated instance at the target.
    pub(super) target_playback_clip_entities: HashSet<Entity>,
    /// Fire-cue owners that should remain materialized at the target.
    pub(super) desired_fire_cue_owners: HashSet<(String, String)>,
    /// Active start owners eligible for same-frame live replay after mutation.
    pub(super) active_start_owners: HashSet<(String, String)>,
    /// Current authored position for each active start owner.
    pub(super) active_start_positions: HashMap<(String, String), Duration>,
    /// All authored owners that directly start a clip on this timeline.
    pub(super) timeline_start_clip_owners: HashSet<(String, String)>,
}

/// Returns start action owners that should be replayed by the live scan after mutation reconstruction.
pub(super) fn active_replay_start_owners(
    planning_actions: &[TimelinePlanningAction],
    completed_noop_actions: &HashSet<(String, String)>,
    action_registry: Option<&ActionRegistry>,
) -> HashSet<(String, String)> {
    let mut active_start_by_uid: HashMap<Uuid, (String, String)> = HashMap::new();
    let mut ordered_planning_actions = planning_actions.iter().enumerate().collect::<Vec<_>>();
    ordered_planning_actions.sort_by_key(|(index, action)| (action.position, *index));
    for (_, action) in ordered_planning_actions {
        if let Some(clip_uid) = timeline_stop_clip_uid(&action.action, action_registry) {
            active_start_by_uid.remove(&clip_uid);
            continue;
        }
        let Some(clip_uid) = timeline_start_clip_uid(&action.action, action_registry) else {
            continue;
        };
        active_start_by_uid.insert(
            clip_uid,
            (action.track_id.clone(), action.action_id.clone()),
        );
    }
    active_start_by_uid
        .into_values()
        .filter(|owner| !completed_noop_actions.contains(owner))
        .collect::<HashSet<_>>()
}

/// Returns active start owners keyed to their current timeline position.
pub(super) fn active_start_positions_by_owner(
    planning_actions: &[TimelinePlanningAction],
    active_start_owners: &HashSet<(String, String)>,
) -> HashMap<(String, String), Duration> {
    planning_actions
        .iter()
        .filter_map(|action| {
            let owner = (action.track_id.clone(), action.action_id.clone());
            active_start_owners
                .contains(&owner)
                .then_some((owner, action.position))
        })
        .collect::<HashMap<_, _>>()
}

/// Returns whether an active start action should be replayed after mutation reconstruction.
pub(super) fn active_start_timing_changed(
    triggered_actions: &HashMap<(String, String), Duration>,
    active_start_positions: &HashMap<(String, String), Duration>,
    owner: &(String, String),
) -> bool {
    let Some(current_position) = active_start_positions.get(owner) else {
        return false;
    };
    triggered_actions.get(owner) != Some(current_position)
}

/// Returns the planned instance rate active for an evaluated instance at the seek target.
pub(super) fn evaluated_instance_playback_rate_at_target(
    instance: &EvaluatedInstanceState,
    timeline_plan: &nightfall_playback_planner::TimelinePlan,
    timeline_position: Duration,
) -> f32 {
    timeline_plan
        .instances
        .iter()
        .find(|interval| interval.owner == instance.owner && interval.source == instance.source)
        .map_or(1.0, |interval| interval.playback_rate_at(timeline_position))
}

/// Builds a deterministic reconstruction plan and all indexes needed by later stages.
pub(super) fn plan_timeline_reconstruction(
    timeline: &MaterializedTimeline,
    timeline_position: Duration,
    action_registry: Option<&ActionRegistry>,
    planning: &TimelineSeekPlanningParams,
    clip_snapshot: &ClipLookupSnapshot,
) -> TimelineReconstructionPlan {
    let cue_data_provider = &planning.cue_data_provider;
    let sequence_data_provider = planning.sequence_data_provider.as_deref();
    let fx_data_provider = planning.fx_data_provider.as_deref();
    let fixture_data_provider = &planning.fixture_data_provider;
    let selection_resolver = &planning.selection_resolver;
    let exec_query = &planning.exec_query;
    let step_fx_query = &planning.step_fx_query;
    let materializer_registry = TimelineSeekMaterializerRegistry;
    let timeline_actions_before_target = timeline
        .collect_actions_in_range(Duration::ZERO, timeline_position)
        .into_iter()
        .map(|(action, track)| {
            (
                track.id.clone(),
                action.id.clone(),
                action.action.clone(),
                action.position,
                action.duration,
            )
        })
        .collect::<Vec<_>>();
    let planning_actions = timeline_actions_before_target
        .iter()
        .map(
            |(track_id, action_id, action, action_position, action_duration)| {
                TimelinePlanningAction {
                    track_id: track_id.clone(),
                    action_id: action_id.clone(),
                    action: action.clone(),
                    position: *action_position,
                    duration: *action_duration,
                }
            },
        )
        .collect::<Vec<_>>();
    let clip_uid_by_start_owner = planning_actions
        .iter()
        .filter_map(|action| {
            timeline_start_clip_uid(&action.action, action_registry).map(|clip_uid| {
                (
                    (action.track_id.clone(), action.action_id.clone()),
                    clip_uid,
                )
            })
        })
        .collect::<HashMap<_, _>>();
    let clip_uid_by_owner = planning_actions
        .iter()
        .filter_map(|action| match action.action {
            ActionKind::StartClip(clip_uid)
            | ActionKind::AdvanceSequence(clip_uid)
            | ActionKind::BackSequence(clip_uid) => Some((
                (action.track_id.clone(), action.action_id.clone()),
                clip_uid,
            )),
            ActionKind::SetClipRate { uid, .. } | ActionKind::JumpToCue { uid, .. } => {
                Some(((action.track_id.clone(), action.action_id.clone()), uid))
            }
            ActionKind::FireCue(_) | ActionKind::StopClip(_) | ActionKind::DeskEval(_) => None,
            ActionKind::RegisteredAction(_) => {
                normalized_registered_action_kind(&action.action, action_registry)
                    .and_then(|action| match action {
                        ActionKind::StartClip(clip_uid)
                        | ActionKind::AdvanceSequence(clip_uid)
                        | ActionKind::BackSequence(clip_uid) => Some(clip_uid),
                        ActionKind::SetClipRate { uid, .. } | ActionKind::JumpToCue { uid, .. } => {
                            Some(uid)
                        }
                        _ => None,
                    })
                    .map(|clip_uid| {
                        (
                            (action.track_id.clone(), action.action_id.clone()),
                            clip_uid,
                        )
                    })
            }
        })
        .collect::<HashMap<_, _>>();
    let source_by_clip_uid = exec_query
        .iter()
        .filter_map(|(_, clip)| {
            planned_source_for_clip(clip).map(|source| (clip.identifiers.uid, source))
        })
        .collect::<HashMap<_, _>>();
    let duration_by_source = source_by_clip_uid
        .values()
        .copied()
        .map(|source| {
            (
                source,
                playback_duration_profile_for_source(
                    source,
                    cue_data_provider,
                    sequence_data_provider,
                    fixture_data_provider,
                    selection_resolver,
                ),
            )
        })
        .chain(
            planning_actions
                .iter()
                .filter_map(|action| match action.action {
                    ActionKind::FireCue(cue_uid) => {
                        let source = PlannedPlaybackSource::Cue(cue_uid);
                        Some((
                            source,
                            playback_duration_profile_for_source(
                                source,
                                cue_data_provider,
                                sequence_data_provider,
                                fixture_data_provider,
                                selection_resolver,
                            ),
                        ))
                    }
                    ActionKind::StartClip(_)
                    | ActionKind::StopClip(_)
                    | ActionKind::AdvanceSequence(_)
                    | ActionKind::BackSequence(_)
                    | ActionKind::SetClipRate { .. }
                    | ActionKind::JumpToCue { .. }
                    | ActionKind::DeskEval(_)
                    | ActionKind::RegisteredAction(_) => None,
                }),
        )
        .collect::<HashMap<_, _>>();
    let planner_resolver = TimelinePlannerResolver {
        source_by_clip_uid,
        duration_by_source,
    };
    let timeline_plan = plan_timeline_at(
        timeline.timeline.identifiers.uid,
        timeline_position,
        planning_actions.clone(),
        &planner_resolver,
        action_registry,
    );
    let evaluated_timeline_state = timeline_plan.evaluate();
    let completed_noop_actions = evaluated_timeline_state
        .no_ops
        .iter()
        .filter(|no_op| {
            no_op.reason == PlannedNoOpReason::ReleaseCompletedBeforeTarget
                || no_op.reason == PlannedNoOpReason::CompletedBeforeTarget
        })
        .map(|no_op| (no_op.owner.track_id.clone(), no_op.owner.action_id.clone()))
        .collect::<HashSet<_>>();
    let mut directly_replaced_clip_entities = timeline_plan
        .instances
        .iter()
        .filter(|interval| {
            materializer_registry.materializes_planned_interval(
                interval.source,
                interval.lifecycle,
                interval.is_noop_at(timeline_position),
            )
        })
        .filter_map(|interval| {
            let clip_uid = clip_uid_by_owner
                .get(&(
                    interval.owner.track_id.clone(),
                    interval.owner.action_id.clone(),
                ))
                .copied()?;
            let (clip_entity, _) = resolve_clip_entity_and_id(
                clip_snapshot,
                &clip_uid,
                "seek-planned-sequence-cleanup",
            )?;
            let Ok((_, clip)) = exec_query.get(clip_entity) else {
                return None;
            };
            let Some(Source::Sequence(sequence_uid)) = &clip.source else {
                return None;
            };
            let sequence_data_provider = sequence_data_provider?;
            let Ok(sequence) = sequence_data_provider.get(*sequence_uid) else {
                return None;
            };
            sequence
                .steps
                .iter()
                .all(|cue_uid| cue_data_provider.get(cue_uid.0).is_ok())
                .then_some(clip_entity)
        })
        .collect::<HashSet<_>>();
    let mut preserve_direct_playback_link_clip_entities = HashSet::new();
    for instance in evaluated_timeline_state
        .instances
        .iter()
        .filter(|instance| instance.lifecycle == PlannedPlaybackLifecycle::Active)
    {
        let Some(clip_uid) = clip_uid_by_owner
            .get(&(
                instance.owner.track_id.clone(),
                instance.owner.action_id.clone(),
            ))
            .copied()
        else {
            continue;
        };
        let Some((clip_entity, _)) =
            resolve_clip_entity_and_id(clip_snapshot, &clip_uid, "seek-planned-active-cleanup")
        else {
            continue;
        };
        let source_uid = instance.source.uid();
        let can_directly_replace = match instance.source.kind() {
            PlannedPlaybackSourceKind::Fx => {
                fx_data_provider.is_some_and(|data_provider| data_provider.get(source_uid).is_ok())
            }
            PlannedPlaybackSourceKind::StepFx => step_fx_query
                .iter()
                .any(|(_, step_fx)| step_fx.identifiers.uid == source_uid),
            PlannedPlaybackSourceKind::FxModule | PlannedPlaybackSourceKind::Flow => true,
            PlannedPlaybackSourceKind::Cue | PlannedPlaybackSourceKind::Sequence => false,
        };
        if !can_directly_replace {
            continue;
        }
        directly_replaced_clip_entities.insert(clip_entity);
        if materializer_registry.preserves_direct_playback_link(instance.source) {
            preserve_direct_playback_link_clip_entities.insert(clip_entity);
        }
    }
    let target_playback_clip_entities = evaluated_timeline_state
        .instances
        .iter()
        .filter_map(|instance| {
            let clip_uid = clip_uid_by_owner
                .get(&(
                    instance.owner.track_id.clone(),
                    instance.owner.action_id.clone(),
                ))
                .copied()?;
            resolve_clip_entity_and_id(clip_snapshot, &clip_uid, "seek-target-instance-cleanup")
                .map(|(clip_entity, _)| clip_entity)
        })
        .collect::<HashSet<_>>();
    let desired_fire_cue_owners = evaluated_timeline_state
        .instances
        .iter()
        .filter(|instance| materializer_registry.materializes_evaluated_fire_cue(instance))
        .map(|instance| {
            (
                instance.owner.track_id.clone(),
                instance.owner.action_id.clone(),
            )
        })
        .collect::<HashSet<_>>();
    let active_start_owners =
        active_replay_start_owners(&planning_actions, &completed_noop_actions, action_registry);
    let active_start_positions =
        active_start_positions_by_owner(&planning_actions, &active_start_owners);
    let timeline_start_clip_owners = timeline
        .timeline
        .tracks
        .iter()
        .flat_map(|track| {
            track.actions.iter().filter_map(|action| {
                matches!(action.action, ActionKind::StartClip(_))
                    .then_some((track.id.clone(), action.id.clone()))
            })
        })
        .collect::<HashSet<_>>();

    TimelineReconstructionPlan {
        timeline_actions_before_target,
        clip_uid_by_start_owner,
        clip_uid_by_owner,
        timeline_plan,
        evaluated_timeline_state,
        completed_noop_actions,
        directly_replaced_clip_entities,
        preserve_direct_playback_link_clip_entities,
        target_playback_clip_entities,
        desired_fire_cue_owners,
        active_start_owners,
        active_start_positions,
        timeline_start_clip_owners,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies completed start owners are not replayed after mutation reconstruction.
    #[test]
    fn active_replay_start_owners_excludes_completed_noop_actions() {
        let clip_uid = Uuid::new_v4();
        let completed_owner = ("track-1".to_owned(), "action-start".to_owned());
        let planning_actions = vec![TimelinePlanningAction {
            track_id: completed_owner.0.clone(),
            action_id: completed_owner.1.clone(),
            action: ActionKind::StartClip(clip_uid),
            position: Duration::from_secs(1),
            duration: Duration::from_secs(1),
        }];
        let completed_noop_actions = HashSet::from([completed_owner]);

        assert!(
            active_replay_start_owners(&planning_actions, &completed_noop_actions, None).is_empty(),
            "completed start actions should not be left for live replay"
        );
    }

    /// Verifies active starts only replay after mutation when their timing changed.
    #[test]
    fn active_start_timing_changed_tracks_trigger_position() {
        let owner = ("track-1".to_owned(), "action-start".to_owned());
        let active_start_positions = HashMap::from([(owner.clone(), Duration::from_secs(1))]);

        assert!(!active_start_timing_changed(
            &HashMap::from([(owner.clone(), Duration::from_secs(1))]),
            &active_start_positions,
            &owner,
        ));
        assert!(active_start_timing_changed(
            &HashMap::from([(owner.clone(), Duration::from_millis(500))]),
            &active_start_positions,
            &owner,
        ));
    }

    /// Verifies the closed-world registry routes each source to exactly one materializer family.
    #[test]
    fn materializer_registry_routes_supported_sources_without_overlap() {
        let registry = TimelineSeekMaterializerRegistry;
        let sources = [
            PlannedPlaybackSource::Cue(Uuid::new_v4()),
            PlannedPlaybackSource::Sequence(Uuid::new_v4()),
            PlannedPlaybackSource::Fx(Uuid::new_v4()),
            PlannedPlaybackSource::StepFx(Uuid::new_v4()),
            PlannedPlaybackSource::FxModule(Uuid::new_v4()),
            PlannedPlaybackSource::Flow(Uuid::new_v4()),
        ];

        for source in sources {
            let route_count = usize::from(registry.planned_interval_kind(source).is_some())
                + usize::from(registry.evaluated_fire_cue_kind(source).is_some())
                + usize::from(registry.evaluated_clip_kind(source).is_some());
            assert_eq!(route_count, 1, "source {source:?} must have one seek route");
        }
    }
}
