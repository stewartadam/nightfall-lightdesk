// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Publishes the parked parameters to clients.

use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::state::{ParkedParameter, ParkedParameters};

/// Park messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum ParkWsMessage<'a> {
    /// Every parked parameter and its value, ordered by fixture, element and attribute.
    ParkedParameters(&'a [ParkedParameter]),
}

impl ResourceFeed for ParkedParameters {
    /// Publishes every parked parameter.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ParkWsMessage::ParkedParameters(&self.entries()),
        );
    }
}
