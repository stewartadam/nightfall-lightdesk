// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Composes the DMX frames sent on the wire.
//!
//! Output bindings and input passthrough bindings resolve into an [`OutputRouting`] plan
//! keyed by concrete transport and on-the-wire universe. Every engine frame,
//! [`compose_output_frames`] turns that plan into [`OutputDmxFrames`], the single source
//! that output drivers transmit, the DMX universe panel reports, and metrics count.
//!
//! A wire frame is composed in this order, later sources overwriting earlier ones:
//! 1. written channels of console universe windows routed by console→transport bindings
//!    (with remapping), later bindings winning where windows overlap;
//! 2. direct fixture→transport output buffer channels;
//! 3. transport input windows routed by input passthrough bindings.
//!
//! Console space never reaches the wire unless a console→transport binding routes it.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_io::{ArtNetDelivery, BindingTransport, OutputTransport, SacnDelivery};

use crate::bindings::{ResolvedInputBindings, ResolvedInputDestination, ResolvedInputSource};
use crate::universe::{ConsoleDmxUniverses, InputDmxUniverses};

/// Concrete output transport and on-the-wire universe identifying one output frame.
pub type OutputFrameKey = (OutputTransport, u16);

/// Copies source channels from `source_address` onward to target channels from
/// `target_address` onward (1-indexed), truncated at the end of either universe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelWindow {
    /// First source channel copied.
    pub source_address: u16,
    /// Target channel receiving `source_address`.
    pub target_address: u16,
}

impl ChannelWindow {
    /// Returns the 0-indexed source start, target start, and channel count of the window
    /// for buffers of the given lengths, or `None` when the window is empty.
    pub fn span(&self, source_len: usize, target_len: usize) -> Option<(usize, usize, usize)> {
        if self.source_address == 0 || self.target_address == 0 {
            return None;
        }
        let source_start = (self.source_address - 1) as usize;
        let target_start = (self.target_address - 1) as usize;
        if source_start >= source_len || target_start >= target_len {
            return None;
        }
        let len = (source_len - source_start).min(target_len - target_start);
        Some((source_start, target_start, len))
    }

    /// Copies the window from `source` onto `target`.
    pub fn overlay(&self, source: &[ChannelDmxValue], target: &mut [ChannelDmxValue]) {
        let Some((source_start, target_start, len)) = self.span(source.len(), target.len()) else {
            return;
        };
        target[target_start..target_start + len]
            .copy_from_slice(&source[source_start..source_start + len]);
    }
}

/// Console universe window routed onto a wire frame by a console→transport binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConsoleWindowRoute {
    /// Console universe supplying the window.
    pub console_universe: u16,
    /// Source (console) and target (wire) addresses.
    pub window: ChannelWindow,
}

/// Transport input window routed onto a wire frame by an input passthrough binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputWindowRoute {
    /// Input transport supplying the window.
    pub transport: BindingTransport,
    /// Input universe supplying the window.
    pub universe: u16,
    /// Source (input) and target (wire) addresses.
    pub window: ChannelWindow,
}

/// Output-binding sources feeding one wire frame.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutputBindingRoute {
    /// Console windows routed by console→transport bindings, in binding priority order.
    pub console_windows: Vec<ConsoleWindowRoute>,
    /// Whether fixture→transport bindings write this frame's direct output buffer.
    pub direct: bool,
}

/// Routing plan describing which wire frames exist and what feeds them.
///
/// Output-binding routes are replaced by output binding resolution and input routes by
/// input binding resolution; both only change when bindings change.
#[derive(Resource, Debug, Default)]
pub struct OutputRouting {
    output_routes: HashMap<OutputFrameKey, OutputBindingRoute>,
    input_routes: HashMap<OutputFrameKey, Vec<InputWindowRoute>>,
    ordered_keys: Vec<OutputFrameKey>,
}

impl OutputRouting {
    /// Replaces the routes produced by output bindings.
    pub fn set_output_routes(&mut self, routes: HashMap<OutputFrameKey, OutputBindingRoute>) {
        self.output_routes = routes;
        self.reorder();
    }

    /// Replaces the routes produced by transport input passthrough bindings.
    pub fn set_input_routes(&mut self, routes: HashMap<OutputFrameKey, Vec<InputWindowRoute>>) {
        self.input_routes = routes;
        self.reorder();
    }

    /// Returns every routed frame key in deterministic transmit order.
    pub fn keys(&self) -> &[OutputFrameKey] {
        &self.ordered_keys
    }

    /// Returns the output-binding route for one frame, if any.
    pub fn output_route(&self, key: &OutputFrameKey) -> Option<&OutputBindingRoute> {
        self.output_routes.get(key)
    }

    /// Returns the input passthrough windows for one frame.
    pub fn input_routes(&self, key: &OutputFrameKey) -> &[InputWindowRoute] {
        self.input_routes.get(key).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Clears every route.
    pub fn clear(&mut self) {
        self.output_routes.clear();
        self.input_routes.clear();
        self.ordered_keys.clear();
    }

    /// Recomputes the deterministic union of routed frame keys.
    fn reorder(&mut self) {
        let mut keys: Vec<OutputFrameKey> = self
            .output_routes
            .keys()
            .chain(self.input_routes.keys())
            .cloned()
            .collect();
        keys.sort_by_cached_key(|(transport, universe)| {
            (output_transport_sort_key(transport), *universe)
        });
        keys.dedup();
        self.ordered_keys = keys;
    }
}

/// One composed wire frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputDmxFrame {
    /// Concrete transport the frame is sent on.
    pub transport: OutputTransport,
    /// On-the-wire universe number.
    pub universe: u16,
    /// Channel values.
    pub channels: [ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE],
}

/// Wire frames composed for the current engine frame, in deterministic transmit order.
#[derive(Resource, Debug, Default)]
pub struct OutputDmxFrames {
    frames: Vec<OutputDmxFrame>,
}

impl OutputDmxFrames {
    /// Iterates every composed frame.
    pub fn iter(&self) -> impl Iterator<Item = &OutputDmxFrame> {
        self.frames.iter()
    }

    /// Returns the number of composed frames.
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// Returns whether no frame was composed.
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// Returns the composed frame for one transport and wire universe.
    pub fn get(&self, transport: &OutputTransport, universe: u16) -> Option<&OutputDmxFrame> {
        self.frames
            .iter()
            .find(|frame| frame.universe == universe && &frame.transport == transport)
    }

    /// Replaces the composed frames.
    pub fn set(&mut self, frames: Vec<OutputDmxFrame>) {
        self.frames = frames;
    }
}

/// Composes one wire frame from its routes; returns `None` when no source has data yet.
fn compose_frame(
    key: &OutputFrameKey,
    routing: &OutputRouting,
    console: &ConsoleDmxUniverses,
    inputs: &InputDmxUniverses,
) -> Option<[ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE]> {
    let (transport, universe) = key;
    let mut channels = [0; MAX_CHANNELS_PER_UNIVERSE];
    let mut has_data = false;

    if let Some(route) = routing.output_route(key) {
        for console_window in &route.console_windows {
            has_data |= console.overlay_console_window(
                console_window.console_universe,
                console_window.window,
                &mut channels,
            );
        }
        if route.direct {
            has_data |= console.overlay_output_universe(transport, *universe, &mut channels);
        }
    }

    for input_window in routing.input_routes(key) {
        if let Some(source) = inputs.universe(input_window.transport, input_window.universe) {
            input_window.window.overlay(source, &mut channels);
            has_data = true;
        }
    }

    has_data.then_some(channels)
}

/// Composes every routed wire frame for this engine frame.
pub fn compose_output_frames(
    routing: Res<OutputRouting>,
    console: Res<ConsoleDmxUniverses>,
    inputs: Res<InputDmxUniverses>,
    mut frames: ResMut<OutputDmxFrames>,
) {
    let composed = routing
        .keys()
        .iter()
        .filter_map(|key| {
            compose_frame(key, &routing, &console, &inputs).map(|channels| OutputDmxFrame {
                transport: key.0.clone(),
                universe: key.1,
                channels,
            })
        })
        .collect();
    frames.set(composed);
}

/// Rebuilds input passthrough routes when resolved input bindings change.
pub fn update_input_routing(
    resolved_input_bindings: Res<ResolvedInputBindings>,
    mut routing: ResMut<OutputRouting>,
) {
    if !resolved_input_bindings.is_changed() {
        return;
    }

    let mut routes: HashMap<OutputFrameKey, Vec<InputWindowRoute>> = HashMap::new();
    for binding in &resolved_input_bindings.bindings {
        let ResolvedInputSource::Transport {
            transport,
            universe,
            address,
        } = &binding.source
        else {
            continue;
        };
        let ResolvedInputDestination::Transport { target } = &binding.destination else {
            continue;
        };
        if matches!(target.transport, OutputTransport::Disabled) {
            continue;
        }
        routes
            .entry((target.transport.clone(), target.universe))
            .or_default()
            .push(InputWindowRoute {
                transport: *transport,
                universe: *universe,
                window: ChannelWindow {
                    source_address: *address,
                    target_address: target.address,
                },
            });
    }
    routing.set_input_routes(routes);
}

/// Orders transports as sACN, Art-Net, USB, then by delivery details.
fn output_transport_sort_key(transport: &OutputTransport) -> (u8, String) {
    match transport {
        OutputTransport::Sacn { mode } => (0, format!("{mode:?}")),
        OutputTransport::ArtNet { mode } => (1, format!("{mode:?}")),
        OutputTransport::Udmx { device } => (2, device.clone()),
        OutputTransport::Disabled => (3, String::new()),
    }
}

/// Returns the operator-facing label of one concrete output transport.
///
/// Default deliveries use the bare family name (`sACN`, `Art-Net`, `USB`); unicast and
/// named devices append their destination so each concrete transport has a unique label.
pub fn output_transport_label(transport: &OutputTransport) -> String {
    match transport {
        OutputTransport::Sacn {
            mode: SacnDelivery::Multicast,
        } => "sACN".to_string(),
        OutputTransport::Sacn {
            mode: SacnDelivery::Unicast { ip },
        } => format!("sACN → {ip}"),
        OutputTransport::ArtNet {
            mode: ArtNetDelivery::Broadcast,
        } => "Art-Net".to_string(),
        OutputTransport::ArtNet {
            mode: ArtNetDelivery::Unicast { ip },
        } => format!("Art-Net → {ip}"),
        OutputTransport::Udmx { device }
            if device == nightfall_io::DEFAULT_USB_DMX_DEVICE_SELECTOR =>
        {
            "USB".to_string()
        }
        OutputTransport::Udmx { device } => format!("USB ({device})"),
        OutputTransport::Disabled => "Disabled".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use bevy_app::{App, Update};
    use web_time::Instant;

    use super::*;
    use crate::bindings::{ResolvedInputBinding, ResolvedTransportTarget};
    use crate::universe::ConsoleChannelOrigin;

    /// Multicast sACN transport used across composition tests.
    fn sacn() -> OutputTransport {
        OutputTransport::Sacn {
            mode: SacnDelivery::Multicast,
        }
    }

    /// Builds an app composing frames from manually seeded routing and buffers.
    fn compose_app() -> App {
        let mut app = App::new();
        app.init_resource::<OutputRouting>();
        app.init_resource::<OutputDmxFrames>();
        app.init_resource::<ConsoleDmxUniverses>();
        app.init_resource::<InputDmxUniverses>();
        app.init_resource::<ResolvedInputBindings>();
        app.add_systems(
            Update,
            (update_input_routing, compose_output_frames).chain(),
        );
        app
    }

    /// Returns the composed frame for one transport and universe after an update.
    fn composed(app: &mut App, transport: &OutputTransport, universe: u16) -> Option<Vec<u8>> {
        app.update();
        app.world()
            .resource::<OutputDmxFrames>()
            .get(transport, universe)
            .map(|frame| frame.channels.to_vec())
    }

    /// Console values never leak onto a wire universe with the same number unless routed:
    /// a passthrough-only sACN 1 frame carries only its input window, not console universe 1.
    #[test]
    fn unrouted_console_universe_does_not_reach_wire() {
        let mut app = compose_app();
        app.world_mut()
            .resource_mut::<ConsoleDmxUniverses>()
            .set_value(1, 1, 42, ConsoleChannelOrigin::OutputBinding);
        let mut input = [0; MAX_CHANNELS_PER_UNIVERSE];
        input[1] = 9;
        app.world_mut()
            .resource_mut::<InputDmxUniverses>()
            .set_universe(BindingTransport::ArtNet, 3, input, Instant::now());
        app.world_mut()
            .resource_mut::<ResolvedInputBindings>()
            .bindings = vec![ResolvedInputBinding {
            source: ResolvedInputSource::Transport {
                transport: BindingTransport::ArtNet,
                universe: 3,
                address: 1,
            },
            priority: 0,
            destination: ResolvedInputDestination::Transport {
                target: ResolvedTransportTarget {
                    target: "sacn".to_string(),
                    protocol: BindingTransport::Sacn,
                    transport: sacn(),
                    universe: 1,
                    address: 1,
                },
            },
        }];

        let frame = composed(&mut app, &sacn(), 1).expect("passthrough frame is composed");

        assert_eq!(frame[0..2], [0, 9]);
    }

    /// A console window route copies console universe 1 onto wire universe 10 at the
    /// remapped address, and direct fixture output overlays it.
    #[test]
    fn console_window_route_remaps_and_direct_output_overlays() {
        let mut app = compose_app();
        {
            let mut console = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            console.set_values(1, 1, &[1, 2, 3], ConsoleChannelOrigin::OutputBinding);
            console.set_output_values(&sacn(), 10, 12, &[99], ConsoleChannelOrigin::OutputBinding);
        }
        app.world_mut()
            .resource_mut::<OutputRouting>()
            .set_output_routes(HashMap::from([(
                (sacn(), 10),
                OutputBindingRoute {
                    console_windows: vec![ConsoleWindowRoute {
                        console_universe: 1,
                        window: ChannelWindow {
                            source_address: 1,
                            target_address: 11,
                        },
                    }],
                    direct: true,
                },
            )]));

        let frame = composed(&mut app, &sacn(), 10).expect("routed frame is composed");

        assert_eq!(frame[10..14], [1, 99, 3, 0]);
        assert!(composed(&mut app, &sacn(), 1).is_none());
    }

    /// Unicast and multicast frames on the same universe are composed separately.
    #[test]
    fn frames_are_composed_per_concrete_transport() {
        let mut app = compose_app();
        let unicast = OutputTransport::Sacn {
            mode: SacnDelivery::Unicast {
                ip: Ipv4Addr::new(10, 0, 0, 4),
            },
        };
        {
            let mut console = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
            console.set_output_values(&sacn(), 1, 1, &[5], ConsoleChannelOrigin::OutputBinding);
            console.set_output_values(&unicast, 1, 2, &[6], ConsoleChannelOrigin::OutputBinding);
        }
        let direct = OutputBindingRoute {
            console_windows: Vec::new(),
            direct: true,
        };
        app.world_mut()
            .resource_mut::<OutputRouting>()
            .set_output_routes(HashMap::from([
                ((sacn(), 1), direct.clone()),
                ((unicast.clone(), 1), direct),
            ]));

        assert_eq!(composed(&mut app, &sacn(), 1).unwrap()[0..2], [5, 0]);
        assert_eq!(composed(&mut app, &unicast, 1).unwrap()[0..2], [0, 6]);
        assert_eq!(output_transport_label(&unicast), "sACN → 10.0.0.4");
    }
}
