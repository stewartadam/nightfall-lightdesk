// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for fixture commands.

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use bevy_app::App;
use bevy_diagnostic::{Diagnostic, DiagnosticPath, Diagnostics, RegisterDiagnostic};
use bevy_ecs::prelude::*;
use nightfall::prelude::{ColorPathDefault, SimpleUuid};
use nightfall_compositor::prelude::FinalLayerAttributedAssertions;
use nightfall_dmx::prelude::Attribute;
use nightfall_dmx::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use web_time::Instant;

use crate::FixtureCommand;
use crate::fixture::Fixture;
use crate::geometry::FixtureGeometry;
use crate::parameter_state::{ParameterLayout, ParameterStateFrame, ParameterStateProjection};
use crate::prelude::{BeamType, FixtureDataProviderExt, FixturePhysical};
use crate::route_validation::RouteValidationSettings;
use crate::routes::{
    DisabledRoute, DisabledRoutes, InputRoute, InputRoutes, OutputRoute, OutputRoutes,
    ResolvedInputDestination, ResolvedInputRoutes, ResolvedInputSource,
};
use crate::universe::InputDmxUniverses;
use crate::universe::InputUniverseStaleTimeout;
use crate::universe_stream::{
    DmxUniverseChannels, DmxUniverseStream, DmxUniverseSummary, STREAM_INTERVAL,
    route_transport_label,
};

/// Wrapper for serializing fx messages with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub(crate) enum FixtureWsMessage<'a> {
    /// List of all fixtures (without geometry)
    FixtureDefinitions(&'a [Fixture]),
    /// Geometry data for fixtures, keyed by fixture UID
    FixtureGeometries(
        #[typeshare(serialized_as = "Record<string, FixtureGeometry>")]
        &'a HashMap<SimpleUuid, FixtureGeometry>,
    ),
    /// Every output and input universe, without channel values.
    DmxUniverseList(&'a [DmxUniverseSummary]),
    /// Channel values of the universes the receiving client watches.
    DmxUniverseChannels(&'a [DmxUniverseChannels<'a>]),
    /// Input contribution trace data.
    InputContributionTrace(&'a [OutboundInputContribution]),
    /// Route definitions for fixtures and transports.
    Routes(&'a RoutesSnapshot),
    /// Fixture and fixture element color path defaults.
    ColorPathDefaults(&'a [ColorPathDefault]),
    /// Current route overlap validation settings.
    RouteValidationSettings(&'a RouteValidationSettings),
    /// Fixture command (for forwarding CRUD operations to UI)
    #[allow(dead_code)]
    FixtureCommand(&'a crate::FixtureCommand),
    /// Slot order for subsequent `ParameterState` frames.
    ParameterLayout(&'a ParameterLayout),
    /// Current absolute, relative, and output parameter values, indexed by layout slot.
    ParameterState(&'a ParameterStateFrame<'a>),
}

/// Time spent projecting the current parameter state for clients.
pub const PARAMETER_STATE_BUILD_MS: DiagnosticPath =
    DiagnosticPath::const_new("desk/parameter_state/build_ms");
/// Time spent encoding and publishing the current parameter state.
pub const PARAMETER_STATE_BROADCAST_MS: DiagnosticPath =
    DiagnosticPath::const_new("desk/parameter_state/broadcast_ms");

/// Beam properties for visualization, derived from FixturePhysical.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct BeamSpec {
    /// Inner cone angle in degrees (GDTF BeamAngle)
    pub beam_angle: f32,
    /// Outer cone angle in degrees (GDTF FieldAngle)
    pub field_angle: f32,
    /// Light output in lumens
    pub lumens: f32,
    /// Beam rendering style
    pub beam_type: BeamType,
}

/// Route snapshot for UI consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct RoutesSnapshot {
    /// Input routes.
    pub input: Vec<InputRoute>,
    /// Output routes.
    pub output: Vec<OutputRoute>,
    /// Disabled routes.
    pub disabled: Vec<DisabledRoute>,
}

impl Default for BeamSpec {
    fn default() -> Self {
        Self {
            beam_angle: 15.0,
            field_angle: 15.0,
            lumens: 10000.0,
            beam_type: BeamType::Spot,
        }
    }
}

/// Register performance diagnostics emitted by fixture-owned client projections.
pub fn register_fixture_websocket_diagnostics(app: &mut App) {
    app.register_diagnostic(Diagnostic::new(PARAMETER_STATE_BUILD_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(PARAMETER_STATE_BROADCAST_MS).with_suffix(" ms"));
}

/// Clients waiting for the parameter layout or a keyframe of the parameter stream.
#[derive(Resource, Default)]
pub struct ParameterStateRequests {
    /// Clients that resynced and need the layout, which a keyframe then follows.
    pub layout: PendingReplies,
    /// Clients that need a keyframe, after resyncing or missing frames.
    pub keyframe: PendingReplies,
}

/// Publish the current absolute, relative, and computed output parameter values.
pub fn send_parameter_state(
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameters_query: Query<&crate::parameter::Parameter>,
    final_layer_attributed_assertions: Res<FinalLayerAttributedAssertions>,
    mut projection: ResMut<ParameterStateProjection>,
    mut requests: ResMut<ParameterStateRequests>,
    mut diagnostics: Diagnostics,
    broadcaster: Res<ClientEventSink>,
) {
    let _span = tracing::debug_span!("send_parameter_state").entered();
    let build_start = Instant::now();
    projection.refresh_layout(
        &fixture_data_provider,
        &fixture_data_provider.parameter_index(),
        fixture_data_provider.is_changed(),
    );
    // Requests for every client are answered on the shared stream. Replies to individual clients
    // carry the state the stream last left everyone in, so they go out before this frame and its
    // shared delta then applies on top of them.
    let layout_requests = requests.layout.take();
    let keyframe_requests = requests.keyframe.take();
    if layout_requests == Some(PendingAudience::Everyone) {
        projection.request_layout();
    }
    if keyframe_requests == Some(PendingAudience::Everyone) {
        projection.request_keyframe();
    }
    if let Some(PendingAudience::Clients(clients)) = layout_requests
        && let Some(layout) = projection.layout_reply()
    {
        broadcaster.narrowed_to(clients).publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FixtureWsMessage::ParameterLayout(layout),
        );
    }
    if let Some(PendingAudience::Clients(clients)) = keyframe_requests
        && let Some(frame) = projection.keyframe_reply(build_start)
    {
        broadcaster.narrowed_to(clients).publish(
            DISCRIMINATOR_DROPPABLE,
            &FixtureWsMessage::ParameterState(&frame),
        );
    }
    projection.fill_values(&parameters_query, &final_layer_attributed_assertions.0);

    let build_elapsed = build_start.elapsed();
    record_elapsed_ms(&mut diagnostics, &PARAMETER_STATE_BUILD_MS, build_elapsed);

    let broadcast_start = Instant::now();
    if let Some(layout) = projection.take_pending_layout() {
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FixtureWsMessage::ParameterLayout(layout),
        );
    }
    if let Some(frame) = projection.publish_frame(build_start) {
        // A keyframe may replace a queued frame; a delta must never, since it builds on it.
        let discriminator = if frame.keyframe {
            DISCRIMINATOR_DROPPABLE
        } else {
            DISCRIMINATOR_DELTA
        };
        broadcaster.publish(discriminator, &FixtureWsMessage::ParameterState(&frame));
    }
    let broadcast_elapsed = broadcast_start.elapsed();
    record_elapsed_ms(
        &mut diagnostics,
        &PARAMETER_STATE_BROADCAST_MS,
        broadcast_elapsed,
    );
    tracing::trace!(
        slot_count = projection.slot_count(),
        build_ms = build_elapsed.as_secs_f64() * 1000.0,
        broadcast_ms = broadcast_elapsed.as_secs_f64() * 1000.0,
        "ParameterState client projection baseline"
    );
}

/// Add one elapsed duration to a Bevy diagnostic in milliseconds.
fn record_elapsed_ms(diagnostics: &mut Diagnostics, path: &DiagnosticPath, elapsed: Duration) {
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    diagnostics.add_measurement(path, || elapsed_ms);
}

impl From<&FixturePhysical> for BeamSpec {
    fn from(physical: &FixturePhysical) -> Self {
        Self {
            beam_angle: physical.beam_angle,
            field_angle: physical.field_angle,
            lumens: physical.lumens,
            beam_type: physical.beam_type,
        }
    }
}

/// Outbound input contribution to parameter state.
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OutboundInputContribution {
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub fixture_uid: Uuid,
    pub element_index: u16,
    pub attribute: Attribute,
    pub output_value: ParameterDmxValue,
    pub transport: String,
    pub universe_id: u16,
    pub source_address: u16,
    pub frame_age_ms: u32,
    pub is_stale: bool,
}

/// Handle a client's request for a parameter keyframe.
///
/// A client sends this after it detects a gap in the parameter frame sequence
/// (or otherwise loses confidence in its rebuilt state). The payload carries no
/// data; the sender alone gets a keyframe before the next frame, so other clients
/// keep receiving deltas.
pub fn deserialize_parameter_keyframe_request(
    world: &mut World,
    _json: Value,
    sender: Audience,
) -> Result<(), String> {
    world
        .resource_mut::<ParameterStateRequests>()
        .keyframe
        .request(sender);
    Ok(())
}

/// Forward fixture commands to UI via broadcaster
///
/// Note: CRUD commands and update commands are intentionally NOT forwarded here
/// because the command echo would be sent before we know if the operation succeeded.
/// Instead, we rely on send_fixtures_on_change to send full definitions after changes.
pub fn forward_fixture_commands(
    mut events: MessageReader<CommandEnvelope<FixtureCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded - rely on send_fixtures_on_change instead
    }
}

/// Internal notification that placement deltas were already emitted this frame.
#[derive(Debug, Clone, Copy, Message)]
pub struct SuppressFixtureChangedSnapshot;

/// Broadcast a fixture command to websocket clients.
pub fn broadcast_fixture_command(broadcaster: &ClientEventSink, command: &FixtureCommand) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureWsMessage::FixtureCommand(command),
    );
}

/// Send fixture definitions when FixtureDataProviderExt changes.
pub fn send_fixtures_on_change(
    fixture_data_provider: Res<FixtureDataProviderExt>,
    geometry_provider: Option<Res<crate::geometry::GeometryProviderResource>>,
    broadcaster: Res<ClientEventSink>,
    mut suppress_snapshot_events: MessageReader<SuppressFixtureChangedSnapshot>,
) {
    let snapshot_suppressed = suppress_snapshot_events.read().count() > 0;

    if !fixture_data_provider.is_changed() {
        return;
    }

    if snapshot_suppressed {
        tracing::trace!("Skipping full fixture websocket sync; placement deltas already emitted");
        return;
    }

    send_fixtures(&fixture_data_provider, &broadcaster, |fixture| {
        geometry_provider
            .as_ref()
            .and_then(|p| p.get_geometry(fixture))
    });
}

/// Send list of fixtures and their geometries to websocket clients.
///
/// Sends two separate messages:
/// - `FixtureDefinitions`: All fixtures (without geometry)
/// - `FixtureGeometries`: Geometry data keyed by fixture UID (only for fixtures with geometry)
///
/// The `geometry_provider` closure receives each fixture and returns its geometry if available.
pub fn send_fixtures<'a, F>(
    fixture_data_provider: &'a FixtureDataProviderExt,
    broadcaster: &ClientEventSink,
    geometry_provider: F,
) where
    F: Fn(&Fixture) -> Option<FixtureGeometry> + 'a,
{
    let fixtures: Vec<Fixture> = fixture_data_provider
        .inner
        .iter()
        .map(|e| e.value().clone())
        .collect();

    // Build geometry map keyed by fixture UID
    let mut geometries: HashMap<SimpleUuid, FixtureGeometry> = HashMap::new();
    for fixture in &fixtures {
        if let Some(geometry) = geometry_provider(fixture) {
            geometries.insert(SimpleUuid(fixture.identifiers.uid), geometry);
        }
    }

    // Send fixtures
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureWsMessage::FixtureDefinitions(&fixtures),
    );

    // Send geometries (only if there are any)
    if !geometries.is_empty() {
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FixtureWsMessage::FixtureGeometries(&geometries),
        );
    }

    tracing::trace!(
        "Sending {} fixtures and {} geometries over websocket",
        fixtures.len(),
        geometries.len()
    );
}

/// Broadcasts a trace of effective input contributions from transport routes to fixture
/// parameters, at most once per [`STREAM_INTERVAL`].
pub fn send_input_contribution_trace(
    resolved_input_routes: Res<ResolvedInputRoutes>,
    input_universes: Res<InputDmxUniverses>,
    input_stale_timeout: Res<InputUniverseStaleTimeout>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<&crate::parameter::Parameter>,
    broadcaster: Res<ClientEventSink>,
    mut last_sent: Local<Option<Instant>>,
) {
    let now = Instant::now();
    if last_sent.is_some_and(|last| now.saturating_duration_since(last) < STREAM_INTERVAL) {
        return;
    }
    *last_sent = Some(now);
    let stale_after_ms = input_stale_timeout.0.as_millis() as u32;

    let param_index = fixture_data_provider.parameter_index();
    let mut parameter_locations: HashMap<Entity, (Uuid, u16)> = HashMap::new();
    for (parameter_instance, location) in param_index.iter() {
        parameter_locations
            .entry(parameter_instance.entity())
            .or_insert((
                location.element.fixture_uid,
                location.element.index.unwrap_or(1) as u16,
            ));
    }

    let mut trace = Vec::new();
    let mut seen = HashSet::new();
    for route in &resolved_input_routes.routes {
        let ResolvedInputSource::Transport {
            transport,
            universe,
            address,
        } = &route.source
        else {
            continue;
        };

        let frame_age_ms = input_universes
            .frame_age_ms(*transport, *universe, now)
            .unwrap_or(u32::MAX);
        let is_stale = frame_age_ms >= stale_after_ms;
        let targets = match &route.destination {
            ResolvedInputDestination::Fixture { targets } => targets,
            ResolvedInputDestination::Console { targets, .. } => targets,
            ResolvedInputDestination::Transport { .. } => continue,
        };
        for target in targets {
            let Some((fixture_uid, element_index)) =
                parameter_locations.get(&target.entity).copied()
            else {
                continue;
            };
            let Ok(parameter) = parameter_query.get(target.entity) else {
                continue;
            };
            let source_address =
                address.saturating_add(target.offsets.first().copied().unwrap_or(0));
            if source_address == 0 {
                continue;
            }
            if !seen.insert((target.entity, *transport, *universe, source_address)) {
                continue;
            }

            trace.push(OutboundInputContribution {
                fixture_uid,
                element_index,
                attribute: parameter.metadata.attribute.clone(),
                output_value: parameter.get_logical_value(),
                transport: route_transport_label(*transport).to_string(),
                universe_id: *universe,
                source_address,
                frame_age_ms,
                is_stale,
            });
        }
    }

    trace.sort_by_key(|item| {
        (
            item.is_stale,
            item.transport.clone(),
            item.universe_id,
            item.source_address,
            item.fixture_uid.as_u128(),
            item.element_index,
        )
    });

    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &FixtureWsMessage::InputContributionTrace(&trace),
    );
}

/// Send route data for fixtures and transports.
pub fn send_routes(
    input_routes: &InputRoutes,
    output_routes: &OutputRoutes,
    disabled_routes: &DisabledRoutes,
    broadcaster: &ClientEventSink,
) {
    let snapshot = RoutesSnapshot {
        input: input_routes.routes.clone(),
        output: output_routes.routes.clone(),
        disabled: disabled_routes.routes.clone(),
    };

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureWsMessage::Routes(&snapshot),
    );
    tracing::trace!("Sending route definitions to websocket clients");
}

/// Send route data when routes change.
pub fn send_routes_on_change(
    input_routes: Res<InputRoutes>,
    output_routes: Res<OutputRoutes>,
    disabled_routes: Res<DisabledRoutes>,
    broadcaster: Res<ClientEventSink>,
) {
    if !input_routes.is_changed() && !output_routes.is_changed() && !disabled_routes.is_changed() {
        return;
    }

    send_routes(
        &input_routes,
        &output_routes,
        &disabled_routes,
        &broadcaster,
    );
}

/// Send fixture color path defaults to websocket clients.
pub fn send_color_path_defaults(
    fixture_data_provider: &FixtureDataProviderExt,
    broadcaster: &ClientEventSink,
) {
    let mut defaults = fixture_data_provider.color_path_default_entries();
    defaults.sort_by_key(|default| {
        (
            default.fixture.fixture_uid.as_u128(),
            default.fixture.index.unwrap_or(0),
        )
    });
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureWsMessage::ColorPathDefaults(&defaults),
    );
}

/// Send fixture color path defaults when the fixture provider changes.
pub fn send_color_path_defaults_on_change(
    fixture_data_provider: Res<FixtureDataProviderExt>,
    broadcaster: Res<ClientEventSink>,
) {
    if !fixture_data_provider.is_changed() {
        return;
    }

    send_color_path_defaults(&fixture_data_provider, &broadcaster);
}

/// Send route validation settings.
pub fn send_route_validation_settings(
    settings: &RouteValidationSettings,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureWsMessage::RouteValidationSettings(settings),
    );
}

/// Send route validation settings when they change.
pub fn send_route_validation_settings_on_change(
    settings: Res<RouteValidationSettings>,
    broadcaster: Res<ClientEventSink>,
) {
    if !settings.is_changed() {
        return;
    }

    send_route_validation_settings(&settings, &broadcaster);
}

/// Handle ResyncState by sending fixtures and patch data.
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    geometry_provider: Option<Res<crate::geometry::GeometryProviderResource>>,
    input_routes: Res<InputRoutes>,
    output_routes: Res<OutputRoutes>,
    disabled_routes: Res<DisabledRoutes>,
    route_validation_settings: Res<RouteValidationSettings>,
    mut parameter_requests: ResMut<ParameterStateRequests>,
    mut universe_stream: ResMut<DmxUniverseStream>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };

    let audiences = broadcaster.audiences().iter().copied();
    parameter_requests.layout.request_each(audiences.clone());
    parameter_requests.keyframe.request_each(audiences);
    universe_stream.request_list(broadcaster.audiences());
    // Send fixtures with geometry if provider is available
    send_fixtures(&fixture_data_provider, &broadcaster, |fixture| {
        geometry_provider
            .as_ref()
            .and_then(|p| p.get_geometry(fixture))
    });
    send_routes(
        &input_routes,
        &output_routes,
        &disabled_routes,
        &broadcaster,
    );
    send_color_path_defaults(&fixture_data_provider, &broadcaster);
    send_route_validation_settings(&route_validation_settings, &broadcaster);
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use moonshine_kind::Instance;
    use nightfall::prelude::{FixtureRef, Identifiers};
    use nightfall_fixture_model::parameter::ParameterMetadata;
    use nightfall_io::prelude::{NetworkDmxOutputTargets, UsbDmxOutputTargets};
    use nightfall_io::{OutputTransport, RouteTransport};

    use super::*;
    use crate::fixture::FixtureElement;
    use crate::output_frames::OutputDmxFrames;
    use crate::output_frames::{OutputRouting, compose_output_frames, update_input_routing};
    use crate::parameter::{Parameter, ParameterValues};
    use crate::route_resolution::{derive_console_addresses, resolve_output_routes};
    use crate::routes::{ConsoleDmxAddresses, DmxRange, OutputSource, OutputTarget};
    use crate::universe::ConsoleDmxUniverses;
    use crate::universe::{ConsoleChannelOrigin, dmx_universes};
    use crate::universe_stream::{DmxIoMode, collect_universes};

    /// Builds an app running route resolution and DMX universe composition.
    fn pipeline_app() -> App {
        let mut app = App::new();
        app.init_resource::<FixtureDataProviderExt>();
        app.init_resource::<OutputRoutes>();
        app.init_resource::<DisabledRoutes>();
        app.init_resource::<ConsoleDmxAddresses>();
        app.init_resource::<NetworkDmxOutputTargets>();
        app.init_resource::<UsbDmxOutputTargets>();
        app.init_resource::<ResolvedInputRoutes>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<OutputRouting>();
        app.init_resource::<OutputDmxFrames>();
        app.init_resource::<ConsoleDmxUniverses>();
        app.add_systems(
            Update,
            (
                derive_console_addresses,
                resolve_output_routes,
                update_input_routing,
                dmx_universes,
                compose_output_frames,
            )
                .chain(),
        );
        app
    }

    /// Spawns a one-element RGB fixture whose coarse channels hold `values`.
    fn spawn_rgb_fixture(app: &mut App, uid: Uuid, id: u32, values: [f32; 3]) {
        let attributes = [Attribute::Red, Attribute::Green, Attribute::Blue];
        let metadata: Vec<ParameterMetadata> = attributes
            .iter()
            .map(|attribute| ParameterMetadata {
                native_unit: attribute.native_unit(),
                value_polarity: attribute.value_polarity(),
                attribute: attribute.clone(),
                resolution: DmxValueResolution::Coarse,
                ..Default::default()
            })
            .collect();
        let fixture = Fixture {
            identifiers: Identifiers {
                id,
                uid,
                label: format!("fixture-{id}"),
            },
            elements: vec![FixtureElement {
                label: "main".to_string(),
                parameters: metadata.clone(),
            }],
            ..Default::default()
        };

        let world = app.world_mut();
        let entities: Vec<Entity> = metadata
            .into_iter()
            .zip(values)
            .map(|(metadata, value)| {
                world
                    .spawn(Parameter {
                        metadata,
                        values: ParameterValues {
                            current_value: value,
                            ..Default::default()
                        },
                    })
                    .id()
            })
            .collect();

        let mut data_provider = world.resource_mut::<FixtureDataProviderExt>();
        data_provider.inner.add(fixture).expect("fixture is added");
        for (attribute, entity) in attributes.into_iter().zip(entities) {
            // SAFETY: the entity was just spawned with a `Parameter` component.
            let parameter: Instance<Parameter> = unsafe { Instance::from_entity_unchecked(entity) };
            data_provider.add_parameter(
                FixtureRef {
                    fixture_uid: uid,
                    index: Some(1),
                },
                attribute,
                parameter,
            );
        }
    }

    /// Returns a fixture-sourced output route for `uid` targeting `target`.
    fn fixture_route(uid: Uuid, target: OutputTarget) -> OutputRoute {
        OutputRoute {
            source: OutputSource::Fixture {
                uids: vec![uid],
                element: None,
                param: None,
            },
            target,
            priority: 0,
            clone: false,
        }
    }

    /// Returns a console route target at one universe and address.
    fn console_target(universe: u16, address: u16) -> OutputTarget {
        OutputTarget::Console {
            universe: Some(DmxRange::single(universe)),
            address: Some(address),
        }
    }

    /// Returns a transport route target at one universe and address.
    fn transport_target(target: &str, universe: u16, address: u16) -> OutputTarget {
        OutputTarget::Transport {
            target: target.to_string(),
            universe: Some(DmxRange::single(universe)),
            address: Some(address),
        }
    }

    /// Runs the pipeline and returns output views as `(label, universe, channels)`.
    fn output_views(app: &mut App) -> Vec<(String, u16, Vec<ChannelDmxValue>)> {
        app.update();
        app.update();
        let world = app.world();
        collect_universes(
            world.resource::<ConsoleDmxUniverses>(),
            world.resource::<OutputDmxFrames>(),
            world.resource::<InputDmxUniverses>(),
            u32::MAX,
            Instant::now(),
        )
        .into_iter()
        .filter(|view| view.key.io_mode == DmxIoMode::Output)
        .map(|view| {
            (
                view.key.transport,
                view.key.universe_id,
                view.channels.to_vec(),
            )
        })
        .collect()
    }

    /// Returns the `(label, universe)` pairs of the reported views.
    fn view_keys(views: &[(String, u16, Vec<ChannelDmxValue>)]) -> Vec<(&str, u16)> {
        views
            .iter()
            .map(|(label, universe, _)| (label.as_str(), *universe))
            .collect()
    }

    /// Fixtures bound only to console addresses are reported under the Console label using
    /// console numbering, even though no transport route exists.
    #[test]
    fn console_only_route_reports_console_universe() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [255.0, 0.0, 128.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes =
            vec![fixture_route(uid, console_target(2, 121))];

        let views = output_views(&mut app);

        assert_eq!(view_keys(&views), vec![("Console", 2)]);
        assert_eq!(views[0].2[120..123], [255, 0, 128]);
    }

    /// Console passthrough to a transport keeps console numbering under Console and reports
    /// the remapped on-the-wire universe under the transport family, with identical values.
    #[test]
    fn console_passthrough_reports_console_and_wire_numbering() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [255.0, 0.0, 128.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes = vec![
            fixture_route(uid, console_target(2, 121)),
            OutputRoute {
                source: OutputSource::Console {
                    universe: Some(DmxRange::single(2)),
                    address: None,
                },
                target: transport_target("sacn", 10, 1),
                priority: 0,
                clone: false,
            },
        ];

        let views = output_views(&mut app);

        assert_eq!(view_keys(&views), vec![("Console", 2), ("sACN", 10)]);
        assert_eq!(views[0].2[120..123], [255, 0, 128]);
        assert_eq!(views[1].2[120..123], [255, 0, 128]);
    }

    /// Direct fixture-to-transport routes only appear under their transport with wire
    /// numbering and never populate console space.
    #[test]
    fn direct_transport_route_reports_only_wire_universe() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [10.0, 20.0, 30.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes =
            vec![fixture_route(uid, transport_target("sacn", 1, 5))];

        let views = output_views(&mut app);

        assert_eq!(view_keys(&views), vec![("sACN", 1)]);
        assert_eq!(views[0].2[4..7], [10, 20, 30]);
    }

    /// Manual channel writes land in console space; a routed transport universe with the same
    /// number keeps showing its own output buffer.
    #[test]
    fn manual_channel_writes_are_console_space() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [10.0, 20.0, 30.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes =
            vec![fixture_route(uid, transport_target("sacn", 1, 5))];
        app.world_mut()
            .resource_mut::<ConsoleDmxUniverses>()
            .set_value(1, 1, 255, ConsoleChannelOrigin::ManualCommand);

        let views = output_views(&mut app);

        assert_eq!(view_keys(&views), vec![("Console", 1), ("sACN", 1)]);
        assert_eq!(views[0].2[0..7], [255, 0, 0, 0, 0, 0, 0]);
        assert_eq!(views[1].2[0..7], [0, 0, 0, 0, 10, 20, 30]);
    }

    /// Returns a console→transport passthrough route for one console universe.
    fn console_passthrough(console_universe: u16, wire_universe: u16) -> OutputRoute {
        OutputRoute {
            source: OutputSource::Console {
                universe: Some(DmxRange::single(console_universe)),
                address: None,
            },
            target: transport_target("sacn", wire_universe, 1),
            priority: 0,
            clone: false,
        }
    }

    /// Console universe 1 routed to sACN 10 never leaks onto sACN 1, even when sACN 1 is
    /// only fed by a transport input passthrough.
    #[test]
    fn routed_console_universe_only_reaches_its_wire_universe() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [11.0, 22.0, 33.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes = vec![
            fixture_route(uid, console_target(1, 1)),
            console_passthrough(1, 10),
        ];
        let mut input = [0; nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE];
        input[99] = 77;
        app.world_mut()
            .resource_mut::<InputDmxUniverses>()
            .set_universe(RouteTransport::ArtNet, 4, input, Instant::now());
        app.world_mut().resource_mut::<ResolvedInputRoutes>().routes =
            vec![crate::routes::ResolvedInputRoute {
                source: ResolvedInputSource::Transport {
                    transport: RouteTransport::ArtNet,
                    universe: 4,
                    address: 100,
                },
                priority: 0,
                destination: ResolvedInputDestination::Transport {
                    target: crate::routes::ResolvedTransportTarget {
                        target: "sacn".to_string(),
                        protocol: RouteTransport::Sacn,
                        transport: OutputTransport::Sacn {
                            mode: nightfall_io::SacnDelivery::Multicast,
                        },
                        universe: 1,
                        address: 100,
                    },
                },
            }];

        let views = output_views(&mut app);

        assert_eq!(
            view_keys(&views),
            vec![("Console", 1), ("sACN", 1), ("sACN", 10)]
        );
        assert_eq!(views[1].2[0..3], [0, 0, 0], "console 1 leaked onto sACN 1");
        assert_eq!(views[1].2[99], 77);
        assert_eq!(views[2].2[0..3], [11, 22, 33]);
    }

    /// Moving, removing, and deleting console-bound fixtures leaves no ghost console values
    /// behind, and the routed wire frame follows.
    #[test]
    fn console_values_clear_when_routes_or_fixtures_change() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [11.0, 22.0, 33.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes = vec![
            fixture_route(uid, console_target(2, 121)),
            console_passthrough(2, 10),
        ];
        let views = output_views(&mut app);
        assert_eq!(views[0].2[120..123], [11, 22, 33]);

        app.world_mut().resource_mut::<OutputRoutes>().routes = vec![
            fixture_route(uid, console_target(2, 1)),
            console_passthrough(2, 10),
        ];
        let views = output_views(&mut app);
        assert_eq!(view_keys(&views), vec![("Console", 2), ("sACN", 10)]);
        assert_eq!(views[0].2[0..3], [11, 22, 33]);
        assert_eq!(
            views[0].2[120..123],
            [0, 0, 0],
            "moved route left ghost values"
        );
        assert_eq!(
            views[1].2[120..123],
            [0, 0, 0],
            "ghost values reached the wire"
        );

        let parameters = app
            .world_mut()
            .resource_mut::<FixtureDataProviderExt>()
            .remove_fixture(&uid)
            .expect("fixture is removed")
            .1;
        for parameter in parameters {
            app.world_mut().despawn(parameter.entity());
        }
        let views = output_views(&mut app);
        assert!(
            views.is_empty(),
            "deleted fixture left views: {:?}",
            view_keys(&views)
        );
    }

    /// Reroute a direct transport patch to another wire universe drops the old wire view.
    #[test]
    fn reroute_direct_patch_drops_stale_wire_universe() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [10.0, 20.0, 30.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes =
            vec![fixture_route(uid, transport_target("sacn", 5, 1))];
        assert_eq!(view_keys(&output_views(&mut app)), vec![("sACN", 5)]);

        app.world_mut().resource_mut::<OutputRoutes>().routes =
            vec![fixture_route(uid, transport_target("sacn", 6, 1))];
        assert_eq!(view_keys(&output_views(&mut app)), vec![("sACN", 6)]);
    }

    /// Parameter-scoped console routes lay out only the selected parameters, so a second
    /// fixture follows the first without overlapping its channels.
    #[test]
    fn parameter_scoped_console_route_does_not_overlap() {
        let mut app = pipeline_app();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, first, 1, [11.0, 22.0, 33.0]);
        spawn_rgb_fixture(&mut app, second, 2, [44.0, 55.0, 66.0]);
        app.world_mut().resource_mut::<OutputRoutes>().routes = vec![OutputRoute {
            source: OutputSource::Fixture {
                uids: vec![first, second],
                element: None,
                param: Some("Red".to_string()),
            },
            target: console_target(1, 1),
            priority: 0,
            clone: false,
        }];

        let views = output_views(&mut app);

        assert_eq!(view_keys(&views), vec![("Console", 1)]);
        assert_eq!(views[0].2[0..3], [11, 44, 0]);
    }
}
