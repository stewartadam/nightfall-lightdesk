// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Trigger bookkeeping and action dispatch after deterministic seek materialization.

use super::*;

/// Action and lookup dependencies used by seek planning, reconciliation, and final dispatch.
#[derive(SystemParam)]
pub struct TimelineSeekDispatch<'w> {
    /// Registered action capabilities used by planning and native action normalization.
    pub(super) action_registry: Option<Res<'w, ActionRegistry>>,
    /// Generic action invocations emitted for opted-in nondeterministic replay.
    action_invocations: Option<MessageWriter<'w, ActionInvocation>>,
    /// Clip actions emitted during reconciliation and rate restoration.
    pub(super) ev_clip: MessageWriter<'w, EngineActionEnvelope<ClipAction>>,
    /// Correlation state for actions emitted on behalf of a timeline.
    pub(super) timeline_command_origins: ResMut<'w, TimelineCommandOrigins>,
    /// Desk actions emitted for opted-in nondeterministic reconstruction.
    ev_desk: MessageWriter<'w, EngineActionEnvelope<DeskAction>>,
}

/// Inputs that determine whether an active start should be replayed by the live scan.
struct LiveReplayEligibility<'a> {
    /// Active start owners at the reconstruction target.
    active_start_owners: &'a HashSet<(String, String)>,
    /// Current authored positions for active start owners.
    active_start_positions: &'a HashMap<(String, String), Duration>,
    /// Active owners retained during stale-entity reconciliation.
    preserved_active_start_owners: &'a HashSet<(String, String)>,
    /// Owners already reconstructed by deterministic materializers.
    direct_materialized_actions: &'a HashSet<(String, String)>,
    /// Owners with clip tracking before reconstruction.
    existing_spawned_clip_owners: &'a HashSet<(String, String)>,
}

/// Returns whether a mutation should leave an active start untriggered for live replay.
fn should_live_replay_active_start(
    reason: TimelineReconstructionReason,
    owner: &(String, String),
    triggered_actions: &HashMap<(String, String), Duration>,
    eligibility: &LiveReplayEligibility,
) -> bool {
    matches!(reason, TimelineReconstructionReason::ActionsChanged)
        && eligibility.active_start_owners.contains(owner)
        && !eligibility.preserved_active_start_owners.contains(owner)
        && !eligibility.direct_materialized_actions.contains(owner)
        && (active_start_timing_changed(
            triggered_actions,
            eligibility.active_start_positions,
            owner,
        ) || !eligibility.existing_spawned_clip_owners.contains(owner))
}

/// Records reconstructed triggers and dispatches opted-in nondeterministic actions.
pub(super) fn dispatch_timeline_reconstruction_actions(
    dispatch: &mut TimelineSeekDispatch,
    timeline: &mut MaterializedTimeline,
    reason: TimelineReconstructionReason,
    plan: &TimelineReconstructionPlan,
    state: &TimelineReconciliationState,
    clip_snapshot: &ClipLookupSnapshot,
) {
    let live_replay_eligibility = LiveReplayEligibility {
        active_start_owners: &plan.active_start_owners,
        active_start_positions: &plan.active_start_positions,
        preserved_active_start_owners: &state.preserved_active_start_owners,
        direct_materialized_actions: &state.direct_materialized_actions,
        existing_spawned_clip_owners: &state.existing_spawned_clip_owners,
    };
    for (track_id, action_id, action, action_position, _) in
        plan.timeline_actions_before_target.iter().cloned()
    {
        let owner = (track_id.clone(), action_id.clone());
        let should_live_replay_active_start = should_live_replay_active_start(
            reason,
            &owner,
            &timeline.triggered_actions,
            &live_replay_eligibility,
        );
        tracing::debug!(
            action_id,
            position = ?action_position,
            "Marking action as triggered for seek"
        );

        if !should_live_replay_active_start {
            timeline
                .triggered_actions
                .insert(owner.clone(), action_position);
        }
        if plan.completed_noop_actions.contains(&owner) {
            tracing::debug!(
                action_id,
                position = ?action_position,
                "Skipping completed aggregate during seek"
            );
            continue;
        }
        if state.direct_materialized_actions.contains(&owner) {
            tracing::debug!(
                action_id,
                position = ?action_position,
                "Skipping directly materialized aggregate during seek"
            );
            continue;
        }
        if should_live_replay_active_start {
            tracing::debug!(
                action_id,
                position = ?action_position,
                "Leaving active clip start untriggered for live replay"
            );
            continue;
        }

        let action =
            normalized_registered_action_kind(&action, dispatch.action_registry.as_deref())
                .unwrap_or(action);
        if let ActionKind::SetClipRate { uid, .. } = action
            && state.direct_materialized_clip_uids.contains(&uid)
        {
            tracing::debug!(
                action_id,
                position = ?action_position,
                "Skipping directly materialized clip rate during seek"
            );
            continue;
        }
        match action {
            ActionKind::SetClipRate { uid, rate } => {
                let Some((_entity, id)) =
                    resolve_clip_entity_and_id(clip_snapshot, &uid, "seek-set-clip-rate")
                else {
                    continue;
                };
                write_timeline_clip_action(
                    &mut dispatch.ev_clip,
                    &mut dispatch.timeline_command_origins,
                    ClipAction::SetRate {
                        clip_id: IdExpr::Single(id),
                        rate,
                    },
                );
            }
            ActionKind::DeskEval(command) => {
                match timeline.timeline.nondeterministic_seek_behavior {
                    TimelineNondeterministicSeekBehavior::Ignore => {
                        tracing::warn!(
                            command,
                            track_id,
                            action_id,
                            position = ?action_position,
                            "Skipping non-deterministic timeline action during seek reconstruction"
                        );
                    }
                    TimelineNondeterministicSeekBehavior::Dispatch => {
                        write_timeline_desk_action(
                            &mut dispatch.ev_desk,
                            &mut dispatch.timeline_command_origins,
                            command,
                        );
                    }
                }
            }
            ActionKind::RegisteredAction(action) => {
                match timeline.timeline.nondeterministic_seek_behavior {
                    TimelineNondeterministicSeekBehavior::Ignore => {
                        tracing::warn!(
                            action_id = action.id.as_str(),
                            track_id,
                            action_id,
                            position = ?action_position,
                            "Skipping non-deterministic registered action during seek reconstruction"
                        );
                    }
                    TimelineNondeterministicSeekBehavior::Dispatch => {
                        if let Some(action_invocations) = dispatch.action_invocations.as_mut() {
                            action_invocations.write(
                                ActionInvocation::trigger(action, ActionSurface::Timeline)
                                    .with_source(format!(
                                        "Timeline {} action {} seek reconstruction",
                                        timeline.timeline.identifiers.id, action_id
                                    )),
                            );
                        } else {
                            tracing::warn!(
                                track_id,
                                action_id,
                                "Registered action invocation is unavailable during seek reconstruction"
                            );
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies live replay is limited to changed, unpreserved mutation starts.
    #[test]
    fn live_replay_requires_changed_unpreserved_mutation_start() {
        let owner = ("track-a".to_owned(), "start".to_owned());
        let active_start_owners = HashSet::from([owner.clone()]);
        let active_start_positions = HashMap::from([(owner.clone(), Duration::from_secs(2))]);
        let previously_triggered = HashMap::from([(owner.clone(), Duration::from_secs(1))]);
        let empty_owners = HashSet::new();
        let existing_owners = HashSet::from([owner.clone()]);
        let eligible = LiveReplayEligibility {
            active_start_owners: &active_start_owners,
            active_start_positions: &active_start_positions,
            preserved_active_start_owners: &empty_owners,
            direct_materialized_actions: &empty_owners,
            existing_spawned_clip_owners: &existing_owners,
        };

        assert!(should_live_replay_active_start(
            TimelineReconstructionReason::ActionsChanged,
            &owner,
            &previously_triggered,
            &eligible,
        ));
        assert!(!should_live_replay_active_start(
            TimelineReconstructionReason::Seek,
            &owner,
            &previously_triggered,
            &eligible,
        ));
        let preserved_owners = HashSet::from([owner.clone()]);
        let preserved = LiveReplayEligibility {
            preserved_active_start_owners: &preserved_owners,
            ..eligible
        };
        assert!(!should_live_replay_active_start(
            TimelineReconstructionReason::ActionsChanged,
            &owner,
            &previously_triggered,
            &preserved,
        ));
    }
}
