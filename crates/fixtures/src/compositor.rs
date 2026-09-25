// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture-backed compositor layers for external and manual parameter assertions.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::command_types::DmxChannelRef;
use nightfall::prelude::{ObjectRef, ObjectType, Priority};
use nightfall_compositor::types::{Layer, ObjectRefMarker, ParameterMap, ParameterRef};
use nightfall_dmx::prelude::{ParameterDmxValue, ParameterValue};
use nightfall_engine::LayerGeneration;
use nightfall_engine::prelude::{
    CommandEnvelope, CommandError, CommandResponder, EngineActionEnvelope,
};
use nightfall_instances::{PlaybackAction, PlaybackScope};

use crate::prelude::{
    ConsoleDmxUniverses, DmxAction, FixtureCommand, InputDmxUniverses, OutputDestination,
    Parameter, ParameterAssertion, ParameterAssertionSource, ResolvedInputBindings,
    ResolvedInputDestination, ResolvedInputSource, ResolvedOutputDestinations,
};
use crate::wire_layout::{combine_dmx_bytes, dmx_max};

/// Priority for the transport input assertion layer.
pub const TRANSPORT_INPUT_LAYER_PRIORITY: Priority = Priority(-128);
/// Priority for the manual channel assertion layer.
pub const MANUAL_ASSERTION_LAYER_PRIORITY: Priority = Priority(-127);

/// Fixture-backed compositor plugin.
pub struct FixtureCompositorPlugin;

impl Plugin for FixtureCompositorPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering FixtureCompositorPlugin");
        app.add_plugins(nightfall_compositor::CompositorPlugin::<Parameter>::default());
        app.add_systems(Startup, spawn_assertion_layers);
        app.add_systems(
            Update,
            (
                clear_unbound_transport_input_assertions
                    .after(crate::binding_resolution::resolve_input_bindings),
                update_manual_assertion_layer,
            )
                .in_set(LayerGeneration),
        );
    }
}

/// Marker for the compositor layer populated from transport input frames.
#[derive(Component)]
pub struct TransportInputLayer;

/// Parameter ownership for assertions populated from transport input frames.
#[derive(Component, Debug, Default, Clone, PartialEq, Eq)]
pub struct TransportInputAssertionOwners {
    /// Source metadata for absolute parameter assertions.
    pub absolute: ParameterMap<ParameterAssertionSource>,
}

/// Marker for the compositor layer populated from manual channel assertions.
#[derive(Component)]
pub struct ManualAssertionLayer;

/// Spawn the persistent compositor-owned assertion layers.
pub fn spawn_assertion_layers(mut commands: Commands) {
    spawn_assertion_layer_entities(&mut commands);
}

/// Queue the persistent compositor-owned assertion layers for spawning.
pub fn spawn_assertion_layer_entities(commands: &mut Commands) {
    commands.queue(spawn_assertion_layer_entities_in_world);
}

/// Spawn the persistent compositor-owned assertion layers directly in a world.
pub fn spawn_assertion_layer_entities_in_world(world: &mut World) {
    world.spawn((
        Layer::new(
            "Transport Input Assertions".to_string(),
            TRANSPORT_INPUT_LAYER_PRIORITY,
        ),
        TransportInputLayer,
        TransportInputAssertionOwners::default(),
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Parameter,
            id: 0,
        }),
    ));

    world.spawn((
        Layer::new(
            "Manual Channel Assertions".to_string(),
            MANUAL_ASSERTION_LAYER_PRIORITY,
        ),
        ManualAssertionLayer,
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Parameter,
            id: 1,
        }),
    ));
}

/// Insert decoded fixture parameter assertions into a compositor layer.
pub(crate) fn apply_parameter_assertions(
    layer: &mut Layer,
    owners: &mut TransportInputAssertionOwners,
    assertions: Vec<ParameterAssertion>,
) {
    for assertion in assertions {
        layer
            .absolute
            .insert(assertion.parameter, (assertion.value, None));
        owners
            .absolute
            .insert(assertion.parameter, assertion.source);
    }
}

/// Remove transport input assertions whose source universe is stale.
pub fn clear_stale_parameter_assertions(
    layer: &mut Layer,
    owners: &mut TransportInputAssertionOwners,
    input_universes: &InputDmxUniverses,
    now: web_time::Instant,
    timeout: std::time::Duration,
) -> usize {
    let timeout_ms = timeout.as_millis() as u32;
    let stale_parameters: Vec<_> = owners
        .absolute
        .iter()
        .filter_map(|(parameter, source)| {
            let frame_age_ms = input_universes.frame_age_ms(source.transport, source.universe, now);
            let is_stale = frame_age_ms.is_none_or(|age_ms| age_ms >= timeout_ms);
            is_stale.then_some(parameter)
        })
        .collect();

    let mut cleared = 0;
    for parameter in stale_parameters {
        owners.absolute.remove(parameter);
        layer.absolute.remove(parameter);
        cleared += 1;
    }

    cleared
}

/// Remove transport input assertions whose resolved input binding target disappeared.
pub fn clear_unbound_parameter_assertions(
    layer: &mut Layer,
    owners: &mut TransportInputAssertionOwners,
    resolved_input_bindings: &ResolvedInputBindings,
) -> usize {
    let unbound_parameters: Vec<_> = owners
        .absolute
        .iter()
        .filter_map(|(parameter, source)| {
            (!resolved_input_binding_owns_parameter(parameter, source, resolved_input_bindings))
                .then_some(parameter)
        })
        .collect();

    let mut cleared = 0;
    for parameter in unbound_parameters {
        owners.absolute.remove(parameter);
        layer.absolute.remove(parameter);
        cleared += 1;
    }

    cleared
}

/// Keep the transport input assertion layer aligned with resolved input bindings.
pub fn clear_unbound_transport_input_assertions(
    resolved_input_bindings: Option<Res<ResolvedInputBindings>>,
    mut layer_query: Query<
        (&mut Layer, &mut TransportInputAssertionOwners),
        With<TransportInputLayer>,
    >,
) {
    let Some(resolved_input_bindings) = resolved_input_bindings else {
        return;
    };

    if !resolved_input_bindings.is_changed() {
        return;
    }

    let Ok((mut layer, mut owners)) = layer_query.single_mut() else {
        return;
    };

    clear_unbound_parameter_assertions(&mut layer, &mut owners, &resolved_input_bindings);
}

/// Return whether a resolved input binding can still drive the parameter assertion.
fn resolved_input_binding_owns_parameter(
    parameter: ParameterRef,
    source: &ParameterAssertionSource,
    resolved_input_bindings: &ResolvedInputBindings,
) -> bool {
    resolved_input_bindings.bindings.iter().any(|binding| {
        let ResolvedInputSource::Transport {
            transport,
            universe,
            ..
        } = binding.source
        else {
            return false;
        };

        transport == source.transport
            && universe == source.universe
            && resolved_input_destination_contains_parameter(&binding.destination, parameter)
    })
}

/// Return whether a resolved input destination contains the asserted parameter.
fn resolved_input_destination_contains_parameter(
    destination: &ResolvedInputDestination,
    parameter: ParameterRef,
) -> bool {
    match destination {
        ResolvedInputDestination::Fixture { targets }
        | ResolvedInputDestination::Console { targets, .. } => targets
            .iter()
            .any(|target| target.entity == parameter.entity()),
        ResolvedInputDestination::Transport { .. } => false,
    }
}

/// Materialize manual DMX channel commands into the manual assertion layer.
pub fn update_manual_assertion_layer(
    mut set_events: MessageReader<CommandEnvelope<FixtureCommand>>,
    mut clear_events: MessageReader<EngineActionEnvelope<crate::undo::ClearDmxChannels>>,
    mut playback_actions: MessageReader<EngineActionEnvelope<PlaybackAction>>,
    mut dmx_actions: MessageReader<EngineActionEnvelope<DmxAction>>,
    mut responder: CommandResponder,
    universes: Res<ConsoleDmxUniverses>,
    destinations_query: Query<(InstanceRef<Parameter>, Option<&ResolvedOutputDestinations>)>,
    mut layer_query: Query<&mut Layer, With<ManualAssertionLayer>>,
) {
    let Ok(mut layer) = layer_query.single_mut() else {
        for event in dmx_actions.read() {
            if let Some(command_id) = event.command_id
                && let Err(error) = responder.fail(
                    command_id,
                    CommandError::new(
                        "fixtures.manual_assertion_layer_missing",
                        "Manual assertion layer is unavailable",
                    ),
                )
            {
                tracing::error!(%command_id, %error, "dmx_release_failure_response_failed");
            }
        }
        return;
    };

    for event in set_events.read() {
        let FixtureCommand::SetDmxChannels { channels, .. } = &event.command else {
            continue;
        };

        for channel in channels.expand() {
            set_manual_assertion_from_channel(
                &channel,
                &universes,
                &destinations_query,
                &mut layer,
            );
        }
    }

    for event in clear_events.read() {
        for channel in event.action.0.channels.expand() {
            remove_manual_assertion_for_channel(&channel, &destinations_query, &mut layer);
        }
    }

    for event in playback_actions.read() {
        if matches!(
            &event.action,
            PlaybackAction::ReleaseParameters {
                scope: PlaybackScope::All
            }
        ) {
            layer.absolute = Default::default();
            layer.relative = Default::default();
        }
    }

    for event in dmx_actions.read() {
        let DmxAction::ReleaseChannels { channels } = &event.action;
        for channel in channels.expand() {
            remove_manual_assertion_for_channel(&channel, &destinations_query, &mut layer);
        }
        if let Some(command_id) = event.command_id
            && let Err(error) = responder.succeed(command_id)
        {
            tracing::error!(%command_id, %error, "dmx_release_success_response_failed");
        }
    }
}

fn set_manual_assertion_from_channel(
    channel: &DmxChannelRef,
    universes: &ConsoleDmxUniverses,
    destinations_query: &Query<(InstanceRef<Parameter>, Option<&ResolvedOutputDestinations>)>,
    layer: &mut Layer,
) {
    for (parameter, destinations) in destinations_query.iter() {
        let Some(destination) = matching_destination(channel, destinations) else {
            continue;
        };

        let dmx_value = dmx_value_from_universe(universes, destination);
        let value = dmx_value_to_parameter_value(dmx_value, &parameter.metadata);
        layer.absolute.insert(
            parameter.instance(),
            (ParameterValue::Absolute { value }, None),
        );
    }
}

/// Remove manual assertions for parameters mapped to the selected DMX channel.
fn remove_manual_assertion_for_channel(
    channel: &DmxChannelRef,
    destinations_query: &Query<(InstanceRef<Parameter>, Option<&ResolvedOutputDestinations>)>,
    layer: &mut Layer,
) {
    for (parameter, destinations) in destinations_query.iter() {
        if matching_destination(channel, destinations).is_some() {
            layer.absolute.remove(parameter.instance());
            layer.relative.remove(parameter.instance());
        }
    }
}

/// Finds the destination whose bytes include the selected console channel.
fn matching_destination<'a>(
    channel: &DmxChannelRef,
    destinations: Option<&'a ResolvedOutputDestinations>,
) -> Option<&'a OutputDestination> {
    destinations?.destinations.iter().find(|destination| {
        destination.universe == channel.universe && destination.addresses.contains(&channel.address)
    })
}

/// Reads a destination's bytes from the console universe and combines them into a DMX integer.
fn dmx_value_from_universe(
    universes: &ConsoleDmxUniverses,
    destination: &OutputDestination,
) -> u32 {
    combine_dmx_bytes(destination.addresses.iter().map(|address| {
        universes
            .get_value(destination.universe, *address)
            .unwrap_or(0)
    }))
}

/// Maps a DMX integer to the parameter's logical value range.
fn dmx_value_to_parameter_value(
    dmx_value: u32,
    metadata: &crate::prelude::ParameterMetadata,
) -> ParameterDmxValue {
    let dmx_max = dmx_max(metadata.resolution) as ParameterDmxValue;
    let normalized = (dmx_value as ParameterDmxValue / dmx_max).clamp(0.0, 1.0);
    let min = metadata.logical_min();
    let max = metadata.logical_max();
    min + normalized * (max - min)
}

#[cfg(test)]
mod tests {
    use nightfall_dmx::prelude::{
        Attribute, DmxValueResolution, ParameterUnit, ParameterValuePolarity,
    };
    use nightfall_io::BindingTransport;

    use super::*;
    use crate::prelude::{ResolvedInputBinding, ResolvedInputTarget};

    /// Verifies manual DMX channel assertions decode signed pan/tilt around the midpoint.
    #[test]
    fn manual_dmx_decoding_uses_signed_logical_bounds() {
        let metadata = crate::prelude::ParameterMetadata {
            attribute: Attribute::Pan,
            native_unit: ParameterUnit::Degrees,
            value_polarity: ParameterValuePolarity::Signed,
            max: 540.0,
            resolution: DmxValueResolution::Coarse,
            ..Default::default()
        };

        assert_eq!(dmx_value_to_parameter_value(0, &metadata), -270.0);
        assert_eq!(dmx_value_to_parameter_value(255, &metadata), 270.0);
        assert!((dmx_value_to_parameter_value(128, &metadata) - 1.0588).abs() < 0.001);
    }

    /// Verifies removed input patch targets are cleared from the transport assertion layer.
    #[test]
    fn clear_unbound_parameter_assertions_removes_removed_input_patch_targets() {
        let mut world = World::new();
        let kept_parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let removed_parameter =
            unsafe { Instance::<Parameter>::from_entity_unchecked(world.spawn_empty().id()) };
        let source = ParameterAssertionSource {
            transport: BindingTransport::Sacn,
            universe: 1,
        };
        let mut layer = Layer::new(
            "test transport input".to_string(),
            TRANSPORT_INPUT_LAYER_PRIORITY,
        );
        let mut owners = TransportInputAssertionOwners::default();

        for parameter in [kept_parameter, removed_parameter] {
            layer
                .absolute
                .insert(parameter, (ParameterValue::Absolute { value: 1.0 }, None));
            owners.absolute.insert(parameter, source);
        }

        let resolved_input_bindings = ResolvedInputBindings {
            bindings: vec![ResolvedInputBinding {
                source: ResolvedInputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: 1,
                    address: 1,
                },
                priority: 0,
                destination: ResolvedInputDestination::Fixture {
                    targets: vec![ResolvedInputTarget {
                        entity: kept_parameter.entity(),
                        offsets: vec![0],
                    }],
                },
            }],
        };

        let cleared =
            clear_unbound_parameter_assertions(&mut layer, &mut owners, &resolved_input_bindings);

        assert_eq!(cleared, 1);
        assert!(layer.absolute.contains_key(&kept_parameter));
        assert!(owners.absolute.contains_key(&kept_parameter));
        assert!(!layer.absolute.contains_key(&removed_parameter));
        assert!(!owners.absolute.contains_key(&removed_parameter));
    }
}
