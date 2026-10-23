// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture patch and input/output route commands.

use super::*;

/// Applies one patch command and reports its outcome.
///
/// Every patch change is staged on copies of the routes and validated before the copies
/// replace the live routes, so a rejected change leaves the patch untouched.
pub(super) fn handle_command(
    context: &mut FixtureCrudContext,
    event: &CommandEnvelope<FixtureCommand>,
) {
    let command_id = event.command_id;
    match &event.command {
        FixtureCommand::UpdateFixturePatch {
            id,
            universe,
            address,
            transport,
        } => update_fixture_patch(
            context,
            command_id,
            *id,
            *universe,
            *address,
            transport.as_ref(),
        ),

        FixtureCommand::AddDmxRoute {
            source,
            target,
            priority,
            clone,
        } => {
            let (priority, clone) = (*priority, *clone);
            apply_staged_route_change(
                context,
                command_id,
                "Failed to apply DMX route",
                "fixture.route_invalid",
                |preview, context| {
                    apply_dmx_route_add(
                        source,
                        target,
                        priority,
                        clone,
                        &mut preview.input,
                        &mut preview.output,
                        &mut preview.disabled,
                        &context.fixture_data_provider,
                        &context.network_outputs,
                        &context.usb_outputs,
                    )
                },
            );
        }

        FixtureCommand::RemoveDmxRoutes {
            source,
            target,
            priority,
            clone,
        } => {
            let (priority, clone) = (*priority, *clone);
            apply_staged_route_change(
                context,
                command_id,
                "Failed to remove DMX routes",
                "fixture.route_remove_failed",
                |preview, context| {
                    apply_dmx_route_remove(
                        source.as_ref(),
                        target.as_ref(),
                        priority,
                        clone,
                        &mut preview.input,
                        &mut preview.output,
                        &mut preview.disabled,
                        &context.fixture_data_provider,
                    )
                },
            );
        }

        _ => {}
    }
}

/// Re-patches a fixture's simple output route to a universe and address.
///
/// Without an explicit transport the fixture keeps its current one; a disabled transport
/// unpatches the fixture. Fixtures with multi-fixture, element, or console output routes
/// must be changed through DMX route commands instead. The result must not introduce
/// route issues involving the fixture.
fn update_fixture_patch(
    context: &mut FixtureCrudContext,
    command_id: CommandId,
    id: u32,
    universe: u16,
    address: u16,
    transport: Option<&OutputTransport>,
) {
    tracing::debug!("Updating patch for fixture {}", id);

    let maybe_uid = context
        .fixture_data_provider
        .inner
        .from_id(id)
        .map(|fixture| fixture.identifiers.uid);
    let Ok(uid) = maybe_uid else {
        tracing::warn!("Failed to update patch for fixture {}: not found", id);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.not_found",
            format!("Failed to update patch for fixture {}: not found", id),
        );
        return;
    };

    if let Err(err) = ensure_simple_fixture_routes(uid, &context.output_routes) {
        tracing::warn!("Failed to update patch for fixture {}: {}", id, err);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.patch_unsupported",
            err,
        );
        return;
    }

    let (effective_transport, existing_target_id) = match transport {
        Some(trans) => (trans.clone(), None),
        None => match current_fixture_transport(
            uid,
            &context.output_routes,
            &context.network_outputs,
            &context.usb_outputs,
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
                    &mut context.responder,
                    command_id,
                    "fixture.patch_transport_invalid",
                    err,
                );
                return;
            }
        },
    };

    let mut output_preview = context.output_routes.clone();
    remove_simple_fixture_output_routes(&mut output_preview, uid);

    // A disabled transport unpatches the fixture: its output is left unbound.
    if effective_transport != OutputTransport::Disabled {
        let target_id = match existing_target_id.clone().map(Ok).unwrap_or_else(|| {
            output_transport_to_target_id(
                &effective_transport,
                &context.network_outputs,
                &context.usb_outputs,
            )
        }) {
            Ok(target) => target,
            Err(err) => {
                tracing::warn!("Failed to update patch for fixture {}: {}", id, err);
                fail_fixture_command(
                    &mut context.responder,
                    command_id,
                    "fixture.patch_transport_invalid",
                    err,
                );
                return;
            }
        };

        output_preview.routes.push(OutputRoute {
            source: OutputSource::Fixture {
                uids: vec![uid],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: target_id,
                universe: Some(DmxRange::single(universe)),
                address: Some(address),
            },
            priority: 0,
            clone: false,
        });
    }

    let issues = validate_routes(
        context.route_settings.as_ref(),
        &context.input_routes,
        &output_preview,
        &context.disabled_routes,
        &context.fixture_data_provider,
    );

    let scoped_issues = issues
        .into_iter()
        .filter(|issue| issue.involves_fixture(uid))
        .collect::<Vec<_>>();

    if let Some(issue) = scoped_issues.first() {
        let message = issue.to_string();
        tracing::warn!("Failed to update patch for fixture {}: {}", id, message);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.patch_invalid",
            message,
        );
        return;
    }

    *context.output_routes = output_preview;
    succeed_fixture_command(&mut context.responder, command_id);
}

/// Staged copies of every route set that a DMX route change mutates.
struct RoutePreview {
    /// Staged input routes.
    input: InputRoutes,
    /// Staged output routes.
    output: OutputRoutes,
    /// Staged disabled input routes.
    disabled: DisabledRoutes,
}

/// Applies a route change to staged copies and commits them when no new issue appears.
///
/// `mutate` edits the staged routes; its error fails the command with `mutation_error_code`.
/// Route issues that already existed before the change are tolerated, while any new issue
/// fails the command with `fixture.route_invalid`. Failures are logged as
/// `{failure_log}: {reason}`.
fn apply_staged_route_change(
    context: &mut FixtureCrudContext,
    command_id: CommandId,
    failure_log: &str,
    mutation_error_code: &'static str,
    mutate: impl FnOnce(&mut RoutePreview, &FixtureCrudContext) -> Result<(), String>,
) {
    let existing_issues = validate_routes(
        context.route_settings.as_ref(),
        &context.input_routes,
        &context.output_routes,
        &context.disabled_routes,
        &context.fixture_data_provider,
    );

    let mut preview = RoutePreview {
        input: context.input_routes.clone(),
        output: context.output_routes.clone(),
        disabled: context.disabled_routes.clone(),
    };

    if let Err(err) = mutate(&mut preview, context) {
        tracing::warn!("{}: {}", failure_log, err);
        fail_fixture_command(&mut context.responder, command_id, mutation_error_code, err);
        return;
    }

    let next_issues = validate_routes(
        context.route_settings.as_ref(),
        &preview.input,
        &preview.output,
        &preview.disabled,
        &context.fixture_data_provider,
    );

    let existing_issue_keys = existing_issues
        .iter()
        .map(|issue| format!("{}|{:?}", issue.message, issue.involved_fixtures))
        .collect::<HashSet<_>>();

    if let Some(issue) = next_issues.into_iter().find(|issue| {
        !existing_issue_keys.contains(&format!("{}|{:?}", issue.message, issue.involved_fixtures))
    }) {
        let message = issue.to_string();
        tracing::warn!("{}: {}", failure_log, message);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.route_invalid",
            message,
        );
        return;
    }

    *context.input_routes = preview.input;
    *context.output_routes = preview.output;
    *context.disabled_routes = preview.disabled;
    succeed_fixture_command(&mut context.responder, command_id);
}

/// Error for patching an output to `disabled`; an unsent output is simply left unbound.
pub(super) const OUTPUT_DISABLE_ERROR: &str =
    "Outputs cannot be disabled; remove the output route with 'rm patch' instead";

/// Resolves a patch target ID to its route transport family.
fn route_transport_from_target_id(target: &str) -> Option<RouteTransport> {
    match target {
        "sacn" => Some(RouteTransport::Sacn),
        "artnet" => Some(RouteTransport::ArtNet),
        "udmx" => Some(RouteTransport::Udmx),
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

/// Validates that fixture patch updates can safely replace a fixture's simple output routes.
fn ensure_simple_fixture_routes(uid: Uuid, output_routes: &OutputRoutes) -> Result<(), String> {
    for route in &output_routes.routes {
        if !source_contains_fixture(&route.source, uid) {
            continue;
        }

        if !is_simple_fixture_source(&route.source, uid) {
            return Err("Fixture patch update cannot modify multi-fixture or element routes; use DMX route commands instead".to_string());
        }

        if !matches!(route.target, OutputTarget::Transport { .. }) {
            return Err("Fixture patch update cannot modify console output routes; use DMX route commands instead".to_string());
        }
    }

    Ok(())
}

/// Removes existing simple output routes for a fixture before writing replacement patch data.
fn remove_simple_fixture_output_routes(routes: &mut OutputRoutes, uid: Uuid) {
    routes
        .routes
        .retain(|route| !is_simple_fixture_source(&route.source, uid));
}

/// Returns the fixture's current output transport together with its persisted target ID when available.
fn current_fixture_transport(
    uid: Uuid,
    output_routes: &OutputRoutes,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<Option<(OutputTransport, Option<String>)>, String> {
    if let Some(route) = output_routes
        .routes
        .iter()
        .find(|route| is_simple_fixture_source(&route.source, uid))
    {
        match &route.target {
            OutputTarget::Transport { target, .. } => {
                return output_transport_from_target_id(target, network_outputs, usb_outputs)
                    .map(|transport| Some((transport, Some(target.clone()))));
            }
            OutputTarget::Console { .. } => {
                return Err(
                    "Fixture patch update cannot modify console output routes; use DMX route commands instead"
                        .to_string(),
                );
            }
        }
    }

    Ok(None)
}

/// Endpoint categories used when resolving DMX route updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndpointKind {
    Transport,
    Console,
    Fixture,
    /// Additional DMX break of whole fixtures; only valid as an output source.
    FixtureBreak,
    Disabled,
}

/// DMX route direction used when emitting fixture route events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteDirection {
    Input,
    Output,
}

/// Concrete input or output endpoint attached to a fixture route.
#[derive(Debug, Clone)]
enum ResolvedRouteEndpoint {
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
    FixtureBreak {
        uids: Vec<Uuid>,
        dmx_break: u16,
    },
    Disabled,
}

fn endpoint_kind(endpoint: &RouteEndpoint) -> EndpointKind {
    match endpoint {
        RouteEndpoint::Console { .. } => EndpointKind::Console,
        RouteEndpoint::Transport { .. } => EndpointKind::Transport,
        RouteEndpoint::Fixture { .. } => EndpointKind::Fixture,
        RouteEndpoint::FixtureBreak { .. } => EndpointKind::FixtureBreak,
        RouteEndpoint::Disabled => EndpointKind::Disabled,
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

fn resolve_route_endpoint(
    endpoint: &RouteEndpoint,
    data_provider: &FixtureDataProviderExt,
) -> Result<ResolvedRouteEndpoint, String> {
    match endpoint {
        RouteEndpoint::Console { universe, address } => Ok(ResolvedRouteEndpoint::Console {
            universe: *universe,
            address: *address,
        }),
        RouteEndpoint::Transport {
            target,
            universe,
            address,
        } => Ok(ResolvedRouteEndpoint::Transport {
            target: target.clone(),
            universe: *universe,
            address: *address,
        }),
        RouteEndpoint::Fixture {
            ids,
            element,
            param,
        } => Ok(ResolvedRouteEndpoint::Fixture {
            uids: resolve_fixture_uids(ids, data_provider)?,
            element: *element,
            param: param.clone(),
        }),
        RouteEndpoint::FixtureBreak { ids, dmx_break } => Ok(ResolvedRouteEndpoint::FixtureBreak {
            uids: resolve_fixture_uids(ids, data_provider)?,
            dmx_break: *dmx_break,
        }),
        RouteEndpoint::Disabled => Ok(ResolvedRouteEndpoint::Disabled),
    }
}

fn classify_route_direction(
    source: &RouteEndpoint,
    target: &RouteEndpoint,
) -> Result<RouteDirection, String> {
    let source_kind = endpoint_kind(source);
    let target_kind = endpoint_kind(target);

    use EndpointKind::{Console, Disabled, Fixture, FixtureBreak, Transport};
    use RouteDirection::{Input, Output};

    match (source_kind, target_kind) {
        (_, FixtureBreak) => Err("Fixture break endpoint cannot be used as a target".to_string()),
        (Fixture | FixtureBreak | Console, Disabled) => Err(OUTPUT_DISABLE_ERROR.to_string()),
        (FixtureBreak, Transport) => Ok(Output),
        (FixtureBreak, _) => {
            Err("Fixture breaks can only be patched to network or USB outputs".to_string())
        }
        (Transport, _) => Ok(Input),
        (_, Transport) => Ok(Output),
        (Console, Console) => Err("Console -> console routes are invalid".to_string()),
        (Console, Fixture) => Err("Console -> fixture routes are invalid".to_string()),
        (Fixture, Fixture) => Ok(Input),
        (Fixture, _) => Ok(Output),
        (Disabled, _) => Err("Disabled endpoint cannot be used as a source".to_string()),
    }
}

fn infer_route_scopes(
    source: Option<&RouteEndpoint>,
    target: Option<&RouteEndpoint>,
) -> Result<(bool, bool), String> {
    if matches!(source, Some(RouteEndpoint::Disabled)) {
        return Err("Disabled endpoint cannot be used as a source".to_string());
    }

    let source_kind = source.map(endpoint_kind);
    let target_kind = target.map(endpoint_kind);

    use EndpointKind::{Console, Disabled, Fixture, FixtureBreak, Transport};

    // Only inputs can be disabled, so a disabled filter never matches output routes.
    if target_kind == Some(Disabled) {
        return match source_kind {
            None | Some(Transport) => Ok((true, false)),
            Some(_) => Err(OUTPUT_DISABLE_ERROR.to_string()),
        };
    }

    if target_kind == Some(FixtureBreak) {
        return Err("Fixture break endpoint cannot be used as a target".to_string());
    }

    if source_kind == Some(FixtureBreak) {
        if matches!(target_kind, Some(Console) | Some(Fixture)) {
            return Err("Fixture breaks can only be patched to network or USB outputs".to_string());
        }
        return Ok((false, true));
    }

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
            return Err("Console -> console/fixture routes are invalid".to_string());
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
            return Err("Console -> console routes are invalid".to_string());
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

    if source_kind.is_none() && target_kind.is_none() {
        return Ok((true, true));
    }

    Err("Invalid DMX route filter".to_string())
}

fn input_source_from_endpoint(endpoint: &ResolvedRouteEndpoint) -> Result<InputSource, String> {
    match endpoint {
        ResolvedRouteEndpoint::Transport {
            target,
            universe,
            address,
        } => {
            let transport = route_transport_from_target_id(target).ok_or_else(|| {
                format!("Network output target '{target}' cannot be used as an input source")
            })?;
            Ok(InputSource::Transport {
                transport,
                universe: *universe,
                address: *address,
            })
        }
        ResolvedRouteEndpoint::Console { universe, address } => Ok(InputSource::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedRouteEndpoint::Fixture {
            uids,
            element,
            param,
        } => Ok(InputSource::Fixture {
            uids: uids.clone(),
            element: *element,
            param: param.clone(),
        }),
        ResolvedRouteEndpoint::FixtureBreak { .. } => {
            Err("Fixture break endpoint cannot be used as an input source".to_string())
        }
        ResolvedRouteEndpoint::Disabled => {
            Err("Disabled endpoint cannot be used as a source".to_string())
        }
    }
}

fn input_target_from_endpoint(endpoint: &ResolvedRouteEndpoint) -> Result<InputTarget, String> {
    match endpoint {
        ResolvedRouteEndpoint::Console { universe, address } => Ok(InputTarget::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedRouteEndpoint::Transport {
            target,
            universe,
            address,
        } => Ok(InputTarget::Transport {
            target: target.clone(),
            universe: *universe,
            address: *address,
        }),
        ResolvedRouteEndpoint::Fixture {
            uids,
            element,
            param,
        } => Ok(InputTarget::Fixture {
            uids: uids.clone(),
            element: *element,
            param: param.clone(),
        }),
        ResolvedRouteEndpoint::Disabled => Ok(InputTarget::Disabled),
        ResolvedRouteEndpoint::FixtureBreak { .. } => {
            Err("Fixture break endpoint cannot be used as an input target".to_string())
        }
    }
}

fn output_source_from_endpoint(endpoint: &ResolvedRouteEndpoint) -> Result<OutputSource, String> {
    match endpoint {
        ResolvedRouteEndpoint::Console { universe, address } => Ok(OutputSource::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedRouteEndpoint::Fixture {
            uids,
            element,
            param,
        } => Ok(OutputSource::Fixture {
            uids: uids.clone(),
            element: *element,
            param: param.clone(),
        }),
        ResolvedRouteEndpoint::FixtureBreak { uids, dmx_break } => Ok(OutputSource::FixtureBreak {
            uids: uids.clone(),
            dmx_break: *dmx_break,
        }),
        ResolvedRouteEndpoint::Transport { .. } => {
            Err("Transport endpoint cannot be used as an output source".to_string())
        }
        ResolvedRouteEndpoint::Disabled => {
            Err("Disabled endpoint cannot be used as a source".to_string())
        }
    }
}

fn output_target_from_endpoint(endpoint: &ResolvedRouteEndpoint) -> Result<OutputTarget, String> {
    match endpoint {
        ResolvedRouteEndpoint::Transport {
            target,
            universe,
            address,
        } => Ok(OutputTarget::Transport {
            target: target.clone(),
            universe: *universe,
            address: *address,
        }),
        ResolvedRouteEndpoint::Console { universe, address } => Ok(OutputTarget::Console {
            universe: *universe,
            address: *address,
        }),
        ResolvedRouteEndpoint::Disabled => Err(OUTPUT_DISABLE_ERROR.to_string()),
        ResolvedRouteEndpoint::Fixture { .. } | ResolvedRouteEndpoint::FixtureBreak { .. } => {
            Err("Fixture endpoint cannot be used as an output target".to_string())
        }
    }
}

fn validate_network_output_target_endpoint(
    endpoint: &ResolvedRouteEndpoint,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<(), String> {
    let ResolvedRouteEndpoint::Transport {
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

fn ranges_overlap(filter: Option<DmxRange>, route: Option<DmxRange>) -> bool {
    match (filter, route) {
        (None, _) => true,
        (Some(_), None) => true,
        (Some(filter), Some(route)) => filter.start <= route.end && route.start <= filter.end,
    }
}

fn address_matches(filter: Option<u16>, route: Option<u16>) -> bool {
    match filter {
        None => true,
        Some(addr) => route.unwrap_or(1) == addr,
    }
}

fn fixture_matches_filter(
    route_uids: &[Uuid],
    route_element: Option<u16>,
    route_param: Option<&str>,
    filter_uids: &[Uuid],
    filter_element: Option<u16>,
    filter_param: Option<&str>,
) -> bool {
    let uids_match = filter_uids
        .iter()
        .any(|uid| route_uids.iter().any(|route_uid| route_uid == uid));
    let element_match =
        filter_element.is_none_or(|filter| route_element.is_none_or(|route| route == filter));
    let param_match =
        filter_param.is_none_or(|filter| route_param.is_none_or(|route| route == filter));

    uids_match && element_match && param_match
}

fn input_source_matches_filter(route: &InputSource, filter: &InputSource) -> bool {
    match (route, filter) {
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

fn input_target_matches_filter(route: &InputTarget, filter: &InputTarget) -> bool {
    match (route, filter) {
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

fn output_source_matches_filter(route: &OutputSource, filter: &OutputSource) -> bool {
    match (route, filter) {
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
        (
            OutputSource::FixtureBreak { uids, dmx_break },
            OutputSource::FixtureBreak {
                uids: filter_uids,
                dmx_break: filter_break,
            },
        ) => {
            dmx_break == filter_break
                && fixture_matches_filter(uids, None, None, filter_uids, None, None)
        }
        (
            OutputSource::FixtureBreak { uids, .. },
            OutputSource::Fixture {
                uids: filter_uids,
                element: None,
                param: None,
            },
        ) => fixture_matches_filter(uids, None, None, filter_uids, None, None),
        _ => false,
    }
}

fn output_target_matches_filter(route: &OutputTarget, filter: &OutputTarget) -> bool {
    match (route, filter) {
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
        _ => false,
    }
}

pub(super) fn apply_dmx_route_add(
    source: &RouteEndpoint,
    target: &RouteEndpoint,
    priority: i32,
    clone: bool,
    input_routes: &mut InputRoutes,
    output_routes: &mut OutputRoutes,
    disabled_routes: &mut DisabledRoutes,
    data_provider: &FixtureDataProviderExt,
    network_outputs: &NetworkDmxOutputTargets,
    usb_outputs: &UsbDmxOutputTargets,
) -> Result<(), String> {
    let direction = classify_route_direction(source, target)?;
    let resolved_source = resolve_route_endpoint(source, data_provider)?;
    let resolved_target = resolve_route_endpoint(target, data_provider)?;
    validate_network_output_target_endpoint(&resolved_target, network_outputs, usb_outputs)?;

    let target_is_disabled = matches!(resolved_target, ResolvedRouteEndpoint::Disabled);

    match direction {
        RouteDirection::Input => {
            let input_source = input_source_from_endpoint(&resolved_source)?;
            if target_is_disabled {
                disabled_routes.routes.push(DisabledRoute::Input {
                    source: input_source,
                    priority,
                    clone,
                });
            } else {
                let input_target = input_target_from_endpoint(&resolved_target)?;
                input_routes.routes.push(InputRoute {
                    source: input_source,
                    target: input_target,
                    priority,
                    clone,
                });
            }
        }
        RouteDirection::Output => {
            output_routes.routes.push(OutputRoute {
                source: output_source_from_endpoint(&resolved_source)?,
                target: output_target_from_endpoint(&resolved_target)?,
                priority,
                clone,
            });
        }
    }

    Ok(())
}

pub(super) fn apply_dmx_route_remove(
    source: Option<&RouteEndpoint>,
    target: Option<&RouteEndpoint>,
    priority: Option<i32>,
    clone: Option<bool>,
    input_routes: &mut InputRoutes,
    output_routes: &mut OutputRoutes,
    disabled_routes: &mut DisabledRoutes,
    data_provider: &FixtureDataProviderExt,
) -> Result<(), String> {
    let (apply_input, apply_output) = infer_route_scopes(source, target)?;
    let resolved_source = source
        .map(|endpoint| resolve_route_endpoint(endpoint, data_provider))
        .transpose()?;
    let resolved_target = target
        .map(|endpoint| resolve_route_endpoint(endpoint, data_provider))
        .transpose()?;

    let target_is_disabled_filter =
        target.is_none() || matches!(target, Some(RouteEndpoint::Disabled));

    if apply_input {
        let source_filter = resolved_source
            .as_ref()
            .map(input_source_from_endpoint)
            .transpose()?;
        let target_filter = resolved_target
            .as_ref()
            .map(input_target_from_endpoint)
            .transpose()?;

        input_routes.routes.retain(|route| {
            if let Some(filter) = &source_filter {
                if !input_source_matches_filter(&route.source, filter) {
                    return true;
                }
            }
            if let Some(filter) = &target_filter {
                if !input_target_matches_filter(&route.target, filter) {
                    return true;
                }
            }
            if let Some(filter_priority) = priority {
                if route.priority != filter_priority {
                    return true;
                }
            }
            if let Some(filter_clone) = clone {
                if route.clone != filter_clone {
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
            disabled_routes.routes.retain(|route| {
                let DisabledRoute::Input {
                    source,
                    priority: route_priority,
                    clone: route_clone,
                } = route;
                if let Some(filter) = &source_filter {
                    if !input_source_matches_filter(source, filter) {
                        return true;
                    }
                }
                if let Some(filter_priority) = priority {
                    if *route_priority != filter_priority {
                        return true;
                    }
                }
                if let Some(filter_clone) = clone {
                    if *route_clone != filter_clone {
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

        output_routes.routes.retain(|route| {
            if let Some(filter) = &source_filter {
                if !output_source_matches_filter(&route.source, filter) {
                    return true;
                }
            }
            if let Some(filter) = &target_filter {
                if !output_target_matches_filter(&route.target, filter) {
                    return true;
                }
            }
            if let Some(filter_priority) = priority {
                if route.priority != filter_priority {
                    return true;
                }
            }
            if let Some(filter_clone) = clone {
                if route.clone != filter_clone {
                    return true;
                }
            }
            false
        });
    }

    Ok(())
}
