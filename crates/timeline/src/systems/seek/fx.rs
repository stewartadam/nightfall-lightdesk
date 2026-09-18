// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Classic and step FX materialization for evaluated timeline seek state.

use super::*;

/// FX-specific dependencies used during timeline reconstruction.
#[derive(SystemParam)]
pub struct TimelineFxSeekMaterializer<'w, 's> {
    /// Optional classic FX definitions used for direct reconstruction.
    fx_data_provider: Option<Res<'w, DataProvider<Fx>>>,
    /// Clips that own the reconstructed FX instance.
    exec_query: Query<'w, 's, (Entity, &'static Clip)>,
    /// Step FX components used for direct reconstruction.
    step_fx_query: Query<'w, 's, (Entity, &'static StepFx)>,
}

/// Returns whether an evaluated instance is active and routed to the requested FX kind.
fn should_materialize_fx(
    instance: &EvaluatedInstanceState,
    expected_kind: PlannedPlaybackSourceKind,
) -> bool {
    TimelineSeekMaterializerRegistry.materializes_active_evaluated_clip(instance, expected_kind)
}

/// Materializes active classic and step FX instances at the reconstruction target.
pub(super) fn materialize_timeline_fx(
    materializer: &TimelineFxSeekMaterializer,
    commands: &mut Commands,
    plan: &TimelineReconstructionPlan,
    timeline_uid: Uuid,
    clip_snapshot: &ClipLookupSnapshot,
    state: &mut TimelineReconciliationState,
) {
    for instance in plan
        .evaluated_timeline_state
        .instances
        .iter()
        .filter(|instance| should_materialize_fx(instance, PlannedPlaybackSourceKind::Fx))
    {
        let Some(clip_uid) = plan
            .clip_uid_by_start_owner
            .get(&(
                instance.owner.track_id.clone(),
                instance.owner.action_id.clone(),
            ))
            .copied()
        else {
            continue;
        };
        let Some((clip_entity, _)) =
            resolve_clip_entity_and_id(clip_snapshot, &clip_uid, "seek-planned-fx")
        else {
            continue;
        };
        if state.queued_clip_cleanup_entities.contains(&clip_entity) {
            continue;
        }
        let Ok((_, clip)) = materializer.exec_query.get(clip_entity) else {
            continue;
        };
        let PlannedPlaybackSource::Fx(fx_uid) = instance.source else {
            continue;
        };
        let Some(fx_data_provider) = materializer.fx_data_provider.as_ref() else {
            continue;
        };
        let Ok(fx) = fx_data_provider.get(fx_uid) else {
            tracing::warn!(
                fx_uid = %fx_uid,
                clip = %clip.identifiers().uid,
                "Skipping direct timeline FX materialization for missing source"
            );
            continue;
        };
        let handle = spawn_reconstructed_fx_for_clip(
            commands,
            clip.identifiers.uid,
            clip.priority,
            &fx,
            instance_clock_from_reconstruction_timing_with_rate(
                PlaybackReconstructionTiming::timeline_source_local(
                    Duration::ZERO,
                    instance.instance_clock_position,
                    timeline_uid,
                    instance.started_at_timeline,
                ),
                evaluated_instance_playback_rate_at_target(
                    instance,
                    &plan.timeline_plan,
                    plan.timeline_plan.target_time,
                ),
            ),
        );
        commands.spawn(MaterializedClip {
            clip_id: clip.identifiers.id,
            attached_instance: handle.instance_id,
            auto_release_on_stop: false,
        });
        track_timeline_clip_entity(
            &mut state.tracked_spawned_entities,
            &mut state.active_clip_entities,
            clip_entity,
            &instance.owner.track_id,
            &instance.owner.action_id,
        );
        state.direct_materialized_actions.insert((
            instance.owner.track_id.clone(),
            instance.owner.action_id.clone(),
        ));
        state.direct_materialized_clip_uids.insert(clip_uid);
    }

    for instance in plan
        .evaluated_timeline_state
        .instances
        .iter()
        .filter(|instance| should_materialize_fx(instance, PlannedPlaybackSourceKind::StepFx))
    {
        let Some(clip_uid) = plan
            .clip_uid_by_start_owner
            .get(&(
                instance.owner.track_id.clone(),
                instance.owner.action_id.clone(),
            ))
            .copied()
        else {
            continue;
        };
        let Some((clip_entity, _)) =
            resolve_clip_entity_and_id(clip_snapshot, &clip_uid, "seek-planned-step-fx")
        else {
            continue;
        };
        if state.queued_clip_cleanup_entities.contains(&clip_entity) {
            continue;
        }
        let Ok((_, clip)) = materializer.exec_query.get(clip_entity) else {
            continue;
        };
        let PlannedPlaybackSource::StepFx(step_fx_uid) = instance.source else {
            continue;
        };
        let Some((step_fx_entity, step_fx)) = materializer
            .step_fx_query
            .iter()
            .find(|(_, step_fx)| step_fx.identifiers.uid == step_fx_uid)
        else {
            tracing::warn!(
                step_fx_uid = %step_fx_uid,
                clip = %clip.identifiers().uid,
                "Skipping direct timeline Step FX materialization for missing source"
            );
            continue;
        };
        let handle = spawn_reconstructed_step_fx_for_clip(
            commands,
            clip.identifiers.uid,
            clip.priority,
            step_fx_entity,
            step_fx,
            instance_clock_from_reconstruction_timing_with_rate(
                PlaybackReconstructionTiming::timeline_source_local(
                    Duration::ZERO,
                    instance.instance_clock_position,
                    timeline_uid,
                    instance.started_at_timeline,
                ),
                evaluated_instance_playback_rate_at_target(
                    instance,
                    &plan.timeline_plan,
                    plan.timeline_plan.target_time,
                ),
            ),
        );
        commands.spawn(MaterializedClip {
            clip_id: clip.identifiers.id,
            attached_instance: handle.instance_id,
            auto_release_on_stop: false,
        });
        track_timeline_clip_entity(
            &mut state.tracked_spawned_entities,
            &mut state.active_clip_entities,
            clip_entity,
            &instance.owner.track_id,
            &instance.owner.action_id,
        );
        state.direct_materialized_actions.insert((
            instance.owner.track_id.clone(),
            instance.owner.action_id.clone(),
        ));
        state.direct_materialized_clip_uids.insert(clip_uid);
    }
}

#[cfg(test)]
mod tests {
    use nightfall_playback_planner::TimelinePlaybackOwner;

    use super::*;

    /// Returns evaluated instance with the requested source and lifecycle.
    fn evaluated_instance(
        source: PlannedPlaybackSource,
        lifecycle: PlannedPlaybackLifecycle,
    ) -> EvaluatedInstanceState {
        EvaluatedInstanceState {
            owner: TimelinePlaybackOwner {
                timeline_uid: Uuid::from_u128(1),
                track_id: "track-a".to_owned(),
                action_id: "action-a".to_owned(),
            },
            source,
            instance_clock_position: Duration::ZERO,
            started_at_timeline: Duration::ZERO,
            released_at_timeline: None,
            release_snapshot_position: None,
            lifecycle,
        }
    }

    /// Verifies FX reconstruction only accepts active instance of the requested kind.
    #[test]
    fn fx_materialization_requires_active_matching_source() {
        let fx_uid = Uuid::new_v4();
        let active_fx = evaluated_instance(
            PlannedPlaybackSource::Fx(fx_uid),
            PlannedPlaybackLifecycle::Active,
        );
        let releasing_fx = evaluated_instance(
            PlannedPlaybackSource::Fx(fx_uid),
            PlannedPlaybackLifecycle::Releasing,
        );

        assert!(should_materialize_fx(
            &active_fx,
            PlannedPlaybackSourceKind::Fx
        ));
        assert!(!should_materialize_fx(
            &active_fx,
            PlannedPlaybackSourceKind::StepFx
        ));
        assert!(!should_materialize_fx(
            &releasing_fx,
            PlannedPlaybackSourceKind::Fx
        ));
    }
}
