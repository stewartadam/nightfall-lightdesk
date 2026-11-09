// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Whether the open show's draft is still being saved, published to clients so they can keep a
//! warning up and confirm before closing while saves fail.

use bevy::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;

use super::DraftSaveOutcome;

/// Whether the open show's most recent draft save failed.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Resource)]
#[typeshare::typeshare]
pub struct DraftSaveStatus {
    /// Why the most recent draft save failed; cleared by the next save that works.
    pub error: Option<String>,
}

/// Draft save messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum DraftSaveWsMessage<'a> {
    /// Whether the open show's most recent draft save failed.
    DraftSaveStatus(&'a DraftSaveStatus),
}

impl ResourceFeed for DraftSaveStatus {
    /// Publishes the draft save status, which a client that connects later also receives.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DraftSaveWsMessage::DraftSaveStatus(self),
        );
    }
}

/// Records the result of a draft save in the status clients follow.
///
/// The status is only marked changed when its error changes, so a drafts folder that keeps
/// failing republishes nothing on each autosave.
pub(crate) fn record_draft_save_result(
    status: &mut ResMut<DraftSaveStatus>,
    result: &Result<DraftSaveOutcome, String>,
) {
    let error = result.as_ref().err();
    if status.error.as_ref() != error {
        status.error = error.cloned();
    }
}

/// Clears a recorded draft save failure after a full showfile save, which rewrites the working
/// draft as well and so shows drafts can be saved again.
pub(crate) fn clear_draft_save_failure(status: &mut ResMut<DraftSaveStatus>) {
    if status.error.is_some() {
        status.error = None;
    }
}

#[cfg(test)]
mod tests {
    use bevy::ecs::system::RunSystemOnce;

    use super::*;

    /// Records `result` in the world's draft save status and returns whether the status was
    /// marked changed, which is what republishes it to clients.
    fn record(world: &mut World, result: Result<DraftSaveOutcome, String>) -> bool {
        world.clear_trackers();
        world
            .run_system_once(move |mut status: ResMut<DraftSaveStatus>| {
                record_draft_save_result(&mut status, &result);
            })
            .expect("record draft save result");
        world.is_resource_changed::<DraftSaveStatus>()
    }

    /// A failure is published once, repeats of it publish nothing, and the next save that works
    /// clears it.
    #[test]
    fn draft_save_status_follows_failures_without_republishing_repeats() {
        let mut world = World::new();
        world.init_resource::<DraftSaveStatus>();

        assert!(!record(&mut world, Ok(DraftSaveOutcome::SkippedClean)));
        assert!(record(&mut world, Err("disk full".to_string())));
        assert_eq!(
            world.resource::<DraftSaveStatus>().error.as_deref(),
            Some("disk full")
        );
        assert!(!record(&mut world, Err("disk full".to_string())));
        assert!(record(&mut world, Ok(DraftSaveOutcome::SavedDirtyDraft)));
        assert_eq!(world.resource::<DraftSaveStatus>().error, None);
    }
}
