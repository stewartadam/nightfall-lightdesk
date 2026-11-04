// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket publication of clip definitions, clip deletions, armed launches and running
//! playbacks.

use std::collections::HashSet;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::launch_quantize::{ArmedLaunch, ArmedLaunches};
use crate::{Clip, ClipCommand, MaterializedClip};

mod playbacks;

pub use playbacks::InstanceInfo;
pub(crate) use playbacks::{
    handle_resync_state as handle_playbacks_resync, refresh_playbacks_at_interval,
    send_playbacks_on_change,
};

/// A clip definition as sent to clients, with whether it is running.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OutboundClipLocal {
    /// The clip definition.
    pub clip: Clip,
    /// Whether this clip has an active playback
    pub is_active: bool,
}

/// Clip messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum ClipWsMessage<'a> {
    /// Definition of all clips
    ClipDefinitions(&'a [OutboundClipLocal]),
    /// A clip command echoed to clients
    ClipCommand(&'a ClipCommand),
    /// Live clip launches waiting for the next beat or bar
    ArmedLaunches(&'a [ArmedLaunch]),
}

/// Sends every clip definition, marking the clips that are running.
fn send_clips(
    clips: &Query<&Clip>,
    materialized_clips: &Query<&MaterializedClip>,
    broadcaster: &ClientEventSink,
) {
    let active_clip_ids: HashSet<u32> = materialized_clips
        .iter()
        .map(|materialized| materialized.clip_id)
        .collect();
    let clips: Vec<OutboundClipLocal> = clips
        .iter()
        .map(|clip| OutboundClipLocal {
            clip: clip.clone(),
            is_active: active_clip_ids.contains(&clip.identifiers.id),
        })
        .collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ClipWsMessage::ClipDefinitions(&clips),
    );
    tracing::trace!("Sending clip definitions to websocket clients");
}

/// Publishes clip definitions when a playback starts or stops.
///
/// Runs where removals are still visible, and consumes every removal so one removal does not
/// trigger a send in the next update too.
pub fn send_clips_on_change(
    clips: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    added_materialized: Query<(), Added<MaterializedClip>>,
    mut removed_materialized: RemovedComponents<MaterializedClip>,
    broadcaster: Res<ClientEventSink>,
) {
    let materialized_removed = !removed_materialized.is_empty();
    removed_materialized.clear();
    if added_materialized.is_empty() && !materialized_removed {
        return;
    }
    tracing::trace!("Sending clips due to MaterializedClip change");
    send_clips(&clips, &materialized_clips, &broadcaster);
}

/// Publishes clip definitions when any clip is added or edited, for example renamed.
pub fn send_clips_on_clip_change(
    clips: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    changed_clips: Query<(), Changed<Clip>>,
    broadcaster: Res<ClientEventSink>,
) {
    if changed_clips.is_empty() {
        return;
    }
    tracing::trace!("Sending clips due to Clip component change");
    send_clips(&clips, &materialized_clips, &broadcaster);
}

/// Echoes clip deletions to clients.
///
/// Renames are not echoed, because the echo would arrive before the rename is known to have
/// succeeded; [`send_clips_on_clip_change`] sends the full definitions after it instead.
pub fn forward_clip_commands(
    mut events: MessageReader<CommandEnvelope<ClipCommand>>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        if matches!(event.command, ClipCommand::DeleteClip(..)) {
            tracing::trace!(?event, "Forwarding ClipCommand to UI");
            broadcaster.publish(
                DISCRIMINATOR_NON_DROPPABLE,
                &ClipWsMessage::ClipCommand(&event.command),
            );
        }
    }
}

/// Sends the live clip launches waiting for the next beat or bar.
fn send_armed_launches(armed: &ArmedLaunches, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ClipWsMessage::ArmedLaunches(&armed.status()),
    );
}

/// Publishes armed launches when a launch is armed, fires, or is cancelled.
pub fn send_armed_launches_on_change(armed: Res<ArmedLaunches>, broadcaster: Res<ClientEventSink>) {
    if armed.is_changed() {
        send_armed_launches(&armed, &broadcaster);
    }
}

/// Sends clip definitions and armed launches to clients that asked for a full resync.
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    clips: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    armed: Res<ArmedLaunches>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };
    send_clips(&clips, &materialized_clips, &broadcaster);
    send_armed_launches(&armed, &broadcaster);
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Verifies a client's resync sends clip definitions and armed launches only to that
    /// client, not to every connection.
    #[test]
    fn resync_replies_only_to_requester() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let mut app = App::new();
        app.add_message::<ResyncRequested>();
        app.insert_resource(ClientEventSink::new(tx));
        app.init_resource::<ArmedLaunches>();
        app.add_systems(Update, handle_resync_state);

        let requester = Audience::Client(ClientId(7));
        app.world_mut().write_message(ResyncRequested {
            command_id: None,
            audience: requester,
        });
        app.update();

        let audiences: Vec<Audience> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| frame.audience)
            .collect();
        assert_eq!(audiences, vec![requester, requester]);
    }
}
