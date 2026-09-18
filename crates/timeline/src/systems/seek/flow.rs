// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Flow reconstruction request materialization for timeline seek state.

use super::*;

/// Flow-specific dependencies used during timeline reconstruction.
#[derive(SystemParam)]
pub struct TimelineFlowSeekMaterializer<'w> {
    /// Domain requests consumed by the flow runtime materializer.
    reconstruction_requests: Option<MessageWriter<'w, DomainInstanceReconstructionRequest>>,
}

/// Returns whether an evaluated instance should be routed to the flow runtime.
fn should_materialize_flow(instance: &EvaluatedInstanceState) -> bool {
    TimelineSeekMaterializerRegistry
        .materializes_active_evaluated_clip(instance, PlannedPlaybackSourceKind::Flow)
}

/// Emits flow reconstruction requests and records clip ownership.
pub(super) fn materialize_timeline_flows(
    materializer: &mut TimelineFlowSeekMaterializer,
    plan: &TimelineReconstructionPlan,
    timeline_uid: Uuid,
    clip_snapshot: &ClipLookupSnapshot,
    state: &mut TimelineReconciliationState,
) {
    for instance in plan
        .evaluated_timeline_state
        .instances
        .iter()
        .filter(|instance| should_materialize_flow(instance))
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
            resolve_clip_entity_and_id(clip_snapshot, &clip_uid, "seek-planned-flow")
        else {
            continue;
        };
        if state.queued_clip_cleanup_entities.contains(&clip_entity) {
            continue;
        }
        if let Some(reconstruction_requests) = materializer.reconstruction_requests.as_mut() {
            reconstruction_requests.write(DomainInstanceReconstructionRequest::new(
                instance.source,
                clip_uid,
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
            ));
        }
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

    /// Verifies flow routing rejects other sources and non-active lifecycle states.
    #[test]
    fn flow_materialization_requires_active_matching_source() {
        let uid = Uuid::new_v4();
        assert!(should_materialize_flow(&evaluated_instance(
            PlannedPlaybackSource::Flow(uid),
            PlannedPlaybackLifecycle::Active,
        )));
        assert!(!should_materialize_flow(&evaluated_instance(
            PlannedPlaybackSource::FxModule(uid),
            PlannedPlaybackLifecycle::Active,
        )));
        assert!(!should_materialize_flow(&evaluated_instance(
            PlannedPlaybackSource::Flow(uid),
            PlannedPlaybackLifecycle::Releasing,
        )));
    }
}
