// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Trigger reset and spawned-entity tracking commit stages for timeline reconstruction.

use super::*;

/// Resets authored trigger bookkeeping before reconstructed playback is materialized.
pub(super) fn reset_timeline_reconstruction_tracking(timeline: &mut MaterializedTimeline) {
    timeline.reset_action_triggers();
}

/// Merges reconstructed entity ownership into the timeline tracking map.
fn merge_spawned_entity_tracking(
    destination: &mut HashMap<Entity, (String, String, SpawnedEntityType)>,
    reconstructed: HashMap<Entity, (String, String, SpawnedEntityType)>,
) {
    destination.extend(reconstructed);
}

/// Commits all reconstructed runtime entity ownership after action dispatch completes.
pub(super) fn commit_timeline_reconstruction_tracking(
    timeline: &mut MaterializedTimeline,
    tracked_spawned_entities: HashMap<Entity, (String, String, SpawnedEntityType)>,
) {
    merge_spawned_entity_tracking(&mut timeline.spawned_entities, tracked_spawned_entities);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the commit stage preserves retained entries and records reconstructed ownership.
    #[test]
    fn tracking_commit_merges_reconstructed_entity_ownership() {
        let retained = Entity::from_bits(1);
        let reconstructed = Entity::from_bits(2);
        let mut destination = HashMap::from([(
            retained,
            (
                "track-a".to_owned(),
                "retained".to_owned(),
                SpawnedEntityType::Cue,
            ),
        )]);

        merge_spawned_entity_tracking(
            &mut destination,
            HashMap::from([(
                reconstructed,
                (
                    "track-b".to_owned(),
                    "reconstructed".to_owned(),
                    SpawnedEntityType::Clip,
                ),
            )]),
        );

        assert_eq!(destination.len(), 2);
        assert!(destination.contains_key(&retained));
        assert!(destination.contains_key(&reconstructed));
    }
}
