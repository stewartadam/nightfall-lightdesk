// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared input frame application for transport-based bindings.

use std::collections::HashSet;

use bevy_app::prelude::*;
use bevy_ecs::{prelude::*, system::SystemParam};
use moonshine_kind::prelude::*;
use nightfall_compositor::types::Layer;
use nightfall_dmx::prelude::{MAX_CHANNELS_PER_UNIVERSE, ParameterDmxValue, ParameterValue};
use nightfall_engine::LayerGeneration;
use nightfall_io::BindingTransport;
use nightfall_io::{AcceptedDmxFrame, DmxInputSet};
use web_time::Instant;

use crate::compositor::apply_parameter_assertions;
use crate::prelude::*;
use crate::wire_layout::{combine_dmx_bytes, dmx_max};

/// Registers same-update consumption of frames accepted by IO adapters.
pub struct TransportInputPlugin;

impl Plugin for TransportInputPlugin {
    /// Orders routing after adapter ingress and binding resolution, before compositing.
    fn build(&self, app: &mut App) {
        app.add_message::<AcceptedDmxFrame>();
        app.init_resource::<ResolvedInputBindings>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ConsoleDmxUniverses>();
        app.configure_sets(
            Update,
            (DmxInputSet::Ingress, DmxInputSet::Apply)
                .chain()
                .in_set(LayerGeneration),
        );
        app.add_systems(
            Update,
            apply_accepted_frames
                .in_set(DmxInputSet::Apply)
                .after(crate::binding_resolution::resolve_input_bindings)
                .after(crate::compositor::clear_unbound_transport_input_assertions),
        );
    }
}

/// Fixture routing state needed to apply an accepted transport frame.
#[derive(SystemParam)]
struct TransportInputRouting<'w, 's> {
    bindings: Res<'w, ResolvedInputBindings>,
    input_universes: ResMut<'w, InputDmxUniverses>,
    console_universes: ResMut<'w, ConsoleDmxUniverses>,
    parameters: Query<'w, 's, InstanceRef<'static, Parameter>>,
    layers: Query<
        'w,
        's,
        (
            &'static mut Layer,
            &'static mut TransportInputAssertionOwners,
        ),
        With<TransportInputLayer>,
    >,
}

/// Applies accepted frames in publication order without replacing their receive timestamps.
fn apply_accepted_frames(
    mut frames: MessageReader<AcceptedDmxFrame>,
    mut routing: TransportInputRouting,
) {
    let mut input_layer = routing.layers.single_mut().ok();
    for frame in frames.read() {
        let assertions = apply_transport_input_frame(
            &routing.bindings,
            frame.transport,
            frame.universe,
            &frame.data,
            frame.received_at,
            frame.is_self_frame,
            &mut routing.input_universes,
            &mut routing.console_universes,
            &routing.parameters,
        );
        if let Some((layer, owners)) = input_layer.as_mut() {
            apply_parameter_assertions(layer, owners, assertions);
        }
    }
}

/// A fixture parameter value asserted by an input frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParameterAssertion {
    /// Parameter receiving the asserted value.
    pub parameter: Instance<Parameter>,
    /// Absolute parameter value decoded from DMX input.
    pub value: ParameterValue,
    /// Transport source that produced this assertion.
    pub source: ParameterAssertionSource,
}

/// Transport source metadata for an input-driven parameter assertion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParameterAssertionSource {
    /// Transport protocol that delivered the input frame.
    pub transport: BindingTransport,
    /// Input universe that delivered the input frame.
    pub universe: u16,
}

/// Applies one transport input frame to bound parameter targets and console input mapping.
fn apply_transport_input_frame(
    resolved_input_bindings: &ResolvedInputBindings,
    transport: BindingTransport,
    universe_id: u16,
    data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
    received_at: Instant,
    is_self_frame: bool,
    input_universes: &mut InputDmxUniverses,
    universes: &mut ConsoleDmxUniverses,
    parameter_query: &Query<InstanceRef<Parameter>>,
) -> Vec<ParameterAssertion> {
    input_universes.set_universe_with_self_flag(
        transport,
        universe_id,
        *data,
        received_at,
        is_self_frame,
    );

    let mut updated_targets = HashSet::new();
    let mut updated_console_channels = HashSet::new();
    let mut assertions = Vec::new();
    let source_origin = ConsoleChannelOrigin::InputTransport {
        transport,
        universe: universe_id,
    };
    let assertion_source = ParameterAssertionSource {
        transport,
        universe: universe_id,
    };

    for binding in &resolved_input_bindings.bindings {
        let ResolvedInputSource::Transport {
            transport: binding_transport,
            universe,
            address,
        } = &binding.source
        else {
            continue;
        };

        if *binding_transport != transport || *universe != universe_id {
            continue;
        }

        match &binding.destination {
            ResolvedInputDestination::Fixture { targets } => {
                apply_parameter_targets(
                    targets,
                    *address,
                    data,
                    parameter_query,
                    assertion_source,
                    &mut updated_targets,
                    &mut assertions,
                );
            }
            ResolvedInputDestination::Console {
                target: console_target,
                targets,
            } => {
                apply_console_input_mapping(
                    universes,
                    data,
                    *address,
                    console_target,
                    source_origin,
                    &mut updated_console_channels,
                );
                apply_parameter_targets(
                    targets,
                    *address,
                    data,
                    parameter_query,
                    assertion_source,
                    &mut updated_targets,
                    &mut assertions,
                );
            }
            ResolvedInputDestination::Transport {
                target: transport_target,
            } => {
                apply_transport_input_mapping(input_universes, data, *address, transport_target);
            }
        }
    }

    assertions
}

/// Decodes each bound parameter once, retaining the first resolved binding for a target.
fn apply_parameter_targets(
    targets: &[ResolvedInputTarget],
    source_base_address: u16,
    data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
    parameter_query: &Query<InstanceRef<Parameter>>,
    source: ParameterAssertionSource,
    updated_targets: &mut HashSet<Entity>,
    assertions: &mut Vec<ParameterAssertion>,
) {
    for target in targets {
        if updated_targets.contains(&target.entity) {
            continue;
        }

        let Ok(parameter) = parameter_query.get(target.entity) else {
            continue;
        };

        let dmx_value = dmx_value_from_frame(data, source_base_address, &target.offsets);
        let parameter_value = dmx_value_to_parameter_value(dmx_value, &parameter.metadata);
        assertions.push(ParameterAssertion {
            parameter: parameter.instance(),
            value: parameter_value,
            source,
        });
        updated_targets.insert(target.entity);
    }
}

/// Copies source transport DMX values into mapped transport universe channels.
fn apply_transport_input_mapping(
    input_universes: &mut InputDmxUniverses,
    source_data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
    source_address: u16,
    transport_target: &ResolvedTransportTarget,
) {
    if source_address == 0 || transport_target.address == 0 {
        return;
    }

    let source_start = (source_address - 1) as usize;
    let target_start = (transport_target.address - 1) as usize;

    if source_start >= MAX_CHANNELS_PER_UNIVERSE || target_start >= MAX_CHANNELS_PER_UNIVERSE {
        return;
    }

    let copy_len =
        (MAX_CHANNELS_PER_UNIVERSE - source_start).min(MAX_CHANNELS_PER_UNIVERSE - target_start);

    let target =
        input_universes.get_universe_mut(transport_target.protocol, transport_target.universe);

    for offset in 0..copy_len {
        let source_idx = source_start + offset;
        let target_idx = target_start + offset;
        target[target_idx] = source_data[source_idx];
    }
}

/// Copies source transport DMX values into mapped console universe channels once per channel.
fn apply_console_input_mapping(
    universes: &mut ConsoleDmxUniverses,
    source_data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
    source_address: u16,
    console_target: &ResolvedConsoleTarget,
    source_origin: ConsoleChannelOrigin,
    updated_console_channels: &mut HashSet<(u16, u16)>,
) {
    if source_address == 0 || console_target.address == 0 {
        return;
    }

    let source_start = (source_address - 1) as usize;
    let target_start = (console_target.address - 1) as usize;

    if source_start >= MAX_CHANNELS_PER_UNIVERSE || target_start >= MAX_CHANNELS_PER_UNIVERSE {
        return;
    }

    let copy_len =
        (MAX_CHANNELS_PER_UNIVERSE - source_start).min(MAX_CHANNELS_PER_UNIVERSE - target_start);

    for offset in 0..copy_len {
        let source_idx = source_start + offset;
        let target_address = (target_start + offset + 1) as u16;
        if updated_console_channels.insert((console_target.universe, target_address)) {
            universes.set_value(
                console_target.universe,
                target_address,
                source_data[source_idx],
                source_origin,
            );
        }
    }
}

/// Reads a DMX value from a frame, combining the bytes at `base_address + offset` for each offset.
///
/// Base address `0` is treated as invalid and returns `0.0`. Missing bytes at frame edges
/// are treated as `0`.
fn dmx_value_from_frame(
    data: &[u8; MAX_CHANNELS_PER_UNIVERSE],
    base_address: u16,
    offsets: &[u16],
) -> ParameterDmxValue {
    if base_address == 0 {
        return 0.0;
    }

    let base_idx = (base_address - 1) as usize;
    combine_dmx_bytes(
        offsets
            .iter()
            .map(|offset| data.get(base_idx + *offset as usize).copied().unwrap_or(0)),
    ) as ParameterDmxValue
}

/// Converts a raw DMX value into a percent-based absolute parameter value.
fn dmx_value_to_parameter_value(
    dmx_value: ParameterDmxValue,
    metadata: &ParameterMetadata,
) -> ParameterValue {
    let dmx_max = dmx_max(metadata.resolution) as ParameterDmxValue;
    let normalized = (dmx_value / dmx_max).clamp(0.0, 1.0);
    let min = metadata.logical_min();
    let max = metadata.logical_max();
    let range = max - min;
    let absolute = (min + normalized * range).clamp(min, max);
    metadata.parameter_value_as_absolute_percent(&ParameterValue::Absolute { value: absolute })
}

#[cfg(test)]
mod tests {
    use nightfall_dmx::prelude::{Attribute, DmxValueResolution, ParameterValuePolarity};

    use super::*;

    /// Builds parameter metadata for input DMX conversion tests.
    fn metadata(value_polarity: ParameterValuePolarity) -> ParameterMetadata {
        ParameterMetadata {
            attribute: Attribute::Pan,
            value_polarity,
            max: 540.0,
            resolution: DmxValueResolution::Coarse,
            ..Default::default()
        }
    }

    /// Verifies unsigned input DMX assertions are represented as absolute percentages.
    #[test]
    fn input_dmx_conversion_uses_unsigned_absolute_percent() {
        assert_eq!(
            dmx_value_to_parameter_value(127.5, &metadata(ParameterValuePolarity::Unsigned)),
            ParameterValue::AbsolutePercent { value: 0.5.into() }
        );
    }

    /// Verifies signed input DMX assertions preserve the signed percentage domain.
    #[test]
    fn input_dmx_conversion_uses_signed_absolute_percent() {
        assert_eq!(
            dmx_value_to_parameter_value(127.5, &metadata(ParameterValuePolarity::Signed)),
            ParameterValue::AbsolutePercent { value: 0.0.into() }
        );
    }
}
