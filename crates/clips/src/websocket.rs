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
use bevy_ecs::system::SystemParam;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::launch_quantize::{ArmedLaunch, ArmedLaunches};
use crate::{Clip, ClipCommand, MaterializedClip};

mod playbacks;

pub use playbacks::InstanceInfo;
pub(crate) use playbacks::{
    PlaybacksFeed, REFRESH_INTERVAL as PLAYBACKS_REFRESH_INTERVAL, playbacks_changed,
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

/// The clip definitions feed, marking the clips that are running.
#[derive(SystemParam)]
pub(crate) struct ClipsFeed<'w, 's> {
    clips: Query<'w, 's, &'static Clip>,
    materialized_clips: Query<'w, 's, &'static MaterializedClip>,
}

impl ClientFeed for ClipsFeed<'static, 'static> {
    /// Publishes every clip definition with whether it has an active playback.
    fn publish(feed: &ClipsFeed<'_, '_>, sink: &ClientEventSink) {
        let active_clip_ids: HashSet<u32> = feed
            .materialized_clips
            .iter()
            .map(|materialized| materialized.clip_id)
            .collect();
        let clips: Vec<OutboundClipLocal> = feed
            .clips
            .iter()
            .map(|clip| OutboundClipLocal {
                clip: clip.clone(),
                is_active: active_clip_ids.contains(&clip.identifiers.id),
            })
            .collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ClipWsMessage::ClipDefinitions(&clips),
        );
    }
}

/// Run condition that passes when a clip is added or edited, for example renamed, or a playback
/// starts or stops.
///
/// Runs where removals are still visible, and consumes every removal so one removal does not
/// pass in the next update too.
pub(crate) fn clips_changed(
    changed_clips: Query<(), Changed<Clip>>,
    added_materialized: Query<(), Added<MaterializedClip>>,
    mut removed_materialized: RemovedComponents<MaterializedClip>,
) -> bool {
    let materialized_removed = removed_materialized.read().count() > 0;
    materialized_removed || !added_materialized.is_empty() || !changed_clips.is_empty()
}

/// Echoes clip deletions to clients.
///
/// Renames are not echoed, because the echo would arrive before the rename is known to have
/// succeeded; [`ClipsFeed`] sends the full definitions after it instead.
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

impl ResourceFeed for ArmedLaunches {
    /// Publishes the live clip launches waiting for the next beat or bar.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ClipWsMessage::ArmedLaunches(&self.status()),
        );
    }
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
        app.add_systems(
            Update,
            (
                resync_client_feed::<ClipsFeed>,
                resync_client_feed::<ResourceFeedParam<ArmedLaunches>>,
            ),
        );

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
