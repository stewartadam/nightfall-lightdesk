// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The metrics feed: every Bevy diagnostic's smoothed value, keyed by its path.
//!
//! Each domain registers and records its own diagnostics, such as the compositor's layer count
//! or a timeline system's run time, so a new measurement reaches clients without changing this
//! feed.

use std::collections::BTreeMap;
use std::time::Duration;

use bevy_diagnostic::DiagnosticsStore;
use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use serde::Serialize;

use crate::client_bridge::{ClientEventSink, DISCRIMINATOR_DROPPABLE};
use crate::client_feed::ClientFeed;

/// How often the metrics are sent.
pub(crate) const SEND_INTERVAL: Duration = Duration::from_millis(100);

/// Metrics messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum MetricsWsMessage<'a> {
    /// Smoothed value of every diagnostic that has measurements, keyed by diagnostic path.
    Metrics(#[typeshare(serialized_as = "Record<string, number>")] &'a BTreeMap<&'a str, f64>),
}

/// The metrics feed, sent every [`SEND_INTERVAL`].
#[derive(SystemParam)]
pub(crate) struct MetricsFeed<'w> {
    diagnostics: Option<Res<'w, DiagnosticsStore>>,
}

impl ClientFeed for MetricsFeed<'static> {
    /// Publishes every enabled diagnostic's smoothed value; diagnostics without measurements yet
    /// are left out, and nothing is sent when no diagnostics are recorded.
    fn publish(feed: &MetricsFeed<'_>, sink: &ClientEventSink) {
        let Some(diagnostics) = feed.diagnostics.as_deref() else {
            return;
        };
        let values: BTreeMap<&str, f64> = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.is_enabled)
            .filter_map(|diagnostic| {
                diagnostic
                    .smoothed()
                    .map(|value| (diagnostic.path().as_str(), value))
            })
            .collect();
        sink.publish(DISCRIMINATOR_DROPPABLE, &MetricsWsMessage::Metrics(&values));
    }
}
