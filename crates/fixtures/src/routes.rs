// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Route declarations and resolved caches for DMX routes.

use std::collections::HashMap;

use bevy_ecs::prelude::{Component, Entity, Resource};
use nightfall::prelude::SpatialSelection;
use nightfall_io::OutputTransport;
use nightfall_io::RouteTransport;
use nightfall_selection::{HeldReference, ReferenceSource};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Inclusive DMX range for universes or addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct DmxRange {
    /// Inclusive start value.
    pub start: u16,
    /// Inclusive end value.
    pub end: u16,
}

impl DmxRange {
    /// Returns a single-value range.
    pub fn single(value: u16) -> Self {
        Self {
            start: value,
            end: value,
        }
    }
}

/// Route declarations for input rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InputRoute {
    /// Route source.
    pub source: InputSource,
    /// Route target.
    pub target: InputTarget,
    /// Priority; when routes conflict, the higher value wins and ties go to the earlier route.
    pub priority: i32,
    /// If true, duplicate the source address across a range destination.
    pub clone: bool,
}

/// Route declarations for output rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OutputRoute {
    /// Route source.
    pub source: OutputSource,
    /// Route target.
    pub target: OutputTarget,
    /// Priority; when routes conflict, the higher value wins and ties go to the earlier route.
    pub priority: i32,
    /// If true, fixtures sharing a target universe all start at the target address instead of
    /// being packed one after another.
    pub clone: bool,
}

/// Reports the output transport target of a transport route.
impl ReferenceSource for OutputRoute {
    fn visit_references(&self, visit: &mut dyn FnMut(&str, HeldReference<'_>)) {
        if let OutputTarget::Transport { target, .. } = &self.target {
            visit("target.target", HeldReference::OutputTarget(target));
        }
    }

    fn visit_selections_mut(&mut self, _visit: &mut dyn FnMut(&mut SpatialSelection)) {}
}

/// Input route source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InputSource {
    /// Transport input (sACN/Art-Net/uDMX).
    Transport {
        /// Transport identifier.
        transport: RouteTransport,
        /// Optional universe range.
        universe: Option<DmxRange>,
        /// Optional address.
        address: Option<u16>,
    },
    /// Console input.
    Console {
        /// Optional universe range.
        universe: Option<DmxRange>,
        /// Optional address.
        address: Option<u16>,
    },
    /// Fixture input.
    Fixture {
        /// Fixture UIDs.
        uids: Vec<Uuid>,
        /// Optional element index.
        element: Option<u16>,
        /// Optional parameter name.
        param: Option<String>,
    },
}

/// Input route target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InputTarget {
    /// Transport target.
    Transport {
        /// Output transport target identifier.
        target: String,
        /// Optional universe range.
        universe: Option<DmxRange>,
        /// Optional address.
        address: Option<u16>,
    },
    /// Console target.
    Console {
        /// Optional universe range.
        universe: Option<DmxRange>,
        /// Optional address.
        address: Option<u16>,
    },
    /// Fixture target.
    Fixture {
        /// Fixture UIDs.
        uids: Vec<Uuid>,
        /// Optional element index.
        element: Option<u16>,
        /// Optional parameter name.
        param: Option<String>,
    },
    /// Disabled target (filter).
    Disabled,
}

/// Output route source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum OutputSource {
    /// Fixture source.
    Fixture {
        /// Fixture UIDs.
        uids: Vec<Uuid>,
        /// Optional element index.
        element: Option<u16>,
        /// Optional parameter name.
        param: Option<String>,
    },
    /// An additional DMX break (2 or higher) of fixtures, patched as a whole.
    ///
    /// Profiles such as a lamp plus scroller place some channels on a second
    /// break with its own start address; `Fixture` sources carry break 1.
    FixtureBreak {
        /// Fixture UIDs.
        uids: Vec<Uuid>,
        /// DMX break number.
        dmx_break: u16,
    },
    /// Console source.
    Console {
        /// Optional universe range.
        universe: Option<DmxRange>,
        /// Optional address.
        address: Option<u16>,
    },
}

/// Fixtures, and the part of each fixture, addressed by a fixture output source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixtureOutputSelection<'a> {
    /// Fixture UIDs in patch order.
    pub uids: &'a [Uuid],
    /// Optional element index.
    pub element: Option<u16>,
    /// Optional parameter name.
    pub param: Option<&'a str>,
    /// DMX break whose parameters are patched.
    pub dmx_break: u16,
}

impl OutputSource {
    /// Returns the fixture selection of a `Fixture` or `FixtureBreak` source.
    ///
    /// `Fixture` sources address the primary break 1.
    pub fn fixture_selection(&self) -> Option<FixtureOutputSelection<'_>> {
        match self {
            OutputSource::Fixture {
                uids,
                element,
                param,
            } => Some(FixtureOutputSelection {
                uids,
                element: *element,
                param: param.as_deref(),
                dmx_break: 1,
            }),
            OutputSource::FixtureBreak { uids, dmx_break } => Some(FixtureOutputSelection {
                uids,
                element: None,
                param: None,
                dmx_break: *dmx_break,
            }),
            OutputSource::Console { .. } => None,
        }
    }

    /// Returns the fixture UIDs a fixture source patches, or `None` for console sources.
    pub fn fixture_uids(&self) -> Option<&[Uuid]> {
        self.fixture_selection().map(|selection| selection.uids)
    }
}

/// Output route target.
///
/// A fixture source patched to a universe range puts its Nth fixture in the Nth universe of
/// the range, each at the target address, and packs every fixture past the end of the range
/// into its last universe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum OutputTarget {
    /// Transport target.
    Transport {
        /// Output transport target identifier.
        target: String,
        /// Optional universe range.
        universe: Option<DmxRange>,
        /// Optional address.
        address: Option<u16>,
    },
    /// Console target.
    Console {
        /// Optional universe range.
        universe: Option<DmxRange>,
        /// Optional address.
        address: Option<u16>,
    },
}

/// Disabled route filter rule.
///
/// Only inputs can be disabled: an output that should not be sent is simply
/// left unbound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum DisabledRoute {
    /// Disable input routes that match the source.
    Input {
        /// Route source to disable.
        source: InputSource,
        /// Priority (lower runs first).
        priority: i32,
        /// If true, duplicate the source address across a range destination.
        clone: bool,
    },
}

/// Resource collection for input routes.
#[derive(Debug, Default, Clone, Resource)]
pub struct InputRoutes {
    /// Route declarations.
    pub routes: Vec<InputRoute>,
}

/// Resource collection for output routes.
#[derive(Debug, Default, Clone, Resource)]
pub struct OutputRoutes {
    /// Route declarations.
    pub routes: Vec<OutputRoute>,
}

/// Resource collection for disabled route filters.
#[derive(Debug, Default, Clone, Resource)]
pub struct DisabledRoutes {
    /// Disabled route declarations.
    pub routes: Vec<DisabledRoute>,
}

/// Drops the fixture UIDs rejected by `keep` from `uids`.
///
/// Returns whether the list still names at least one fixture. Sets `changed` when a UID was
/// dropped.
fn retain_uids(uids: &mut Vec<Uuid>, keep: &impl Fn(&Uuid) -> bool, changed: &mut bool) -> bool {
    let before = uids.len();
    uids.retain(keep);
    *changed |= uids.len() != before;
    !uids.is_empty()
}

impl InputSource {
    /// Drops rejected fixtures from a fixture source and returns whether the source still
    /// addresses anything; non-fixture sources are left untouched.
    fn retain_fixtures(&mut self, keep: &impl Fn(&Uuid) -> bool, changed: &mut bool) -> bool {
        match self {
            InputSource::Fixture { uids, .. } => retain_uids(uids, keep, changed),
            InputSource::Transport { .. } | InputSource::Console { .. } => true,
        }
    }
}

impl InputTarget {
    /// Drops rejected fixtures from a fixture target and returns whether the target still
    /// addresses anything; non-fixture targets are left untouched.
    fn retain_fixtures(&mut self, keep: &impl Fn(&Uuid) -> bool, changed: &mut bool) -> bool {
        match self {
            InputTarget::Fixture { uids, .. } => retain_uids(uids, keep, changed),
            InputTarget::Transport { .. } | InputTarget::Console { .. } | InputTarget::Disabled => {
                true
            }
        }
    }
}

impl OutputSource {
    /// Drops rejected fixtures from a fixture source and returns whether the source still
    /// addresses anything; console sources are left untouched.
    fn retain_fixtures(&mut self, keep: &impl Fn(&Uuid) -> bool, changed: &mut bool) -> bool {
        match self {
            OutputSource::Fixture { uids, .. } | OutputSource::FixtureBreak { uids, .. } => {
                retain_uids(uids, keep, changed)
            }
            OutputSource::Console { .. } => true,
        }
    }
}

/// Removes every fixture rejected by `keep` from the DMX routes.
///
/// A route that patches several fixtures keeps the remaining ones, so later fixtures in a
/// packed route move up to fill the gap. A route left without any fixture on one of its ends
/// is removed. Returns whether any route changed.
pub fn retain_route_fixtures(
    input: &mut InputRoutes,
    output: &mut OutputRoutes,
    disabled: &mut DisabledRoutes,
    keep: impl Fn(&Uuid) -> bool,
) -> bool {
    let mut changed = false;
    input.routes.retain_mut(|route| {
        let source = route.source.retain_fixtures(&keep, &mut changed);
        let target = route.target.retain_fixtures(&keep, &mut changed);
        source && target
    });
    output
        .routes
        .retain_mut(|route| route.source.retain_fixtures(&keep, &mut changed));
    disabled.routes.retain_mut(|route| {
        let DisabledRoute::Input { source, .. } = route;
        source.retain_fixtures(&keep, &mut changed)
    });
    changed
}

/// Resolved input route source for per-frame processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedInputSource {
    /// Transport input resolved to a concrete universe/address.
    Transport {
        /// Transport identifier.
        transport: RouteTransport,
        /// Universe number.
        universe: u16,
        /// Address number.
        address: u16,
    },
    /// Console input resolved to a concrete universe/address.
    Console {
        /// Universe number.
        universe: u16,
        /// Address number.
        address: u16,
    },
    /// Fixture input resolved to a specific fixture UID.
    Fixture {
        /// Fixture UID.
        uid: Uuid,
        /// Optional element index.
        element: Option<u16>,
        /// Optional parameter name.
        param: Option<String>,
    },
}

/// Resolved target for an input route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInputTarget {
    /// Target entity.
    pub entity: Entity,
    /// Channel offset of every byte into the source address, most significant first.
    pub offsets: Vec<u16>,
}

/// Resolved console target metadata for input->console mappings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConsoleTarget {
    /// Target console universe.
    pub universe: u16,
    /// Target base address.
    pub address: u16,
}

/// Resolved transport target metadata for input->transport mappings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTransportTarget {
    /// Output transport target identifier.
    pub target: String,
    /// Target physical protocol.
    pub protocol: RouteTransport,
    /// Target output transport settings.
    pub transport: OutputTransport,
    /// Target universe.
    pub universe: u16,
    /// Target base address.
    pub address: u16,
}

/// Resolved destination for an input route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedInputDestination {
    /// Fixture parameter targets.
    Fixture {
        /// Resolved targets for this route.
        targets: Vec<ResolvedInputTarget>,
    },
    /// Console universe/address mapping, optionally with fixture parameter targets.
    Console {
        /// Console mapping target.
        target: ResolvedConsoleTarget,
        /// Resolved targets for this route.
        targets: Vec<ResolvedInputTarget>,
    },
    /// Transport universe/address mapping.
    Transport {
        /// Transport mapping target.
        target: ResolvedTransportTarget,
    },
}

/// Resolved input route for per-frame processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInputRoute {
    /// Resolved source.
    pub source: ResolvedInputSource,
    /// Priority; when routes write the same destination, the higher value wins.
    pub priority: i32,
    /// Resolved destination.
    pub destination: ResolvedInputDestination,
}

/// Resource cache of resolved input routes.
#[derive(Debug, Default, Clone, Resource)]
pub struct ResolvedInputRoutes {
    /// Resolved routes in precedence order: highest priority first, with equal priorities in
    /// authoring order. Consumers that keep the first write to a destination iterate this
    /// directly; consumers that overwrite use [`Self::iter_overlay_order`].
    pub routes: Vec<ResolvedInputRoute>,
}

impl ResolvedInputRoutes {
    /// Iterates routes lowest precedence first, so a consumer that copies each route's data
    /// over the previous one leaves the highest-priority (then earliest-authored) route's data
    /// in place.
    pub fn iter_overlay_order(&self) -> impl Iterator<Item = &ResolvedInputRoute> {
        self.routes.iter().rev()
    }

    /// Returns the precedence (position in [`Self::routes`], lower wins) of the strongest route
    /// fed by `transport` universe `universe` for which `drives` holds, or `None` when no route
    /// from that source qualifies.
    pub fn transport_source_precedence(
        &self,
        transport: RouteTransport,
        universe: u16,
        drives: impl Fn(&ResolvedInputRoute) -> bool,
    ) -> Option<usize> {
        self.routes.iter().position(|route| {
            matches!(
                route.source,
                ResolvedInputSource::Transport {
                    transport: source_transport,
                    universe: source_universe,
                    ..
                } if source_transport == transport && source_universe == universe
            ) && drives(route)
        })
    }
}

/// Destination for output processing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OutputDestination {
    /// Output transport.
    pub transport: OutputTransport,
    /// Output universe.
    pub universe: u16,
    /// Output address of every byte, most significant first.
    pub addresses: Vec<u16>,
}

/// Component storing resolved output destinations for a fixture or parameter.
#[derive(Debug, Default, Clone, Component, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ResolvedOutputDestinations {
    /// Output destinations in evaluation order.
    pub destinations: Vec<OutputDestination>,
}

/// Component storing the console-space DMX address of one parameter.
///
/// Mirrors [`ConsoleDmxAddresses::parameters`]. `None` when no active console route
/// covers the parameter.
#[derive(Debug, Default, Clone, PartialEq, Eq, Component)]
pub struct ResolvedConsoleDestination {
    /// Console universe and per-byte addresses of the parameter, when console-bound.
    pub address: Option<ConsoleParameterAddress>,
}

/// Console-space placement of one parameter's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleParameterAddress {
    /// Console universe.
    pub universe: u16,
    /// 1-indexed console address of every byte, most significant first.
    pub addresses: Vec<u16>,
}

/// Console DMX address mapping for a fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ConsoleDmxAddress {
    /// Console universe.
    pub universe: u16,
    /// Console address.
    pub address: u16,
}

/// Resource mapping fixtures and parameters to their console DMX addresses.
#[derive(Debug, Default, Clone, Resource)]
pub struct ConsoleDmxAddresses {
    /// Map of fixture UID to the first console address of its bound footprint.
    pub addresses: HashMap<Uuid, ConsoleDmxAddress>,
    /// Map of parameter entity to the console addresses of its bytes.
    ///
    /// Only parameters selected by the winning console route's element/parameter filter
    /// occupy console channels, placed by the selection's wire layout in DMX order.
    pub parameters: HashMap<Entity, ConsoleParameterAddress>,
}

impl ConsoleDmxAddresses {
    /// Clears fixture and parameter console addresses.
    pub fn clear(&mut self) {
        self.addresses.clear();
        self.parameters.clear();
    }

    /// Returns the sorted, deduplicated console universes occupied by bound parameters.
    pub fn universes(&self) -> Vec<u16> {
        let mut universes: Vec<u16> = self
            .parameters
            .values()
            .map(|address| address.universe)
            .collect();
        universes.sort_unstable();
        universes.dedup();
        universes
    }
}
