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
use serde::Serialize;
use web_time::Instant;

use crate::client_bridge::{ClientEventSink, DISCRIMINATOR_DROPPABLE};

/// How often the metrics are sent.
const SEND_INTERVAL: Duration = Duration::from_millis(100);

/// Metrics messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum MetricsWsMessage<'a> {
    /// Smoothed value of every diagnostic that has measurements, keyed by diagnostic path.
    Metrics(#[typeshare(serialized_as = "Record<string, number>")] &'a BTreeMap<&'a str, f64>),
}

/// Sends every enabled diagnostic's smoothed value every [`SEND_INTERVAL`]; diagnostics without
/// measurements yet are left out.
pub(crate) fn send_metrics_at_interval(
    diagnostics: Option<Res<DiagnosticsStore>>,
    mut last_sent: Local<Option<Instant>>,
    broadcaster: Res<ClientEventSink>,
) {
    let Some(diagnostics) = diagnostics else {
        return;
    };
    if last_sent.is_some_and(|sent_at| sent_at.elapsed() < SEND_INTERVAL) {
        return;
    }
    *last_sent = Some(Instant::now());
    let values: BTreeMap<&str, f64> = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.is_enabled)
        .filter_map(|diagnostic| {
            diagnostic
                .smoothed()
                .map(|value| (diagnostic.path().as_str(), value))
        })
        .collect();
    broadcaster.publish(DISCRIMINATOR_DROPPABLE, &MetricsWsMessage::Metrics(&values));
}
