// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The client feed of network output send failures.

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use web_time::Instant;

use super::{NetworkOutputSendFailure, NetworkStats};

/// How often the failures are compared with the last list sent, since a failing output updates
/// its failure count on every output tick.
const CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// Network output messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum NetworkOutputWsMessage<'a> {
    /// Outputs whose last sends failed, one entry per physical output.
    NetworkOutputSendFailures(&'a [NetworkOutputSendFailure]),
}

impl ResourceFeed for NetworkStats {
    /// Publishes the send failures list as a snapshot, so a newer list replaces one still queued.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_DROPPABLE,
            &NetworkOutputWsMessage::NetworkOutputSendFailures(self.recent_send_failures()),
        );
    }
}

/// The failures list the feed last passed for, and when.
#[derive(Default)]
pub(crate) struct CheckedFailures {
    failures: Option<Vec<NetworkOutputSendFailure>>,
    checked_at: Option<Instant>,
}

/// Run condition that passes when the failures list differs from the one it last passed for,
/// comparing at most every [`CHECK_INTERVAL`].
pub(crate) fn send_failures_changed(
    stats: Res<NetworkStats>,
    mut checked: Local<CheckedFailures>,
) -> bool {
    let now = Instant::now();
    if checked
        .checked_at
        .is_some_and(|checked_at| now.duration_since(checked_at) < CHECK_INTERVAL)
    {
        return false;
    }
    checked.checked_at = Some(now);
    let failures = stats.recent_send_failures();
    if checked.failures.as_deref() == Some(failures) {
        return false;
    }
    checked.failures = Some(failures.to_vec());
    true
}
