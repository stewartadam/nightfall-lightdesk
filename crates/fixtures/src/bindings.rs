// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Binding declarations and resolved caches for patch bindings.

use std::collections::HashMap;

use bevy_ecs::prelude::{Component, Entity, Resource};
use nightfall_io::BindingTransport;
use nightfall_io::OutputTransport;
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

/// Binding declarations for input rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InputBinding {
    /// Binding source.
    pub source: InputSource,
    /// Binding target.
    pub target: InputTarget,
    /// Priority; when bindings conflict, the higher value wins and ties go to the earlier binding.
    pub priority: i32,
    /// If true, duplicate the source address across a range destination.
    pub clone: bool,
}

/// Binding declarations for output rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct OutputBinding {
    /// Binding source.
    pub source: OutputSource,
    /// Binding target.
    pub target: OutputTarget,
    /// Priority; when bindings conflict, the higher value wins and ties go to the earlier binding.
    pub priority: i32,
    /// If true, fixtures sharing a target universe all start at the target address instead of
    /// being packed one after another.
    pub clone: bool,
}

/// Input binding source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InputSource {
    /// Transport input (sACN/Art-Net/uDMX).
    Transport {
        /// Transport identifier.
        transport: BindingTransport,
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

/// Input binding target.
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

/// Output binding source.
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

/// Output binding target.
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

/// Disabled binding filter rule.
///
/// Only inputs can be disabled: an output that should not be sent is simply
/// left unbound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum DisabledBinding {
    /// Disable input bindings that match the source.
    Input {
        /// Binding source to disable.
        source: InputSource,
        /// Priority (lower runs first).
        priority: i32,
        /// If true, duplicate the source address across a range destination.
        clone: bool,
    },
}

/// Resource collection for input bindings.
#[derive(Debug, Default, Clone, Resource)]
pub struct InputBindings {
    /// Binding declarations.
    pub bindings: Vec<InputBinding>,
}

/// Resource collection for output bindings.
#[derive(Debug, Default, Clone, Resource)]
pub struct OutputBindings {
    /// Binding declarations.
    pub bindings: Vec<OutputBinding>,
}

/// Resource collection for disabled binding filters.
#[derive(Debug, Default, Clone, Resource)]
pub struct DisabledBindings {
    /// Disabled binding declarations.
    pub bindings: Vec<DisabledBinding>,
}

/// Resolved input binding source for per-frame processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedInputSource {
    /// Transport input resolved to a concrete universe/address.
    Transport {
        /// Transport identifier.
        transport: BindingTransport,
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

/// Resolved target for an input binding.
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
    pub protocol: BindingTransport,
    /// Target output transport settings.
    pub transport: OutputTransport,
    /// Target universe.
    pub universe: u16,
    /// Target base address.
    pub address: u16,
}

/// Resolved destination for an input binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedInputDestination {
    /// Fixture parameter targets.
    Fixture {
        /// Resolved targets for this binding.
        targets: Vec<ResolvedInputTarget>,
    },
    /// Console universe/address mapping, optionally with fixture parameter targets.
    Console {
        /// Console mapping target.
        target: ResolvedConsoleTarget,
        /// Resolved targets for this binding.
        targets: Vec<ResolvedInputTarget>,
    },
    /// Transport universe/address mapping.
    Transport {
        /// Transport mapping target.
        target: ResolvedTransportTarget,
    },
}

/// Resolved input binding for per-frame processing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInputBinding {
    /// Resolved source.
    pub source: ResolvedInputSource,
    /// Priority; when bindings write the same destination, the higher value wins.
    pub priority: i32,
    /// Resolved destination.
    pub destination: ResolvedInputDestination,
}

/// Resource cache of resolved input bindings.
#[derive(Debug, Default, Clone, Resource)]
pub struct ResolvedInputBindings {
    /// Resolved bindings in precedence order: highest priority first, with equal priorities in
    /// authoring order. Consumers that keep the first write to a destination iterate this
    /// directly; consumers that overwrite use [`Self::iter_overlay_order`].
    pub bindings: Vec<ResolvedInputBinding>,
}

impl ResolvedInputBindings {
    /// Iterates bindings lowest precedence first, so a consumer that copies each binding's data
    /// over the previous one leaves the highest-priority (then earliest-authored) binding's data
    /// in place.
    pub fn iter_overlay_order(&self) -> impl Iterator<Item = &ResolvedInputBinding> {
        self.bindings.iter().rev()
    }

    /// Returns the precedence (position in [`Self::bindings`], lower wins) of the strongest binding
    /// fed by `transport` universe `universe` for which `drives` holds, or `None` when no binding
    /// from that source qualifies.
    pub fn transport_source_precedence(
        &self,
        transport: BindingTransport,
        universe: u16,
        drives: impl Fn(&ResolvedInputBinding) -> bool,
    ) -> Option<usize> {
        self.bindings.iter().position(|binding| {
            matches!(
                binding.source,
                ResolvedInputSource::Transport {
                    transport: source_transport,
                    universe: source_universe,
                    ..
                } if source_transport == transport && source_universe == universe
            ) && drives(binding)
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
/// Mirrors [`ConsoleDmxAddresses::parameters`]. `None` when no active console binding
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
    /// Only parameters selected by the winning console binding's element/parameter filter
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
