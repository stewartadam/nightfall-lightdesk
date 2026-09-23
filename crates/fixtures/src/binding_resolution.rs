// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Systems for resolving patch bindings into runtime caches.

use std::collections::HashMap;
use std::str::FromStr;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_dmx::prelude::Attribute;
use nightfall_io::BindingTransport;
use nightfall_io::prelude::{
    NetworkDmxOutputTarget, NetworkDmxOutputTargets, OutputTransport, UsbDmxOutputTarget,
    UsbDmxOutputTargets,
};
use uuid::Uuid;

use crate::prelude::*;

const DEFAULT_UNIVERSE_MAX: u16 = 512;

/// Resolved fixture parameter target used during binding resolution.
#[derive(Debug, Clone)]
struct ParameterTarget {
    entity: Entity,
    width: u16,
}

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

fn default_universe_list() -> Vec<u16> {
    (1..=DEFAULT_UNIVERSE_MAX).collect()
}

fn range_contains(range: Option<DmxRange>, value: u16) -> bool {
    match range {
        Some(range) => value >= range.start && value <= range.end,
        None => true,
    }
}

fn collect_fixture_parameters(
    data_provider: &FixtureDataProviderExt,
    param_query: &Query<InstanceRef<Parameter>>,
    fixture_uid: Uuid,
    element: Option<u16>,
    param: Option<&str>,
    include_virtual: bool,
) -> Vec<ParameterTarget> {
    let mut results = Vec::new();
    let element_indices: Vec<u32> = if let Some(element) = element {
        vec![element as u32]
    } else {
        fixture_element_indices_in_dmx_order(data_provider, fixture_uid)
    };

    if let Some(param_name) = param {
        for element_index in element_indices {
            let fixture_ref = FixtureRef {
                fixture_uid,
                index: Some(element_index),
            };
            let attribute = parse_attribute(param_name);
            if let Some(resolved_parameter) =
                data_provider.try_parameter_for_logical_attribute(&fixture_ref, &attribute)
            {
                let param_instance = resolved_parameter.instance;
                if let Ok(param_ref) = param_query.get(param_instance.entity()) {
                    if !include_virtual
                        && param_ref.metadata.attribute == Attribute::VirtualIntensity
                    {
                        continue;
                    }
                    results.push(ParameterTarget {
                        entity: param_instance.entity(),
                        width: param_ref.metadata.resolution.channel_width(),
                    });
                }
            }
        }
        return results;
    }

    for element_index in element_indices {
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(element_index),
        };
        let params = data_provider.parameter_entities_for_element(&fixture_ref);
        for param_instance in params {
            if let Ok(param_ref) = param_query.get(param_instance.entity()) {
                if !include_virtual && param_ref.metadata.attribute == Attribute::VirtualIntensity {
                    continue;
                }
                results.push(ParameterTarget {
                    entity: param_instance.entity(),
                    width: param_ref.metadata.resolution.channel_width(),
                });
            }
        }
    }

    results
}

/// Resolves logical element positions to the declared physical wiring layout.
fn fixture_element_indices_in_dmx_order(
    data_provider: &FixtureDataProviderExt,
    fixture_uid: Uuid,
) -> Vec<u32> {
    let Ok(fixture) = data_provider.inner.get(fixture_uid) else {
        return Vec::new();
    };

    if fixture.layout == Some(crate::fixture::FixtureLayout::RgbStrobeBar) {
        return (25..=48)
            .rev()
            .chain(49..=72)
            .chain((1..=24).rev())
            .collect();
    }

    if fixture.layout == Some(crate::fixture::FixtureLayout::RotatingWashBeam) {
        return std::iter::once(1)
            .chain((2..=13).rev())
            .chain(14..=37)
            .collect();
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

fn output_source_matches(source: &OutputSource, disabled: &OutputSource) -> bool {
    match (source, disabled) {
        (
            OutputSource::Fixture {
                uids,
                element,
                param,
            },
            OutputSource::Fixture {
                uids: disabled_uids,
                element: disabled_element,
                param: disabled_param,
            },
        ) => {
            uids.iter().any(|uid| disabled_uids.contains(uid))
                && disabled_element.is_none_or(|idx| *element == Some(idx))
                && disabled_param
                    .as_ref()
                    .is_none_or(|p| param.as_ref() == Some(p))
        }
        (
            OutputSource::Console { universe, address },
            OutputSource::Console {
                universe: disabled_universe,
                address: disabled_address,
            },
        ) => {
            let universe_match = match (universe, disabled_universe) {
                (Some(source_range), Some(disabled_range)) => {
                    source_range.start <= disabled_range.end
                        && disabled_range.start <= source_range.end
                }
                (Some(_), None) | (None, Some(_)) | (None, None) => true,
            };
            let address_match = disabled_address
                .is_none_or(|addr| address.is_none_or(|source_addr| source_addr == addr));
            universe_match && address_match
        }
        _ => false,
    }
}

fn output_transport_from_target_id(
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

fn output_protocol_for_transport(transport: &OutputTransport) -> BindingTransport {
    match transport {
        OutputTransport::Sacn { .. } => BindingTransport::Sacn,
        OutputTransport::ArtNet { .. } => BindingTransport::ArtNet,
        OutputTransport::Udmx { .. } | OutputTransport::Disabled => BindingTransport::Udmx,
    }
}

/// Rebuild `ConsoleDmxAddresses` from output bindings and fixtures when inputs change.
pub fn derive_console_addresses(
    output_bindings: Res<OutputBindings>,
    disabled_bindings: Res<DisabledBindings>,
    data_provider: Res<FixtureDataProviderExt>,
    param_query: Query<InstanceRef<Parameter>>,
    mut console_addresses: ResMut<ConsoleDmxAddresses>,
) {
    let should_rebuild = output_bindings.is_changed()
        || disabled_bindings.is_changed()
        || data_provider.is_changed();
    if !should_rebuild {
        return;
    }

    let mut disabled_sources: Vec<OutputSource> = disabled_bindings
        .bindings
        .iter()
        .filter_map(|binding| match binding {
            DisabledBinding::Output { source, .. } => Some(source.clone()),
            _ => None,
        })
        .collect();

    for binding in &output_bindings.bindings {
        if matches!(binding.target, OutputTarget::Disabled) {
            disabled_sources.push(binding.source.clone());
        }
    }

    console_addresses.addresses.clear();

    let mut bindings_with_index: Vec<(usize, &OutputBinding)> =
        output_bindings.bindings.iter().enumerate().collect();
    bindings_with_index.sort_by_key(|(index, binding)| (binding.priority, *index));

    for (_, binding) in bindings_with_index {
        let OutputSource::Fixture {
            uids,
            element,
            param,
        } = &binding.source
        else {
            continue;
        };
        let OutputTarget::Console { universe, address } = &binding.target else {
            continue;
        };

        if disabled_sources
            .iter()
            .any(|source| output_source_matches(&binding.source, source))
        {
            continue;
        }

        let target_universes = expand_range(*universe);
        let base_universes = if target_universes.is_empty() {
            vec![1]
        } else {
            target_universes
        };

        let base_address = address.unwrap_or(1);

        let mut running_address = base_address;
        let mut last_universe = base_universes.first().copied().unwrap_or(1);

        for (index, uid) in uids.iter().enumerate() {
            let target_universe = map_universe_by_index(&base_universes, &base_universes, index);
            if target_universe != last_universe {
                running_address = base_address;
                last_universe = target_universe;
            }

            let params = collect_fixture_parameters(
                &data_provider,
                &param_query,
                *uid,
                *element,
                param.as_deref(),
                false,
            );
            if params.is_empty() {
                continue;
            }

            console_addresses.addresses.insert(
                *uid,
                ConsoleDmxAddress {
                    universe: target_universe,
                    address: running_address,
                },
            );

            if !binding.clone {
                let footprint: u16 = params.iter().map(|param| param.width).sum();
                running_address = running_address.saturating_add(footprint);
            }
        }
    }
}

/// Resolve input bindings into a cached list of concrete input rules.
pub fn resolve_input_bindings(
    input_bindings: Res<InputBindings>,
    disabled_bindings: Res<DisabledBindings>,
    console_addresses: Res<ConsoleDmxAddresses>,
    data_provider: Res<FixtureDataProviderExt>,
    param_query: Query<InstanceRef<Parameter>>,
    universes: Res<ConsoleDmxUniverses>,
    network_outputs: Res<NetworkDmxOutputTargets>,
    usb_outputs: Res<UsbDmxOutputTargets>,
    mut resolved: ResMut<ResolvedInputBindings>,
) {
    let should_rebuild = input_bindings.is_changed()
        || disabled_bindings.is_changed()
        || console_addresses.is_changed()
        || data_provider.is_changed()
        || network_outputs.is_changed()
        || usb_outputs.is_changed();
    if !should_rebuild {
        return;
    }

    let mut disabled_sources: Vec<InputSource> = disabled_bindings
        .bindings
        .iter()
        .filter_map(|binding| match binding {
            DisabledBinding::Input { source, .. } => Some(source.clone()),
            _ => None,
        })
        .collect();

    for binding in &input_bindings.bindings {
        if matches!(binding.target, InputTarget::Disabled) {
            disabled_sources.push(binding.source.clone());
        }
    }

    let mut bindings_with_index: Vec<(usize, ResolvedInputBinding)> = Vec::new();

    for (binding_index, binding) in input_bindings.bindings.iter().enumerate() {
        if matches!(binding.target, InputTarget::Disabled) {
            continue;
        }

        match &binding.source {
            InputSource::Transport {
                transport,
                universe,
                address,
            } => {
                let source_universes = resolve_transport_input_universes(*universe);
                let target_universes = match &binding.target {
                    InputTarget::Console { universe, .. } => expand_range(*universe),
                    InputTarget::Transport { universe, .. } => expand_range(*universe),
                    _ => Vec::new(),
                };
                let source_address = address.unwrap_or(1);

                for (index, source_universe) in source_universes.iter().enumerate() {
                    let target_universe = if matches!(
                        binding.target,
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
                        &binding.target,
                        target_universe,
                        binding.clone,
                        &console_addresses,
                        &data_provider,
                        &param_query,
                        matches!(&binding.source, InputSource::Fixture { .. }),
                    );

                    let destination = match &binding.target {
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

                    bindings_with_index.push((
                        binding_index,
                        ResolvedInputBinding {
                            source,
                            priority: binding.priority,
                            destination,
                        },
                    ));
                }
            }
            InputSource::Console { universe, address } => {
                let source_universes = resolve_console_input_universes(*universe, &universes);
                let target_universes = match &binding.target {
                    InputTarget::Console { universe, .. } => expand_range(*universe),
                    InputTarget::Transport { universe, .. } => expand_range(*universe),
                    _ => Vec::new(),
                };
                let source_address = address.unwrap_or(1);

                for (index, source_universe) in source_universes.iter().enumerate() {
                    let target_universe = if matches!(
                        binding.target,
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
                        &binding.target,
                        target_universe,
                        binding.clone,
                        &console_addresses,
                        &data_provider,
                        &param_query,
                        matches!(&binding.source, InputSource::Fixture { .. }),
                    );

                    let destination = match &binding.target {
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

                    bindings_with_index.push((
                        binding_index,
                        ResolvedInputBinding {
                            source,
                            priority: binding.priority,
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
                let target = &binding.target;

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
                        binding.clone,
                        &console_addresses,
                        &data_provider,
                        &param_query,
                        true,
                    );
                    if targets.is_empty() {
                        continue;
                    }

                    bindings_with_index.push((
                        binding_index,
                        ResolvedInputBinding {
                            source,
                            priority: binding.priority,
                            destination: ResolvedInputDestination::Fixture { targets },
                        },
                    ));
                }
            }
        }
    }

    bindings_with_index
        .sort_by_key(|(index, binding)| (std::cmp::Reverse(binding.priority), *index as i32));

    resolved.bindings = bindings_with_index
        .into_iter()
        .map(|(_, binding)| binding)
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
                    include_virtual,
                );
                if params.is_empty() {
                    continue;
                }

                let mut fixture_offset = if clone { 0 } else { running_offset };
                for param in params {
                    targets.push(ResolvedInputTarget {
                        entity: param.entity,
                        offsets: (0..param.width)
                            .map(|byte| fixture_offset.saturating_add(byte))
                            .collect(),
                    });
                    fixture_offset = fixture_offset.saturating_add(param.width);
                }

                if !clone {
                    running_offset = fixture_offset;
                }
            }

            targets
        }
        InputTarget::Console { universe, address } => {
            let base_address = address.unwrap_or(1);
            let universe_match = |value: u16| range_contains(*universe, value);
            let mut fixtures: Vec<(Uuid, ConsoleDmxAddress)> = console_addresses
                .addresses
                .iter()
                .filter(|(_, address)| universe_match(address.universe))
                .map(|(uid, addr)| (*uid, *addr))
                .collect();

            fixtures.sort_by_key(|(_, address)| (address.universe, address.address));

            let mut targets = Vec::new();

            for (uid, console_address) in fixtures {
                if console_address.universe != target_universe {
                    continue;
                }
                if console_address.address < base_address {
                    continue;
                }

                let params =
                    collect_fixture_parameters(data_provider, param_query, uid, None, None, false);
                if params.is_empty() {
                    continue;
                }

                let base_offset = console_address.address - base_address;
                let mut param_offset = base_offset;
                for param in params {
                    targets.push(ResolvedInputTarget {
                        entity: param.entity,
                        offsets: (0..param.width)
                            .map(|byte| param_offset.saturating_add(byte))
                            .collect(),
                    });
                    param_offset = param_offset.saturating_add(param.width);
                }
            }

            targets
        }
        InputTarget::Transport { .. } => Vec::new(),
        InputTarget::Disabled => Vec::new(),
    }
}

/// Resolve output bindings into per-parameter output destinations.
pub fn resolve_output_bindings(
    output_bindings: Res<OutputBindings>,
    disabled_bindings: Res<DisabledBindings>,
    console_addresses: Res<ConsoleDmxAddresses>,
    data_provider: Res<FixtureDataProviderExt>,
    network_outputs: Res<NetworkDmxOutputTargets>,
    usb_outputs: Res<UsbDmxOutputTargets>,
    param_query: Query<InstanceRef<Parameter>>,
    param_entities: Query<Entity, With<Parameter>>,
    mut destinations_query: Query<
        (Entity, Option<&mut ResolvedOutputDestinations>),
        With<Parameter>,
    >,
    mut commands: Commands,
) {
    let should_rebuild = output_bindings.is_changed()
        || disabled_bindings.is_changed()
        || console_addresses.is_changed()
        || data_provider.is_changed()
        || network_outputs.is_changed()
        || usb_outputs.is_changed();
    if !should_rebuild {
        return;
    }

    let mut disabled_sources: Vec<OutputSource> = disabled_bindings
        .bindings
        .iter()
        .filter_map(|binding| match binding {
            DisabledBinding::Output { source, .. } => Some(source.clone()),
            _ => None,
        })
        .collect();

    for binding in &output_bindings.bindings {
        if matches!(binding.target, OutputTarget::Disabled) {
            disabled_sources.push(binding.source.clone());
        }
    }

    let mut destinations: HashMap<Entity, Vec<OutputDestination>> = HashMap::new();

    let mut bindings_with_index: Vec<(usize, &OutputBinding)> =
        output_bindings.bindings.iter().enumerate().collect();
    bindings_with_index.sort_by_key(|(index, binding)| (binding.priority, *index));

    for (_, binding) in bindings_with_index {
        if matches!(binding.target, OutputTarget::Disabled) {
            continue;
        }

        if disabled_sources
            .iter()
            .any(|source| output_source_matches(&binding.source, source))
        {
            continue;
        }

        match (&binding.source, &binding.target) {
            (
                OutputSource::Fixture {
                    uids,
                    element,
                    param,
                },
                OutputTarget::Transport {
                    target,
                    universe,
                    address,
                },
            ) => {
                let Some(output_transport) =
                    output_transport_from_target_id(target, &network_outputs, &usb_outputs)
                else {
                    continue;
                };
                let base_universes = expand_range(*universe);
                let base_universes = if base_universes.is_empty() {
                    vec![1]
                } else {
                    base_universes
                };
                let base_address = address.unwrap_or(1);

                let mut running_address = base_address;
                let mut last_universe = base_universes.first().copied().unwrap_or(1);

                for (index, uid) in uids.iter().enumerate() {
                    let target_universe =
                        map_universe_by_index(&base_universes, &base_universes, index);
                    if target_universe != last_universe {
                        running_address = base_address;
                        last_universe = target_universe;
                    }

                    let params = collect_fixture_parameters(
                        &data_provider,
                        &param_query,
                        *uid,
                        *element,
                        param.as_deref(),
                        false,
                    );
                    if params.is_empty() {
                        continue;
                    }

                    let mut fixture_offset = if binding.clone {
                        0
                    } else {
                        running_address - base_address
                    };
                    for param in params {
                        let dest_address = base_address.saturating_add(fixture_offset);
                        destinations
                            .entry(param.entity)
                            .or_default()
                            .push(OutputDestination {
                                transport: output_transport.clone(),
                                universe: target_universe,
                                addresses: (0..param.width)
                                    .map(|byte| dest_address.saturating_add(byte))
                                    .collect(),
                            });
                        fixture_offset = fixture_offset.saturating_add(param.width);
                    }

                    if !binding.clone {
                        running_address = base_address.saturating_add(fixture_offset);
                    }
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
                let source_universes = expand_range(*universe);
                let source_universes = if source_universes.is_empty() {
                    let mut universes: Vec<u16> = console_addresses
                        .addresses
                        .values()
                        .map(|addr| addr.universe)
                        .collect();
                    universes.sort_unstable();
                    universes.dedup();
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

                let source_base_address = address.unwrap_or(1);
                let target_base_address = target_address.unwrap_or(1);

                let mut fixtures_by_universe: HashMap<u16, Vec<(Uuid, ConsoleDmxAddress)>> =
                    HashMap::new();
                for (uid, addr) in &console_addresses.addresses {
                    fixtures_by_universe
                        .entry(addr.universe)
                        .or_default()
                        .push((*uid, *addr));
                }

                for (source_index, source_universe) in source_universes.iter().enumerate() {
                    let target_universe_value =
                        map_universe_by_index(&source_universes, &target_universes, source_index);

                    let fixtures = fixtures_by_universe
                        .get(source_universe)
                        .cloned()
                        .unwrap_or_default();
                    for (uid, console_addr) in fixtures {
                        if console_addr.address < source_base_address {
                            continue;
                        }

                        let params = collect_fixture_parameters(
                            &data_provider,
                            &param_query,
                            uid,
                            None,
                            None,
                            false,
                        );
                        if params.is_empty() {
                            continue;
                        }

                        let mut param_offset = console_addr.address - source_base_address;
                        for param in params {
                            let dest_address = target_base_address.saturating_add(param_offset);
                            destinations
                                .entry(param.entity)
                                .or_default()
                                .push(OutputDestination {
                                    transport: output_transport.clone(),
                                    universe: target_universe_value,
                                    addresses: (0..param.width)
                                        .map(|byte| dest_address.saturating_add(byte))
                                        .collect(),
                                });
                            param_offset = param_offset.saturating_add(param.width);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    for entity in &param_entities {
        let entry = destinations.remove(&entity).unwrap_or_default();
        if let Ok((_, Some(mut destinations_component))) = destinations_query.get_mut(entity) {
            destinations_component.destinations = entry;
            continue;
        }
        commands.entity(entity).insert(ResolvedOutputDestinations {
            destinations: entry,
        });
    }
}
