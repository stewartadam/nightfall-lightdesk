// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for OSC input.

use bevy_ecs::prelude::*;
use nightfall_actions::BindingDiagnostic;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::command::{OscExternalEval, OscLastEvent, OscListenerStatus, OscMapping};
use crate::mapping::OscMappings;
use crate::{LastOscEvent, OscControlTouches, OscMappingDiagnostics, OscRuntimeStatus, OscSources};

/// OSC source info for UI display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct OscSource {
    /// Source socket address (`ip:port`).
    pub address: String,
}

/// Websocket messages emitted by the OSC plugin.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
#[allow(clippy::enum_variant_names)]
pub enum OscWsMessage<'a> {
    /// Known source list.
    OscSources(&'a [OscSource]),
    /// Configured mappings.
    OscMappings(&'a [OscMapping]),
    /// Last observed OSC event.
    OscLastEvent(&'a OscLastEvent),
    /// Listener bind status.
    OscListenerStatus(&'a OscListenerStatus),
    /// External eval metadata for CommandLine source tagging.
    OscExternalEval(&'a OscExternalEval),
    /// OSC mappings that cannot currently invoke their action, and why.
    OscMappingDiagnostics(&'a [BindingDiagnostic]),
    /// Messages received in one frame while controller mapping mode is active, in order.
    ///
    /// Unlike `OscLastEvent`, these are never dropped or coalesced to one message per frame,
    /// so a mapping client reliably arms the touched address with its press and release.
    OscControlTouched(&'a [OscLastEvent]),
}

/// Sends the messages received while controller mapping mode is active, in order, draining
/// them.
pub fn send_control_touches(
    mut touches: ResMut<OscControlTouches>,
    broadcaster: Res<ClientEventSink>,
) {
    if !touches.0.is_empty() {
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscControlTouched(&touches.0),
        );
        touches.0.clear();
    }
}

/// Broadcast external eval metadata for command-line source tags.
pub fn send_external_evals(
    mut events: MessageReader<OscExternalEval>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscExternalEval(event),
        );
    }
}

impl ResourceFeed for OscSources {
    /// Publishes the known OSC sources.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscSources(&self.0),
        );
    }
}

impl ResourceFeed for OscMappings {
    /// Publishes the configured OSC mappings.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscMappings(self.mappings()),
        );
    }
}

impl ResourceFeed for OscMappingDiagnostics {
    /// Publishes the OSC mappings that cannot currently invoke their action.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscMappingDiagnostics(&self.0),
        );
    }
}

impl ResourceFeed for OscRuntimeStatus {
    /// Publishes the listener bind status.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscListenerStatus(&self.0),
        );
    }
}

impl ResourceFeed for LastOscEvent {
    /// Publishes the last observed OSC event, if any, as a snapshot a newer event replaces.
    fn publish(&self, sink: &ClientEventSink) {
        if let Some(event) = &self.0 {
            sink.publish(DISCRIMINATOR_DROPPABLE, &OscWsMessage::OscLastEvent(event));
        }
    }
}
