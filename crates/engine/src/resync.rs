// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Full state resync requests and the clients their snapshots go to.
//!
//! A client resyncs when it connects or reconnects, and only that client needs the snapshot.
//! Resync handlers read the frame's requests through [`ResyncReplies`], which hands them a sink
//! addressing just the requesting clients, so one phone reconnecting does not push the whole show
//! down every other connection.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;

use crate::EngineCommand;
use crate::prelude::{
    Audience, ClientEventSink, CommandEnvelope, CommandId, PendingAudience, PendingReplies,
};

/// Fact published when an external command or internal transition requests a state resync.
#[derive(Clone, Debug, Message)]
pub struct ResyncRequested {
    /// User command awaiting completion after the resync, when externally requested.
    pub command_id: Option<CommandId>,
    /// Clients that need the resynced state.
    pub audience: Audience,
}

/// Converts semantic resync commands into the event consumed across plugin crates, addressed to
/// the client that sent each command.
pub(crate) fn begin_resync(
    mut commands: MessageReader<CommandEnvelope<EngineCommand>>,
    mut resync_requests: MessageWriter<ResyncRequested>,
) {
    for command in commands.read() {
        if matches!(command.command, EngineCommand::ResyncState) {
            resync_requests.write(ResyncRequested {
                command_id: Some(command.command_id),
                audience: Audience::of_reply_target(&command.reply_target),
            });
        }
    }
}

/// Returns who `requests` ask to be resynced, or `None` when there are none.
pub fn resync_audience<'a>(
    requests: impl IntoIterator<Item = &'a ResyncRequested>,
) -> Option<PendingAudience> {
    let mut pending = PendingReplies::default();
    pending.request_each(requests.into_iter().map(|request| request.audience));
    pending.take()
}

/// This frame's resync requests and the client sink their snapshots go out on.
#[derive(SystemParam)]
pub struct ResyncReplies<'w, 's> {
    requests: MessageReader<'w, 's, ResyncRequested>,
    sink: Option<Res<'w, ClientEventSink>>,
}

impl ResyncReplies<'_, '_> {
    /// Reads this frame's resync requests and returns a sink addressing only the clients that
    /// made them, or `None` when no client asked or no host adapter is attached.
    ///
    /// Requests from several clients in one frame share the sink, so each snapshot is still
    /// encoded once.
    pub fn sink(&mut self) -> Option<ClientEventSink> {
        let audience = resync_audience(self.requests.read())?;
        let sink = self.sink.as_deref()?;
        Some(sink.narrowed_to(audience.into_audiences()))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::prelude::ClientId;

    /// Builds a request addressed to `audience`.
    fn request(audience: Audience) -> ResyncRequested {
        ResyncRequested {
            command_id: None,
            audience,
        }
    }

    /// Verifies requests from distinct clients each get the snapshot once.
    #[test]
    fn audiences_are_deduplicated() {
        let requests = [
            request(Audience::Client(ClientId(1))),
            request(Audience::Client(ClientId(2))),
            request(Audience::Client(ClientId(1))),
        ];

        assert_eq!(
            resync_audience(&requests),
            Some(PendingAudience::Clients(Arc::from([
                Audience::Client(ClientId(1)),
                Audience::Client(ClientId(2)),
            ])))
        );
    }

    /// Verifies a request for every client covers the targeted ones, so no client gets it twice.
    #[test]
    fn broadcast_request_absorbs_targeted_ones() {
        let requests = [
            request(Audience::Client(ClientId(1))),
            request(Audience::All),
        ];

        assert_eq!(resync_audience(&requests), Some(PendingAudience::Everyone));
        assert_eq!(resync_audience(&[]), None);
    }
}
