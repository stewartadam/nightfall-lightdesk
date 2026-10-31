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

/// Send OSC state on resync.
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    sources: Res<OscSources>,
    mappings: Res<OscMappings>,
    diagnostics: Res<OscMappingDiagnostics>,
    last_event: Res<LastOscEvent>,
    status: Res<OscRuntimeStatus>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };

    send_sources(&sources, &broadcaster);
    send_mappings(&mappings, &broadcaster);
    send_diagnostics(&diagnostics, &broadcaster);
    send_listener_status(&status, &broadcaster);
    if let Some(ref event) = last_event.0 {
        send_last_event(event, &broadcaster);
    }
}

/// Send OSC state updates when resources change.
pub fn send_osc_state(
    sources: Res<OscSources>,
    mappings: Res<OscMappings>,
    diagnostics: Res<OscMappingDiagnostics>,
    last_event: Res<LastOscEvent>,
    status: Res<OscRuntimeStatus>,
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
    if sources.is_changed() {
        send_sources(&sources, &broadcaster);
    }
    if mappings.is_changed() {
        send_mappings(&mappings, &broadcaster);
    }
    if diagnostics.is_changed() {
        send_diagnostics(&diagnostics, &broadcaster);
    }
    if status.is_changed() {
        send_listener_status(&status, &broadcaster);
    }
    if last_event.is_changed()
        && let Some(ref event) = last_event.0
    {
        send_last_event(event, &broadcaster);
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

fn send_sources(sources: &OscSources, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscSources(&sources.0),
    );
}

fn send_mappings(mappings: &OscMappings, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscMappings(mappings.mappings()),
    );
}

/// Sends the current OSC mapping diagnostics to websocket clients.
fn send_diagnostics(diagnostics: &OscMappingDiagnostics, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscMappingDiagnostics(&diagnostics.0),
    );
}

fn send_last_event(event: &OscLastEvent, broadcaster: &ClientEventSink) {
    broadcaster.publish(DISCRIMINATOR_DROPPABLE, &OscWsMessage::OscLastEvent(event));
}

fn send_listener_status(status: &OscRuntimeStatus, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscListenerStatus(&status.0),
    );
}
