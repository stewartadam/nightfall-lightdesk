// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Systems for resolving DMX routes into runtime caches.

use std::collections::HashMap;
use std::str::FromStr;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_dmx::prelude::Attribute;
use nightfall_fixture_model::prelude::*;
use nightfall_io::RouteTransport;
use nightfall_io::prelude::{
    NetworkDmxOutputTarget, NetworkDmxOutputTargets, OutputTransport, UsbDmxOutputTarget,
    UsbDmxOutputTargets,
};
use uuid::Uuid;

use crate::output_frames::{
    ChannelWindow, ConsoleWindowFeed, OutputFrameFeed, OutputFrameKey, OutputRouting,
};
use crate::prelude::*;

const DEFAULT_UNIVERSE_MAX: u16 = 512;

fn parse_attribute(name: &str) -> Attribute {
    Attribute::from_str(name).unwrap_or_else(|_| Attribute::Custom {
        label: name.to_string(),
    })
}

fn expand_range(range: Option<DmxRange>) -> Vec<u16> {
    match range {
        Some(range) => (range.start..=range.end).collect(),
        None => Vec::new(),
    }
}

/// Places the fixtures of one fixture→console or fixture→transport route, in patch order.
///
/// The Nth fixture lands in the Nth universe of the route's range, and every fixture past the
/// end of the range lands in its last universe. Each universe starts at the route address;
/// fixtures sharing a universe are packed one after another unless the route clones them onto
/// the same address. Output resolution and patch validation both walk routes through this
/// layout so a validation error always describes a real conflict on the wire.
pub(crate) struct FixturePatchLayout {
    /// Universe the next fixture lands in.
    next_universe: u16,
    /// Last universe of the range, which takes every remaining fixture.
    last_universe: u16,
    /// Universe holding the most recently placed fixture.
    current_universe: u16,
    base_address: u16,
    clone: bool,
    /// Packing position in the current universe.
    next_address: u16,
    /// Start address of the most recently placed fixture.
    placed_address: u16,
}

impl FixturePatchLayout {
    /// Starts a layout for a route target's universe range (universe 1 when unset or
    /// empty), start address (1 when unset) and clone flag.
    pub(crate) fn new(universe: Option<DmxRange>, address: Option<u16>, clone: bool) -> Self {
        let (first_universe, last_universe) = match universe {
            Some(range) if range.start <= range.end => (range.start, range.end),
            _ => (1, 1),
        };
        let base_address = address.unwrap_or(1);
        Self {
            next_universe: first_universe,
            last_universe,
            current_universe: first_universe,
            base_address,
            clone,
            next_address: base_address,
            placed_address: base_address,
        }
    }

    /// Returns the universe and start address of the next fixture in the route.
    ///
    /// Call once for every fixture of the route, in order, including fixtures that end up
    /// skipped, since each one consumes its universe slot in the range.
    pub(crate) fn place_next(&mut self) -> (u16, u16) {
        let universe = self.next_universe;
        if universe != self.current_universe {
            self.current_universe = universe;
            self.next_address = self.base_address;
        }
        if self.next_universe < self.last_universe {
            self.next_universe += 1;
        }
        self.placed_address = if self.clone {
            self.base_address
        } else {
            self.next_address
        };
        (universe, self.placed_address)
    }

    /// Moves the packing position past the fixture just placed, which spans `footprint`
    /// slots; cloned routes keep every fixture on the route address.
    pub(crate) fn advance(&mut self, footprint: u16) {
        if !self.clone {
            self.next_address = self.placed_address.saturating_add(footprint);
        }
    }
}

fn default_universe_list() -> Vec<u16> {
    (1..=DEFAULT_UNIVERSE_MAX).collect()
}

fn range_contains(range: Option<DmxRange>, value: u16) -> bool {
    match range {
        Some(range) => value >= range.start && value <= range.end,
        None => true,
    }
}

/// Lays out the DMX slots of a fixture's parameters selected by a route.
///
/// Whole-fixture selections keep the profile's footprint offsets. Element or
/// parameter selections are rebased so the first selected byte lands on the
/// route's address. `VirtualIntensity` parameters are included only for
/// input routes that request them; they are placed as sequential bytes.
/// Only parameters on `dmx_break` are laid out; secondary breaks keep their
/// break-relative offsets since each break has its own start address.
fn collect_fixture_parameters(
    data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceRef<Parameter>>,
    fixture_uid: Uuid,
    element: Option<u16>,
    param: Option<&str>,
    dmx_break: u16,
    include_virtual: bool,
) -> WireLayout<Entity> {
    let element_indices: Vec<u32> = if let Some(element) = element {
        vec![element as u32]
    } else {
        fixture_element_indices_in_dmx_order(data_provider, fixture_uid)
    };

    let mut selected: Vec<(Entity, ParameterMetadata)> = Vec::new();
    for element_index in element_indices {
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(element_index),
        };
        let instances = match param {
            Some(param_name) => data_provider
                .try_parameter_for_logical_attribute(&fixture_ref, &parse_attribute(param_name))
                .map(|resolved| vec![resolved.instance])
                .unwrap_or_default(),
            None => data_provider.parameter_entities_for_element(&fixture_ref),
        };
        for instance in instances {
            let Ok(param_ref) = param_query.get(instance.entity()) else {
                continue;
            };
            let mut metadata = param_ref.metadata.clone();
            if metadata.attribute == Attribute::VirtualIntensity {
                if !include_virtual {
                    continue;
                }
                // Input routes may drive virtual intensity from a console slot.
                metadata.attribute = Attribute::Intensity;
                metadata.dmx_slots = DmxSlots::Sequential;
            }
            selected.push((instance.entity(), metadata));
        }
    }

    let layout = WireLayout::for_break(
        selected
            .iter()
            .map(|(entity, metadata)| (*entity, metadata)),
        dmx_break,
    );
    if element.is_some() || param.is_some() {
        layout.rebased()
    } else {
        layout
    }
}

/// Offsets every slot of a laid-out parameter by `base`.
fn offset_slots(slots: &[u16], base: u16) -> Vec<u16> {
    slots
        .iter()
        .map(|slot| base.saturating_add(*slot))
        .collect()
}

/// Resolves logical element positions to the declared physical wiring layout.
fn fixture_element_indices_in_dmx_order(
    data_provider: &FixtureDataProviderExt,
    fixture_uid: Uuid,
) -> Vec<u32> {
    let Ok(fixture) = data_provider.inner.get(fixture_uid) else {
        return Vec::new();
    };

    if let Some(order) = fixture.layout.and_then(FixtureLayout::dmx_element_order) {
        return order;
    }

    match data_provider.element_count(fixture_uid) {
        Some(count) => (1..=count as u32).collect(),
        None => Vec::new(),
    }
}

/// Resolves a transport input universe range to concrete universe IDs.
///
/// Falls back to the default universe list when no source range is specified.
fn resolve_transport_input_universes(source_range: Option<DmxRange>) -> Vec<u16> {
    let resolved = expand_range(source_range);
    if resolved.is_empty() {
        return default_universe_list();
    }
    resolved
}

/// Resolves a console input universe range to concrete universe IDs.
///
/// Falls back to configured console universes when no source range is specified,
/// or to the default universe list when no console universes are configured.
fn resolve_console_input_universes(
    source_range: Option<DmxRange>,
    universes: &ConsoleDmxUniverses,
) -> Vec<u16> {
    let mut resolved = expand_range(source_range);
    if resolved.is_empty() {
        let mut universe_ids: Vec<u16> = universes.universe_ids().copied().collect();
        universe_ids.sort_unstable();
        if universe_ids.is_empty() {
            resolved = default_universe_list();
        } else {
            resolved = universe_ids;
        }
    }
    resolved
}

fn map_universe_by_index(source: &[u16], target: &[u16], index: usize) -> u16 {
    if target.is_empty() {
        return source[index];
    }
    if target.len() == 1 {
        return target[0];
    }
    if index < target.len() {
        return target[index];
    }
    *target.last().expect("target is not empty")
}

fn input_source_matches(source: &ResolvedInputSource, disabled: &InputSource) -> bool {
    match (source, disabled) {
        (
            ResolvedInputSource::Transport {
                transport,
                universe,
                address,
            },
            InputSource::Transport {
                transport: disabled_transport,
                universe: disabled_universe,
                address: disabled_address,
            },
        ) => {
            transport == disabled_transport
                && range_contains(*disabled_universe, *universe)
                && disabled_address.is_none_or(|addr| addr == *address)
        }
        (
            ResolvedInputSource::Console { universe, address },
            InputSource::Console {
                universe: disabled_universe,
                address: disabled_address,
            },
        ) => {
            range_contains(*disabled_universe, *universe)
                && disabled_address.is_none_or(|addr| addr == *address)
        }
        (
            ResolvedInputSource::Fixture {
                uid,
                element,
                param,
            },
            InputSource::Fixture {
                uids,
                element: disabled_element,
                param: disabled_param,
            },
        ) => {
            uids.contains(uid)
                && disabled_element.is_none_or(|idx| Some(idx) == *element)
                && disabled_param
                    .as_ref()
                    .is_none_or(|p| Some(p) == param.as_ref())
        }
        _ => false,
    }
}

/// Resolves an output route's transport target identifier to the configured network or USB
/// output it names, or `None` when no configured output matches.
pub fn output_transport_from_target_id(
    target: &str,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Option<OutputTransport> {
    network_outputs
        .get(target)
        .and_then(NetworkDmxOutputTarget::output_transport)
        .or_else(|| {
            usb_outputs
                .get(target)
                .map(UsbDmxOutputTarget::output_transport)
        })
}

fn output_protocol_for_transport(transport: &OutputTransport) -> RouteTransport {
    match transport {
        OutputTransport::Sacn { .. } => RouteTransport::Sacn,
        OutputTransport::ArtNet { .. } => RouteTransport::ArtNet,
        OutputTransport::Udmx { .. } | OutputTransport::Disabled => RouteTransport::Udmx,
    }
}

/// Orders output routes lowest precedence first: ascending priority, and among equal
/// priorities the earliest-authored route last. Consumers where a later route replaces an
/// earlier one therefore leave the highest-priority, earliest-authored route in effect.
pub(crate) fn output_routes_in_overlay_order(output_routes: &OutputRoutes) -> Vec<&OutputRoute> {
    let mut routes_with_index: Vec<(usize, &OutputRoute)> =
        output_routes.routes.iter().enumerate().collect();
    routes_with_index.sort_by_key(|(index, route)| (route.priority, std::cmp::Reverse(*index)));
    routes_with_index
        .into_iter()
        .map(|(_, route)| route)
        .collect()
}

/// Rebuild `ConsoleDmxAddresses` from output routes and fixtures when inputs change.
///
/// Fixture→console routes apply in overlay order; a later route replaces earlier
/// addresses for the parameters it selects, so the highest-priority route wins and ties go
/// to the earliest-authored one. Each route lays out only the parameters
/// selected by its element/parameter filter, placed by the selection's wire layout in DMX
/// order (explicit footprint slots and gaps included).
pub fn derive_console_addresses(
    output_routes: Res<OutputRoutes>,
    data_provider: Res<FixtureDataProviderExt>,
    param_query: Query<InstanceRef<Parameter>>,
    mut console_addresses: ResMut<ConsoleDmxAddresses>,
) {
    let should_rebuild = output_routes.is_changed() || data_provider.is_changed();
    if !should_rebuild {
        return;
    }

    console_addresses.clear();

    for route in output_routes_in_overlay_order(&output_routes) {
        let OutputSource::Fixture {
            uids,
            element,
            param,
        } = &route.source
        else {
            continue;
        };
        let OutputTarget::Console { universe, address } = &route.target else {
            continue;
        };

        let mut layout = FixturePatchLayout::new(*universe, *address, route.clone);
        for uid in uids {
            let (target_universe, fixture_address) = layout.place_next();
            let params = collect_fixture_parameters(
                &data_provider,
                &param_query,
                *uid,
                *element,
                param.as_deref(),
                1,
                false,
            );
            if params.parameters.is_empty() {
                continue;
            }

            console_addresses.addresses.insert(
                *uid,
                ConsoleDmxAddress {
                    universe: target_universe,
                    address: fixture_address,
                },
            );

            let footprint = params.footprint();
            for param in params.parameters {
                console_addresses.parameters.insert(
                    param.target,
                    ConsoleParameterAddress {
                        universe: target_universe,
                        addresses: offset_slots(&param.slots, fixture_address),
                    },
                );
            }

            layout.advance(footprint);
        }
    }
}

/// Resolve input routes into a cached list of concrete input rules.
pub fn resolve_input_routes(
    input_routes: Res<InputRoutes>,
    disabled_routes: Res<DisabledRoutes>,
    console_addresses: Res<ConsoleDmxAddresses>,
    data_provider: Res<FixtureDataProviderExt>,
    param_query: Query<InstanceRef<Parameter>>,
    universes: Res<ConsoleDmxUniverses>,
    network_outputs: Res<NetworkDmxOutputTargets>,
    usb_outputs: Res<UsbDmxOutputTargets>,
    mut resolved: ResMut<ResolvedInputRoutes>,
) {
    let should_rebuild = input_routes.is_changed()
        || disabled_routes.is_changed()
        || console_addresses.is_changed()
        || data_provider.is_changed()
        || network_outputs.is_changed()
        || usb_outputs.is_changed();
    if !should_rebuild {
        return;
    }

    let mut disabled_sources: Vec<InputSource> = disabled_routes
        .routes
        .iter()
        .map(|route| match route {
            DisabledRoute::Input { source, .. } => source.clone(),
        })
        .collect();

    for route in &input_routes.routes {
        if matches!(route.target, InputTarget::Disabled) {
            disabled_sources.push(route.source.clone());
        }
    }

    let mut routes_with_index: Vec<(usize, ResolvedInputRoute)> = Vec::new();

    for (route_index, route) in input_routes.routes.iter().enumerate() {
        if matches!(route.target, InputTarget::Disabled) {
            continue;
        }

        match &route.source {
            InputSource::Transport {
                transport,
                universe,
                address,
            } => {
                let source_universes = resolve_transport_input_universes(*universe);
                let target_universes = match &route.target {
                    InputTarget::Console { universe, .. } => expand_range(*universe),
                    InputTarget::Transport { universe, .. } => expand_range(*universe),
                    _ => Vec::new(),
                };
                let source_address = address.unwrap_or(1);

                for (index, source_universe) in source_universes.iter().enumerate() {
                    let target_universe = if matches!(
                        route.target,
                        InputTarget::Console { .. } | InputTarget::Transport { .. }
                    ) {
                        map_universe_by_index(&source_universes, &target_universes, index)
                    } else {
                        *source_universe
                    };

                    let source = ResolvedInputSource::Transport {
                        transport: *transport,
                        universe: *source_universe,
                        address: source_address,
                    };

                    if disabled_sources
                        .iter()
                        .any(|disabled| input_source_matches(&source, disabled))
                    {
                        continue;
                    }

                    let targets = resolve_input_targets(
                        &route.target,
                        target_universe,
                        route.clone,
                        &console_addresses,
                        &data_provider,
                        &param_query,
                        matches!(&route.source, InputSource::Fixture { .. }),
                    );

                    let destination = match &route.target {
                        InputTarget::Console { address, .. } => ResolvedInputDestination::Console {
                            target: ResolvedConsoleTarget {
                                universe: target_universe,
                                address: address.unwrap_or(1),
                            },
                            targets,
                        },
                        InputTarget::Transport {
                            target, address, ..
                        } => {
                            let Some(output_transport) = output_transport_from_target_id(
                                target,
                                &network_outputs,
                                &usb_outputs,
                            ) else {
                                continue;
                            };
                            ResolvedInputDestination::Transport {
                                target: ResolvedTransportTarget {
                                    target: target.clone(),
                                    protocol: output_protocol_for_transport(&output_transport),
                                    transport: output_transport,
                                    universe: target_universe,
                                    address: address.unwrap_or(1),
                                },
                            }
                        }
                        InputTarget::Fixture { .. } => {
                            if targets.is_empty() {
                                continue;
                            }
                            ResolvedInputDestination::Fixture { targets }
                        }
                        InputTarget::Disabled => continue,
                    };

                    routes_with_index.push((
                        route_index,
                        ResolvedInputRoute {
                            source,
                            priority: route.priority,
                            destination,
                        },
                    ));
                }
            }
            InputSource::Console { universe, address } => {
                let source_universes = resolve_console_input_universes(*universe, &universes);
                let target_universes = match &route.target {
                    InputTarget::Console { universe, .. } => expand_range(*universe),
                    InputTarget::Transport { universe, .. } => expand_range(*universe),
                    _ => Vec::new(),
                };
                let source_address = address.unwrap_or(1);

                for (index, source_universe) in source_universes.iter().enumerate() {
                    let target_universe = if matches!(
                        route.target,
                        InputTarget::Console { .. } | InputTarget::Transport { .. }
                    ) {
                        map_universe_by_index(&source_universes, &target_universes, index)
                    } else {
                        *source_universe
                    };

                    let source = ResolvedInputSource::Console {
                        universe: *source_universe,
                        address: source_address,
                    };

                    if disabled_sources
                        .iter()
                        .any(|disabled| input_source_matches(&source, disabled))
                    {
                        continue;
                    }

                    let targets = resolve_input_targets(
                        &route.target,
                        target_universe,
                        route.clone,
                        &console_addresses,
                        &data_provider,
                        &param_query,
                        matches!(&route.source, InputSource::Fixture { .. }),
                    );

                    let destination = match &route.target {
                        InputTarget::Console { address, .. } => ResolvedInputDestination::Console {
                            target: ResolvedConsoleTarget {
                                universe: target_universe,
                                address: address.unwrap_or(1),
                            },
                            targets,
                        },
                        InputTarget::Transport {
                            target, address, ..
                        } => {
                            let Some(output_transport) = output_transport_from_target_id(
                                target,
                                &network_outputs,
                                &usb_outputs,
                            ) else {
                                continue;
                            };
                            ResolvedInputDestination::Transport {
                                target: ResolvedTransportTarget {
                                    target: target.clone(),
                                    protocol: output_protocol_for_transport(&output_transport),
                                    transport: output_transport,
                                    universe: target_universe,
                                    address: address.unwrap_or(1),
                                },
                            }
                        }
                        InputTarget::Fixture { .. } => {
                            if targets.is_empty() {
                                continue;
                            }
                            ResolvedInputDestination::Fixture { targets }
                        }
                        InputTarget::Disabled => continue,
                    };

                    routes_with_index.push((
                        route_index,
                        ResolvedInputRoute {
                            source,
                            priority: route.priority,
                            destination,
                        },
                    ));
                }
            }
            InputSource::Fixture {
                uids,
                element,
                param,
            } => {
                let target = &route.target;

                for uid in uids {
                    let source = ResolvedInputSource::Fixture {
                        uid: *uid,
                        element: *element,
                        param: param.clone(),
                    };

                    if disabled_sources
                        .iter()
                        .any(|disabled| input_source_matches(&source, disabled))
                    {
                        continue;
                    }

                    let targets = resolve_input_targets(
                        target,
                        1,
                        route.clone,
                        &console_addresses,
                        &data_provider,
                        &param_query,
                        true,
                    );
                    if targets.is_empty() {
                        continue;
                    }

                    routes_with_index.push((
                        route_index,
                        ResolvedInputRoute {
                            source,
                            priority: route.priority,
                            destination: ResolvedInputDestination::Fixture { targets },
                        },
                    ));
                }
            }
        }
    }

    routes_with_index
        .sort_by_key(|(index, route)| (std::cmp::Reverse(route.priority), *index as i32));

    resolved.routes = routes_with_index
        .into_iter()
        .map(|(_, route)| route)
        .collect();
}

fn resolve_input_targets(
    target: &InputTarget,
    target_universe: u16,
    clone: bool,
    console_addresses: &ConsoleDmxAddresses,
    data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceRef<Parameter>>,
    include_virtual: bool,
) -> Vec<ResolvedInputTarget> {
    match target {
        InputTarget::Fixture {
            uids,
            element,
            param,
        } => {
            let mut targets = Vec::new();
            let mut running_offset = 0u16;

            for uid in uids {
                let params = collect_fixture_parameters(
                    data_provider,
                    param_query,
                    *uid,
                    *element,
                    param.as_deref(),
                    1,
                    include_virtual,
                );
                if params.parameters.is_empty() {
                    continue;
                }

                let fixture_offset = if clone { 0 } else { running_offset };
                let footprint = params.footprint();
                for param in params.parameters {
                    targets.push(ResolvedInputTarget {
                        entity: param.target,
                        offsets: offset_slots(&param.slots, fixture_offset),
                    });
                }

                if !clone {
                    running_offset = fixture_offset.saturating_add(footprint);
                }
            }

            targets
        }
        InputTarget::Console { universe, address } => {
            let base_address = address.unwrap_or(1);
            if !range_contains(*universe, target_universe) {
                return Vec::new();
            }
            let mut targets: Vec<ResolvedInputTarget> = console_addresses
                .parameters
                .iter()
                .filter(|(_, console_address)| {
                    console_address.universe == target_universe
                        && console_address
                            .addresses
                            .iter()
                            .all(|address| *address >= base_address)
                })
                .map(|(entity, console_address)| ResolvedInputTarget {
                    entity: *entity,
                    offsets: console_address
                        .addresses
                        .iter()
                        .map(|address| address - base_address)
                        .collect(),
                })
                .collect();
            targets.sort_by_key(|target| (target.offsets.iter().min().copied(), target.entity));
            targets
        }
        InputTarget::Transport { .. } => Vec::new(),
        InputTarget::Disabled => Vec::new(),
    }
}

/// Resolved per-parameter output components rewritten by [`resolve_output_routes`].
type ResolvedParameterOutputs<'a> = (
    Option<&'a mut ResolvedOutputDestinations>,
    Option<&'a mut ResolvedConsoleDestination>,
);

/// Resolve output routes into per-parameter destinations and the wire output routing plan.
///
/// Fixture→transport routes become per-parameter [`ResolvedOutputDestinations`] feeding
/// direct output buffers; console→transport routes become console window feeds. Each
/// parameter's console address is mirrored into [`ResolvedConsoleDestination`]. On rebuild,
/// fixture-owned console and output buffer values are cleared so moved or removed
/// routes leave no ghost values behind.
pub fn resolve_output_routes(
    output_routes: Res<OutputRoutes>,
    console_addresses: Res<ConsoleDmxAddresses>,
    data_provider: Res<FixtureDataProviderExt>,
    network_outputs: Res<NetworkDmxOutputTargets>,
    usb_outputs: Res<UsbDmxOutputTargets>,
    param_query: Query<InstanceRef<Parameter>>,
    param_entities: Query<Entity, With<Parameter>>,
    mut destinations_query: Query<ResolvedParameterOutputs, With<Parameter>>,
    mut routing: ResMut<OutputRouting>,
    mut universes: ResMut<ConsoleDmxUniverses>,
    mut commands: Commands,
) {
    let should_rebuild = output_routes.is_changed()
        || console_addresses.is_changed()
        || data_provider.is_changed()
        || network_outputs.is_changed()
        || usb_outputs.is_changed();
    if !should_rebuild {
        return;
    }

    let mut destinations: HashMap<Entity, Vec<OutputDestination>> = HashMap::new();
    let mut feeds: HashMap<OutputFrameKey, OutputFrameFeed> = HashMap::new();

    for route in output_routes_in_overlay_order(&output_routes) {
        match (&route.source, &route.target) {
            (
                source @ (OutputSource::Fixture { .. } | OutputSource::FixtureBreak { .. }),
                OutputTarget::Transport {
                    target,
                    universe,
                    address,
                },
            ) => {
                let Some(selection) = source.fixture_selection() else {
                    continue;
                };
                let Some(output_transport) =
                    output_transport_from_target_id(target, &network_outputs, &usb_outputs)
                else {
                    continue;
                };
                let mut layout = FixturePatchLayout::new(*universe, *address, route.clone);
                for uid in selection.uids {
                    let (target_universe, fixture_address) = layout.place_next();
                    let params = collect_fixture_parameters(
                        &data_provider,
                        &param_query,
                        *uid,
                        selection.element,
                        selection.param,
                        selection.dmx_break,
                        false,
                    );
                    if params.parameters.is_empty() {
                        continue;
                    }

                    let footprint = params.footprint();
                    for param in params.parameters {
                        destinations
                            .entry(param.target)
                            .or_default()
                            .push(OutputDestination {
                                transport: output_transport.clone(),
                                universe: target_universe,
                                addresses: offset_slots(&param.slots, fixture_address),
                            });
                    }

                    layout.advance(footprint);
                }
            }
            (
                OutputSource::Console { universe, address },
                OutputTarget::Transport {
                    target,
                    universe: target_universe,
                    address: target_address,
                },
            ) => {
                let Some(output_transport) =
                    output_transport_from_target_id(target, &network_outputs, &usb_outputs)
                else {
                    continue;
                };
                if matches!(output_transport, OutputTransport::Disabled) {
                    continue;
                }
                let source_universes = expand_range(*universe);
                let source_universes = if source_universes.is_empty() {
                    let universes = console_addresses.universes();
                    if universes.is_empty() {
                        vec![1]
                    } else {
                        universes
                    }
                } else {
                    source_universes
                };

                let target_universes = expand_range(*target_universe);
                let target_universes = if target_universes.is_empty() {
                    source_universes.clone()
                } else {
                    target_universes
                };

                let window = ChannelWindow {
                    source_address: address.unwrap_or(1),
                    target_address: target_address.unwrap_or(1),
                };
                for (source_index, source_universe) in source_universes.iter().enumerate() {
                    let wire_universe =
                        map_universe_by_index(&source_universes, &target_universes, source_index);
                    feeds
                        .entry((output_transport.clone(), wire_universe))
                        .or_default()
                        .console_windows
                        .push(ConsoleWindowFeed {
                            console_universe: *source_universe,
                            window,
                        });
                }
            }
            _ => {}
        }
    }

    for entity in &param_entities {
        let entry = destinations.remove(&entity).unwrap_or_default();
        for destination in &entry {
            if !matches!(destination.transport, OutputTransport::Disabled) {
                feeds
                    .entry((destination.transport.clone(), destination.universe))
                    .or_default()
                    .direct = true;
            }
        }
        let console_destination = ResolvedConsoleDestination {
            address: console_addresses.parameters.get(&entity).cloned(),
        };
        let Ok((destinations_component, console_component)) = destinations_query.get_mut(entity)
        else {
            continue;
        };

        match destinations_component {
            Some(mut component) => component.destinations = entry,
            None => {
                commands.entity(entity).insert(ResolvedOutputDestinations {
                    destinations: entry,
                });
            }
        }
        match console_component {
            Some(mut component) => {
                component.set_if_neq(console_destination);
            }
            None => {
                commands.entity(entity).insert(console_destination);
            }
        }
    }

    routing.set_output_feeds(feeds);
    universes.clear_output_route_values();
}
