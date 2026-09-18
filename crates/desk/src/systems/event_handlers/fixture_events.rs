// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Event handlers for fixture commands.

use std::collections::{HashMap, HashSet, hash_map::Entry};

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::{ColorPath, ColorPathId, FixtureRef};
use nightfall_engine::prelude::*;
use nightfall_fixtures::FixturePlacementUpdateEntry;
use nightfall_fixtures::binding_validation::validate_bindings;
use nightfall_fixtures::parameter::Parameter;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::websocket::{
    SuppressFixtureChangedSnapshot, broadcast_fixture_command, send_color_path_defaults,
};
use nightfall_io::BindingTransport;
use nightfall_io::prelude::*;
use uuid::Uuid;

/// Resolves a patch target ID to its binding transport family.
fn binding_transport_from_target_id(target: &str) -> Option<BindingTransport> {
    match target {
        "sacn" => Some(BindingTransport::Sacn),
        "artnet" => Some(BindingTransport::ArtNet),
        "udmx" => Some(BindingTransport::Udmx),
        _ => None,
    }
}

/// Resolves a configured patch target ID to the concrete runtime output transport.
fn output_transport_from_target_id(
    target: &str,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<OutputTransport, String> {
    if let Some(transport) = network_outputs
        .get(target)
        .and_then(NetworkDmxOutputTarget::output_transport)
    {
        return Ok(transport);
    }
    if let Some(transport) = usb_outputs
        .get(target)
        .map(UsbDmxOutputTarget::output_transport)
    {
        return Ok(transport);
    }
    Err(format!("Unknown output transport target '{target}'"))
}

/// Verifies that an assigned color path exists when the command references one.
fn validate_color_path_id(
    color_paths: Option<&Res<DataProvider<ColorPath>>>,
    color_path_id: Option<ColorPathId>,
) -> Result<(), String> {
    let Some(color_path_id) = color_path_id else {
        return Ok(());
    };
    let Some(color_paths) = color_paths else {
        return Err(
            "Failed to set fixture color path default: color path provider unavailable".to_string(),
        );
    };
    if color_paths.from_id(color_path_id.0).is_err() {
        return Err(format!(
            "Failed to set fixture color path default: color path {} not found",
            color_path_id.0
        ));
    }
    Ok(())
}

/// Returns whether an output source targets only one fixture without element or parameter filters.
fn is_simple_fixture_source(source: &OutputSource, uid: Uuid) -> bool {
    match source {
        OutputSource::Fixture {
            uids,
            element,
            param,
        } => uids.len() == 1 && uids[0] == uid && element.is_none() && param.is_none(),
        _ => false,
    }
}

/// Returns whether an output source includes the requested fixture UID.
fn source_contains_fixture(source: &OutputSource, uid: Uuid) -> bool {
    match source {
        OutputSource::Fixture { uids, .. } => uids.contains(&uid),
        _ => false,
    }
}

/// Validates that fixture patch updates can safely replace a fixture's simple output bindings.
fn ensure_simple_fixture_bindings(
    uid: Uuid,
    output_bindings: &OutputBindings,
    disabled_bindings: &DisabledBindings,
) -> Result<(), String> {
    for binding in &output_bindings.bindings {
        if !source_contains_fixture(&binding.source, uid) {
            continue;
        }

        if !is_simple_fixture_source(&binding.source, uid) {
            return Err("Fixture patch update cannot modify multi-fixture or element bindings; use patch binding commands instead".to_string());
        }

        if !matches!(
            binding.target,
            OutputTarget::Transport { .. } | OutputTarget::Disabled
        ) {
            return Err("Fixture patch update cannot modify console output bindings; use patch binding commands instead".to_string());
        }
    }

    for binding in &disabled_bindings.bindings {
        let DisabledBinding::Output { source, .. } = binding else {
            continue;
        };
        if !source_contains_fixture(source, uid) {
            continue;
        }
        if !is_simple_fixture_source(source, uid) {
            return Err("Fixture patch update cannot modify multi-fixture or element bindings; use patch binding commands instead".to_string());
        }
    }

    Ok(())
}

/// Removes existing simple output bindings for a fixture before writing replacement patch data.
fn remove_simple_fixture_output_bindings(bindings: &mut OutputBindings, uid: Uuid) {
    bindings
        .bindings
        .retain(|binding| !is_simple_fixture_source(&binding.source, uid));
}

/// Removes existing simple disabled output bindings for a fixture before writing replacement patch data.
fn remove_simple_fixture_disabled_bindings(bindings: &mut DisabledBindings, uid: Uuid) {
    bindings.bindings.retain(|binding| {
        let DisabledBinding::Output { source, .. } = binding else {
            return true;
        };
        !is_simple_fixture_source(source, uid)
    });
}

/// Returns the fixture's current output transport together with its persisted target ID when available.
fn current_fixture_transport(
    uid: Uuid,
    output_bindings: &OutputBindings,
    disabled_bindings: &DisabledBindings,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<Option<(OutputTransport, Option<String>)>, String> {
    for binding in &disabled_bindings.bindings {
        let DisabledBinding::Output { source, .. } = binding else {
            continue;
        };
        if is_simple_fixture_source(source, uid) {
            return Ok(Some((OutputTransport::Disabled, None)));
        }
    }

    if let Some(binding) = output_bindings
        .bindings
        .iter()
        .find(|binding| is_simple_fixture_source(&binding.source, uid))
    {
        match &binding.target {
            OutputTarget::Transport { target, .. } => {
                return output_transport_from_target_id(target, network_outputs, usb_outputs)
                    .map(|transport| Some((transport, Some(target.clone()))));
            }
            OutputTarget::Disabled => return Ok(Some((OutputTransport::Disabled, None))),
            OutputTarget::Console { .. } => {
                return Err(
                    "Fixture patch update cannot modify console output bindings; use patch binding commands instead"
                        .to_string(),
                );
            }
        }
    }

    Ok(None)
}

fn apply_fixture_placement_update(
    fixture: &mut Fixture,
    position: &Option<FixturePlacementPositionUpdate>,
    rotation: &Option<FixturePlacementRotationUpdate>,
) -> bool {
    let previous_placement = fixture.placement.clone();

    if let Some(pos_update) = position {
        match pos_update {
            FixturePlacementPositionUpdate::All(pos) => {
                fixture.placement.position = *pos;
            }
            FixturePlacementPositionUpdate::X(x) => {
                fixture.placement.position.x = *x;
            }
            FixturePlacementPositionUpdate::Y(y) => {
                fixture.placement.position.y = *y;
            }
            FixturePlacementPositionUpdate::Z(z) => {
                fixture.placement.position.z = *z;
            }
        }
    }

    if let Some(rot_update) = rotation {
        match rot_update {
            FixturePlacementRotationUpdate::All(rot) => {
                fixture.placement.rotation = *rot;
            }
            FixturePlacementRotationUpdate::X(x) => {
                fixture.placement.rotation.x = *x;
            }
            FixturePlacementRotationUpdate::Y(y) => {
                fixture.placement.rotation.y = *y;
            }
            FixturePlacementRotationUpdate::Z(z) => {
                fixture.placement.rotation.z = *z;
            }
        }
    }

    fixture.placement != previous_placement
}

fn collect_fixture_placement_batch_updates(
    fixture_data_provider: &FixtureDataProviderExt,
    updates: &[FixturePlacementUpdateEntry],
) -> Result<(Vec<Fixture>, Vec<FixturePlacementUpdateEntry>), String> {
    let mut staged_fixtures: HashMap<u32, Fixture> = HashMap::new();
    let mut changed_fixture_ids: HashSet<u32> = HashSet::new();
    let mut changed_updates = Vec::new();

    for update in updates {
        let fixture = match staged_fixtures.entry(update.id) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let base_fixture = fixture_data_provider
                    .inner
                    .from_id(update.id)
                    .map(|fixture| fixture.clone())
                    .map_err(|_| {
                        format!(
                            "Failed to update placement for fixture {}: not found",
                            update.id
                        )
                    })?;
                entry.insert(base_fixture)
            }
        };

        let changed = apply_fixture_placement_update(fixture, &update.position, &update.rotation);
        if changed {
            changed_fixture_ids.insert(update.id);
            changed_updates.push(update.clone());
        }
    }

    let fixtures_to_store = changed_fixture_ids
        .into_iter()
        .filter_map(|id| staged_fixtures.remove(&id))
        .collect();

    Ok((fixtures_to_store, changed_updates))
}

/// Endpoint categories used when resolving patch binding updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndpointKind {
    Transport,
    Console,
    Fixture,
    Disabled,
}

/// Patch binding direction used when emitting fixture binding events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BindingDirection {
    Input,
    Output,
}

/// Concrete input or output endpoint attached to a fixture binding.
#[derive(Debug, Clone)]
enum ResolvedBindingEndpoint {
    Console {
        universe: Option<DmxRange>,
        address: Option<u16>,
    },
    Transport {
        target: String,
        universe: Option<DmxRange>,
        address: Option<u16>,
    },
    Fixture {
        uids: Vec<Uuid>,
        element: Option<u16>,
        param: Option<String>,
    },
    Disabled,
}

fn endpoint_kind(endpoint: &BindingEndpoint) -> EndpointKind {
    match endpoint {
        BindingEndpoint::Console { .. } => EndpointKind::Console,
        BindingEndpoint::Transport { .. } => EndpointKind::Transport,
        BindingEndpoint::Fixture { .. } => EndpointKind::Fixture,
        BindingEndpoint::Disabled => EndpointKind::Disabled,
    }
}

fn resolve_fixture_uids(
    ids: &[u32],
    data_provider: &FixtureDataProviderExt,
) -> Result<Vec<Uuid>, String> {
    if ids.is_empty() {
        return Err("fixture IDs resolve to empty set".to_string());
    }

    let mut uids = Vec::with_capacity(ids.len());
    for id in ids {
        match data_provider.inner.from_id(*id) {
            Ok(fixture) => uids.push(fixture.identifiers.uid),
            Err(_) => return Err(format!("Fixture {} not found", id)),
        }
    }
    Ok(uids)
}

fn resolve_binding_endpoint(
    endpoint: &BindingEndpoint,
    data_provider: &FixtureDataProviderExt,
) -> Result<ResolvedBindingEndpoint, String> {
    match endpoint {
        BindingEndpoint::Console { universe, address } => Ok(ResolvedBindingEndpoint::Console {
            universe: *universe,
            address: *address,
        }),
        BindingEndpoint::Transport {
            target,
            universe,
            address,
        } => Ok(ResolvedBindingEndpoint::Transport {
            target: target.clone(),
            universe: *universe,
            address: *address,
        }),
        BindingEndpoint::Fixture {
            ids,
            element,
            param,
        } => Ok(ResolvedBindingEndpoint::Fixture {
            uids: resolve_fixture_uids(ids, data_provider)?,
            element: *element,
            param: param.clone(),
        }),
        BindingEndpoint::Disabled => Ok(ResolvedBindingEndpoint::Disabled),
    }
}

fn classify_binding_direction(
    source: &BindingEndpoint,
    target: &BindingEndpoint,
) -> Result<BindingDirection, String> {
    let source_kind = endpoint_kind(source);
    let target_kind = endpoint_kind(target);

    use BindingDirection::{Input, Output};
    use EndpointKind::{Console, Disabled, Fixture, Transport};

    match (source_kind, target_kind) {
        (Transport, _) => Ok(Input),
        (_, Transport) => Ok(Output),
        (Console, Console) => Err("Console -> console bindings are invalid".to_string()),
        (Console, Fixture) => Err("Console -> fixture bindings are invalid".to_string()),
        (Console, _) => Ok(Output),
        (Fixture, Fixture) => Ok(Input),
        (Fixture, _) => Ok(Output),
        (Disabled, _) => Err("Disabled endpoint cannot be used as a source".to_string()),
    }
}

fn infer_binding_scopes(
    source: Option<&BindingEndpoint>,
    target: Option<&BindingEndpoint>,
) -> Result<(bool, bool), String> {
    if matches!(source, Some(BindingEndpoint::Disabled)) {
        return Err("Disabled endpoint cannot be used as a source".to_string());
    }

    let source_kind = source.map(endpoint_kind);
    let target_kind = target.map(endpoint_kind);

    use EndpointKind::{Console, Disabled, Fixture, Transport};

    if source_kind == Some(Transport) {
        return Ok((true, false));
    }

    if target_kind == Some(Transport) {
        if source_kind.is_none() {
            return Ok((true, true));
        }
        return Ok((false, true));
    }

    if source_kind == Some(Console) {
        if matches!(target_kind, Some(Console) | Some(Fixture)) {
            return Err("Console -> console/fixture bindings are invalid".to_string());
        }
        return Ok((false, true));
    }

    if target_kind == Some(Console) {
        if source_kind == Some(Fixture) {
            return Ok((false, true));
        }
        if source_kind.is_none() {
            return Ok((true, false));
        }
        if source_kind == Some(Console) {
            return Err("Console -> console bindings are invalid".to_string());
        }
    }

    if source_kind == Some(Fixture) && target_kind == Some(Fixture) {
        return Ok((true, false));
    }

    if source_kind == Some(Fixture) {
        return Ok((false, true));
    }

    if target_kind == Some(Fixture) {
        return Ok((true, false));
    }

    if target_kind == Some(Disabled) || (source_kind.is_none() && target_kind.is_none()) {
        return Ok((true, true));
    }

    Err("Invalid patch binding filter".to_string())
}

fn input_source_from_endpoint(endpoint: &ResolvedBindingEndpoint) -> Result<InputSource, String> {
    match endpoint {
        ResolvedBindingEndpoint::Transport {
            target,
            universe,
            address,
        } => {
            let transport = binding_transport_from_target_id(target).ok_or_else(|| {
                format!("Network output target '{target}' cannot be used as an input source")
            })?;
            Ok(InputSource::Transport {
                transport,
                universe: *universe,
                address: *address,
            })
        }
        ResolvedBindingEndpoint::Console { universe, address } => Ok(InputSource::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedBindingEndpoint::Fixture {
            uids,
            element,
            param,
        } => Ok(InputSource::Fixture {
            uids: uids.clone(),
            element: *element,
            param: param.clone(),
        }),
        ResolvedBindingEndpoint::Disabled => {
            Err("Disabled endpoint cannot be used as a source".to_string())
        }
    }
}

fn input_target_from_endpoint(endpoint: &ResolvedBindingEndpoint) -> Result<InputTarget, String> {
    match endpoint {
        ResolvedBindingEndpoint::Console { universe, address } => Ok(InputTarget::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedBindingEndpoint::Transport {
            target,
            universe,
            address,
        } => Ok(InputTarget::Transport {
            target: target.clone(),
            universe: *universe,
            address: *address,
        }),
        ResolvedBindingEndpoint::Fixture {
            uids,
            element,
            param,
        } => Ok(InputTarget::Fixture {
            uids: uids.clone(),
            element: *element,
            param: param.clone(),
        }),
        ResolvedBindingEndpoint::Disabled => Ok(InputTarget::Disabled),
    }
}

fn output_source_from_endpoint(endpoint: &ResolvedBindingEndpoint) -> Result<OutputSource, String> {
    match endpoint {
        ResolvedBindingEndpoint::Console { universe, address } => Ok(OutputSource::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedBindingEndpoint::Fixture {
            uids,
            element,
            param,
        } => Ok(OutputSource::Fixture {
            uids: uids.clone(),
            element: *element,
            param: param.clone(),
        }),
        ResolvedBindingEndpoint::Transport { .. } => {
            Err("Transport endpoint cannot be used as an output source".to_string())
        }
        ResolvedBindingEndpoint::Disabled => {
            Err("Disabled endpoint cannot be used as a source".to_string())
        }
    }
}

fn output_target_from_endpoint(endpoint: &ResolvedBindingEndpoint) -> Result<OutputTarget, String> {
    match endpoint {
        ResolvedBindingEndpoint::Transport {
            target,
            universe,
            address,
        } => Ok(OutputTarget::Transport {
            target: target.clone(),
            universe: *universe,
            address: *address,
        }),
        ResolvedBindingEndpoint::Console { universe, address } => Ok(OutputTarget::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedBindingEndpoint::Disabled => Ok(OutputTarget::Disabled),
        ResolvedBindingEndpoint::Fixture { .. } => {
            Err("Fixture endpoint cannot be used as an output target".to_string())
        }
    }
}

fn validate_network_output_target_endpoint(
    endpoint: &ResolvedBindingEndpoint,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<(), String> {
    let ResolvedBindingEndpoint::Transport {
        target, universe, ..
    } = endpoint
    else {
        return Ok(());
    };

    if usb_outputs.get(target).is_some() {
        return Ok(());
    }

    let output = network_outputs
        .get(target)
        .ok_or_else(|| format!("Unknown output transport target '{target}'"))?;
    let Some(_transport) = output.output_transport() else {
        return Err(format!(
            "Network DMX output target '{target}' has invalid delivery settings"
        ));
    };

    if output.protocol == NetworkDmxProtocol::Sacn
        && universe.is_some_and(|range| range.start == 0 || range.end == 0)
    {
        return Err(format!(
            "sACN output target '{target}' requires universe 1 or higher"
        ));
    }

    Ok(())
}

fn ranges_overlap(filter: Option<DmxRange>, binding: Option<DmxRange>) -> bool {
    match (filter, binding) {
        (None, _) => true,
        (Some(_), None) => true,
        (Some(filter), Some(binding)) => filter.start <= binding.end && binding.start <= filter.end,
    }
}

fn address_matches(filter: Option<u16>, binding: Option<u16>) -> bool {
    match filter {
        None => true,
        Some(addr) => binding.unwrap_or(1) == addr,
    }
}

fn fixture_matches_filter(
    binding_uids: &[Uuid],
    binding_element: Option<u16>,
    binding_param: Option<&str>,
    filter_uids: &[Uuid],
    filter_element: Option<u16>,
    filter_param: Option<&str>,
) -> bool {
    let uids_match = filter_uids
        .iter()
        .any(|uid| binding_uids.iter().any(|binding_uid| binding_uid == uid));
    let element_match =
        filter_element.is_none_or(|filter| binding_element.is_none_or(|binding| binding == filter));
    let param_match =
        filter_param.is_none_or(|filter| binding_param.is_none_or(|binding| binding == filter));

    uids_match && element_match && param_match
}

fn input_source_matches_filter(binding: &InputSource, filter: &InputSource) -> bool {
    match (binding, filter) {
        (
            InputSource::Transport {
                transport,
                universe,
                address,
            },
            InputSource::Transport {
                transport: filter_transport,
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            transport == filter_transport
                && ranges_overlap(*filter_universe, *universe)
                && address_matches(*filter_address, *address)
        }
        (
            InputSource::Console { universe, address },
            InputSource::Console {
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            ranges_overlap(*filter_universe, *universe)
                && address_matches(*filter_address, *address)
        }
        (
            InputSource::Fixture {
                uids,
                element,
                param,
            },
            InputSource::Fixture {
                uids: filter_uids,
                element: filter_element,
                param: filter_param,
            },
        ) => fixture_matches_filter(
            uids,
            *element,
            param.as_deref(),
            filter_uids,
            *filter_element,
            filter_param.as_deref(),
        ),
        _ => false,
    }
}

fn input_target_matches_filter(binding: &InputTarget, filter: &InputTarget) -> bool {
    match (binding, filter) {
        (
            InputTarget::Transport {
                target,
                universe,
                address,
            },
            InputTarget::Transport {
                target: filter_target,
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            target == filter_target
                && ranges_overlap(*filter_universe, *universe)
                && address_matches(*filter_address, *address)
        }
        (
            InputTarget::Console { universe, address },
            InputTarget::Console {
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            ranges_overlap(*filter_universe, *universe)
                && address_matches(*filter_address, *address)
        }
        (
            InputTarget::Fixture {
                uids,
                element,
                param,
            },
            InputTarget::Fixture {
                uids: filter_uids,
                element: filter_element,
                param: filter_param,
            },
        ) => fixture_matches_filter(
            uids,
            *element,
            param.as_deref(),
            filter_uids,
            *filter_element,
            filter_param.as_deref(),
        ),
        (InputTarget::Disabled, InputTarget::Disabled) => true,
        _ => false,
    }
}

fn output_source_matches_filter(binding: &OutputSource, filter: &OutputSource) -> bool {
    match (binding, filter) {
        (
            OutputSource::Console { universe, address },
            OutputSource::Console {
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            ranges_overlap(*filter_universe, *universe)
                && address_matches(*filter_address, *address)
        }
        (
            OutputSource::Fixture {
                uids,
                element,
                param,
            },
            OutputSource::Fixture {
                uids: filter_uids,
                element: filter_element,
                param: filter_param,
            },
        ) => fixture_matches_filter(
            uids,
            *element,
            param.as_deref(),
            filter_uids,
            *filter_element,
            filter_param.as_deref(),
        ),
        _ => false,
    }
}

fn output_target_matches_filter(binding: &OutputTarget, filter: &OutputTarget) -> bool {
    match (binding, filter) {
        (
            OutputTarget::Transport {
                target,
                universe,
                address,
            },
            OutputTarget::Transport {
                target: filter_target,
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            target == filter_target
                && ranges_overlap(*filter_universe, *universe)
                && address_matches(*filter_address, *address)
        }
        (
            OutputTarget::Console { universe, address },
            OutputTarget::Console {
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            ranges_overlap(*filter_universe, *universe)
                && address_matches(*filter_address, *address)
        }
        (OutputTarget::Disabled, OutputTarget::Disabled) => true,
        _ => false,
    }
}

fn apply_patch_binding_add(
    source: &BindingEndpoint,
    target: &BindingEndpoint,
    priority: i32,
    clone: bool,
    input_bindings: &mut InputBindings,
    output_bindings: &mut OutputBindings,
    disabled_bindings: &mut DisabledBindings,
    data_provider: &FixtureDataProviderExt,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<(), String> {
    let direction = classify_binding_direction(source, target)?;
    let resolved_source = resolve_binding_endpoint(source, data_provider)?;
    let resolved_target = resolve_binding_endpoint(target, data_provider)?;
    validate_network_output_target_endpoint(&resolved_target, network_outputs, usb_outputs)?;

    let target_is_disabled = matches!(resolved_target, ResolvedBindingEndpoint::Disabled);

    match direction {
        BindingDirection::Input => {
            let input_source = input_source_from_endpoint(&resolved_source)?;
            if target_is_disabled {
                disabled_bindings.bindings.push(DisabledBinding::Input {
                    source: input_source,
                    priority,
                    clone,
                });
            } else {
                let input_target = input_target_from_endpoint(&resolved_target)?;
                input_bindings.bindings.push(InputBinding {
                    source: input_source,
                    target: input_target,
                    priority,
                    clone,
                });
            }
        }
        BindingDirection::Output => {
            let output_source = output_source_from_endpoint(&resolved_source)?;
            if target_is_disabled {
                disabled_bindings.bindings.push(DisabledBinding::Output {
                    source: output_source,
                    priority,
                    clone,
                });
            } else {
                let output_target = output_target_from_endpoint(&resolved_target)?;
                output_bindings.bindings.push(OutputBinding {
                    source: output_source,
                    target: output_target,
                    priority,
                    clone,
                });
            }
        }
    }

    Ok(())
}

fn apply_patch_binding_remove(
    source: Option<&BindingEndpoint>,
    target: Option<&BindingEndpoint>,
    priority: Option<i32>,
    clone: Option<bool>,
    input_bindings: &mut InputBindings,
    output_bindings: &mut OutputBindings,
    disabled_bindings: &mut DisabledBindings,
    data_provider: &FixtureDataProviderExt,
) -> Result<(), String> {
    let (apply_input, apply_output) = infer_binding_scopes(source, target)?;
    let resolved_source = source
        .map(|endpoint| resolve_binding_endpoint(endpoint, data_provider))
        .transpose()?;
    let resolved_target = target
        .map(|endpoint| resolve_binding_endpoint(endpoint, data_provider))
        .transpose()?;

    let target_is_disabled_filter =
        target.is_none() || matches!(target, Some(BindingEndpoint::Disabled));

    if apply_input {
        let source_filter = resolved_source
            .as_ref()
            .map(input_source_from_endpoint)
            .transpose()?;
        let target_filter = resolved_target
            .as_ref()
            .map(input_target_from_endpoint)
            .transpose()?;

        input_bindings.bindings.retain(|binding| {
            if let Some(filter) = &source_filter {
                if !input_source_matches_filter(&binding.source, filter) {
                    return true;
                }
            }
            if let Some(filter) = &target_filter {
                if !input_target_matches_filter(&binding.target, filter) {
                    return true;
                }
            }
            if let Some(filter_priority) = priority {
                if binding.priority != filter_priority {
                    return true;
                }
            }
            if let Some(filter_clone) = clone {
                if binding.clone != filter_clone {
                    return true;
                }
            }
            false
        });

        if target_is_disabled_filter {
            let source_filter = resolved_source
                .as_ref()
                .map(input_source_from_endpoint)
                .transpose()?;
            disabled_bindings.bindings.retain(|binding| {
                let DisabledBinding::Input {
                    source,
                    priority: binding_priority,
                    clone: binding_clone,
                } = binding
                else {
                    return true;
                };
                if let Some(filter) = &source_filter {
                    if !input_source_matches_filter(source, filter) {
                        return true;
                    }
                }
                if let Some(filter_priority) = priority {
                    if *binding_priority != filter_priority {
                        return true;
                    }
                }
                if let Some(filter_clone) = clone {
                    if *binding_clone != filter_clone {
                        return true;
                    }
                }
                false
            });
        }
    }

    if apply_output {
        let source_filter = resolved_source
            .as_ref()
            .map(output_source_from_endpoint)
            .transpose()?;
        let target_filter = resolved_target
            .as_ref()
            .map(output_target_from_endpoint)
            .transpose()?;

        output_bindings.bindings.retain(|binding| {
            if let Some(filter) = &source_filter {
                if !output_source_matches_filter(&binding.source, filter) {
                    return true;
                }
            }
            if let Some(filter) = &target_filter {
                if !output_target_matches_filter(&binding.target, filter) {
                    return true;
                }
            }
            if let Some(filter_priority) = priority {
                if binding.priority != filter_priority {
                    return true;
                }
            }
            if let Some(filter_clone) = clone {
                if binding.clone != filter_clone {
                    return true;
                }
            }
            false
        });

        if target_is_disabled_filter {
            let source_filter = resolved_source
                .as_ref()
                .map(output_source_from_endpoint)
                .transpose()?;
            disabled_bindings.bindings.retain(|binding| {
                let DisabledBinding::Output {
                    source,
                    priority: binding_priority,
                    clone: binding_clone,
                } = binding
                else {
                    return true;
                };
                if let Some(filter) = &source_filter {
                    if !output_source_matches_filter(source, filter) {
                        return true;
                    }
                }
                if let Some(filter_priority) = priority {
                    if *binding_priority != filter_priority {
                        return true;
                    }
                }
                if let Some(filter_clone) = clone {
                    if *binding_clone != filter_clone {
                        return true;
                    }
                }
                false
            });
        }
    }

    Ok(())
}

/// Finishes a fixture command with a structured domain failure.
fn fail_fixture_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    code: &'static str,
    message: String,
) {
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%command_id, %error, "fixture_command_failure_failed");
    }
}

/// Finishes a fixture command after its requested mutation has completed.
fn succeed_fixture_command(responder: &mut CommandResponder, command_id: CommandId) {
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%command_id, %error, "fixture_command_success_failed");
    }
}

/// Handles CRUD events for fixtures.
#[allow(clippy::type_complexity)]
pub fn crud_events(
    mut commands: Commands,
    mut fixture_data_provider: ResMut<FixtureDataProviderExt>,
    mut events: MessageReader<CommandEnvelope<FixtureCommand>>,
    broadcaster: Res<ClientEventSink>,
    mut suppress_fixture_changed_snapshot: MessageWriter<SuppressFixtureChangedSnapshot>,
    mut responder: CommandResponder,
    mut param_query: Query<InstanceMut<Parameter>>,
    mut input_bindings: ResMut<InputBindings>,
    mut output_bindings: ResMut<OutputBindings>,
    mut disabled_bindings: ResMut<DisabledBindings>,
    binding_settings: Res<BindingValidationSettings>,
    network_outputs: Res<NetworkDmxOutputTargets>,
    usb_outputs: Res<UsbDmxOutputTargets>,
    color_paths: Option<Res<DataProvider<ColorPath>>>,
) {
    for event in events.read() {
        match &event.command {
            FixtureCommand::StoreFixture(fixture) => {
                tracing::debug!("Storing fixture with ID: {}", fixture.identifiers.id);
                if let Err(e) = fixture_data_provider.inner.add(fixture.clone()) {
                    tracing::warn!("Failed to store fixture: {}", e);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.store_failed",
                        format!("Failed to store fixture: {}", e),
                    );
                    continue;
                }
            }

            FixtureCommand::RenameFixture { id, new_id } => {
                tracing::debug!("Renaming fixture with ID: {} to {}", id, new_id);
                if fixture_data_provider.inner.from_id(*new_id).is_ok() {
                    tracing::warn!(
                        "Failed to rename fixture {} -> {}: already exists",
                        id,
                        new_id
                    );
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.id_conflict",
                        format!(
                            "Failed to rename fixture {} to {}: already exists",
                            id, new_id
                        ),
                    );
                    continue;
                }

                let maybe_fixture = fixture_data_provider
                    .inner
                    .from_id(*id)
                    .map(|fixture| fixture.clone());
                if let Ok(mut fixture) = maybe_fixture {
                    fixture.identifiers.id = *new_id;
                    // This is an update (same UID, new ID) so it should always succeed
                    let _ = fixture_data_provider.inner.add(fixture);
                } else {
                    tracing::warn!("Failed to rename fixture {} -> {}: not found", id, new_id);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.not_found",
                        format!("Failed to rename fixture {} to {}: not found", id, new_id),
                    );
                    continue;
                }
            }

            FixtureCommand::DeleteFixture(fixture_id) => {
                tracing::debug!("Deleting fixture with ID: {}", fixture_id);
                let maybe_uid = fixture_data_provider
                    .inner
                    .from_id(*fixture_id)
                    .map(|fixture| fixture.identifiers.uid);
                if let Ok(uid) = maybe_uid {
                    match fixture_data_provider.remove_fixture(&uid) {
                        Ok((_fixture, parameter_entities)) => {
                            // Despawn all parameter entities
                            for param_entity in parameter_entities {
                                commands.entity(param_entity.entity()).despawn();
                            }
                        }
                        Err(err) => {
                            tracing::warn!("Failed to delete fixture {}: {}", fixture_id, err);
                            fail_fixture_command(
                                &mut responder,
                                event.command_id,
                                "fixture.delete_failed",
                                format!("Failed to delete fixture {}: {}", fixture_id, err),
                            );
                            continue;
                        }
                    }
                } else {
                    tracing::warn!("Failed to delete fixture {}: not found", fixture_id);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.not_found",
                        format!("Failed to delete fixture {}: not found", fixture_id),
                    );
                    continue;
                }
            }

            FixtureCommand::SetDmxChannels { .. } => {
                // Handled by fixtures crate event handler
                continue;
            }

            FixtureCommand::UpdateFixturePlacements { updates } => {
                if updates.is_empty() {
                    succeed_fixture_command(&mut responder, event.command_id);
                    continue;
                }

                let (fixtures_to_store, changed_updates) =
                    match collect_fixture_placement_batch_updates(&fixture_data_provider, updates) {
                        Ok(result) => result,
                        Err(message) => {
                            tracing::warn!("{}", message);
                            fail_fixture_command(
                                &mut responder,
                                event.command_id,
                                "fixture.placement_invalid",
                                message,
                            );
                            continue;
                        }
                    };

                for fixture in fixtures_to_store {
                    let _ = fixture_data_provider.inner.add(fixture);
                }

                if !changed_updates.is_empty() {
                    broadcast_fixture_command(
                        &broadcaster,
                        &FixtureCommand::UpdateFixturePlacements {
                            updates: changed_updates,
                        },
                    );
                    suppress_fixture_changed_snapshot.write(SuppressFixtureChangedSnapshot);
                }
            }

            FixtureCommand::UpdateFixturePatch {
                id,
                universe,
                address,
                transport,
            } => {
                tracing::debug!("Updating patch for fixture {}", id);

                let maybe_uid = fixture_data_provider
                    .inner
                    .from_id(*id)
                    .map(|fixture| fixture.identifiers.uid);

                if let Ok(uid) = maybe_uid {
                    if let Err(err) =
                        ensure_simple_fixture_bindings(uid, &output_bindings, &disabled_bindings)
                    {
                        tracing::warn!("Failed to update patch for fixture {}: {}", id, err);
                        fail_fixture_command(
                            &mut responder,
                            event.command_id,
                            "fixture.patch_unsupported",
                            err,
                        );
                        continue;
                    }

                    let (effective_transport, existing_target_id) = match transport {
                        Some(trans) => (trans.clone(), None),
                        None => match current_fixture_transport(
                            uid,
                            &output_bindings,
                            &disabled_bindings,
                            &network_outputs,
                            &usb_outputs,
                        ) {
                            Ok(Some((trans, target_id))) => (trans, target_id),
                            Ok(None) => (OutputTransport::Disabled, None),
                            Err(err) => {
                                tracing::warn!(
                                    "Failed to resolve patch transport for fixture {}: {}",
                                    id,
                                    err
                                );
                                fail_fixture_command(
                                    &mut responder,
                                    event.command_id,
                                    "fixture.patch_transport_invalid",
                                    err,
                                );
                                continue;
                            }
                        },
                    };

                    let mut output_preview = output_bindings.clone();
                    let mut disabled_preview = disabled_bindings.clone();
                    remove_simple_fixture_output_bindings(&mut output_preview, uid);
                    remove_simple_fixture_disabled_bindings(&mut disabled_preview, uid);

                    if effective_transport == OutputTransport::Disabled {
                        disabled_preview.bindings.push(DisabledBinding::Output {
                            source: OutputSource::Fixture {
                                uids: vec![uid],
                                element: None,
                                param: None,
                            },
                            priority: 0,
                            clone: false,
                        });
                    } else {
                        let target_id =
                            match existing_target_id.clone().map(Ok).unwrap_or_else(|| {
                                output_transport_to_target_id(
                                    &effective_transport,
                                    &network_outputs,
                                    &usb_outputs,
                                )
                            }) {
                                Ok(target) => target,
                                Err(err) => {
                                    tracing::warn!(
                                        "Failed to update patch for fixture {}: {}",
                                        id,
                                        err
                                    );
                                    fail_fixture_command(
                                        &mut responder,
                                        event.command_id,
                                        "fixture.patch_transport_invalid",
                                        err,
                                    );
                                    continue;
                                }
                            };

                        output_preview.bindings.push(OutputBinding {
                            source: OutputSource::Fixture {
                                uids: vec![uid],
                                element: None,
                                param: None,
                            },
                            target: OutputTarget::Transport {
                                target: target_id,
                                universe: Some(DmxRange::single(*universe)),
                                address: Some(*address),
                            },
                            priority: 0,
                            clone: false,
                        });
                    }

                    let issues = validate_bindings(
                        binding_settings.as_ref(),
                        &input_bindings,
                        &output_preview,
                        &disabled_preview,
                        &fixture_data_provider,
                    );

                    let scoped_issues = issues
                        .into_iter()
                        .filter(|issue| issue.involves_fixture(uid))
                        .collect::<Vec<_>>();

                    if let Some(issue) = scoped_issues.first() {
                        let message = issue.to_string();
                        tracing::warn!("Failed to update patch for fixture {}: {}", id, message);
                        fail_fixture_command(
                            &mut responder,
                            event.command_id,
                            "fixture.patch_invalid",
                            message,
                        );
                        continue;
                    }

                    remove_simple_fixture_output_bindings(&mut output_bindings, uid);
                    remove_simple_fixture_disabled_bindings(&mut disabled_bindings, uid);

                    if effective_transport == OutputTransport::Disabled {
                        disabled_bindings.bindings.push(DisabledBinding::Output {
                            source: OutputSource::Fixture {
                                uids: vec![uid],
                                element: None,
                                param: None,
                            },
                            priority: 0,
                            clone: false,
                        });
                    } else {
                        let target_id =
                            match existing_target_id.clone().map(Ok).unwrap_or_else(|| {
                                output_transport_to_target_id(
                                    &effective_transport,
                                    &network_outputs,
                                    &usb_outputs,
                                )
                            }) {
                                Ok(target) => target,
                                Err(err) => {
                                    tracing::warn!(
                                        "Failed to update patch for fixture {}: {}",
                                        id,
                                        err
                                    );
                                    fail_fixture_command(
                                        &mut responder,
                                        event.command_id,
                                        "fixture.patch_transport_invalid",
                                        err,
                                    );
                                    continue;
                                }
                            };

                        output_bindings.bindings.push(OutputBinding {
                            source: OutputSource::Fixture {
                                uids: vec![uid],
                                element: None,
                                param: None,
                            },
                            target: OutputTarget::Transport {
                                target: target_id,
                                universe: Some(DmxRange::single(*universe)),
                                address: Some(*address),
                            },
                            priority: 0,
                            clone: false,
                        });
                    }
                } else {
                    tracing::warn!("Failed to update patch for fixture {}: not found", id);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.not_found",
                        format!("Failed to update patch for fixture {}: not found", id),
                    );
                    continue;
                }
            }

            FixtureCommand::PatchBinding {
                source,
                target,
                priority,
                clone,
            } => {
                let existing_issues = validate_bindings(
                    binding_settings.as_ref(),
                    &input_bindings,
                    &output_bindings,
                    &disabled_bindings,
                    &fixture_data_provider,
                );

                let mut input_preview = input_bindings.clone();
                let mut output_preview = output_bindings.clone();
                let mut disabled_preview = disabled_bindings.clone();

                if let Err(err) = apply_patch_binding_add(
                    source,
                    target,
                    *priority,
                    *clone,
                    &mut input_preview,
                    &mut output_preview,
                    &mut disabled_preview,
                    &fixture_data_provider,
                    &network_outputs,
                    &usb_outputs,
                ) {
                    tracing::warn!("Failed to apply patch binding: {}", err);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.binding_invalid",
                        err,
                    );
                    continue;
                }

                let next_issues = validate_bindings(
                    binding_settings.as_ref(),
                    &input_preview,
                    &output_preview,
                    &disabled_preview,
                    &fixture_data_provider,
                );

                let existing_issue_keys = existing_issues
                    .iter()
                    .map(|issue| format!("{}|{:?}", issue.message, issue.involved_fixtures))
                    .collect::<std::collections::HashSet<_>>();

                if let Some(issue) = next_issues.into_iter().find(|issue| {
                    !existing_issue_keys
                        .contains(&format!("{}|{:?}", issue.message, issue.involved_fixtures))
                }) {
                    let message = issue.to_string();
                    tracing::warn!("Failed to apply patch binding: {}", message);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.binding_invalid",
                        message,
                    );
                    continue;
                }

                *input_bindings = input_preview;
                *output_bindings = output_preview;
                *disabled_bindings = disabled_preview;
            }

            FixtureCommand::RemovePatchBinding {
                source,
                target,
                priority,
                clone,
            } => {
                let existing_issues = validate_bindings(
                    binding_settings.as_ref(),
                    &input_bindings,
                    &output_bindings,
                    &disabled_bindings,
                    &fixture_data_provider,
                );

                let mut input_preview = input_bindings.clone();
                let mut output_preview = output_bindings.clone();
                let mut disabled_preview = disabled_bindings.clone();

                if let Err(err) = apply_patch_binding_remove(
                    source.as_ref(),
                    target.as_ref(),
                    *priority,
                    *clone,
                    &mut input_preview,
                    &mut output_preview,
                    &mut disabled_preview,
                    &fixture_data_provider,
                ) {
                    tracing::warn!("Failed to remove patch bindings: {}", err);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.binding_remove_failed",
                        err,
                    );
                    continue;
                }

                let next_issues = validate_bindings(
                    binding_settings.as_ref(),
                    &input_preview,
                    &output_preview,
                    &disabled_preview,
                    &fixture_data_provider,
                );

                let existing_issue_keys = existing_issues
                    .iter()
                    .map(|issue| format!("{}|{:?}", issue.message, issue.involved_fixtures))
                    .collect::<std::collections::HashSet<_>>();

                if let Some(issue) = next_issues.into_iter().find(|issue| {
                    !existing_issue_keys
                        .contains(&format!("{}|{:?}", issue.message, issue.involved_fixtures))
                }) {
                    let message = issue.to_string();
                    tracing::warn!("Failed to remove patch bindings: {}", message);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.binding_invalid",
                        message,
                    );
                    continue;
                }

                *input_bindings = input_preview;
                *output_bindings = output_preview;
                *disabled_bindings = disabled_preview;
            }

            FixtureCommand::UpdateFixtureParameterOffset {
                id,
                attribute,
                offset,
            } => {
                tracing::debug!(
                    fixture_id = id,
                    ?attribute,
                    "Updating parameter offset for fixture"
                );

                let maybe_fixture = fixture_data_provider
                    .inner
                    .from_id(*id)
                    .map(|fixture| fixture.clone());

                if let Ok(mut fixture) = maybe_fixture {
                    let mut updated_metadata = false;
                    for element in &mut fixture.elements {
                        for parameter in &mut element.parameters {
                            if parameter.attribute == *attribute {
                                parameter.offset = *offset;
                                updated_metadata = true;
                            }
                        }
                    }

                    if !updated_metadata {
                        tracing::warn!(
                            "Failed to update parameter offset for fixture {}: attribute not found",
                            id
                        );
                        fail_fixture_command(
                            &mut responder,
                            event.command_id,
                            "fixture.attribute_not_found",
                            format!(
                                "Failed to update parameter offset for fixture {}: attribute not found",
                                id
                            ),
                        );
                        continue;
                    }

                    let uid = fixture.identifiers.uid;
                    let _ = fixture_data_provider.inner.add(fixture);

                    for param_instance in fixture_data_provider.parameter_entities_for_fixture(uid)
                    {
                        let param_entity = param_instance.entity();
                        if let Ok(mut param) = param_query.get_mut(param_entity) {
                            if param.metadata.attribute == *attribute {
                                param.metadata.offset = *offset;
                            }
                        }
                    }
                } else {
                    tracing::warn!(
                        "Failed to update parameter offset for fixture {}: not found",
                        id
                    );
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.not_found",
                        format!(
                            "Failed to update parameter offset for fixture {}: not found",
                            id
                        ),
                    );
                    continue;
                }
            }

            FixtureCommand::SetColorPathDefault {
                fixture,
                color_path_id,
            } => {
                if let Err(message) = validate_color_path_id(color_paths.as_ref(), *color_path_id) {
                    tracing::warn!("{}", message);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.color_path_invalid",
                        message,
                    );
                    continue;
                }

                fixture_data_provider.set_color_path_default(fixture.clone(), *color_path_id);
                send_color_path_defaults(&fixture_data_provider, &broadcaster);
            }

            FixtureCommand::SetColorPathDefaultById {
                id,
                element_index,
                color_path_id,
            } => {
                if let Err(message) = validate_color_path_id(color_paths.as_ref(), *color_path_id) {
                    tracing::warn!("{}", message);
                    fail_fixture_command(
                        &mut responder,
                        event.command_id,
                        "fixture.color_path_invalid",
                        message,
                    );
                    continue;
                }

                let fixture = match resolve_color_path_default_fixture_ref(
                    &fixture_data_provider,
                    *id,
                    *element_index,
                ) {
                    Ok(fixture) => fixture,
                    Err(message) => {
                        tracing::warn!("{}", message);
                        fail_fixture_command(
                            &mut responder,
                            event.command_id,
                            "fixture.color_path_target_invalid",
                            message,
                        );
                        continue;
                    }
                };

                fixture_data_provider.set_color_path_default(fixture, *color_path_id);
                send_color_path_defaults(&fixture_data_provider, &broadcaster);
            }
        }

        succeed_fixture_command(&mut responder, event.command_id);
    }
}

/// Resolves a fixture or fixture element color-path default target from operator-facing IDs.
fn resolve_color_path_default_fixture_ref(
    fixture_data_provider: &FixtureDataProviderExt,
    id: u32,
    element_index: Option<u32>,
) -> Result<FixtureRef, String> {
    let fixture = fixture_data_provider.inner.from_id(id).map_err(|_| {
        format!(
            "Failed to set fixture color path default: fixture {} not found",
            id
        )
    })?;

    if let Some(element_index) = element_index {
        let element_count = fixture.elements.len() as u32;
        if element_index == 0 || element_index > element_count {
            return Err(format!(
                "Failed to set fixture color path default: fixture {} element {} not found",
                id, element_index
            ));
        }
    }

    Ok(FixtureRef {
        fixture_uid: fixture.identifiers.uid,
        index: element_index,
    })
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall::prelude::Identifiers;
    use uuid::Uuid;

    use super::*;

    fn create_test_fixture(id: u32) -> Fixture {
        Fixture {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: format!("fixture-{id}"),
            },
            make: "Test".to_string(),
            model: "Fixture".to_string(),
            mode: "Default".to_string(),
            elements: Vec::new(),
            physical: None,
            placement: FixturePlacement::default(),
            layout: None,
            library_asset_etag: None,
        }
    }

    /// Creates a minimal app that executes fixture CRUD commands with lifecycle tracking.
    fn fixture_command_app() -> App {
        let mut app = App::new();
        app.add_message::<CommandEnvelope<FixtureCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_message::<SuppressFixtureChangedSnapshot>();
        app.init_resource::<CommandTracker>();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(InputBindings::default());
        app.insert_resource(OutputBindings::default());
        app.insert_resource(DisabledBindings::default());
        app.insert_resource(BindingValidationSettings::default());
        app.insert_resource(NetworkDmxOutputTargets::default());
        app.insert_resource(UsbDmxOutputTargets::default());
        let (sender, _receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(Update, crud_events);
        app
    }

    /// Submits one tracked fixture command to the test app.
    fn submit_fixture_command(app: &mut App, command: FixtureCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("fixture command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Verifies fixture storage mutates the provider before reporting semantic success.
    #[test]
    fn store_fixture_mutates_before_success() {
        let mut app = fixture_command_app();
        let fixture = create_test_fixture(42);
        let command_id =
            submit_fixture_command(&mut app, FixtureCommand::StoreFixture(fixture.clone()));

        app.update();

        assert!(
            app.world()
                .resource::<FixtureDataProviderExt>()
                .inner
                .from_id(42)
                .is_ok()
        );
        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(matches!(
            results.as_slice(),
            [CommandResult {
                command_id: result_command_id,
                outcome: CommandOutcome::Succeeded { output: None },
            }] if result_command_id.to_owned() == command_id
        ));
    }

    /// Verifies a missing fixture rename returns one structured failure.
    #[test]
    fn rename_missing_fixture_returns_failure() {
        let mut app = fixture_command_app();
        let command_id =
            submit_fixture_command(&mut app, FixtureCommand::RenameFixture { id: 7, new_id: 8 });

        app.update();

        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(matches!(
            results.as_slice(),
            [CommandResult {
                command_id: result_command_id,
                outcome: CommandOutcome::Failed(error),
            }] if result_command_id.to_owned() == command_id && error.code == "fixture.not_found"
        ));
    }

    /// Builds a fixture with a fixed number of empty elements for target resolution tests.
    fn create_test_fixture_with_elements(id: u32, element_count: u32) -> Fixture {
        let mut fixture = create_test_fixture(id);
        fixture.elements = (1..=element_count)
            .map(|index| FixtureElement {
                label: format!("element-{index}"),
                parameters: Vec::new(),
            })
            .collect();
        fixture
    }

    /// Verifies whole-fixture color path targets resolve to fixture refs without an element index.
    #[test]
    fn resolve_color_path_default_fixture_ref_resolves_whole_fixture() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        let fixture = create_test_fixture_with_elements(301, 2);
        let fixture_uid = fixture.identifiers.uid;
        fixture_data_provider
            .inner
            .add(fixture)
            .expect("fixture should insert");

        let resolved = resolve_color_path_default_fixture_ref(&fixture_data_provider, 301, None)
            .expect("whole fixture target should resolve");

        assert_eq!(
            resolved,
            FixtureRef {
                fixture_uid,
                index: None
            }
        );
    }

    /// Verifies element color path targets resolve to fixture refs with a 1-based index.
    #[test]
    fn resolve_color_path_default_fixture_ref_resolves_fixture_element() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        let fixture = create_test_fixture_with_elements(301, 2);
        let fixture_uid = fixture.identifiers.uid;
        fixture_data_provider
            .inner
            .add(fixture)
            .expect("fixture should insert");

        let resolved = resolve_color_path_default_fixture_ref(&fixture_data_provider, 301, Some(2))
            .expect("fixture element target should resolve");

        assert_eq!(
            resolved,
            FixtureRef {
                fixture_uid,
                index: Some(2)
            }
        );
    }

    /// Verifies invalid element color path targets fail before writing defaults.
    #[test]
    fn resolve_color_path_default_fixture_ref_rejects_missing_element() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        fixture_data_provider
            .inner
            .add(create_test_fixture_with_elements(301, 1))
            .expect("fixture should insert");

        let error = resolve_color_path_default_fixture_ref(&fixture_data_provider, 301, Some(2))
            .expect_err("missing fixture element should fail");

        assert_eq!(
            error,
            "Failed to set fixture color path default: fixture 301 element 2 not found"
        );
    }

    #[test]
    fn collect_fixture_placement_batch_updates_composes_repeated_fixture_updates() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        fixture_data_provider
            .inner
            .add(create_test_fixture(1))
            .expect("fixture should be inserted");

        let updates = vec![
            FixturePlacementUpdateEntry {
                id: 1,
                position: Some(FixturePlacementPositionUpdate::X(1.0)),
                rotation: None,
            },
            FixturePlacementUpdateEntry {
                id: 1,
                position: Some(FixturePlacementPositionUpdate::Y(2.0)),
                rotation: None,
            },
        ];

        let (fixtures_to_store, changed_updates) =
            collect_fixture_placement_batch_updates(&fixture_data_provider, &updates)
                .expect("batch update should succeed");

        assert_eq!(changed_updates.len(), 2);
        assert_eq!(fixtures_to_store.len(), 1);
        let updated_fixture = &fixtures_to_store[0];
        assert_eq!(updated_fixture.identifiers.id, 1);
        assert_eq!(updated_fixture.placement.position.x, 1.0);
        assert_eq!(updated_fixture.placement.position.y, 2.0);
        assert_eq!(updated_fixture.placement.position.z, 0.0);
    }

    #[test]
    fn collect_fixture_placement_batch_updates_errors_on_missing_fixture() {
        let fixture_data_provider = FixtureDataProviderExt::default();

        let updates = vec![FixturePlacementUpdateEntry {
            id: 42,
            position: Some(FixturePlacementPositionUpdate::X(1.0)),
            rotation: None,
        }];

        let result = collect_fixture_placement_batch_updates(&fixture_data_provider, &updates);

        match result {
            Ok(_) => panic!("expected missing fixture error"),
            Err(message) => {
                assert_eq!(
                    message,
                    "Failed to update placement for fixture 42: not found"
                );
            }
        }
    }

    #[test]
    fn apply_patch_binding_add_supports_transport_to_transport() {
        let source = BindingEndpoint::Transport {
            target: "sacn".to_string(),
            universe: Some(DmxRange::single(1)),
            address: Some(10),
        };
        let target = BindingEndpoint::Transport {
            target: "artnet".to_string(),
            universe: Some(DmxRange::single(2)),
            address: Some(20),
        };

        let mut input_bindings = InputBindings::default();
        let mut output_bindings = OutputBindings::default();
        let mut disabled_bindings = DisabledBindings::default();
        let data_provider = FixtureDataProviderExt::default();
        let network_outputs = NetworkDmxOutputTargets::default();
        let usb_outputs = UsbDmxOutputTargets::default();

        apply_patch_binding_add(
            &source,
            &target,
            3,
            true,
            &mut input_bindings,
            &mut output_bindings,
            &mut disabled_bindings,
            &data_provider,
            &network_outputs,
            &usb_outputs,
        )
        .expect("transport-to-transport add should succeed");

        assert_eq!(input_bindings.bindings.len(), 1);
        assert!(output_bindings.bindings.is_empty());
        assert!(disabled_bindings.bindings.is_empty());

        assert_eq!(
            input_bindings.bindings[0],
            InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                target: InputTarget::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange::single(2)),
                    address: Some(20),
                },
                priority: 3,
                clone: true,
            }
        );
    }

    #[test]
    fn apply_patch_binding_remove_supports_transport_to_transport() {
        let mut input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                target: InputTarget::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange::single(9)),
                    address: Some(42),
                },
                priority: 4,
                clone: false,
            }],
        };
        let mut output_bindings = OutputBindings::default();
        let mut disabled_bindings = DisabledBindings::default();
        let data_provider = FixtureDataProviderExt::default();

        apply_patch_binding_remove(
            Some(&BindingEndpoint::Transport {
                target: "sacn".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(10),
            }),
            Some(&BindingEndpoint::Transport {
                target: "artnet".to_string(),
                universe: Some(DmxRange::single(9)),
                address: Some(42),
            }),
            Some(4),
            Some(false),
            &mut input_bindings,
            &mut output_bindings,
            &mut disabled_bindings,
            &data_provider,
        )
        .expect("transport-to-transport remove should succeed");

        assert!(input_bindings.bindings.is_empty());
        assert!(output_bindings.bindings.is_empty());
        assert!(disabled_bindings.bindings.is_empty());
    }

    #[test]
    fn apply_patch_binding_remove_target_transport_without_source_removes_input_and_output() {
        let mut input_bindings = InputBindings {
            bindings: vec![
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::Sacn,
                        universe: Some(DmxRange::single(1)),
                        address: Some(1),
                    },
                    target: InputTarget::Transport {
                        target: "artnet".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::ArtNet,
                        universe: Some(DmxRange::single(2)),
                        address: Some(1),
                    },
                    target: InputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let fixture_uid = Uuid::new_v4();
        let mut output_bindings = OutputBindings {
            bindings: vec![
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![fixture_uid],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "artnet".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![fixture_uid],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let mut disabled_bindings = DisabledBindings::default();
        let data_provider = FixtureDataProviderExt::default();

        apply_patch_binding_remove(
            None,
            Some(&BindingEndpoint::Transport {
                target: "artnet".to_string(),
                universe: None,
                address: None,
            }),
            None,
            None,
            &mut input_bindings,
            &mut output_bindings,
            &mut disabled_bindings,
            &data_provider,
        )
        .expect("remove with target transport filter should succeed");

        assert_eq!(input_bindings.bindings.len(), 1);
        assert!(matches!(
            input_bindings.bindings[0].target,
            InputTarget::Transport {
                ref target,
                ..
            } if target == "sacn"
        ));

        assert_eq!(output_bindings.bindings.len(), 1);
        assert!(matches!(
            output_bindings.bindings[0].target,
            OutputTarget::Transport {
                ref target,
                ..
            } if target == "sacn"
        ));
    }
}
