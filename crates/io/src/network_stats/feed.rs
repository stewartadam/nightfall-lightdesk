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

/// Shortest time between two sends, since a failing output updates its failure count on every
/// output tick.
const MIN_SEND_INTERVAL: Duration = Duration::from_millis(100);

/// Network output messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum NetworkOutputWsMessage<'a> {
    /// Outputs whose last sends failed, one entry per physical output.
    NetworkOutputSendFailures(&'a [NetworkOutputSendFailure]),
}

/// Sends the failures list. It is only sent when it changes, so it is never dropped: a dropped
/// recovery would leave the warning showing.
fn send_failures(failures: &[NetworkOutputSendFailure], broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &NetworkOutputWsMessage::NetworkOutputSendFailures(failures),
    );
}

/// What the failures feed last sent, and when.
#[derive(Default)]
pub(crate) struct SentFailures {
    failures: Vec<NetworkOutputSendFailure>,
    sent_at: Option<Instant>,
}

/// Sends the failures list when it differs from the last one sent, at most every
/// [`MIN_SEND_INTERVAL`].
pub(crate) fn send_failures_on_change(
    stats: Res<NetworkStats>,
    mut sent: Local<SentFailures>,
    broadcaster: Res<ClientEventSink>,
) {
    let failures = stats.recent_send_failures();
    if sent.failures == failures
        || sent
            .sent_at
            .is_some_and(|sent_at| sent_at.elapsed() < MIN_SEND_INTERVAL)
    {
        return;
    }
    send_failures(failures, &broadcaster);
    sent.failures = failures.to_vec();
    sent.sent_at = Some(Instant::now());
}

/// Sends the failures list to a client that asked for a full resync.
pub(crate) fn handle_resync_state(mut resync: ResyncReplies, stats: Res<NetworkStats>) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };
    send_failures(stats.recent_send_failures(), &broadcaster);
}
