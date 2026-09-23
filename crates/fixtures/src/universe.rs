// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Provides a logical representation of DMX universes and their channel values.

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall_dmx::prelude::*;
#[cfg(test)]
use nightfall_io::ArtNetDelivery;
use nightfall_io::BindingTransport;
use nightfall_io::OutputTransport;
use web_time::Instant;

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

/// Aggregates transport metadata per universe from resolved output destinations.
/// A universe may be associated with multiple transports when different address ranges
/// are routed to different outputs (e.g., 1:0-120 on sACN, 1:121-511 on Art-Net).
#[derive(Default, Resource)]
pub struct UniverseTransportMap {
    /// Maps each universe to its set of transports.
    by_universe: HashMap<u16, HashSet<OutputTransport>>,
}

impl UniverseTransportMap {
    /// Records that a universe uses a given transport.
    pub fn add_transport(&mut self, universe_id: u16, transport: OutputTransport) {
        let transports = self.by_universe.entry(universe_id).or_default();
        if transports.insert(transport.clone()) {
            tracing::trace!(universe_id, ?transport, "Universe added to transport map");
        }
    }

    /// Gets all transports for a specific universe.
    pub fn transports_for_universe(
        &self,
        universe_id: u16,
    ) -> impl Iterator<Item = &OutputTransport> {
        self.by_universe.get(&universe_id).into_iter().flatten()
    }

    /// Gets all universes that have any transport configured.
    pub fn universes(&self) -> impl Iterator<Item = u16> + '_ {
        self.by_universe.keys().copied()
    }

    /// Checks if a universe has a transport matching the given predicate.
    pub fn has_transport(
        &self,
        universe_id: u16,
        predicate: impl Fn(&OutputTransport) -> bool,
    ) -> bool {
        self.transports_for_universe(universe_id).any(predicate)
    }

    /// Clears all transport mappings.
    pub fn clear(&mut self) {
        self.by_universe.clear();
    }
}

/// Console DMX universe space with per-channel origin metadata.
#[derive(Default, Resource)]
pub struct ConsoleDmxUniverses {
    universes: HashMap<u16, ConsoleUniverse>,
    output_universes: HashMap<(OutputTransport, u16), ConsoleUniverse>,
}

impl ConsoleDmxUniverses {
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

    /// Sets a DMX channel value for one concrete output transport.
    /// Address is 1-indexed (DMX convention).
    pub fn set_output_value(
        &mut self,
        transport: OutputTransport,
        universe_id: u16,
        address: u16,
        value: ChannelDmxValue,
        origin: ConsoleChannelOrigin,
    ) {
        if address == 0 || address > MAX_CHANNELS_PER_UNIVERSE as u16 {
            tracing::warn!("Address {} is invalid, skipping", address);
            return;
        }

        let universe = self
            .output_universes
            .entry((transport, universe_id))
            .or_default();
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

/// Write a validated sparse parameter mapping to both console and transport buffers.
fn write_parameter_to_console_universe(
    universes: &mut ConsoleDmxUniverses,
    destination: &OutputDestination,
    parameter: &Parameter,
) {
    let width = parameter.metadata.resolution.channel_width();
    if !destination.has_valid_addresses(width) {
        return;
    }
    let bytes = parameter_to_dmx_value(parameter).to_be_bytes();
    for (&address, &value) in destination
        .addresses
        .iter()
        .zip(&bytes[4 - usize::from(width)..])
    {
        universes.set_value(
            destination.universe,
            address,
            value,
            ConsoleChannelOrigin::OutputBinding,
        );
        universes.set_output_value(
            destination.transport.clone(),
            destination.universe,
            address,
            value,
            ConsoleChannelOrigin::OutputBinding,
        );
    }
}

/// Organizes DMX values from parameters into universes according to resolved destinations.
pub fn dmx_universes(
    query: Query<(InstanceRef<Parameter>, Option<&ResolvedOutputDestinations>)>,
    mut universes: ResMut<ConsoleDmxUniverses>,
) {
    for (parameter, destinations) in &query {
        let Some(destinations) = destinations else {
            continue;
        };
        for destination in &destinations.destinations {
            write_parameter_to_console_universe(&mut universes, destination, &parameter);
        }
    }
}

/// Updates transport map when patch entities change.
pub fn update_transport_map(
    changed_query: Query<&ResolvedOutputDestinations, Changed<ResolvedOutputDestinations>>,
    all_destinations_query: Query<&ResolvedOutputDestinations>,
    resolved_input_bindings: Res<ResolvedInputBindings>,
    mut removed: RemovedComponents<ResolvedOutputDestinations>,
    mut transport_map: ResMut<UniverseTransportMap>,
) {
    if changed_query.is_empty()
        && removed.read().next().is_none()
        && !resolved_input_bindings.is_changed()
    {
        return;
    }

    transport_map.clear();
    for destinations in &all_destinations_query {
        for destination in &destinations.destinations {
            transport_map.add_transport(destination.universe, destination.transport.clone());
        }
    }

    for binding in &resolved_input_bindings.bindings {
        if let ResolvedInputDestination::Transport {
            target: transport_target,
        } = &binding.destination
        {
            transport_map.add_transport(
                transport_target.universe,
                transport_target.transport.clone(),
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
    use bevy_app::{App, Update};

    use super::*;

    /// Exercise the actual output system with reversed sparse bytes and preserve unrelated channel ownership.
    #[test]
    fn output_system_writes_sparse_significant_addresses() {
        let mut app = App::new();
        app.init_resource::<ConsoleDmxUniverses>();
        let transport = OutputTransport::Disabled;
        {
            let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            for address in 1..=5 {
                universes.set_value(7, address, 0xee, ConsoleChannelOrigin::ManualCommand);
                universes.set_output_value(
                    transport.clone(),
                    7,
                    address,
                    0xee,
                    ConsoleChannelOrigin::ManualCommand,
                );
            }
        }
        app.world_mut().spawn((
            Parameter {
                metadata: ParameterMetadata {
                    resolution: DmxValueResolution::Fine,
                    max: 65535.0,
                    ..Default::default()
                },
                values: ParameterValues {
                    current_value: 0xabcd as f32,
                    ..Default::default()
                },
            },
            ResolvedOutputDestinations {
                destinations: vec![OutputDestination {
                    transport: transport.clone(),
                    universe: 7,
                    addresses: vec![4, 1],
                }],
            },
        ));
        app.add_systems(Update, dmx_universes);
        app.update();
        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(
            &universes.get_universe(7)[..5],
            &[0xcd, 0xee, 0xee, 0xab, 0xee]
        );
        assert_eq!(
            &universes.get_output_universe(&transport, 7)[..5],
            &[0xcd, 0xee, 0xee, 0xab, 0xee]
        );
        assert_eq!(
            universes.get_origin(7, 2),
            Some(ConsoleChannelOrigin::ManualCommand)
        );
        assert_eq!(
            universes.get_origin(7, 4),
            Some(ConsoleChannelOrigin::OutputBinding)
        );
    }

    /// Reject the entire destination before touching console values, transport bytes or ownership metadata.
    #[test]
    fn invalid_output_addresses_do_not_partially_write() {
        let parameter = Parameter {
            metadata: ParameterMetadata {
                resolution: DmxValueResolution::Fine,
                max: 65535.0,
                ..Default::default()
            },
            values: ParameterValues {
                current_value: 65535.0,
                ..Default::default()
            },
        };
        for addresses in [
            vec![],
            vec![1],
            vec![1, 2, 3],
            vec![1, 0],
            vec![1, 513],
            vec![1, 1],
            vec![1, u16::MAX],
        ] {
            let mut universes = ConsoleDmxUniverses::default();
            universes.set_value(7, 1, 42, ConsoleChannelOrigin::ManualCommand);
            let destination = OutputDestination {
                transport: OutputTransport::Disabled,
                universe: 7,
                addresses,
            };
            write_parameter_to_console_universe(&mut universes, &destination, &parameter);
            assert_eq!(universes.get_value(7, 1), Some(42));
            assert_eq!(
                universes.get_origin(7, 1),
                Some(ConsoleChannelOrigin::ManualCommand)
            );
            assert!(!universes.has_output_universe(&OutputTransport::Disabled, 7));
        }
    }

    #[test]
    fn update_transport_map_includes_input_transport_targets() {
        let mut app = App::new();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<UniverseTransportMap>();

        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::Sacn,
                universe: 2,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Transport {
                target: ResolvedTransportTarget {
                    target: "artnet".to_string(),
                    protocol: BindingTransport::ArtNet,
                    transport: OutputTransport::ArtNet {
                        mode: ArtNetDelivery::Broadcast,
                    },
                    universe: 7,
                    address: 1,
                },
            },
        }];

        app.add_systems(Update, update_transport_map);
        app.update();

        let map = app.world().resource::<UniverseTransportMap>();
        assert!(map.has_transport(7, |transport| matches!(
            transport,
            OutputTransport::ArtNet { .. }
        )));
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
