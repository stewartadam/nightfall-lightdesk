// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Provides a logical representation of DMX universes and their channel values.

use std::{collections::HashMap, time::Duration};

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_io::BindingTransport;
use nightfall_io::OutputTransport;
use web_time::Instant;

use crate::output_frames::ChannelWindow;
use crate::prelude::*;

/// Default timeout before an input universe is treated as stale.
pub const DEFAULT_INPUT_UNIVERSE_STALE_TIMEOUT_MS: u32 = 2000;

/// Configured age threshold for marking transport input universes as stale.
#[derive(Resource, Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputUniverseStaleTimeout(pub Duration);

impl Default for InputUniverseStaleTimeout {
    /// Returns the default input stale timeout resource.
    fn default() -> Self {
        Self(Duration::from_millis(
            DEFAULT_INPUT_UNIVERSE_STALE_TIMEOUT_MS.into(),
        ))
    }
}

/// Captures raw DMX input frames by transport and universe.
///
/// The `u16` values are universe IDs.
#[derive(Default, Resource)]
pub struct InputDmxUniverses {
    universes:
        HashMap<BindingTransport, HashMap<u16, [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE]>>,
    last_seen: HashMap<(BindingTransport, u16), Instant>,
    last_is_self: HashMap<(BindingTransport, u16), bool>,
}

impl InputDmxUniverses {
    /// Stores the latest raw DMX data for a transport + universe.
    pub fn set_universe(
        &mut self,
        transport: BindingTransport,
        universe_id: u16,
        data: [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE],
        received_at: Instant,
    ) {
        self.set_universe_with_self_flag(transport, universe_id, data, received_at, false);
    }

    /// Stores the latest raw DMX data for a transport + universe and marks whether it is local.
    pub fn set_universe_with_self_flag(
        &mut self,
        transport: BindingTransport,
        universe_id: u16,
        data: [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE],
        received_at: Instant,
        is_self_frame: bool,
    ) {
        let by_transport = self.universes.entry(transport).or_default();
        by_transport.insert(universe_id, data);
        self.last_seen.insert((transport, universe_id), received_at);
        self.last_is_self
            .insert((transport, universe_id), is_self_frame);
    }

    /// Iterates over all stored input universes.
    pub fn iter(
        &self,
    ) -> impl Iterator<
        Item = (
            BindingTransport,
            u16,
            &[ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE],
        ),
    > {
        self.universes.iter().flat_map(|(transport, universes)| {
            universes
                .iter()
                .map(move |(universe_id, data)| (*transport, *universe_id, data))
        })
    }

    /// Returns an immutable view of a transport/universe, creating a zeroed fallback on miss.
    pub fn get_universe(
        &self,
        transport: BindingTransport,
        universe_id: u16,
    ) -> [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE] {
        self.universes
            .get(&transport)
            .and_then(|by_universe| by_universe.get(&universe_id))
            .copied()
            .unwrap_or([0; MAX_CHANNELS_PER_UNIVERSE])
    }

    /// Borrows the latest frame of a transport/universe, if one was received.
    pub fn universe(
        &self,
        transport: BindingTransport,
        universe_id: u16,
    ) -> Option<&[ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE]> {
        self.universes
            .get(&transport)
            .and_then(|by_universe| by_universe.get(&universe_id))
    }

    /// Returns a mutable universe buffer, creating it if absent.
    pub fn get_universe_mut(
        &mut self,
        transport: BindingTransport,
        universe_id: u16,
    ) -> &mut [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE] {
        self.universes
            .entry(transport)
            .or_default()
            .entry(universe_id)
            .or_insert([0; MAX_CHANNELS_PER_UNIVERSE])
    }

    /// Returns age in milliseconds for the latest frame of a transport + universe.
    pub fn frame_age_ms(
        &self,
        transport: BindingTransport,
        universe_id: u16,
        now: Instant,
    ) -> Option<u32> {
        self.last_seen
            .get(&(transport, universe_id))
            .map(|last_seen| now.saturating_duration_since(*last_seen).as_millis() as u32)
    }

    /// Returns whether the latest frame for a transport + universe was detected as local.
    pub fn is_self_frame(&self, transport: BindingTransport, universe_id: u16) -> Option<bool> {
        self.last_is_self.get(&(transport, universe_id)).copied()
    }

    /// Clears all cached input DMX universes and age tracking metadata.
    pub fn clear(&mut self) {
        self.universes.clear();
        self.last_seen.clear();
        self.last_is_self.clear();
    }
}

/// Origin metadata for a console channel value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConsoleChannelOrigin {
    /// Channel currently owned by output routing from parameter state.
    OutputBinding,
    /// Channel currently owned by input binding from a transport universe.
    InputTransport {
        /// Input transport.
        transport: BindingTransport,
        /// Input universe ID.
        universe: u16,
    },
    /// Channel written by explicit manual command.
    ManualCommand,
    /// Channel written by system-level clear/release behavior.
    System,
}

/// DMX universe state owned by the console, including source metadata.
#[derive(Clone)]
struct ConsoleUniverse {
    values: [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE],
    origins: [Option<ConsoleChannelOrigin>; MAX_CHANNELS_PER_UNIVERSE],
}

impl Default for ConsoleUniverse {
    fn default() -> Self {
        Self {
            values: [0; MAX_CHANNELS_PER_UNIVERSE],
            origins: [None; MAX_CHANNELS_PER_UNIVERSE],
        }
    }
}

/// Returns whether a 1-indexed DMX address lies inside a universe.
fn is_valid_address(address: u16) -> bool {
    address != 0 && address as usize <= MAX_CHANNELS_PER_UNIVERSE
}

/// Writes `values` into consecutive channels of `universe` starting at a 1-indexed `address`.
///
/// Channels past the end of the universe are skipped with a warning.
fn write_channel_window(
    universe: &mut ConsoleUniverse,
    universe_id: u16,
    address: u16,
    values: &[ChannelDmxValue],
    origin: ConsoleChannelOrigin,
) {
    for (offset, value) in values.iter().enumerate() {
        let channel = address as usize + offset;
        if channel == 0 || channel > MAX_CHANNELS_PER_UNIVERSE {
            tracing::warn!(
                universe_id,
                address = channel,
                "Address is invalid, skipping"
            );
            continue;
        }
        universe.values[channel - 1] = *value;
        universe.origins[channel - 1] = Some(origin);
    }
}

/// Console DMX universe space with per-channel origin metadata.
///
/// Holds two numbering spaces:
/// - console universes, keyed by console numbering: fixture values at their console
///   addresses, manual `ch` writes, and input bindings targeting the console;
/// - output buffers, keyed by concrete transport and on-the-wire universe numbering, holding
///   direct fixture→transport values.
///
/// Neither is sent as-is: [`crate::output_frames::compose_output_frames`] combines them
/// according to the routing plan, so console space only reaches the wire through
/// console→transport bindings.
#[derive(Default, Resource)]
pub struct ConsoleDmxUniverses {
    universes: HashMap<u16, ConsoleUniverse>,
    output_universes: HashMap<(OutputTransport, u16), ConsoleUniverse>,
}

impl ConsoleDmxUniverses {
    /// Writes consecutive console channel values starting at a 1-indexed address.
    ///
    /// Values that would fall past the end of the universe are dropped with a warning.
    pub fn set_values(
        &mut self,
        universe_id: u16,
        address: u16,
        values: &[ChannelDmxValue],
        origin: ConsoleChannelOrigin,
    ) {
        if !is_valid_address(address) {
            tracing::warn!(universe_id, address, "Address is invalid, skipping");
            return;
        }
        let universe = self.universes.entry(universe_id).or_default();
        write_channel_window(universe, universe_id, address, values, origin);
    }

    /// Writes consecutive channel values for one output transport starting at a 1-indexed address.
    pub fn set_output_values(
        &mut self,
        transport: &OutputTransport,
        universe_id: u16,
        address: u16,
        values: &[ChannelDmxValue],
        origin: ConsoleChannelOrigin,
    ) {
        if !is_valid_address(address) {
            tracing::warn!(universe_id, address, "Address is invalid, skipping");
            return;
        }
        let universe = self
            .output_universes
            .entry((transport.clone(), universe_id))
            .or_default();
        write_channel_window(universe, universe_id, address, values, origin);
    }

    /// Copies every written channel of one transport's output buffer onto `target`.
    ///
    /// Returns whether the buffer exists. Unwritten channels leave `target` untouched so
    /// direct fixture output layers over routed console windows.
    pub fn overlay_output_universe(
        &self,
        transport: &OutputTransport,
        universe_id: u16,
        target: &mut [ChannelDmxValue],
    ) -> bool {
        let Some(universe) = self.output_universes.get(&(transport.clone(), universe_id)) else {
            return false;
        };
        for ((target, value), origin) in target
            .iter_mut()
            .zip(universe.values.iter())
            .zip(universe.origins.iter())
        {
            if origin.is_some() {
                *target = *value;
            }
        }
        true
    }

    /// Copies the written channels of a console universe window onto a wire frame.
    ///
    /// Only channels with an origin are copied, so unwritten console channels never mask
    /// values placed by other windows. Returns whether the console universe exists.
    pub fn overlay_console_window(
        &self,
        universe_id: u16,
        window: ChannelWindow,
        target: &mut [ChannelDmxValue],
    ) -> bool {
        let Some(universe) = self.universes.get(&universe_id) else {
            return false;
        };
        if let Some((source_start, target_start, len)) =
            window.span(universe.values.len(), target.len())
        {
            for offset in 0..len {
                if universe.origins[source_start + offset].is_some() {
                    target[target_start + offset] = universe.values[source_start + offset];
                }
            }
        }
        true
    }

    /// Removes every value written by output bindings after the bindings were re-resolved.
    ///
    /// Output buffers are dropped entirely, console channels owned by output bindings are
    /// zeroed and unowned, and console universes left without any owned channel are removed.
    /// The next [`dmx_universes`] run rewrites values for the bindings that still apply.
    pub fn clear_output_binding_values(&mut self) {
        self.output_universes.clear();
        self.universes.retain(|_, universe| {
            for (value, origin) in universe.values.iter_mut().zip(universe.origins.iter_mut()) {
                if *origin == Some(ConsoleChannelOrigin::OutputBinding) {
                    *value = 0;
                    *origin = None;
                }
            }
            universe.origins.iter().any(Option::is_some)
        });
    }

    /// Sets a DMX channel value with explicit origin metadata.
    /// Address is 1-indexed (DMX convention).
    pub fn set_value(
        &mut self,
        universe_id: u16,
        address: u16,
        value: ChannelDmxValue,
        origin: ConsoleChannelOrigin,
    ) {
        if address == 0 || address > MAX_CHANNELS_PER_UNIVERSE as u16 {
            tracing::warn!("Address {} is invalid, skipping", address);
            return;
        }

        let universe = self.universes.entry(universe_id).or_default();
        let index = (address - 1) as usize;
        universe.values[index] = value;
        universe.origins[index] = Some(origin);
    }

    /// Checks if a universe exists.
    pub fn has_universe(&self, universe_id: u16) -> bool {
        self.universes.contains_key(&universe_id)
    }

    /// Checks if an output transport has a specific universe buffer.
    pub fn has_output_universe(&self, transport: &OutputTransport, universe_id: u16) -> bool {
        self.output_universes
            .contains_key(&(transport.clone(), universe_id))
    }

    /// Gets a single DMX channel value, if present.
    pub fn get_value(&self, universe_id: u16, address: u16) -> Option<ChannelDmxValue> {
        if address == 0 || address > MAX_CHANNELS_PER_UNIVERSE as u16 {
            return None;
        }
        self.universes
            .get(&universe_id)
            .map(|universe| universe.values[(address - 1) as usize])
    }

    /// Gets the current origin metadata for a DMX channel, if present.
    pub fn get_origin(&self, universe_id: u16, address: u16) -> Option<ConsoleChannelOrigin> {
        if address == 0 || address > MAX_CHANNELS_PER_UNIVERSE as u16 {
            return None;
        }
        self.universes
            .get(&universe_id)
            .and_then(|universe| universe.origins[(address - 1) as usize])
    }

    /// Gets a DMX universe.
    pub fn get_universe(&self, universe_id: u16) -> [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE] {
        self.universes
            .get(&universe_id)
            .map(|universe| universe.values)
            .expect("universe does not exist")
    }

    /// Gets a DMX universe for one output transport.
    pub fn get_output_universe(
        &self,
        transport: &OutputTransport,
        universe_id: u16,
    ) -> [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE] {
        self.output_universes
            .get(&(transport.clone(), universe_id))
            .map(|universe| universe.values)
            .expect("output universe does not exist")
    }

    /// Gets the IDs of all universes.
    pub fn universe_ids(&self) -> impl Iterator<Item = &u16> {
        self.universes.keys()
    }

    /// Clears all channel values for existing universes.
    pub fn clear_values(&mut self) {
        for universe in self.universes.values_mut() {
            universe.values.fill(0);
            universe.origins.fill(Some(ConsoleChannelOrigin::System));
        }
        for universe in self.output_universes.values_mut() {
            universe.values.fill(0);
            universe.origins.fill(Some(ConsoleChannelOrigin::System));
        }
    }

    /// Clears all console universe buffers and ownership metadata.
    pub fn clear(&mut self) {
        self.universes.clear();
        self.output_universes.clear();
    }

    /// Clears channels currently owned by stale input transport sources.
    pub fn clear_stale_input_channels(
        &mut self,
        input_universes: &InputDmxUniverses,
        now: Instant,
        timeout: Duration,
    ) -> usize {
        let timeout_ms = timeout.as_millis() as u32;
        let mut cleared = 0;

        for universe in self.universes.values_mut() {
            for idx in 0..MAX_CHANNELS_PER_UNIVERSE {
                let Some(ConsoleChannelOrigin::InputTransport {
                    transport,
                    universe: input_universe,
                }) = universe.origins[idx]
                else {
                    continue;
                };

                let frame_age_ms = input_universes.frame_age_ms(transport, input_universe, now);
                let is_stale = frame_age_ms.is_none_or(|age_ms| age_ms >= timeout_ms);
                if !is_stale {
                    continue;
                }

                universe.values[idx] = 0;
                universe.origins[idx] = Some(ConsoleChannelOrigin::System);
                cleared += 1;
            }
        }

        cleared
    }
}

fn parameter_to_dmx_value(parameter: &Parameter) -> u32 {
    let physical_value = parameter.get_raw_value();
    let min = parameter.metadata.logical_min();
    let max = parameter.metadata.logical_max();
    let range = max - min;

    let normalized = if range > 0.0 {
        ((physical_value - min) / range).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let dmx_max: u32 = match parameter.metadata.resolution {
        DmxValueResolution::Coarse => 255,
        DmxValueResolution::Fine => 65535,
        DmxValueResolution::UltraFine => 16777215,
        DmxValueResolution::Uber => u32::MAX,
    };

    (normalized * dmx_max as ParameterDmxValue).round() as u32
}

/// Encodes a parameter's current value as its big-endian DMX channel bytes.
///
/// Returns a fixed buffer plus the number of leading bytes that are meaningful; the slice
/// `bytes[4 - width..]` holds coarse through finest channel values in DMX order.
pub(crate) fn parameter_dmx_bytes(parameter: &Parameter) -> ([ChannelDmxValue; 4], usize) {
    let width = parameter.metadata.resolution.channel_width() as usize;
    (
        parameter_to_dmx_value(parameter).to_be_bytes(),
        width.min(4),
    )
}

/// Writes parameter values into console space and each resolved transport output buffer.
///
/// Console-space values are keyed by console universe numbering (from console bindings),
/// while transport buffers are keyed by on-the-wire universe numbering.
pub fn dmx_universes(
    query: Query<(
        InstanceRef<Parameter>,
        Option<&ResolvedOutputDestinations>,
        Option<&ResolvedConsoleDestination>,
    )>,
    mut universes: ResMut<ConsoleDmxUniverses>,
) {
    for (parameter, destinations, console_destination) in &query {
        let console_address = console_destination.and_then(|console| console.address);
        let destinations = destinations
            .map(|destinations| destinations.destinations.as_slice())
            .unwrap_or_default();
        if console_address.is_none() && destinations.is_empty() {
            continue;
        }

        let (bytes, width) = parameter_dmx_bytes(&parameter);
        let channels = &bytes[bytes.len() - width..];

        if let Some(console_address) = console_address {
            universes.set_values(
                console_address.universe,
                console_address.address,
                channels,
                ConsoleChannelOrigin::OutputBinding,
            );
        }

        for destination in destinations {
            if destination.address == 0 {
                tracing::warn!(
                    attribute = ?parameter.metadata.attribute,
                    universe = destination.universe,
                    "Parameter has output address 0"
                );
            }

            universes.set_output_values(
                &destination.transport,
                destination.universe,
                destination.address,
                channels,
                ConsoleChannelOrigin::OutputBinding,
            );
        }
    }
}

/// Prints the finalized DMX universes.
pub fn dmx_universes_debug(universes: ResMut<ConsoleDmxUniverses>) {
    let _span: tracing::span::EnteredSpan = tracing::trace_span!("dmx_values").entered();
    for universe_id in universes.universe_ids() {
        let data = universes.get_universe(*universe_id);
        tracing::trace!(universe_id, ?data, "DMX universe values");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Clearing output-binding values keeps manual writes, drops fixture-owned channels,
    /// removes universes left without owned channels, and drops output buffers.
    #[test]
    fn clear_output_binding_values_keeps_only_non_binding_channels() {
        let mut universes = ConsoleDmxUniverses::default();
        let sacn = OutputTransport::Sacn {
            mode: nightfall_io::SacnDelivery::Multicast,
        };
        universes.set_values(1, 1, &[10, 20], ConsoleChannelOrigin::OutputBinding);
        universes.set_value(1, 5, 55, ConsoleChannelOrigin::ManualCommand);
        universes.set_values(2, 1, &[30], ConsoleChannelOrigin::OutputBinding);
        universes.set_output_values(&sacn, 3, 1, &[40], ConsoleChannelOrigin::OutputBinding);

        universes.clear_output_binding_values();

        assert_eq!(universes.get_value(1, 1), Some(0));
        assert_eq!(universes.get_origin(1, 1), None);
        assert_eq!(universes.get_value(1, 5), Some(55));
        assert!(!universes.has_universe(2));
        assert!(!universes.has_output_universe(&sacn, 3));
    }

    #[test]
    fn console_input_owner_clears_when_source_stale() {
        let mut universes = ConsoleDmxUniverses::default();
        let mut input_universes = InputDmxUniverses::default();

        let source = (BindingTransport::Sacn, 1);
        let now = Instant::now();
        let past = now - Duration::from_millis(1500);

        universes.set_value(
            2,
            1,
            42,
            ConsoleChannelOrigin::InputTransport {
                transport: source.0,
                universe: source.1,
            },
        );
        input_universes.set_universe(source.0, source.1, [0; MAX_CHANNELS_PER_UNIVERSE], past);

        let cleared =
            universes.clear_stale_input_channels(&input_universes, now, Duration::from_millis(500));
        assert_eq!(cleared, 1);
        assert_eq!(universes.get_value(2, 1), Some(0));
        assert_eq!(
            universes.get_origin(2, 1),
            Some(ConsoleChannelOrigin::System)
        );
    }

    #[test]
    fn console_input_owner_does_not_clear_when_channel_reowned() {
        let mut universes = ConsoleDmxUniverses::default();
        let mut input_universes = InputDmxUniverses::default();

        let source = (BindingTransport::ArtNet, 3);
        let now = Instant::now();
        let past = now - Duration::from_millis(1500);

        universes.set_value(
            4,
            5,
            77,
            ConsoleChannelOrigin::InputTransport {
                transport: source.0,
                universe: source.1,
            },
        );
        universes.set_value(4, 5, 77, ConsoleChannelOrigin::ManualCommand);
        input_universes.set_universe(source.0, source.1, [0; MAX_CHANNELS_PER_UNIVERSE], past);

        let cleared =
            universes.clear_stale_input_channels(&input_universes, now, Duration::from_millis(500));
        assert_eq!(cleared, 0);
        assert_eq!(universes.get_value(4, 5), Some(77));
        assert_eq!(
            universes.get_origin(4, 5),
            Some(ConsoleChannelOrigin::ManualCommand)
        );
    }

    #[test]
    fn input_universe_tracks_frame_age() {
        let mut input_universes = InputDmxUniverses::default();
        let now = Instant::now();
        let past = now - Duration::from_millis(250);

        input_universes.set_universe(
            BindingTransport::Sacn,
            1,
            [0; MAX_CHANNELS_PER_UNIVERSE],
            past,
        );

        let age_ms = input_universes
            .frame_age_ms(BindingTransport::Sacn, 1, now)
            .unwrap();
        assert!(age_ms >= 250);
    }

    #[test]
    fn input_universe_mut_insert_does_not_mark_received_frame() {
        let mut input_universes = InputDmxUniverses::default();
        let now = Instant::now();

        let target = input_universes.get_universe_mut(BindingTransport::ArtNet, 7);
        target[0] = 123;

        assert_eq!(
            input_universes.frame_age_ms(BindingTransport::ArtNet, 7, now),
            None
        );
        assert_eq!(
            input_universes.is_self_frame(BindingTransport::ArtNet, 7),
            None
        );
    }

    #[test]
    fn input_universe_tracks_self_frame_flag_for_latest_frame() {
        let mut input_universes = InputDmxUniverses::default();
        let now = Instant::now();

        input_universes.set_universe_with_self_flag(
            BindingTransport::Sacn,
            11,
            [0; MAX_CHANNELS_PER_UNIVERSE],
            now,
            true,
        );
        assert_eq!(
            input_universes.is_self_frame(BindingTransport::Sacn, 11),
            Some(true)
        );

        input_universes.set_universe_with_self_flag(
            BindingTransport::Sacn,
            11,
            [0; MAX_CHANNELS_PER_UNIVERSE],
            now,
            false,
        );
        assert_eq!(
            input_universes.is_self_frame(BindingTransport::Sacn, 11),
            Some(false)
        );
    }
}
