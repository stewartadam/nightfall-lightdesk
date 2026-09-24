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
    pub transports: Vec<String>,
    pub io_mode: DmxIoMode,
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

/// Last time droppable websocket data was sent (ms since epoch)
static LAST_DROPPABLE_SEND_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const DROPPABLE_INTERVAL_MS: u64 = (1000.0 / 10.0) as u64;
/// Mapping from console universe data to a transport-specific passthrough output.
#[derive(Debug, Clone, Copy)]
struct TransportPassthroughMapping {
    source_transport: BindingTransport,
    source_universe: u16,
    source_address: u16,
    target_address: u16,
}

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

    let mut data = Vec::new();

    let binding_transport_label = |transport: BindingTransport| match transport {
        BindingTransport::Sacn => "sACN".to_string(),
        BindingTransport::ArtNet => "Art-Net".to_string(),
        BindingTransport::Udmx => "USB".to_string(),
    };

    let output_transport_label = |transport: &OutputTransport| match transport {
        OutputTransport::Disabled => "Disabled".to_string(),
        OutputTransport::Sacn { .. } => "sACN".to_string(),
        OutputTransport::Udmx { .. } => "USB".to_string(),
        OutputTransport::ArtNet { .. } => "Art-Net".to_string(),
    };
    let mut input_values_by_transport_universe: HashMap<(BindingTransport, u16), Vec<u8>> =
        HashMap::new();
    for (transport, universe_id, channels) in input_universes.iter() {
        input_values_by_transport_universe.insert((transport, universe_id), channels.to_vec());
    }

    let available_input_sources: HashSet<(BindingTransport, u16)> =
        input_values_by_transport_universe.keys().copied().collect();
    let mut passthrough_mappings_by_universe: HashMap<u16, Vec<TransportPassthroughMapping>> =
        HashMap::new();
    for binding in &resolved_input_bindings.bindings {
        let ResolvedInputSource::Transport {
            transport: source_transport,
            universe: source_universe,
            address: source_address,
        } = &binding.source
        else {
            continue;
        };
        let ResolvedInputDestination::Transport { target } = &binding.destination else {
            continue;
        };
        passthrough_mappings_by_universe
            .entry(target.universe)
            .or_default()
            .push(TransportPassthroughMapping {
                source_transport: *source_transport,
                source_universe: *source_universe,
                source_address: *source_address,
                target_address: target.address,
            });
    }

    let mut universe_ids: HashSet<u16> = dmx_universes.universe_ids().copied().collect();
    universe_ids.extend(transport_map.universes());
    universe_ids.extend(passthrough_mappings_by_universe.keys().copied());
    let mut universe_ids: Vec<u16> = universe_ids.into_iter().collect();
    universe_ids.sort_unstable();

    for universe_id in universe_ids {
        let mut channels = if dmx_universes.has_universe(universe_id) {
            dmx_universes.get_universe(universe_id).to_vec()
        } else {
            vec![0; nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE]
        };
        let mut has_channels = dmx_universes.has_universe(universe_id);

        if let Some(passthrough_mappings) = passthrough_mappings_by_universe.get(&universe_id) {
            for mapping in passthrough_mappings {
                if !available_input_sources
                    .contains(&(mapping.source_transport, mapping.source_universe))
                {
                    continue;
                }
                let Some(source_channels) = input_values_by_transport_universe
                    .get(&(mapping.source_transport, mapping.source_universe))
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
        }

        if !has_channels {
            continue;
        }

        let transports: Vec<String> = transport_map
            .transports_for_universe(universe_id)
            .map(output_transport_label)
            .collect();

        let universe = OutboundDmxUniverse {
            universe_id,
            channels,
            transports,
            io_mode: DmxIoMode::Output,
            transport: None,
            frame_age_ms: None,
            is_stale: None,
            is_self: None,
        };
        data.push(universe);
    }

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
            transports: Vec::new(),
            io_mode: DmxIoMode::Input,
            transport: Some(binding_transport_label(transport)),
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

    let binding_transport_label = |transport: BindingTransport| match transport {
        BindingTransport::Sacn => "sACN".to_string(),
        BindingTransport::ArtNet => "Art-Net".to_string(),
        BindingTransport::Udmx => "USB".to_string(),
    };

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
                transport: binding_transport_label(*transport),
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
    send_fixtures(&fixture_data_provider, &broadcaster, |fixture| {
        geometry_provider
            .as_ref()
            .and_then(|p| p.get_geometry(fixture))
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
