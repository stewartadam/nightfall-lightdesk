// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Route overlap highlighting for the patch views.
//!
//! Two routes overlap when they write the same destination: the same console universe and
//! address, the same transport universe and address (inputs and outputs included), or the same
//! fixture parameter. Console sources sharing an output transport universe with any other route
//! overlap too. The patch views flag each overlapping route cell and each universe that holds an
//! overlap. Route validation decides which overlaps the show accepts; this report only shows
//! where they are.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::routes::{
    DisabledRoute, DmxRange, InputRoute, InputSource, InputTarget, OutputRoute, OutputSource,
    OutputTarget,
};

/// Universe ranges wider than this are treated as covering every universe.
const MAX_UNIVERSE_RANGE_EXPANSION: u16 = 64;

/// Universes one route touches.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct RouteUniverses {
    /// Universes the route names explicitly, in ascending order.
    pub universes: Vec<u16>,
    /// Whether the route applies to every universe (no universe, or a very wide range) and names
    /// none explicitly.
    pub all: bool,
}

/// Overlap state of one route row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct RouteOverlapEntry {
    /// Universes the route touches.
    pub universes: RouteUniverses,
    /// Whether the route's source cell overlaps another route.
    pub source_conflict: bool,
    /// Whether the route's target cell overlaps another route.
    pub target_conflict: bool,
}

/// Overlap flags for one universe.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct UniverseOverlap {
    /// Universe number, or `None` for routes that apply to every universe.
    pub universe: Option<u16>,
    /// Whether input routes overlap on this universe.
    pub input_overlap: bool,
    /// Whether output routes overlap on this universe.
    pub output_overlap: bool,
}

/// Overlap report for a full set of routes, with one entry per route in the same order as the
/// input, output and disabled route lists.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct RouteOverlapReport {
    /// One entry per input route.
    pub input: Vec<RouteOverlapEntry>,
    /// One entry per output route.
    pub output: Vec<RouteOverlapEntry>,
    /// One entry per disabled route.
    pub disabled: Vec<RouteOverlapEntry>,
    /// Overlap flags for each universe that any route touches, plus a `None` entry when a route
    /// applies to every universe. A universe no route names (one that is only active) shares the
    /// flags of the `None` entry.
    pub universes: Vec<UniverseOverlap>,
}

/// A universe a route registers on: one universe, or every universe.
type UniverseKey = Option<u16>;

/// Which list a route row belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum RouteList {
    Input,
    Output,
    Disabled,
}

/// Which cell of a route row an endpoint is drawn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Column {
    Source,
    Target,
}

/// One cell of one route row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Endpoint {
    list: RouteList,
    index: usize,
    column: Column,
}

/// Endpoints writing one universe, by address, and those writing every address.
#[derive(Debug, Default)]
struct AddressOwners {
    wildcard: Vec<Endpoint>,
    by_address: HashMap<u16, Vec<Endpoint>>,
}

impl AddressOwners {
    /// Returns the endpoints that already write `address`, or any address when it is `None`.
    fn conflicting(&self, address: Option<u16>) -> Vec<Endpoint> {
        let mut owners = self.wildcard.clone();
        match address {
            Some(address) => owners.extend(self.by_address.get(&address).into_iter().flatten()),
            None => owners.extend(self.by_address.values().flatten()),
        }
        owners
    }

    /// Records an endpoint writing `address`, or every address when it is `None`.
    fn push(&mut self, address: Option<u16>, owner: Endpoint) {
        match address {
            Some(address) => self.by_address.entry(address).or_default().push(owner),
            None => self.wildcard.push(owner),
        }
    }
}

/// Input and output endpoints writing one transport universe.
#[derive(Debug, Default)]
struct TransportOwners {
    input: AddressOwners,
    output: AddressOwners,
}

/// Output transport routes on one transport universe, split by whether a console feeds them.
#[derive(Debug, Default)]
struct OutputTransportSources {
    console: Vec<Endpoint>,
    other: Vec<Endpoint>,
}

/// Accumulates overlap state while routes register their destinations.
#[derive(Debug, Default)]
struct OverlapState {
    universes: HashMap<UniverseKey, (bool, bool)>,
    conflicts: HashSet<Endpoint>,
    input_console: HashMap<UniverseKey, AddressOwners>,
    output_console: HashMap<UniverseKey, AddressOwners>,
    fixture_inputs: HashMap<(Uuid, Option<u16>, Option<String>), Vec<Endpoint>>,
    transports: HashMap<(String, UniverseKey), TransportOwners>,
    output_transport_sources: HashMap<(String, UniverseKey), OutputTransportSources>,
}

impl OverlapState {
    /// Flags a universe's input or output overlap, creating its entry if needed.
    fn flag(&mut self, universe: UniverseKey, input: bool, output: bool) {
        let flags = self.universes.entry(universe).or_default();
        flags.0 |= input;
        flags.1 |= output;
    }

    /// Marks every endpoint as overlapping.
    fn mark(&mut self, endpoints: impl IntoIterator<Item = Endpoint>) {
        for endpoint in endpoints {
            self.conflicts.insert(endpoint);
        }
    }

    /// Registers an endpoint on an address table, marking it and every earlier owner of the
    /// same address as overlapping. Returns whether it overlapped.
    fn register_address(
        table: &mut AddressOwners,
        conflicts: &mut HashSet<Endpoint>,
        address: Option<u16>,
        owner: Endpoint,
    ) -> bool {
        let conflicting = table.conflicting(address);
        let overlapped = !conflicting.is_empty();
        if overlapped {
            for endpoint in conflicting.into_iter().chain([owner]) {
                conflicts.insert(endpoint);
            }
        }
        table.push(address, owner);
        overlapped
    }

    /// Registers a console input destination (or a disabled console input).
    fn register_input_console(
        &mut self,
        universe: UniverseKey,
        address: Option<u16>,
        owner: Endpoint,
    ) {
        let table = self.input_console.entry(universe).or_default();
        let overlapped = Self::register_address(table, &mut self.conflicts, address, owner);
        self.flag(universe, overlapped, false);
    }

    /// Registers a console output destination.
    fn register_output_console(
        &mut self,
        universe: UniverseKey,
        address: Option<u16>,
        owner: Endpoint,
    ) {
        let table = self.output_console.entry(universe).or_default();
        let overlapped = Self::register_address(table, &mut self.conflicts, address, owner);
        self.flag(universe, false, overlapped);
    }

    /// Registers an input route writing a fixture parameter.
    fn register_fixture_input(
        &mut self,
        key: (Uuid, Option<u16>, Option<String>),
        owner: Endpoint,
    ) {
        let owners = self.fixture_inputs.entry(key).or_default();
        if !owners.is_empty() {
            for endpoint in owners.iter().copied().chain([owner]) {
                self.conflicts.insert(endpoint);
            }
        }
        owners.push(owner);
    }

    /// Registers an output transport route, flagging a console source that shares the transport
    /// universe with any other route.
    fn register_output_transport_source(
        &mut self,
        universe: UniverseKey,
        transport: &str,
        console_source: bool,
        owner: Endpoint,
    ) {
        let sources = self
            .output_transport_sources
            .entry((transport.to_string(), universe))
            .or_default();
        if console_source {
            sources.console.push(owner);
        } else {
            sources.other.push(owner);
        }
        if !sources.console.is_empty() && (!sources.other.is_empty() || sources.console.len() > 1) {
            let endpoints: Vec<_> = sources
                .console
                .iter()
                .chain(&sources.other)
                .copied()
                .collect();
            self.flag(universe, false, true);
            self.mark(endpoints);
        }
    }

    /// Registers a transport destination, checking same-direction and cross-direction overlap.
    fn register_transport(
        &mut self,
        universe: UniverseKey,
        transport: &str,
        address: Option<u16>,
        input: bool,
        owner: Endpoint,
    ) {
        let owners = self
            .transports
            .entry((transport.to_string(), universe))
            .or_default();
        let (own, other) = if input {
            (&mut owners.input, &owners.output)
        } else {
            (&mut owners.output, &owners.input)
        };
        let cross = other.conflicting(address);
        let same = Self::register_address(own, &mut self.conflicts, address, owner);

        if same {
            self.flag(universe, input, !input);
        }
        if !cross.is_empty() {
            self.flag(universe, false, true);
            self.mark(cross.into_iter().chain([owner]));
        }
    }
}

/// Universes named by a route endpoint's optional universe range: `None` stands for every
/// universe, and an inverted range names none.
fn range_universes(range: Option<DmxRange>) -> Vec<UniverseKey> {
    let Some(range) = range else {
        return vec![None];
    };
    if range.end < range.start {
        return Vec::new();
    }
    if range.end - range.start >= MAX_UNIVERSE_RANGE_EXPANSION {
        return vec![None];
    }
    (range.start..=range.end).map(Some).collect()
}

/// Universes an input route source reads.
fn input_source_universes(source: &InputSource) -> Vec<UniverseKey> {
    match source {
        InputSource::Transport { universe, .. } | InputSource::Console { universe, .. } => {
            range_universes(*universe)
        }
        InputSource::Fixture { .. } => Vec::new(),
    }
}

/// Universes an input route target writes.
fn input_target_universes(target: &InputTarget) -> Vec<UniverseKey> {
    match target {
        InputTarget::Transport { universe, .. } | InputTarget::Console { universe, .. } => {
            range_universes(*universe)
        }
        InputTarget::Fixture { .. } | InputTarget::Disabled => Vec::new(),
    }
}

/// Universes an output route source reads.
fn output_source_universes(source: &OutputSource) -> Vec<UniverseKey> {
    match source {
        OutputSource::Console { universe, .. } => range_universes(*universe),
        OutputSource::Fixture { .. } | OutputSource::FixtureBreak { .. } => Vec::new(),
    }
}

/// Universes an output route target writes.
fn output_target_universes(target: &OutputTarget) -> Vec<UniverseKey> {
    match target {
        OutputTarget::Transport { universe, .. } | OutputTarget::Console { universe, .. } => {
            range_universes(*universe)
        }
    }
}

/// Returns the source of a disabled route.
fn disabled_source(route: &DisabledRoute) -> &InputSource {
    match route {
        DisabledRoute::Input { source, .. } => source,
    }
}

/// The universes a route touches, and the universe keys it registers its destinations on.
struct RouteSpan {
    universes: RouteUniverses,
    keys: Vec<UniverseKey>,
}

impl RouteSpan {
    /// Resolves a route's universes from the keys its endpoints name. Explicit universes win;
    /// otherwise a route on every universe registers on the wildcard and on each known universe.
    fn new(keys: impl IntoIterator<Item = UniverseKey>, known: &BTreeSet<u16>) -> Self {
        let mut all = false;
        let mut explicit = BTreeSet::new();
        for key in keys {
            match key {
                Some(universe) => {
                    explicit.insert(universe);
                }
                None => all = true,
            }
        }
        if !explicit.is_empty() {
            return Self {
                keys: explicit.iter().copied().map(Some).collect(),
                universes: RouteUniverses {
                    universes: explicit.into_iter().collect(),
                    all: false,
                },
            };
        }
        if all {
            return Self {
                keys: [None]
                    .into_iter()
                    .chain(known.iter().copied().map(Some))
                    .collect(),
                universes: RouteUniverses {
                    universes: Vec::new(),
                    all: true,
                },
            };
        }
        Self {
            keys: Vec::new(),
            universes: RouteUniverses::default(),
        }
    }
}

/// Finds which route cells write the same destination as another route, and on which universes.
pub fn route_overlap_report(
    input: &[InputRoute],
    output: &[OutputRoute],
    disabled: &[DisabledRoute],
) -> RouteOverlapReport {
    let known: BTreeSet<u16> = input
        .iter()
        .flat_map(|route| {
            input_source_universes(&route.source)
                .into_iter()
                .chain(input_target_universes(&route.target))
        })
        .chain(output.iter().flat_map(|route| {
            output_source_universes(&route.source)
                .into_iter()
                .chain(output_target_universes(&route.target))
        }))
        .chain(
            disabled
                .iter()
                .flat_map(|route| input_source_universes(disabled_source(route))),
        )
        .flatten()
        .collect();

    let mut state = OverlapState::default();
    let mut spans = Vec::with_capacity(input.len() + output.len() + disabled.len());

    for (index, route) in input.iter().enumerate() {
        let span = RouteSpan::new(
            input_source_universes(&route.source)
                .into_iter()
                .chain(input_target_universes(&route.target)),
            &known,
        );
        let target = Endpoint {
            list: RouteList::Input,
            index,
            column: Column::Target,
        };
        match &route.target {
            InputTarget::Console { address, .. } => {
                for &universe in &span.keys {
                    state.register_input_console(universe, *address, target);
                }
            }
            InputTarget::Transport {
                target: transport,
                address,
                ..
            } => {
                for &universe in &span.keys {
                    state.register_transport(universe, transport, *address, true, target);
                }
            }
            InputTarget::Fixture {
                uids,
                element,
                param,
            } => {
                let source = Endpoint {
                    column: Column::Source,
                    ..target
                };
                for uid in uids {
                    state.register_fixture_input((*uid, *element, param.clone()), source);
                }
            }
            InputTarget::Disabled => {}
        }
        spans.push((RouteList::Input, index, span));
    }

    for (index, route) in output.iter().enumerate() {
        let span = RouteSpan::new(
            output_source_universes(&route.source)
                .into_iter()
                .chain(output_target_universes(&route.target)),
            &known,
        );
        let target = Endpoint {
            list: RouteList::Output,
            index,
            column: Column::Target,
        };
        match &route.target {
            OutputTarget::Console { address, .. } => {
                for &universe in &span.keys {
                    state.register_output_console(universe, *address, target);
                }
            }
            OutputTarget::Transport {
                target: transport,
                address,
                ..
            } => {
                let console_source = matches!(route.source, OutputSource::Console { .. });
                for &universe in &span.keys {
                    state.register_output_transport_source(
                        universe,
                        transport,
                        console_source,
                        target,
                    );
                    state.register_transport(universe, transport, *address, false, target);
                }
            }
        }
        spans.push((RouteList::Output, index, span));
    }

    for (index, route) in disabled.iter().enumerate() {
        let source = disabled_source(route);
        let span = RouteSpan::new(input_source_universes(source), &known);
        if let InputSource::Console { address, .. } = source {
            let endpoint = Endpoint {
                list: RouteList::Disabled,
                index,
                column: Column::Source,
            };
            for &universe in &span.keys {
                state.register_input_console(universe, *address, endpoint);
            }
        }
        spans.push((RouteList::Disabled, index, span));
    }

    for (_, _, span) in &spans {
        for &universe in &span.keys {
            state.flag(universe, false, false);
        }
    }

    let mut report = RouteOverlapReport::default();
    for (list, index, span) in spans {
        let conflict = |column| {
            state.conflicts.contains(&Endpoint {
                list,
                index,
                column,
            })
        };
        let entry = RouteOverlapEntry {
            universes: span.universes,
            source_conflict: conflict(Column::Source),
            target_conflict: conflict(Column::Target),
        };
        match list {
            RouteList::Input => report.input.push(entry),
            RouteList::Output => report.output.push(entry),
            RouteList::Disabled => report.disabled.push(entry),
        }
    }
    report.universes = state
        .universes
        .into_iter()
        .map(
            |(universe, (input_overlap, output_overlap))| UniverseOverlap {
                universe,
                input_overlap,
                output_overlap,
            },
        )
        .collect();
    report.universes.sort_by_key(|entry| entry.universe);
    report
}

#[cfg(test)]
mod tests {
    use nightfall_io::RouteTransport;

    use super::*;

    /// Builds a one-universe range.
    fn single(universe: u16) -> Option<DmxRange> {
        Some(DmxRange::single(universe))
    }

    /// Builds an input route from a transport universe into a transport target.
    fn input_transport(target: &str, universe: u16, address: u16) -> InputRoute {
        InputRoute {
            source: InputSource::Transport {
                transport: RouteTransport::Sacn,
                universe: single(universe),
                address: Some(address),
            },
            target: InputTarget::Transport {
                target: target.into(),
                universe: single(universe),
                address: Some(address),
            },
            priority: 0,
            clone: false,
        }
    }

    /// Builds an input route from a transport universe into a console address.
    fn input_console(source_universe: u16, universe: u16, address: u16) -> InputRoute {
        InputRoute {
            source: InputSource::Transport {
                transport: RouteTransport::Sacn,
                universe: single(source_universe),
                address: Some(1),
            },
            target: InputTarget::Console {
                universe: single(universe),
                address: Some(address),
            },
            priority: 0,
            clone: false,
        }
    }

    /// Builds an input route from a transport universe into a fixture parameter.
    fn input_fixture(source_universe: u16, fixture: Uuid) -> InputRoute {
        InputRoute {
            source: InputSource::Transport {
                transport: RouteTransport::Sacn,
                universe: single(source_universe),
                address: None,
            },
            target: InputTarget::Fixture {
                uids: vec![fixture],
                element: None,
                param: Some("Intensity".into()),
            },
            priority: 0,
            clone: false,
        }
    }

    /// Builds an output route from `source` into a transport universe and address.
    fn output_transport(
        source: OutputSource,
        target: &str,
        universe: u16,
        address: u16,
    ) -> OutputRoute {
        OutputRoute {
            source,
            target: OutputTarget::Transport {
                target: target.into(),
                universe: single(universe),
                address: Some(address),
            },
            priority: 0,
            clone: false,
        }
    }

    /// Builds a fixture output source.
    fn fixture_source(uid: u128) -> OutputSource {
        OutputSource::Fixture {
            uids: vec![Uuid::from_u128(uid)],
            element: None,
            param: None,
        }
    }

    /// Returns the (input, output) overlap flags reported for a universe.
    fn flags(report: &RouteOverlapReport, universe: u16) -> (bool, bool) {
        let entry = report
            .universes
            .iter()
            .find(|entry| entry.universe == Some(universe))
            .expect("universe should be reported");
        (entry.input_overlap, entry.output_overlap)
    }

    /// Returns the (source, target) conflict flags of an entry.
    fn cells(entry: &RouteOverlapEntry) -> (bool, bool) {
        (entry.source_conflict, entry.target_conflict)
    }

    /// An input and an output route writing the same transport address overlap on output.
    #[test]
    fn input_and_output_on_same_transport_address_overlap() {
        let report = route_overlap_report(
            &[input_transport("artnet", 4, 1)],
            &[output_transport(fixture_source(215), "artnet", 4, 1)],
            &[],
        );
        assert_eq!(flags(&report, 4), (false, true));
        assert_eq!(cells(&report.input[0]), (false, true));
        assert_eq!(cells(&report.output[0]), (false, true));
    }

    /// Different transport addresses do not overlap.
    #[test]
    fn different_transport_addresses_do_not_overlap() {
        let report = route_overlap_report(
            &[input_transport("artnet", 4, 1)],
            &[output_transport(fixture_source(215), "artnet", 4, 2)],
            &[],
        );
        assert_eq!(flags(&report, 4), (false, false));
        assert_eq!(cells(&report.input[0]), (false, false));
        assert_eq!(cells(&report.output[0]), (false, false));
    }

    /// Two inputs writing the same transport or console address overlap on input.
    #[test]
    fn duplicate_input_targets_overlap() {
        let report = route_overlap_report(
            &[
                input_transport("artnet", 4, 1),
                input_transport("artnet", 4, 1),
            ],
            &[],
            &[],
        );
        assert_eq!(flags(&report, 4), (true, false));
        assert_eq!(cells(&report.input[0]), (false, true));
        assert_eq!(cells(&report.input[1]), (false, true));

        let report = route_overlap_report(
            &[input_console(1, 50, 5), input_console(2, 50, 5)],
            &[],
            &[],
        );
        assert_eq!(flags(&report, 50), (true, false));
        assert_eq!(cells(&report.input[0]), (false, true));
        assert_eq!(cells(&report.input[1]), (false, true));
    }

    /// Two inputs writing the same fixture parameter flag their source cells.
    #[test]
    fn duplicate_fixture_inputs_flag_sources() {
        let fixture = Uuid::from_u128(311);
        let report = route_overlap_report(
            &[input_fixture(1, fixture), input_fixture(2, fixture)],
            &[],
            &[],
        );
        assert_eq!(cells(&report.input[0]), (true, false));
        assert_eq!(cells(&report.input[1]), (true, false));
    }

    /// Two fixture outputs on the same transport address overlap on output.
    #[test]
    fn duplicate_fixture_outputs_overlap() {
        let report = route_overlap_report(
            &[],
            &[
                output_transport(fixture_source(311), "sacn", 20, 1),
                output_transport(fixture_source(312), "sacn", 20, 1),
            ],
            &[],
        );
        assert_eq!(flags(&report, 20), (false, true));
        assert_eq!(cells(&report.output[0]), (false, true));
        assert_eq!(cells(&report.output[1]), (false, true));
    }

    /// A console output shares its transport universe with no other route, even at a different
    /// address.
    #[test]
    fn console_output_transport_universe_is_exclusive() {
        let report = route_overlap_report(
            &[],
            &[
                output_transport(
                    OutputSource::Console {
                        universe: single(4),
                        address: Some(1),
                    },
                    "artnet",
                    4,
                    1,
                ),
                output_transport(fixture_source(216), "artnet", 4, 50),
            ],
            &[],
        );
        assert!(flags(&report, 4).1);
        assert_eq!(cells(&report.output[0]), (false, true));
        assert_eq!(cells(&report.output[1]), (false, true));
    }

    /// Routes without a universe apply to every universe and register on each known one, and
    /// routes with explicit universes report only those.
    #[test]
    fn route_universes_report_wildcards_and_explicit_ranges() {
        let wildcard = InputRoute {
            source: InputSource::Transport {
                transport: RouteTransport::Sacn,
                universe: None,
                address: None,
            },
            target: InputTarget::Console {
                universe: None,
                address: Some(5),
            },
            ..input_console(1, 1, 5)
        };
        let report = route_overlap_report(&[wildcard, input_console(2, 7, 5)], &[], &[]);
        assert_eq!(
            report.input[1].universes,
            RouteUniverses {
                universes: vec![2, 7],
                all: false
            }
        );
        assert_eq!(
            report.input[0].universes,
            RouteUniverses {
                universes: Vec::new(),
                all: true
            }
        );
        assert_eq!(flags(&report, 7), (true, false));
        assert_eq!(cells(&report.input[0]), (false, true));
    }
}
