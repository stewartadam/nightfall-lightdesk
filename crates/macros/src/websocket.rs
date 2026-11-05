// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket ingress for macro commands and publication of macros and their live runs.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::runner::{MacroRunStatus, MacroRuns};

/// Macro messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum MacroWsMessage<'a> {
    /// Every macro definition.
    MacroDefinitions(&'a [Macro]),
    /// Every running macro body and the statement it is on.
    MacroRunStates(&'a [MacroRunStatus]),
}

/// Collects macro definitions in ID order.
fn sorted_macros(macros: &DataProvider<Macro>) -> Vec<Macro> {
    let mut macros: Vec<Macro> = macros.iter().map(|entry| entry.value().clone()).collect();
    macros.sort_by_key(|definition| definition.identifiers.id);
    macros
}

/// The macro definitions feed.
#[derive(SystemParam)]
pub(crate) struct MacrosFeed<'w> {
    macros: Res<'w, DataProvider<Macro>>,
}

impl ClientFeed for MacrosFeed<'static> {
    /// Publishes every macro definition in ID order.
    fn publish(feed: &MacrosFeed<'_>, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &MacroWsMessage::MacroDefinitions(&sorted_macros(&feed.macros)),
        );
    }
}

impl ResourceFeed for MacroRuns {
    /// Publishes every running macro body and the statement it is on.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &MacroWsMessage::MacroRunStates(&self.statuses()),
        );
    }
}

/// Run condition that passes when a run starts, moves to another statement or ends, and not
/// when the runs change without changing what clients are shown.
pub(crate) fn macro_runs_changed(
    runs: Res<MacroRuns>,
    mut last_passed: Local<Option<Vec<MacroRunStatus>>>,
) -> bool {
    if !runs.is_changed() && last_passed.is_some() {
        return false;
    }
    let statuses = runs.statuses();
    if last_passed.as_ref() == Some(&statuses) {
        return false;
    }
    *last_passed = Some(statuses);
    true
}
