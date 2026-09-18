// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue instance materialization for evaluated timeline seek state.

use super::*;

/// Cue-specific dependencies used during timeline reconstruction.
#[derive(SystemParam)]
pub struct TimelineCueSeekMaterializer<'w, 's> {
    /// Cue definitions used to rebuild evaluated fire-cue instance.
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    /// Optional color paths referenced by reconstructed cues.
    color_path_data_provider: Option<Res<'w, DataProvider<ColorPath>>>,
    /// Optional Blueprints referenced by reconstructed cues.
    blueprint_data_provider: Option<Res<'w, DataProvider<Blueprint>>>,
    /// Fixture data used to resolve cue targets and durations.
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    /// Spatial selection resolver used to expand cue selections.
    selection_resolver: SpatialSelectionResolver<'w>,
    /// Parameter instances used to materialize cue output.
    parameter_query: Query<'w, 's, InstanceRef<'static, Parameter>>,
}

/// Returns whether an evaluated fire cue still needs materialization.
fn should_materialize_cue(
    materializer_registry: TimelineSeekMaterializerRegistry,
    instance: &EvaluatedInstanceState,
    preserved_fire_cue_owners: &HashSet<(String, String)>,
) -> bool {
    materializer_registry.materializes_evaluated_fire_cue(instance)
        && !preserved_fire_cue_owners.contains(&(
            instance.owner.track_id.clone(),
            instance.owner.action_id.clone(),
        ))
}

/// Materializes evaluated fire cues and records their timeline ownership.
pub(super) fn materialize_timeline_cues(
    materializer: &TimelineCueSeekMaterializer,
    commands: &mut Commands,
    plan: &TimelineReconstructionPlan,
    timeline_uid: Uuid,
    state: &mut TimelineReconciliationState,
) {
    let materializer_registry = TimelineSeekMaterializerRegistry;
    for instance in &plan.evaluated_timeline_state.instances {
        if !should_materialize_cue(
            materializer_registry,
            instance,
            &state.preserved_fire_cue_owners,
        ) {
            continue;
        }
        if let Some(entity) = materialize_evaluated_fire_cue(
            commands,
            instance,
            timeline_uid,
            &materializer.cue_data_provider,
            materializer.color_path_data_provider.as_deref(),
            materializer.blueprint_data_provider.as_deref(),
            &materializer.fixture_data_provider,
            &materializer.selection_resolver,
            &materializer.parameter_query,
        ) {
            state.tracked_spawned_entities.insert(
                entity,
                (
                    instance.owner.track_id.clone(),
                    instance.owner.action_id.clone(),
                    SpawnedEntityType::Cue,
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use nightfall_playback_planner::TimelinePlaybackOwner;

    use super::*;

    /// Returns an active evaluated instance for focused cue routing tests.
    fn evaluated_instance(source: PlannedPlaybackSource) -> EvaluatedInstanceState {
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
            lifecycle: PlannedPlaybackLifecycle::Active,
        }
    }

    /// Verifies cue materialization honors both source routing and preservation state.
    #[test]
    fn cue_materialization_skips_preserved_and_non_cue_instances() {
        let registry = TimelineSeekMaterializerRegistry;
        let cue = evaluated_instance(PlannedPlaybackSource::Cue(Uuid::new_v4()));
        let fx = evaluated_instance(PlannedPlaybackSource::Fx(Uuid::new_v4()));

        assert!(should_materialize_cue(registry, &cue, &HashSet::new()));
        assert!(!should_materialize_cue(
            registry,
            &cue,
            &HashSet::from([("track-a".to_owned(), "action-a".to_owned())]),
        ));
        assert!(!should_materialize_cue(registry, &fx, &HashSet::new()));
    }
}
