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
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_dmx::*;
use nightfall_engine::prelude::*;
use nightfall_io::BindingTransport;
use nightfall_io::OutputTransport;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use web_time::{Instant, SystemTime, UNIX_EPOCH};

use crate::FixtureCommand;
use crate::binding_validation::BindingValidationSettings;
use crate::bindings::{
    DisabledBinding, DisabledBindings, InputBinding, InputBindings, OutputBinding, OutputBindings,
    ResolvedInputBindings, ResolvedInputDestination, ResolvedInputSource,
};
use crate::fixture::Fixture;
use crate::geometry::FixtureGeometry;
use crate::prelude::{BeamType, FixtureDataProviderExt, FixturePhysical};
use crate::universe::InputUniverseStaleTimeout;
use crate::universe::{ConsoleDmxUniverses, InputDmxUniverses, UniverseTransportMap};

/// Wrapper for serializing fx messages with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum FixtureWsMessage<'a> {
    /// List of all fixtures (without geometry)
    FixtureDefinitions(&'a [Fixture]),
    /// Geometry data for fixtures, keyed by fixture UID
    FixtureGeometries(
        #[typeshare(serialized_as = "Record<string, FixtureGeometry>")]
        &'a HashMap<SimpleUuid, FixtureGeometry>,
    ),
    /// DMX universes data
    DmxUniverseData(&'a [OutboundDmxUniverse]),
    /// Input contribution trace data.
    InputContributionTrace(&'a [OutboundInputContribution]),
    /// Binding definitions for fixtures and transports.
    Bindings(&'a BindingsSnapshot),
    /// Fixture and fixture element color path defaults.
    ColorPathDefaults(&'a [ColorPathDefault]),
    /// Current binding overlap validation settings.
    BindingValidationSettings(&'a BindingValidationSettings),
    /// Fixture command (for forwarding CRUD operations to UI)
    #[allow(dead_code)]
    FixtureCommand(&'a crate::FixtureCommand),
    /// Current absolute, relative, and output parameter values.
    ParameterState(&'a [OutboundParameterState]),
}

/// Time spent projecting the current parameter state for clients.
pub const PARAMETER_STATE_BUILD_MS: DiagnosticPath =
    DiagnosticPath::const_new("desk/parameter_state/build_ms");
/// Time spent encoding and publishing the current parameter state.
pub const PARAMETER_STATE_BROADCAST_MS: DiagnosticPath =
    DiagnosticPath::const_new("desk/parameter_state/broadcast_ms");

/// Parameter values for one fixture in the client wire format.
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutboundParameterState {
    /// Unique ID of the fixture this state applies to.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub fixture_uid: Uuid,
    /// Absolute, relative, and output values for each fixture element.
    pub parameters: Vec<ParameterState>,
}

/// Parameter values for one fixture element in the client wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ParameterState {
    /// Absolute parameter values asserted by objects in the layer stack.
    #[typeshare(serialized_as = "Record<String, ParameterValue>")]
    #[serde(with = "attribute_keyed_map")]
    pub absolute: HashMap<Attribute, ParameterValue>,
    /// Relative parameter values asserted by objects in the layer stack.
    #[typeshare(serialized_as = "Record<String, ParameterValue>")]
    #[serde(with = "attribute_keyed_map")]
    pub relative: HashMap<Attribute, ParameterValue>,
    /// Final computed output values after compositing and fixture processing.
    #[typeshare(serialized_as = "Record<String, ParameterDmxValue>")]
    #[serde(with = "attribute_keyed_map")]
    pub output: HashMap<Attribute, ParameterDmxValue>,
}

mod attribute_keyed_map {
    use std::collections::HashMap;
    use std::str::FromStr;

    use nightfall_dmx::prelude::Attribute;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    /// Serialize attribute maps with the canonical string keys consumed by the web UI.
    pub fn serialize<S, V>(map: &HashMap<Attribute, V>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
        V: Serialize,
    {
        let keyed: HashMap<String, &V> = map
            .iter()
            .map(|(attribute, value)| (attribute.key(), value))
            .collect();
        keyed.serialize(serializer)
    }

    /// Deserialize canonical attribute keys while retaining unknown custom labels.
    pub fn deserialize<'de, D, V>(deserializer: D) -> Result<HashMap<Attribute, V>, D::Error>
    where
        D: Deserializer<'de>,
        V: Deserialize<'de>,
    {
        let keyed = HashMap::<String, V>::deserialize(deserializer)?;
        Ok(keyed
            .into_iter()
            .map(|(key, value)| {
                let attribute =
                    Attribute::from_str(&key).unwrap_or(Attribute::Custom { label: key });
                (attribute, value)
            })
            .collect())
    }
}

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

/// Binding snapshot for UI consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BindingsSnapshot {
    /// Input bindings.
    pub input: Vec<InputBinding>,
    /// Output bindings.
    pub output: Vec<OutputBinding>,
    /// Disabled bindings.
    pub disabled: Vec<DisabledBinding>,
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

/// Publish the current absolute, relative, and computed output parameter values.
pub fn send_parameter_state(
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameters_query: Query<&crate::parameter::Parameter>,
    final_layer_attributed_assertions: Res<FinalLayerAttributedAssertions>,
    mut diagnostics: Diagnostics,
    broadcaster: Res<ClientEventSink>,
) {
    let _span = tracing::debug_span!("send_parameter_state").entered();
    let build_start = Instant::now();
    let param_map = fixture_data_provider.parameter_attribute_map_guard();

    let mut fixture_state = Vec::new();
    for fixture in fixture_data_provider.inner.iter() {
        let fixture_id = fixture.identifiers.uid;
        let mut elements = Vec::with_capacity(fixture.elements.len());

        for (index, element) in fixture.elements.iter().enumerate() {
            let fixture_ref = nightfall::prelude::FixtureRef {
                fixture_uid: fixture_id,
                index: Some(index as u32 + 1),
            };
            let parameter_count = element.parameters.len();
            let mut absolute_values = HashMap::new();
            let mut relative_values = HashMap::new();
            let mut output_values = HashMap::with_capacity(parameter_count);

            for parameter_metadata in &element.parameters {
                let attribute = &parameter_metadata.attribute;
                let Some(parameter_instance) =
                    param_map.get_by_left(&(fixture_ref.clone(), attribute.clone()))
                else {
                    continue;
                };

                let Ok(parameter) = parameters_query.get(parameter_instance.entity()) else {
                    tracing::warn!(
                        fixture_uid = %fixture_id,
                        element_index = index + 1,
                        attribute = %attribute,
                        "Fixture parameter index referenced a missing entity"
                    );
                    continue;
                };
                output_values.insert(attribute.clone(), parameter.get_logical_value());

                let attributed_assertions = &final_layer_attributed_assertions.0;
                if let Some((_, (param_value, _))) =
                    attributed_assertions.absolute.get(parameter_instance)
                {
                    absolute_values.insert(attribute.clone(), *param_value);
                }
                if let Some((_, (param_value, _))) =
                    attributed_assertions.relative.get(parameter_instance)
                {
                    relative_values.insert(attribute.clone(), *param_value);
                }
            }

            elements.push(ParameterState {
                absolute: absolute_values,
                relative: relative_values,
                output: output_values,
            });
        }

        fixture_state.push(OutboundParameterState {
            fixture_uid: fixture_id,
            parameters: elements,
        });
    }

    let build_elapsed = build_start.elapsed();
    record_elapsed_ms(&mut diagnostics, &PARAMETER_STATE_BUILD_MS, build_elapsed);

    let broadcast_start = Instant::now();
    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &FixtureWsMessage::ParameterState(&fixture_state),
    );
    let broadcast_elapsed = broadcast_start.elapsed();
    record_elapsed_ms(
        &mut diagnostics,
        &PARAMETER_STATE_BROADCAST_MS,
        broadcast_elapsed,
    );
    tracing::trace!(
        fixture_count = fixture_state.len(),
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
            lumens: physical.lumens.unwrap_or(10000.0),
            beam_type: physical.beam_type,
        }
    }
}

/// DMX input/output mode.
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum DmxIoMode {
    Input,
    Output,
}

/// Outbound representation of a DMX universe for WebSocket transmission.
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
struct OutboundDmxUniverse {
    pub universe_id: u16,
    pub channels: Vec<ChannelDmxValue>,
    pub io_mode: DmxIoMode,
    /// Numbering space of the universe: `Console` for console-space output universes,
    /// otherwise the transport family (`sACN`, `Art-Net`, `USB`…) using wire numbering.
    pub transport: Option<String>,
    pub frame_age_ms: Option<u32>,
    pub is_stale: Option<bool>,
    pub is_self: Option<bool>,
}

/// Outbound input contribution to parameter state.
#[typeshare::typeshare]
#[derive(Clone, Debug, Serialize, Deserialize)]
struct OutboundInputContribution {
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

/// Deserialize and dispatch FixtureCommand from JSON.
pub fn deserialize_fixture_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: FixtureCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse FixtureCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

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

    send_fixtures(&fixture_data_provider, &broadcaster, |make, model, mode| {
        geometry_provider
            .as_ref()
            .and_then(|p| p.get_geometry(make, model, mode))
    });
}

/// Send list of fixtures and their geometries to websocket clients.
///
/// Sends two separate messages:
/// - `FixtureDefinitions`: All fixtures (without geometry)
/// - `FixtureGeometries`: Geometry data keyed by fixture UID (only for fixtures with geometry)
///
/// The `geometry_provider` closure receives (make, model, mode) and returns geometry if available.
pub fn send_fixtures<'a, F>(
    fixture_data_provider: &'a FixtureDataProviderExt,
    broadcaster: &ClientEventSink,
    geometry_provider: F,
) where
    F: Fn(&str, &str, &str) -> Option<FixtureGeometry> + 'a,
{
    let fixtures: Vec<Fixture> = fixture_data_provider
        .inner
        .iter()
        .map(|e| e.value().clone())
        .collect();

    // Build geometry map keyed by fixture UID
    let mut geometries: HashMap<SimpleUuid, FixtureGeometry> = HashMap::new();
    for fixture in &fixtures {
        if let Some(geometry) = geometry_provider(&fixture.make, &fixture.model, &fixture.mode) {
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

/// Last time droppable websocket data was sent (ms since epoch)
static LAST_DROPPABLE_SEND_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const DROPPABLE_INTERVAL_MS: u64 = (1000.0 / 10.0) as u64;
/// Display label for console-space output universes in the DMX universe panel.
const CONSOLE_SPACE_LABEL: &str = "Console";

/// Mapping from a transport input universe onto a transport output universe.
#[derive(Debug, Clone)]
struct TransportPassthroughMapping {
    source_transport: BindingTransport,
    source_universe: u16,
    source_address: u16,
    target_transport: OutputTransport,
    target_universe: u16,
    target_address: u16,
}

/// Returns the operator-facing label of a binding (input) transport.
fn binding_transport_label(transport: BindingTransport) -> &'static str {
    match transport {
        BindingTransport::Sacn => "sACN",
        BindingTransport::ArtNet => "Art-Net",
        BindingTransport::Udmx => "USB",
    }
}

/// Returns the operator-facing transport family label of an output transport.
fn output_transport_label(transport: &OutputTransport) -> &'static str {
    match transport {
        OutputTransport::Disabled => "Disabled",
        OutputTransport::Sacn { .. } => "sACN",
        OutputTransport::Udmx { .. } => "USB",
        OutputTransport::ArtNet { .. } => "Art-Net",
    }
}

/// Orders output universe views: console space first, then transport families.
fn output_label_rank(label: &str) -> u8 {
    match label {
        CONSOLE_SPACE_LABEL => 0,
        "sACN" => 1,
        "Art-Net" => 2,
        "USB" => 3,
        _ => 4,
    }
}

/// Builds the output universe views reported to clients.
///
/// Console-space universes are reported under the `Console` label with console numbering.
/// Each transport family (sACN, Art-Net, USB…) gets its own view per on-the-wire universe,
/// mirroring what output drivers send: the transport's output buffer, else the console
/// universe with the same number, overlaid with transport input passthrough windows.
fn build_output_universes(
    dmx_universes: &ConsoleDmxUniverses,
    transport_map: &UniverseTransportMap,
    resolved_input_bindings: &ResolvedInputBindings,
    input_universes: &InputDmxUniverses,
) -> Vec<OutboundDmxUniverse> {
    let mut console_ids: Vec<u16> = dmx_universes.universe_ids().copied().collect();
    console_ids.sort_unstable();
    let mut data: Vec<OutboundDmxUniverse> = console_ids
        .into_iter()
        .map(|universe_id| {
            output_universe_view(
                CONSOLE_SPACE_LABEL,
                universe_id,
                dmx_universes.get_universe(universe_id).to_vec(),
            )
        })
        .collect();

    let passthrough_mappings: Vec<TransportPassthroughMapping> = resolved_input_bindings
        .bindings
        .iter()
        .filter_map(|binding| {
            let ResolvedInputSource::Transport {
                transport,
                universe,
                address,
            } = &binding.source
            else {
                return None;
            };
            let ResolvedInputDestination::Transport { target } = &binding.destination else {
                return None;
            };
            Some(TransportPassthroughMapping {
                source_transport: *transport,
                source_universe: *universe,
                source_address: *address,
                target_transport: target.transport.clone(),
                target_universe: target.universe,
                target_address: target.address,
            })
        })
        .collect();

    let mut transports_by_view: HashMap<(&'static str, u16), HashSet<&OutputTransport>> =
        HashMap::new();
    for universe_id in transport_map.universes() {
        for transport in transport_map.transports_for_universe(universe_id) {
            transports_by_view
                .entry((output_transport_label(transport), universe_id))
                .or_default()
                .insert(transport);
        }
    }
    for (transport, universe_id) in dmx_universes.output_universe_keys() {
        transports_by_view
            .entry((output_transport_label(transport), universe_id))
            .or_default()
            .insert(transport);
    }
    for mapping in &passthrough_mappings {
        transports_by_view
            .entry((
                output_transport_label(&mapping.target_transport),
                mapping.target_universe,
            ))
            .or_default()
            .insert(&mapping.target_transport);
    }

    let mut views: Vec<_> = transports_by_view.into_iter().collect();
    views.sort_by_key(|((label, universe_id), _)| (output_label_rank(label), *universe_id));

    for ((label, universe_id), transports) in views {
        let mut channels = vec![0; nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE];
        let mut has_channels = false;
        let uses_console_fallback = dmx_universes.has_universe(universe_id)
            && transports
                .iter()
                .any(|transport| !dmx_universes.has_output_universe(transport, universe_id));
        if uses_console_fallback {
            channels.copy_from_slice(&dmx_universes.get_universe(universe_id));
            has_channels = true;
        }
        for transport in transports {
            has_channels |=
                dmx_universes.overlay_output_universe(transport, universe_id, &mut channels);
        }

        for mapping in &passthrough_mappings {
            if mapping.target_universe != universe_id
                || output_transport_label(&mapping.target_transport) != label
            {
                continue;
            }
            let Some(source_channels) = input_universes
                .iter()
                .find(|(transport, source_universe, _)| {
                    *transport == mapping.source_transport
                        && *source_universe == mapping.source_universe
                })
                .map(|(_, _, channels)| channels)
            else {
                continue;
            };
            overlay_mapped_window(
                source_channels,
                mapping.source_address,
                &mut channels,
                mapping.target_address,
            );
            has_channels = true;
        }

        if has_channels {
            data.push(output_universe_view(label, universe_id, channels));
        }
    }

    data
}

/// Creates one output universe view reported under the given display label.
fn output_universe_view(
    label: &str,
    universe_id: u16,
    channels: Vec<ChannelDmxValue>,
) -> OutboundDmxUniverse {
    OutboundDmxUniverse {
        universe_id,
        channels,
        io_mode: DmxIoMode::Output,
        transport: Some(label.to_string()),
        frame_age_ms: None,
        is_stale: None,
        is_self: None,
    }
}

/// Copies an input window starting at `source_address` onto `target` at `target_address`.
fn overlay_mapped_window(
    source: &[ChannelDmxValue],
    source_address: u16,
    target: &mut [ChannelDmxValue],
    target_address: u16,
) {
    if source_address == 0 || target_address == 0 {
        return;
    }

    let source_start = (source_address - 1) as usize;
    let target_start = (target_address - 1) as usize;
    if source_start >= source.len() || target_start >= target.len() {
        return;
    }

    let copy_len = (source.len() - source_start).min(target.len() - target_start);
    target[target_start..(target_start + copy_len)]
        .copy_from_slice(&source[source_start..(source_start + copy_len)]);
}

/// Send DMX universe data for visualization
pub fn send_dmx_universes(
    dmx_universes: Res<ConsoleDmxUniverses>,
    input_universes: Res<InputDmxUniverses>,
    input_stale_timeout: Res<InputUniverseStaleTimeout>,
    transport_map: Res<UniverseTransportMap>,
    resolved_input_bindings: Res<ResolvedInputBindings>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<&crate::parameter::Parameter>,
    broadcaster: Res<ClientEventSink>,
) {
    // Apply rate limit
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let last_send = LAST_DROPPABLE_SEND_MS.load(std::sync::atomic::Ordering::Relaxed);
    let within_rate_limit = now_ms.saturating_sub(last_send) < DROPPABLE_INTERVAL_MS;

    if within_rate_limit {
        return;
    }
    LAST_DROPPABLE_SEND_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
    let now_instant = Instant::now();
    let stale_after_ms = input_stale_timeout.0.as_millis() as u32;

    let mut data = build_output_universes(
        &dmx_universes,
        &transport_map,
        &resolved_input_bindings,
        &input_universes,
    );

    let transport_rank = |transport: BindingTransport| match transport {
        BindingTransport::Sacn => 0,
        BindingTransport::ArtNet => 1,
        BindingTransport::Udmx => 2,
    };

    let mut input_entries: Vec<(BindingTransport, u16, Vec<ChannelDmxValue>, u32, bool)> =
        input_universes
            .iter()
            .filter_map(|(transport, universe_id, channels)| {
                let frame_age_ms =
                    input_universes.frame_age_ms(transport, universe_id, now_instant)?;
                let is_self = input_universes
                    .is_self_frame(transport, universe_id)
                    .unwrap_or(false);
                Some((
                    transport,
                    universe_id,
                    channels.to_vec(),
                    frame_age_ms,
                    is_self,
                ))
            })
            .collect();
    input_entries.sort_by_key(|(transport, universe_id, _, _, _)| {
        (transport_rank(*transport), *universe_id)
    });

    for (transport, universe_id, channels, frame_age_ms, is_self) in input_entries {
        let universe = OutboundDmxUniverse {
            universe_id,
            channels,
            io_mode: DmxIoMode::Input,
            transport: Some(binding_transport_label(transport).to_string()),
            frame_age_ms: Some(frame_age_ms),
            is_stale: Some(frame_age_ms >= stale_after_ms),
            is_self: Some(is_self),
        };
        data.push(universe);
    }

    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &FixtureWsMessage::DmxUniverseData(&data),
    );
    tracing::trace!("Sending DMX universes to websocket clients");

    send_input_contribution_trace(
        &resolved_input_bindings,
        &input_universes,
        &fixture_data_provider,
        &parameter_query,
        now_instant,
        stale_after_ms,
        &broadcaster,
    );
}

/// Broadcasts a trace of effective input contributions from transport bindings to fixture parameters.
fn send_input_contribution_trace(
    resolved_input_bindings: &ResolvedInputBindings,
    input_universes: &InputDmxUniverses,
    fixture_data_provider: &FixtureDataProviderExt,
    parameter_query: &Query<&crate::parameter::Parameter>,
    now: Instant,
    stale_after_ms: u32,
    broadcaster: &ClientEventSink,
) {
    let param_map = fixture_data_provider.parameter_attribute_map_guard();
    let mut parameter_locations: HashMap<Entity, (Uuid, u16)> = HashMap::new();
    for ((fixture_ref, _), parameter_instance) in param_map.iter() {
        parameter_locations
            .entry(parameter_instance.entity())
            .or_insert((
                fixture_ref.fixture_uid,
                fixture_ref.index.unwrap_or(1) as u16,
            ));
    }

    let mut trace = Vec::new();
    let mut seen = HashSet::new();
    for binding in &resolved_input_bindings.bindings {
        let ResolvedInputSource::Transport {
            transport,
            universe,
            address,
        } = &binding.source
        else {
            continue;
        };

        let frame_age_ms = input_universes
            .frame_age_ms(*transport, *universe, now)
            .unwrap_or(u32::MAX);
        let is_stale = frame_age_ms >= stale_after_ms;
        let targets = match &binding.destination {
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
            let source_address = address.saturating_add(target.offset);
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
                transport: binding_transport_label(*transport).to_string(),
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

/// Send binding data for fixtures and transports.
pub fn send_bindings(
    input_bindings: &InputBindings,
    output_bindings: &OutputBindings,
    disabled_bindings: &DisabledBindings,
    broadcaster: &ClientEventSink,
) {
    let snapshot = BindingsSnapshot {
        input: input_bindings.bindings.clone(),
        output: output_bindings.bindings.clone(),
        disabled: disabled_bindings.bindings.clone(),
    };

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureWsMessage::Bindings(&snapshot),
    );
    tracing::trace!("Sending binding definitions to websocket clients");
}

/// Send binding data when bindings change.
pub fn send_bindings_on_change(
    input_bindings: Res<InputBindings>,
    output_bindings: Res<OutputBindings>,
    disabled_bindings: Res<DisabledBindings>,
    broadcaster: Res<ClientEventSink>,
) {
    if !input_bindings.is_changed()
        && !output_bindings.is_changed()
        && !disabled_bindings.is_changed()
    {
        return;
    }

    send_bindings(
        &input_bindings,
        &output_bindings,
        &disabled_bindings,
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

/// Send binding validation settings.
pub fn send_binding_validation_settings(
    settings: &BindingValidationSettings,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureWsMessage::BindingValidationSettings(settings),
    );
}

/// Send binding validation settings when they change.
pub fn send_binding_validation_settings_on_change(
    settings: Res<BindingValidationSettings>,
    broadcaster: Res<ClientEventSink>,
) {
    if !settings.is_changed() {
        return;
    }

    send_binding_validation_settings(&settings, &broadcaster);
}

/// Handle ResyncState by sending fixtures and patch data.
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    geometry_provider: Option<Res<crate::geometry::GeometryProviderResource>>,
    input_bindings: Res<InputBindings>,
    output_bindings: Res<OutputBindings>,
    disabled_bindings: Res<DisabledBindings>,
    binding_validation_settings: Res<BindingValidationSettings>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    // Send fixtures with geometry if provider is available
    send_fixtures(&fixture_data_provider, &broadcaster, |make, model, mode| {
        geometry_provider
            .as_ref()
            .and_then(|p| p.get_geometry(make, model, mode))
    });
    send_bindings(
        &input_bindings,
        &output_bindings,
        &disabled_bindings,
        &broadcaster,
    );
    send_color_path_defaults(&fixture_data_provider, &broadcaster);
    send_binding_validation_settings(&binding_validation_settings, &broadcaster);
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use moonshine_kind::Instance;
    use nightfall::prelude::{FixtureRef, Identifiers};
    use nightfall_io::prelude::{NetworkDmxOutputTargets, UsbDmxOutputTargets};

    use super::*;
    use crate::binding_resolution::{derive_console_addresses, resolve_output_bindings};
    use crate::bindings::{ConsoleDmxAddresses, DmxRange, OutputSource, OutputTarget};
    use crate::fixture::FixtureElement;
    use crate::parameter::{Parameter, ParameterMetadata, ParameterValues};
    use crate::universe::{ConsoleChannelOrigin, dmx_universes, update_transport_map};

    /// Builds an app running binding resolution and DMX universe composition.
    fn pipeline_app() -> App {
        let mut app = App::new();
        app.init_resource::<FixtureDataProviderExt>();
        app.init_resource::<OutputBindings>();
        app.init_resource::<DisabledBindings>();
        app.init_resource::<ConsoleDmxAddresses>();
        app.init_resource::<NetworkDmxOutputTargets>();
        app.init_resource::<UsbDmxOutputTargets>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<UniverseTransportMap>();
        app.init_resource::<ConsoleDmxUniverses>();
        app.add_systems(
            Update,
            (
                derive_console_addresses,
                resolve_output_bindings,
                update_transport_map,
                dmx_universes,
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

    /// Returns a fixture-sourced output binding for `uid` targeting `target`.
    fn fixture_binding(uid: Uuid, target: OutputTarget) -> OutputBinding {
        OutputBinding {
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

    /// Returns a console binding target at one universe and address.
    fn console_target(universe: u16, address: u16) -> OutputTarget {
        OutputTarget::Console {
            universe: Some(DmxRange::single(universe)),
            address: Some(address),
        }
    }

    /// Returns a transport binding target at one universe and address.
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
        build_output_universes(
            world.resource::<ConsoleDmxUniverses>(),
            world.resource::<UniverseTransportMap>(),
            world.resource::<ResolvedInputBindings>(),
            world.resource::<InputDmxUniverses>(),
        )
        .into_iter()
        .map(|view| {
            (
                view.transport.expect("output views carry a label"),
                view.universe_id,
                view.channels,
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
    fn console_only_binding_reports_console_universe() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [255.0, 0.0, 128.0]);
        app.world_mut().resource_mut::<OutputBindings>().bindings =
            vec![fixture_binding(uid, console_target(2, 121))];

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
        app.world_mut().resource_mut::<OutputBindings>().bindings = vec![
            fixture_binding(uid, console_target(2, 121)),
            OutputBinding {
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

    /// Direct fixture-to-transport bindings only appear under their transport with wire
    /// numbering and never populate console space.
    #[test]
    fn direct_transport_binding_reports_only_wire_universe() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [10.0, 20.0, 30.0]);
        app.world_mut().resource_mut::<OutputBindings>().bindings =
            vec![fixture_binding(uid, transport_target("sacn", 1, 5))];

        let views = output_views(&mut app);

        assert_eq!(view_keys(&views), vec![("sACN", 1)]);
        assert_eq!(views[0].2[4..7], [10, 20, 30]);
    }

    /// A disabled output binding for the fixture blocks console-space reporting.
    #[test]
    fn disabled_binding_blocks_console_reporting() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [255.0, 0.0, 0.0]);
        app.world_mut().resource_mut::<OutputBindings>().bindings = vec![
            fixture_binding(uid, console_target(2, 1)),
            fixture_binding(uid, OutputTarget::Disabled),
        ];

        let views = output_views(&mut app);

        assert!(
            views.is_empty(),
            "unexpected views: {:?}",
            view_keys(&views)
        );
    }

    /// Manual channel writes land in console space; a routed transport universe with the same
    /// number keeps showing its own output buffer.
    #[test]
    fn manual_channel_writes_are_console_space() {
        let mut app = pipeline_app();
        let uid = Uuid::new_v4();
        spawn_rgb_fixture(&mut app, uid, 1, [10.0, 20.0, 30.0]);
        app.world_mut().resource_mut::<OutputBindings>().bindings =
            vec![fixture_binding(uid, transport_target("sacn", 1, 5))];
        app.world_mut()
            .resource_mut::<ConsoleDmxUniverses>()
            .set_value(1, 1, 255, ConsoleChannelOrigin::ManualCommand);

        let views = output_views(&mut app);

        assert_eq!(view_keys(&views), vec![("Console", 1), ("sACN", 1)]);
        assert_eq!(views[0].2[0..7], [255, 0, 0, 0, 0, 0, 0]);
        assert_eq!(views[1].2[0..7], [0, 0, 0, 0, 10, 20, 30]);
    }
}
