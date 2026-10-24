// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Raw values held on output transport wire universes by `ch <transport>:U.A @ V`.
//!
//! Console `ch U.A` writes go through console space and reach the wire only where a route
//! routes them. A transport hold addresses the wire directly: the named output's universe
//! carries the held value over everything patched there until `release ch <transport>:U.A`.
//! Holds are kept by output target ID, so they follow the output if its delivery settings
//! change and can always be released by the name they were set with.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};
use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_engine::prelude::*;
use nightfall_io::{NetworkDmxOutputTargets, OutputTransport, UsbDmxOutputTargets};

use crate::prelude::*;
use crate::route_resolution::output_transport_from_target_id;

/// Resolves output transport target IDs (`sacn`, `udmx`, configured names) to the configured
/// output they name.
#[derive(SystemParam)]
pub struct OutputTargetResolver<'w> {
    network_outputs: Res<'w, NetworkDmxOutputTargets>,
    usb_outputs: Res<'w, UsbDmxOutputTargets>,
}

impl OutputTargetResolver<'_> {
    /// Returns the output a target ID names, or `None` when no configured output matches.
    pub fn resolve(&self, target: &str) -> Option<OutputTransport> {
        output_transport_from_target_id(target, &self.network_outputs, &self.usb_outputs)
    }

    /// Returns whether the output configuration changed since the system last ran.
    pub fn is_changed(&self) -> bool {
        self.network_outputs.is_changed() || self.usb_outputs.is_changed()
    }
}

/// Captures the current hold state of each wire channel so undo can put it back.
pub(crate) fn snapshot_held_channels(
    universes: &ConsoleDmxUniverses,
    target: &str,
    channels: impl IntoIterator<Item = DmxChannelRef>,
) -> Vec<HeldTransportDmxChannelState> {
    channels
        .into_iter()
        .map(|channel| HeldTransportDmxChannelState {
            target: target.to_string(),
            channel,
            held_value: universes.held_wire_value(target, channel.universe, channel.address),
        })
        .collect()
}

/// Checks that a hold names a configured output and only addresses existing wire slots.
fn validate_hold(
    resolver: &OutputTargetResolver,
    target: &str,
    channels: &DmxChannelExpr,
) -> Result<Vec<DmxChannelRef>, CommandError> {
    if resolver.resolve(target).is_none() {
        return Err(CommandError::new(
            "fixtures.unknown_output_target",
            format!("No DMX output is named '{target}'"),
        ));
    }
    let expanded = channels.expand();
    if let Some(invalid) = expanded.iter().find(|channel| {
        channel.universe == 0
            || channel.address == 0
            || usize::from(channel.address) > MAX_CHANNELS_PER_UNIVERSE
    }) {
        return Err(CommandError::new(
            "fixtures.invalid_dmx_channel",
            format!("{target}:{invalid} is not a DMX channel"),
        ));
    }
    Ok(expanded)
}

/// Holds wire channels for `SetTransportDmxChannels` commands. A command whose target names
/// no configured output, or that addresses a slot outside a universe, fails without holding
/// anything.
pub fn handle_set_transport_dmx_channels(
    mut events: MessageReader<CommandEnvelope<FixtureCommand>>,
    mut universes: ResMut<ConsoleDmxUniverses>,
    resolver: OutputTargetResolver,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let FixtureCommand::SetTransportDmxChannels {
            target,
            channels,
            value,
        } = &event.command
        else {
            continue;
        };
        let result = match validate_hold(&resolver, target, channels) {
            Ok(expanded) => {
                tracing::debug!(%target, %channels, value, "Holding transport DMX channels");
                for channel in expanded {
                    universes.hold_wire_value(target, channel.universe, channel.address, *value);
                }
                responder.succeed(event.command_id)
            }
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = result {
            tracing::error!(command_id = %event.command_id, %error, "transport_dmx_command_finish_failed");
        }
    }
}

/// Applies transport hold releases and undo restores, ignoring console channel operations.
pub fn handle_transport_dmx_operations(
    mut events: MessageReader<EngineOperationEnvelope<DmxOperation>>,
    mut universes: ResMut<ConsoleDmxUniverses>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        match &event.operation {
            DmxOperation::ReleaseTransportChannels { target, channels } => {
                for channel in channels.expand() {
                    universes.release_wire_value(target, channel.universe, channel.address);
                }
            }
            DmxOperation::RestoreTransportChannels { channels } => {
                for HeldTransportDmxChannelState {
                    target,
                    channel,
                    held_value,
                } in channels
                {
                    match held_value {
                        Some(value) => universes.hold_wire_value(
                            target,
                            channel.universe,
                            channel.address,
                            *value,
                        ),
                        None => {
                            universes.release_wire_value(target, channel.universe, channel.address)
                        }
                    }
                }
            }
            DmxOperation::ReleaseChannels { .. } | DmxOperation::RestoreChannels { .. } => {
                continue;
            }
        }
        if let Some(command_id) = event.command_id
            && let Err(error) = responder.succeed(command_id)
        {
            tracing::error!(%command_id, %error, "transport_dmx_operation_finish_failed");
        }
    }
}

/// Maps held wire channels onto output frames before composition, after holds or the output
/// configuration changed.
pub fn resolve_transport_holds(
    mut universes: ResMut<ConsoleDmxUniverses>,
    resolver: OutputTargetResolver,
) {
    let outputs_changed = resolver.is_changed();
    universes.resolve_held_wire_values(outputs_changed, |target| resolver.resolve(target));
}
