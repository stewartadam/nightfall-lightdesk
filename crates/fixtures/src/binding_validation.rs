// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Binding validation rules for patch bindings.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::fmt;
use std::ops::RangeInclusive;
use std::str::FromStr;

use bevy_ecs::change_detection::DetectChanges;
use bevy_ecs::prelude::{Res, Resource};
use nightfall_dmx::prelude::*;
use nightfall_fixture_model::prelude::*;
use nightfall_io::BindingTransport;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::binding_resolution::{FixturePatchLayout, output_bindings_in_overlay_order};
use crate::bindings::{
    DmxRange, FixtureOutputSelection, InputBindings, InputSource, InputTarget, OutputBindings,
    OutputSource, OutputTarget,
};
use crate::data_provider_ext::FixtureDataProviderExt;
use crate::fixture::{Fixture, FixtureLayout};
use crate::prelude::DisabledBindings;
use crate::wire_layout::WireLayout;

/// Last channel of a DMX universe, as an absolute 1-based address.
const LAST_CHANNEL: u32 = MAX_CHANNELS_PER_UNIVERSE as u32;

/// Validation mode for binding overlaps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[derive(Default)]
pub enum BindingValidationMode {
    /// Enforce all overlap rules.
    #[default]
    Strict,
    /// Allow overlaps except for console address uniqueness.
    Permissive,
}

/// Resource settings for binding validation.
#[derive(Debug, Clone, Resource, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BindingValidationSettings {
    /// Validation mode.
    pub mode: BindingValidationMode,
}

impl Default for BindingValidationSettings {
    fn default() -> Self {
        Self {
            mode: BindingValidationMode::Strict,
        }
    }
}

/// Validation issue found while processing bindings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingValidationIssue {
    /// Human-readable message.
    pub message: String,
    /// Fixture UIDs involved in the issue (best-effort).
    pub involved_fixtures: Vec<Uuid>,
}

impl fmt::Display for BindingValidationIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl BindingValidationIssue {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            involved_fixtures: Vec::new(),
        }
    }

    fn for_fixtures(message: impl Into<String>, fixtures: impl IntoIterator<Item = Uuid>) -> Self {
        let mut involved_fixtures: Vec<Uuid> = fixtures.into_iter().collect();
        involved_fixtures.sort_unstable();
        involved_fixtures.dedup();
        Self {
            message: message.into(),
            involved_fixtures,
        }
    }

    /// Returns true if this issue is known to involve the given fixture UID.
    pub fn involves_fixture(&self, fixture_uid: Uuid) -> bool {
        self.involved_fixtures.contains(&fixture_uid)
    }
}

/// Validate bindings against strict/permissive rules.
pub fn validate_bindings(
    settings: &BindingValidationSettings,
    input_bindings: &InputBindings,
    output_bindings: &OutputBindings,
    _disabled_bindings: &DisabledBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<BindingValidationIssue> {
    let mut issues = Vec::new();

    issues.extend(validate_fixture_to_fixture_shapes(
        input_bindings,
        data_provider,
    ));
    issues.extend(validate_console_patch(output_bindings, data_provider));
    issues.extend(validate_transport_universe_bounds(
        output_bindings,
        data_provider,
    ));

    if settings.mode == BindingValidationMode::Strict {
        issues.extend(validate_input_transport_console_priorities(input_bindings));
        issues.extend(validate_transport_address_uniqueness(
            input_bindings,
            output_bindings,
            data_provider,
        ));
        issues.extend(validate_console_transport_exclusivity(
            output_bindings,
            data_provider,
        ));
    }

    issues
}

/// Bevy system to validate bindings when bindings change.
pub fn validate_bindings_on_change(
    settings: Res<BindingValidationSettings>,
    input_bindings: Res<InputBindings>,
    output_bindings: Res<OutputBindings>,
    disabled_bindings: Res<DisabledBindings>,
    data_provider: Res<FixtureDataProviderExt>,
) {
    if !settings.is_changed()
        && !input_bindings.is_changed()
        && !output_bindings.is_changed()
        && !disabled_bindings.is_changed()
    {
        return;
    }

    let issues = validate_bindings(
        &settings,
        &input_bindings,
        &output_bindings,
        &disabled_bindings,
        &data_provider,
    );

    for issue in issues {
        tracing::warn!("Binding validation: {}", issue);
    }
}

fn validate_fixture_to_fixture_shapes(
    input_bindings: &InputBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<BindingValidationIssue> {
    let mut issues = Vec::new();

    for binding in &input_bindings.bindings {
        let (
            InputSource::Fixture {
                uids: source_uids,
                element: source_element,
                param: source_param,
            },
            InputTarget::Fixture {
                uids: target_uids,
                element: target_element,
                param: target_param,
            },
        ) = (&binding.source, &binding.target)
        else {
            continue;
        };

        if binding.clone && source_uids.len() != 1 {
            issues.push(BindingValidationIssue::new(format!(
                "Fixture-to-fixture clone requires a single source fixture, found {}",
                source_uids.len()
            )));
            continue;
        }

        if !binding.clone && source_uids.len() != target_uids.len() {
            issues.push(BindingValidationIssue::new(format!(
                "Fixture-to-fixture binding requires equal selection lengths (source {}, target {})",
                source_uids.len(),
                target_uids.len()
            )));
            continue;
        }

        let source_shapes = source_uids
            .iter()
            .map(|uid| {
                fixture_shape_for_binding(
                    data_provider,
                    *uid,
                    *source_element,
                    source_param.as_deref(),
                )
            })
            .collect::<Vec<_>>();

        let target_shapes = target_uids
            .iter()
            .map(|uid| {
                fixture_shape_for_binding(
                    data_provider,
                    *uid,
                    *target_element,
                    target_param.as_deref(),
                )
            })
            .collect::<Vec<_>>();

        if source_shapes.iter().any(|shape| shape.is_err())
            || target_shapes.iter().any(|shape| shape.is_err())
        {
            for shape in source_shapes.into_iter().chain(target_shapes) {
                if let Err(issue) = shape {
                    issues.push(issue);
                }
            }
            continue;
        }

        if binding.clone {
            let source_shape = source_shapes[0].as_ref().unwrap();
            for (idx, target_shape) in target_shapes.iter().enumerate() {
                let target_shape = target_shape.as_ref().unwrap();
                if !source_shape.matches(target_shape) {
                    issues.push(BindingValidationIssue::for_fixtures(
                        format!(
                            "Fixture-to-fixture shape mismatch between source {} and target {}",
                            source_uids[0], target_uids[idx]
                        ),
                        [source_uids[0], target_uids[idx]],
                    ));
                }
            }
        } else {
            for idx in 0..source_uids.len() {
                let source_shape = source_shapes[idx].as_ref().unwrap();
                let target_shape = target_shapes[idx].as_ref().unwrap();
                if !source_shape.matches(target_shape) {
                    issues.push(BindingValidationIssue::for_fixtures(
                        format!(
                            "Fixture-to-fixture shape mismatch between source {} and target {}",
                            source_uids[idx], target_uids[idx]
                        ),
                        [source_uids[idx], target_uids[idx]],
                    ));
                }
            }
        }
    }

    issues
}

/// Validates the console patch: addresses claimed by more than one fixture parameter, and
/// fixtures that run past the last channel of a console universe.
///
/// Only the addresses output actually uses are checked: a fixture parameter patched to the
/// console by several bindings keeps just the address of the winning binding, and bytes past
/// the end of a universe are reported as an overrun rather than as overlaps.
fn validate_console_patch(
    output_bindings: &OutputBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<BindingValidationIssue> {
    let (placements, mut issues) = effective_console_placements(output_bindings, data_provider);
    let mut occupancy: HashMap<(u16, u32), &ConsoleParameterPlacement> = HashMap::new();
    let mut overruns: Vec<(Uuid, u32, u16, RangeInclusive<u32>)> = Vec::new();
    let mut overrun_index: HashMap<(Uuid, u16), usize> = HashMap::new();

    for placement in &placements {
        for &addr in &placement.addresses {
            if addr > LAST_CHANNEL {
                let key = (placement.fixture, placement.universe);
                match overrun_index.entry(key) {
                    Entry::Occupied(index) => {
                        let span = &mut overruns[*index.get()].3;
                        *span = (*span.start()).min(*placement.channels.start())
                            ..=(*span.end()).max(*placement.channels.end());
                    }
                    Entry::Vacant(slot) => {
                        slot.insert(overruns.len());
                        overruns.push((
                            placement.fixture,
                            placement.fixture_id,
                            placement.universe,
                            placement.channels.clone(),
                        ));
                    }
                }
                continue;
            }
            match occupancy.entry((placement.universe, addr)) {
                Entry::Occupied(existing) => {
                    let existing = *existing.get();
                    if existing.fixture != placement.fixture {
                        issues.push(BindingValidationIssue::for_fixtures(
                            format!(
                                "Console address overlap at universe {} address {} (fixtures {} and {})",
                                placement.universe, addr, existing.fixture, placement.fixture
                            ),
                            [existing.fixture, placement.fixture],
                        ));
                    } else if existing.parameter != placement.parameter {
                        issues.push(BindingValidationIssue::for_fixtures(
                            format!(
                                "Console address overlap at universe {} address {} (two parameters of fixture {})",
                                placement.universe, addr, placement.fixture_id
                            ),
                            [placement.fixture],
                        ));
                    }
                }
                Entry::Vacant(slot) => {
                    slot.insert(placement);
                }
            }
        }
    }

    issues.extend(
        overruns
            .into_iter()
            .map(|(fixture, fixture_id, universe, channels)| {
                universe_overrun_issue(
                    fixture,
                    fixture_id,
                    &format!("console universe {universe}"),
                    &channels,
                )
            }),
    );
    issues
}

/// Console addresses of one fixture parameter, as placed by the binding that wins it.
#[derive(Debug, Clone)]
struct ConsoleParameterPlacement {
    fixture: Uuid,
    fixture_id: u32,
    /// Fixture element index and parameter index of the placed parameter.
    parameter: (usize, usize),
    universe: u16,
    /// Absolute addresses of the parameter's bytes, which may run past the universe.
    addresses: Vec<u32>,
    /// Channels spanned by the whole selection the winning binding placed with it.
    channels: RangeInclusive<u32>,
}
/// Resolves the console address of every fixture parameter the way output does.
///
/// Fixture→console bindings apply in overlay order and a later binding replaces the address
/// of each parameter it selects, so the highest-priority, earliest-authored binding wins.
/// Placements come back in a stable order; fixtures whose selection cannot be laid out are
/// returned as issues.
fn effective_console_placements(
    output_bindings: &OutputBindings,
    data_provider: &FixtureDataProviderExt,
) -> (Vec<ConsoleParameterPlacement>, Vec<BindingValidationIssue>) {
    let mut placements: Vec<Option<ConsoleParameterPlacement>> = Vec::new();
    let mut winners: HashMap<(Uuid, usize, usize), usize> = HashMap::new();
    let mut issues = Vec::new();

    for binding in output_bindings_in_overlay_order(output_bindings) {
        let (source @ OutputSource::Fixture { .. }, OutputTarget::Console { universe, address }) =
            (&binding.source, &binding.target)
        else {
            continue;
        };
        let Some(selection) = source.fixture_selection() else {
            continue;
        };

        for placed in place_binding_fixtures(
            &selection,
            *universe,
            *address,
            binding.clone,
            data_provider,
        ) {
            let placed = match placed {
                Ok(placed) => placed,
                Err(issue) => {
                    issues.push(issue);
                    continue;
                }
            };
            for parameter in &placed.layout.parameters {
                let (element, index) = placed.shape.origin(parameter.target);
                let placement = ConsoleParameterPlacement {
                    fixture: placed.uid,
                    fixture_id: placed.fixture_id,
                    parameter: (element, index),
                    universe: placed.universe,
                    addresses: parameter
                        .slots
                        .iter()
                        .map(|slot| placed.start + u32::from(*slot))
                        .collect(),
                    channels: placed.start..=placed.end(),
                };
                let position = placements.len();
                placements.push(Some(placement));
                if let Some(replaced) = winners.insert((placed.uid, element, index), position) {
                    placements[replaced] = None;
                }
            }
        }
    }

    (placements.into_iter().flatten().collect(), issues)
}

/// Reports fixtures whose transport patch runs past the last channel of a universe.
///
/// Output has nowhere to put those bytes, which typically happens when a binding packs more
/// fixtures into the last universe of its range than fit there.
fn validate_transport_universe_bounds(
    output_bindings: &OutputBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<BindingValidationIssue> {
    let mut issues = Vec::new();

    for binding in &output_bindings.bindings {
        let OutputTarget::Transport {
            target,
            universe,
            address,
        } = &binding.target
        else {
            continue;
        };
        let Some(selection) = binding.source.fixture_selection() else {
            continue;
        };
        for placed in place_binding_fixtures(
            &selection,
            *universe,
            *address,
            binding.clone,
            data_provider,
        )
        .into_iter()
        .flatten()
        {
            if placed.end() > LAST_CHANNEL {
                issues.push(universe_overrun_issue(
                    placed.uid,
                    placed.fixture_id,
                    &format!("{target} universe {}", placed.universe),
                    &(placed.start..=placed.end()),
                ));
            }
        }
    }

    issues
}

/// Builds the issue for a fixture whose `channels` run past the end of `universe_label`.
fn universe_overrun_issue(
    fixture: Uuid,
    fixture_id: u32,
    universe_label: &str,
    channels: &RangeInclusive<u32>,
) -> BindingValidationIssue {
    BindingValidationIssue::for_fixtures(
        format!(
            "Fixture {} runs past the end of {} (needs channels {}..={}, the last channel is {})",
            fixture_id,
            universe_label,
            channels.start(),
            channels.end(),
            LAST_CHANNEL
        ),
        [fixture],
    )
}

/// One fixture of a fixture→console or fixture→transport binding, placed where output puts it.
#[derive(Debug, Clone)]
struct PlacedFixture {
    uid: Uuid,
    fixture_id: u32,
    universe: u16,
    /// Absolute address of the selection's first slot.
    start: u32,
    /// Parameters selected by the binding.
    shape: FixtureShape,
    /// Selected parameter bytes on the binding's DMX break, relative to `start`.
    layout: WireLayout<(usize, usize)>,
}

impl PlacedFixture {
    /// Returns the absolute address of the selection's last slot.
    fn end(&self) -> u32 {
        self.start + u32::from(self.layout.footprint()) - 1
    }
}

/// Places every fixture a binding selects in the universe and at the address output resolution
/// gives it.
///
/// Fixtures whose selection has no DMX slots are skipped like output skips them; fixtures that
/// cannot be laid out are returned as issues and still consume their universe slot.
fn place_binding_fixtures(
    selection: &FixtureOutputSelection<'_>,
    universe: Option<DmxRange>,
    address: Option<u16>,
    clone: bool,
    data_provider: &FixtureDataProviderExt,
) -> Vec<Result<PlacedFixture, BindingValidationIssue>> {
    let mut layout = FixturePatchLayout::new(universe, address, clone);
    let mut placed = Vec::with_capacity(selection.uids.len());

    for uid in selection.uids {
        let (universe, start) = layout.place_next();
        let fixture = match data_provider.inner.get(*uid) {
            Ok(fixture) => fixture,
            Err(_) => {
                placed.push(Err(BindingValidationIssue::for_fixtures(
                    format!("Fixture {} not found", uid),
                    [*uid],
                )));
                continue;
            }
        };
        let shape = match fixture_shape(fixture.value(), selection.element, selection.param) {
            Ok(shape) => shape,
            Err(issue) => {
                placed.push(Err(issue));
                continue;
            }
        };
        let wire_layout = shape.layout_for_break(selection.dmx_break);
        let footprint = wire_layout.footprint();
        if footprint == 0 {
            continue;
        }
        layout.advance(footprint);
        placed.push(Ok(PlacedFixture {
            uid: *uid,
            fixture_id: fixture.identifiers.id,
            universe,
            start: u32::from(start),
            shape,
            layout: wire_layout,
        }));
    }

    placed
}

fn validate_input_transport_console_priorities(
    input_bindings: &InputBindings,
) -> Vec<BindingValidationIssue> {
    let mut issues = Vec::new();
    let mut transport_bindings = Vec::new();

    for binding in &input_bindings.bindings {
        let (
            InputSource::Transport {
                transport,
                universe,
                address,
            },
            InputTarget::Console { .. },
        ) = (&binding.source, &binding.target)
        else {
            continue;
        };

        transport_bindings.push(InputTransportBinding {
            transport: *transport,
            universe: range_from_optional(*universe, 1, 512),
            address: range_from_optional_address(*address),
            priority: binding.priority,
        });
    }

    for idx in 0..transport_bindings.len() {
        for other_idx in (idx + 1)..transport_bindings.len() {
            let a = &transport_bindings[idx];
            let b = &transport_bindings[other_idx];
            if a.transport != b.transport || a.priority != b.priority {
                continue;
            }
            if ranges_overlap(&a.universe, &b.universe) && ranges_overlap(&a.address, &b.address) {
                issues.push(BindingValidationIssue::new(format!(
                    "Transport-to-console overlap with same priority {} on {:?}",
                    a.priority, a.transport
                )));
            }
        }
    }

    issues
}

fn validate_transport_address_uniqueness(
    input_bindings: &InputBindings,
    output_bindings: &OutputBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<BindingValidationIssue> {
    let mut spans = collect_transport_spans(output_bindings, data_provider);
    spans.extend(collect_input_transport_target_spans(input_bindings));
    let mut issues = Vec::new();

    for idx in 0..spans.len() {
        for other_idx in (idx + 1)..spans.len() {
            let a = &spans[idx];
            let b = &spans[other_idx];
            if a.transport != b.transport {
                continue;
            }
            if ranges_overlap(&a.universe, &b.universe) && ranges_overlap(&a.address, &b.address) {
                let overlap_universe = overlap_range(&a.universe, &b.universe);
                let overlap_address = overlap_range(&a.address, &b.address);
                issues.push(BindingValidationIssue::for_fixtures(
                    format!(
                        "Transport address overlap on {:?} universe {:?} {} between {} and {}",
                        a.transport,
                        overlap_universe,
                        format_channel_overlap(&overlap_address),
                        a.label,
                        b.label
                    ),
                    a.fixtures.iter().copied().chain(b.fixtures.iter().copied()),
                ));
            }
        }
    }

    issues
}

/// Collect transport-target spans produced by input bindings.
fn collect_input_transport_target_spans(input_bindings: &InputBindings) -> Vec<TransportSpan> {
    let mut spans = Vec::new();

    for binding in &input_bindings.bindings {
        let InputTarget::Transport {
            target: target_transport,
            universe: target_universe,
            address: target_address,
        } = &binding.target
        else {
            continue;
        };

        match &binding.source {
            InputSource::Transport {
                transport: source_transport,
                universe: source_universe,
                address: source_address,
            } => collect_mapped_transport_target_spans(
                &mut spans,
                TransportSpanKind::Input,
                format!("transport {:?} input", source_transport),
                Vec::new(),
                target_transport.clone(),
                *source_universe,
                *target_universe,
                *source_address,
                *target_address,
            ),
            InputSource::Console {
                universe: source_universe,
                address: source_address,
            } => collect_mapped_transport_target_spans(
                &mut spans,
                TransportSpanKind::Input,
                "console input".to_string(),
                Vec::new(),
                target_transport.clone(),
                *source_universe,
                *target_universe,
                *source_address,
                *target_address,
            ),
            InputSource::Fixture { .. } => {}
        }
    }

    spans
}

/// Add mapped source-to-target transport spans using binding resolver universe/address rules.
fn collect_mapped_transport_target_spans(
    spans: &mut Vec<TransportSpan>,
    kind: TransportSpanKind,
    label: String,
    fixtures: Vec<Uuid>,
    target_transport: String,
    source_universe: Option<DmxRange>,
    target_universe: Option<DmxRange>,
    source_address: Option<u16>,
    target_address: Option<u16>,
) {
    let source_universe_range = range_from_optional(source_universe, 1, 512);
    let source_universes: Vec<u16> = source_universe_range.collect();
    let target_universes: Vec<u16> = target_universe
        .map(|range| (range.start..=range.end).collect())
        .unwrap_or_default();

    let source_base_address = source_address.unwrap_or(1);
    let target_base_address = target_address.unwrap_or(1);
    let source_width = 512u16.saturating_sub(source_base_address.saturating_sub(1));
    let target_capacity = 512u16.saturating_sub(target_base_address.saturating_sub(1));
    let copied_width = source_width.min(target_capacity);
    if copied_width == 0 {
        return;
    }
    let target_end_address = target_base_address.saturating_add(copied_width - 1);
    let mut mapped_universes = Vec::new();

    for (idx, source_universe_id) in source_universes.iter().enumerate() {
        let mapped_target_universe = if target_universes.is_empty() {
            *source_universe_id
        } else if target_universes.len() == 1 {
            target_universes[0]
        } else if idx < target_universes.len() {
            target_universes[idx]
        } else {
            *target_universes
                .last()
                .expect("target_universes is not empty")
        };
        if mapped_universes.contains(&mapped_target_universe) {
            continue;
        }
        mapped_universes.push(mapped_target_universe);

        spans.push(TransportSpan {
            transport: target_transport.clone(),
            universe: mapped_target_universe..=mapped_target_universe,
            address: target_base_address..=target_end_address,
            kind,
            label: label.clone(),
            fixtures: fixtures.clone(),
        });
    }
}

fn validate_console_transport_exclusivity(
    output_bindings: &OutputBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<BindingValidationIssue> {
    let spans = collect_transport_spans(output_bindings, data_provider);
    let mut issues = Vec::new();

    let console_spans: Vec<_> = spans
        .iter()
        .filter(|span| span.kind == TransportSpanKind::Console)
        .collect();
    let fixture_spans: Vec<_> = spans
        .iter()
        .filter(|span| span.kind == TransportSpanKind::Fixture)
        .collect();

    for console_span in &console_spans {
        for fixture_span in &fixture_spans {
            if console_span.transport != fixture_span.transport {
                continue;
            }
            if ranges_overlap(&console_span.universe, &fixture_span.universe) {
                issues.push(BindingValidationIssue::for_fixtures(
                    format!(
                        "Console owns transport universe on {:?} between {} and {}",
                        console_span.transport, console_span.label, fixture_span.label
                    ),
                    fixture_span.fixtures.iter().copied(),
                ));
            }
        }
    }

    issues
}

/// Transport endpoint resolved from an input binding during overlap validation.
#[derive(Debug, Clone, PartialEq, Eq)]
struct InputTransportBinding {
    transport: BindingTransport,
    universe: RangeInclusive<u16>,
    address: RangeInclusive<u16>,
    priority: i32,
}

/// Kinds of address spans used when checking patch binding overlap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportSpanKind {
    Console,
    Fixture,
    Input,
}

/// Resolved universe/address interval used for transport conflict detection.
#[derive(Debug, Clone)]
struct TransportSpan {
    transport: String,
    universe: RangeInclusive<u16>,
    address: RangeInclusive<u16>,
    kind: TransportSpanKind,
    label: String,
    fixtures: Vec<Uuid>,
}

/// Collect transport-target spans produced by output bindings.
fn collect_transport_spans(
    output_bindings: &OutputBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<TransportSpan> {
    let mut spans = Vec::new();

    for binding in &output_bindings.bindings {
        match (&binding.source, &binding.target) {
            (
                source @ (OutputSource::Fixture { .. } | OutputSource::FixtureBreak { .. }),
                OutputTarget::Transport {
                    target,
                    universe,
                    address,
                },
            ) => {
                let Some(selection) = source.fixture_selection() else {
                    continue;
                };
                for placed in place_binding_fixtures(
                    &selection,
                    *universe,
                    *address,
                    binding.clone,
                    data_provider,
                )
                .into_iter()
                .flatten()
                {
                    // Bytes past the end of the universe never reach the wire;
                    // validate_transport_universe_bounds reports them.
                    if placed.start > LAST_CHANNEL {
                        continue;
                    }
                    let end = placed.end().min(LAST_CHANNEL);
                    spans.push(TransportSpan {
                        transport: target.clone(),
                        universe: placed.universe..=placed.universe,
                        address: placed.start as u16..=end as u16,
                        kind: TransportSpanKind::Fixture,
                        label: if selection.dmx_break == 1 {
                            format!("fixture {}", placed.fixture_id)
                        } else {
                            format!(
                                "fixture {} break {}",
                                placed.fixture_id, selection.dmx_break
                            )
                        },
                        fixtures: vec![placed.uid],
                    });
                }
            }
            (
                OutputSource::Console {
                    universe: source_universe,
                    address: source_address,
                },
                OutputTarget::Transport {
                    target,
                    universe: target_universe,
                    address: target_address,
                },
            ) => collect_mapped_transport_target_spans(
                &mut spans,
                TransportSpanKind::Console,
                "console".to_string(),
                Vec::new(),
                target.clone(),
                *source_universe,
                *target_universe,
                *source_address,
                *target_address,
            ),
            _ => {}
        }
    }

    spans
}

fn fixture_shape_for_binding(
    data_provider: &FixtureDataProviderExt,
    uid: Uuid,
    element: Option<u16>,
    param: Option<&str>,
) -> Result<FixtureShape, BindingValidationIssue> {
    let fixture = data_provider.inner.get(uid).map_err(|_| {
        BindingValidationIssue::for_fixtures(format!("Fixture {} not found", uid), [uid])
    })?;

    fixture_shape(fixture.value(), element, param)
}

/// Parameters selected by a binding, used to validate patch binding spans.
#[derive(Debug, Clone)]
struct FixtureShape {
    /// Selected parameters of each selected element, in fixture DMX order.
    elements: Vec<Vec<ParameterMetadata>>,
    /// Fixture element index and parameter index of each selected parameter, parallel to
    /// `elements`.
    origins: Vec<Vec<(usize, usize)>>,
    /// Whether the binding selects only part of the fixture and starts at its first selected byte.
    partial: bool,
}

impl FixtureShape {
    /// Returns the fixture element index and parameter index behind a layout key, which
    /// identifies the same parameter across bindings that select it differently.
    fn origin(&self, (element, parameter): (usize, usize)) -> (usize, usize) {
        self.origins[element][parameter]
    }

    /// Lays out the selection's bytes on the primary DMX break, keyed by `(element, parameter)` position.
    fn layout(&self) -> WireLayout<(usize, usize)> {
        self.layout_for_break(1)
    }

    /// Lays out the selection's bytes on `dmx_break`, keyed by `(element, parameter)` position.
    ///
    /// Slots are relative to that break's own start address. Partial
    /// selections are rebased so their first byte sits at slot zero,
    /// matching how the binding patches them at its address.
    fn layout_for_break(&self, dmx_break: u16) -> WireLayout<(usize, usize)> {
        let layout = WireLayout::for_break(
            self.elements
                .iter()
                .enumerate()
                .flat_map(|(element_index, parameters)| {
                    parameters
                        .iter()
                        .enumerate()
                        .map(move |(parameter_index, metadata)| {
                            ((element_index, parameter_index), metadata)
                        })
                }),
            dmx_break,
        );
        if self.partial {
            layout.rebased()
        } else {
            layout
        }
    }

    /// Returns whether bytes copied from one selection land on the same parameters in the other.
    ///
    /// Both selections must have the same element structure, the same
    /// attributes at the same resolutions within each element, and every
    /// parameter byte at the same footprint slot.
    fn matches(&self, other: &Self) -> bool {
        self.elements.len() == other.elements.len()
            && self
                .elements
                .iter()
                .zip(&other.elements)
                .all(|(left, right)| {
                    left.len() == right.len()
                        && left.iter().zip(right).all(|(left, right)| {
                            left.attribute == right.attribute && left.resolution == right.resolution
                        })
                })
            && self.layout() == other.layout()
    }
}

/// Collects the parameters a binding selects from a fixture.
///
/// A whole-fixture selection walks elements in the fixture layout's wiring order, as output
/// resolution does, so sequentially packed parameters land on the same slots.
fn fixture_shape(
    fixture: &Fixture,
    element: Option<u16>,
    param: Option<&str>,
) -> Result<FixtureShape, BindingValidationIssue> {
    let element_indices = match element {
        Some(index) => {
            if index == 0 || index as usize > fixture.elements.len() {
                return Err(BindingValidationIssue::new(format!(
                    "Fixture {} element {} does not exist",
                    fixture.identifiers.uid, index
                )));
            }
            vec![(index - 1) as usize]
        }
        None => match fixture.layout.and_then(FixtureLayout::dmx_element_order) {
            Some(order) => order
                .into_iter()
                .filter_map(|index| (index as usize).checked_sub(1))
                .filter(|index| *index < fixture.elements.len())
                .collect(),
            None => (0..fixture.elements.len()).collect(),
        },
    };

    let mut elements = Vec::new();
    let mut origins = Vec::new();
    for idx in element_indices {
        let element = &fixture.elements[idx];
        let selected: Vec<usize> = if let Some(param_name) = param {
            let attribute = attribute_from_param(param_name);
            element
                .parameters
                .iter()
                .position(|param| param.attribute == attribute)
                .into_iter()
                .collect()
        } else {
            (0..element.parameters.len()).collect()
        };
        elements.push(
            selected
                .iter()
                .map(|position| element.parameters[*position].clone())
                .collect(),
        );
        origins.push(
            selected
                .into_iter()
                .map(|position| (idx, position))
                .collect(),
        );
    }

    // A parameter selection patches the elements that have the parameter, like output; it is
    // only an error when no selected element has it.
    if let Some(param_name) = param
        && elements.iter().all(Vec::is_empty)
    {
        return Err(BindingValidationIssue::new(format!(
            "Fixture {} missing parameter {:?}",
            fixture.identifiers.uid,
            attribute_from_param(param_name)
        )));
    }

    Ok(FixtureShape {
        elements,
        origins,
        partial: element.is_some() || param.is_some(),
    })
}

fn attribute_from_param(name: &str) -> Attribute {
    Attribute::from_str(name).unwrap_or(Attribute::Custom {
        label: name.to_string(),
    })
}

fn range_from_optional(
    range: Option<DmxRange>,
    default_start: u16,
    default_end: u16,
) -> RangeInclusive<u16> {
    range
        .map(range_from_range)
        .unwrap_or(default_start..=default_end)
}

fn range_from_range(range: DmxRange) -> RangeInclusive<u16> {
    range.start..=range.end
}

fn range_from_optional_address(address: Option<u16>) -> RangeInclusive<u16> {
    match address {
        Some(value) => value..=value,
        None => 1..=512,
    }
}

fn ranges_overlap(a: &RangeInclusive<u16>, b: &RangeInclusive<u16>) -> bool {
    !(a.end() < b.start() || b.end() < a.start())
}

fn overlap_range(a: &RangeInclusive<u16>, b: &RangeInclusive<u16>) -> RangeInclusive<u16> {
    let start = *a.start().max(b.start());
    let end = *a.end().min(b.end());
    start..=end
}

fn format_channel_overlap(range: &RangeInclusive<u16>) -> String {
    if range.start() == range.end() {
        format!("at channel {}", range.start())
    } else {
        format!("at channels {}..={}", range.start(), range.end())
    }
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::Identifiers;

    use super::*;
    use crate::bindings::{InputBinding, OutputBinding};

    fn make_fixture(uid: Uuid, id: u32, params: Vec<ParameterMetadata>) -> Fixture {
        Fixture {
            identifiers: Identifiers {
                id,
                uid,
                label: format!("fixture-{id}"),
            },
            make: "test".to_string(),
            model: "test".to_string(),
            mode: "default".to_string(),
            elements: vec![crate::fixture::FixtureElement {
                label: "main".to_string(),
                parameters: params,
            }],
            physical: None,
            placement: Default::default(),
            layout: None,
            library_asset_etag: None,
        }
    }

    fn param(attribute: Attribute) -> ParameterMetadata {
        ParameterMetadata {
            native_unit: attribute.native_unit(),
            value_polarity: attribute.value_polarity(),
            attribute,
            resolution: DmxValueResolution::Coarse,
            ..Default::default()
        }
    }

    /// Build parameter metadata with a selected DMX resolution for validation tests.
    fn param_with_resolution(
        attribute: Attribute,
        resolution: DmxValueResolution,
    ) -> ParameterMetadata {
        ParameterMetadata {
            native_unit: attribute.native_unit(),
            value_polarity: attribute.value_polarity(),
            attribute,
            resolution,
            ..Default::default()
        }
    }

    #[test]
    fn console_address_uniqueness_enforced() {
        let uid_a = Uuid::new_v4();
        let uid_b = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid_a, 1, vec![param(Attribute::Intensity)]))
            .unwrap();
        provider
            .inner
            .add(make_fixture(uid_b, 2, vec![param(Attribute::Intensity)]))
            .unwrap();

        let output_bindings = OutputBindings {
            bindings: vec![
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![uid_a],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Console {
                        universe: Some(DmxRange::single(1)),
                        address: Some(1),
                    },
                    priority: 0,
                    clone: false,
                },
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![uid_b],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Console {
                        universe: Some(DmxRange::single(1)),
                        address: Some(1),
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let issues = validate_console_patch(&output_bindings, &provider);
        assert!(!issues.is_empty());
    }

    /// Adds `count` fixtures with a `footprint`-slot DMX footprint and returns their uids.
    fn add_fixtures_with_footprint(
        provider: &mut FixtureDataProviderExt,
        count: u32,
        footprint: u16,
    ) -> Vec<Uuid> {
        (1..=count)
            .map(|id| {
                let uid = Uuid::new_v4();
                let intensity = param_at_slots(
                    Attribute::Intensity,
                    DmxValueResolution::Coarse,
                    &[footprint],
                );
                provider
                    .inner
                    .add(make_fixture(uid, id, vec![intensity]))
                    .unwrap();
                uid
            })
            .collect()
    }

    /// Returns a fixture binding of `uids` onto `target`, packed from the target address.
    fn fixture_binding(uids: Vec<Uuid>, target: OutputTarget) -> OutputBinding {
        OutputBinding {
            source: OutputSource::Fixture {
                uids,
                element: None,
                param: None,
            },
            target,
            priority: 0,
            clone: false,
        }
    }

    /// One binding over a universe range whose fixtures add up to more than 65,535 channels
    /// places one fixture per universe, so neither console nor transport validation reports
    /// an overlap.
    #[test]
    fn wide_universe_range_binding_does_not_self_overlap() {
        let mut provider = FixtureDataProviderExt::default();
        let uids = add_fixtures_with_footprint(&mut provider, 600, 120);
        let universe = Some(DmxRange {
            start: 101,
            end: 700,
        });
        let output_bindings = OutputBindings {
            bindings: vec![
                fixture_binding(
                    uids.clone(),
                    OutputTarget::Console {
                        universe,
                        address: Some(1),
                    },
                ),
                fixture_binding(
                    uids,
                    OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe,
                        address: Some(1),
                    },
                ),
            ],
        };

        let console_issues = validate_console_patch(&output_bindings, &provider);
        assert!(console_issues.is_empty(), "{console_issues:?}");
        let transport_issues = validate_transport_address_uniqueness(
            &InputBindings::default(),
            &output_bindings,
            &provider,
        );
        assert!(transport_issues.is_empty(), "{transport_issues:?}");
    }

    /// Console validation places fixtures where output does: the Nth fixture in the Nth
    /// universe of the range, with the remainder packed into the last universe. A binding next
    /// to the first fixture is clear, and one on the packed remainder overlaps.
    #[test]
    fn console_validation_follows_universe_range_layout() {
        let mut provider = FixtureDataProviderExt::default();
        let uids = add_fixtures_with_footprint(&mut provider, 5, 1);
        let ranged = fixture_binding(
            uids[..3].to_vec(),
            OutputTarget::Console {
                universe: Some(DmxRange { start: 1, end: 2 }),
                address: Some(1),
            },
        );
        let at = |uid: Uuid, universe: u16, address: u16| {
            fixture_binding(
                vec![uid],
                OutputTarget::Console {
                    universe: Some(DmxRange::single(universe)),
                    address: Some(address),
                },
            )
        };

        let clear = OutputBindings {
            bindings: vec![ranged.clone(), at(uids[3], 1, 2)],
        };
        let issues = validate_console_patch(&clear, &provider);
        assert!(issues.is_empty(), "{issues:?}");

        let overlapping = OutputBindings {
            bindings: vec![ranged, at(uids[4], 2, 2)],
        };
        let issues = validate_console_patch(&overlapping, &provider);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].involves_fixture(uids[2]) && issues[0].involves_fixture(uids[4]));
    }

    /// A cloned binding over a universe range puts each fixture at the binding address of its
    /// own universe, so its fixtures do not collide with each other, and a fixture patched over
    /// that address in the second universe overlaps only the fixture cloned there.
    #[test]
    fn cloned_universe_range_binding_places_one_fixture_per_universe() {
        let mut provider = FixtureDataProviderExt::default();
        let uids = add_fixtures_with_footprint(&mut provider, 3, 4);
        let cloned = OutputBinding {
            clone: true,
            ..fixture_binding(
                uids[..2].to_vec(),
                OutputTarget::Console {
                    universe: Some(DmxRange { start: 1, end: 2 }),
                    address: Some(5),
                },
            )
        };
        let neighbour = fixture_binding(
            vec![uids[2]],
            OutputTarget::Console {
                universe: Some(DmxRange::single(2)),
                address: Some(5),
            },
        );

        let bindings = OutputBindings {
            bindings: vec![cloned, neighbour],
        };
        let issues = validate_console_patch(&bindings, &provider);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].message.contains("universe 2 address 8"));
        assert!(issues[0].involves_fixture(uids[1]) && issues[0].involves_fixture(uids[2]));
    }

    /// Returns a console binding of `uids` at `universe`/`address` with `priority`.
    fn console_binding(
        uids: Vec<Uuid>,
        universe: u16,
        address: u16,
        priority: i32,
    ) -> OutputBinding {
        OutputBinding {
            priority,
            ..fixture_binding(
                uids,
                OutputTarget::Console {
                    universe: Some(DmxRange::single(universe)),
                    address: Some(address),
                },
            )
        }
    }

    /// Fixtures packed into the last universe of a range past channel 512 are reported once
    /// each as running past the end, on the console and on a transport, and the bytes that do
    /// not exist on the wire raise no overlap errors.
    #[test]
    fn fixtures_past_the_end_of_a_universe_are_reported() {
        let mut provider = FixtureDataProviderExt::default();
        let uids = add_fixtures_with_footprint(&mut provider, 6, 120);
        let universe = Some(DmxRange { start: 1, end: 2 });
        let bindings = OutputBindings {
            bindings: vec![
                fixture_binding(
                    uids.clone(),
                    OutputTarget::Console {
                        universe,
                        address: Some(1),
                    },
                ),
                fixture_binding(
                    uids.clone(),
                    OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe,
                        address: Some(1),
                    },
                ),
            ],
        };

        let issues: Vec<_> = validate_console_patch(&bindings, &provider)
            .into_iter()
            .chain(validate_transport_universe_bounds(&bindings, &provider))
            .collect();
        let messages: Vec<&str> = issues.iter().map(|issue| issue.message.as_str()).collect();
        assert_eq!(
            messages,
            [
                "Fixture 6 runs past the end of console universe 2 (needs channels 481..=600, the last channel is 512)",
                "Fixture 6 runs past the end of sacn universe 2 (needs channels 481..=600, the last channel is 512)",
            ]
        );
        assert!(issues.iter().all(|issue| issue.involves_fixture(uids[5])));
        let transport_issues =
            validate_transport_address_uniqueness(&InputBindings::default(), &bindings, &provider);
        assert!(transport_issues.is_empty(), "{transport_issues:?}");
    }

    /// A single universe packed with more than 65,535 channels of fixtures reports the
    /// fixtures that do not fit, never the saturated "address 65535" overlap.
    #[test]
    fn overfull_universe_does_not_report_saturated_overlaps() {
        let mut provider = FixtureDataProviderExt::default();
        let uids = add_fixtures_with_footprint(&mut provider, 600, 120);
        let bindings = OutputBindings {
            bindings: vec![console_binding(uids, 101, 1, 0)],
        };

        let issues = validate_console_patch(&bindings, &provider);
        assert_eq!(
            issues.len(),
            596,
            "fixtures 5..=600 do not fit: {:?}",
            &issues[..3]
        );
        assert!(
            issues
                .iter()
                .all(|issue| issue.message.contains("runs past the end"))
        );
    }

    /// When one fixture is patched to the console twice, only the winning binding's address
    /// is checked: a higher priority wins, and equal priorities go to the earliest-authored
    /// binding, as in output resolution.
    #[test]
    fn console_validation_checks_only_the_winning_binding() {
        let mut provider = FixtureDataProviderExt::default();
        let uids = add_fixtures_with_footprint(&mut provider, 2, 1);
        let (moved, other) = (uids[0], uids[1]);

        let higher_priority_move = OutputBindings {
            bindings: vec![
                console_binding(vec![moved], 1, 1, 0),
                console_binding(vec![moved], 2, 1, 5),
                console_binding(vec![other], 1, 1, 0),
            ],
        };
        let issues = validate_console_patch(&higher_priority_move, &provider);
        assert!(issues.is_empty(), "{issues:?}");

        let equal_priority_move = OutputBindings {
            bindings: vec![
                console_binding(vec![moved], 1, 1, 0),
                console_binding(vec![moved], 2, 1, 0),
                console_binding(vec![other], 1, 1, 0),
            ],
        };
        let issues = validate_console_patch(&equal_priority_move, &provider);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].involves_fixture(moved) && issues[0].involves_fixture(other));
    }

    /// A parameter or element binding that wins only part of a fixture moves just those
    /// parameters: the addresses they leave behind are free, located by the fixture layout's
    /// wiring order rather than the logical element order.
    #[test]
    fn partial_binding_frees_only_its_parameters() {
        let mut provider = FixtureDataProviderExt::default();
        let beam = Uuid::new_v4();
        let mut fixture = make_fixture_with_elements(
            beam,
            100,
            (0..37).map(|_| vec![param(Attribute::Intensity)]).collect(),
        );
        fixture.layout = Some(FixtureLayout::RotatingWashBeam);
        provider.inner.add(fixture).unwrap();
        let other = add_fixtures_with_footprint(&mut provider, 1, 1)[0];
        let element_two_moved = OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![beam],
                element: Some(2),
                param: None,
            },
            ..console_binding(vec![beam], 2, 1, 5)
        };
        let with_other_at = |address: u16| OutputBindings {
            bindings: vec![
                console_binding(vec![beam], 1, 1, 0),
                element_two_moved.clone(),
                console_binding(vec![other], 1, address, 0),
            ],
        };

        // Wiring order 1, 13..=2, 14..=37 puts element 2 on channel 13 of the whole fixture.
        let issues = validate_console_patch(&with_other_at(13), &provider);
        assert!(issues.is_empty(), "{issues:?}");
        let issues = validate_console_patch(&with_other_at(2), &provider);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].message.contains("universe 1 address 2"));
    }

    /// A partial binding that moves one parameter onto an address another parameter of the
    /// same fixture still uses is reported, since both write the same channel.
    #[test]
    fn partial_binding_onto_its_own_fixture_overlaps() {
        let mut provider = FixtureDataProviderExt::default();
        let fixture = Uuid::new_v4();
        provider
            .inner
            .add(make_fixture(
                fixture,
                100,
                vec![param(Attribute::Intensity), param(Attribute::Red)],
            ))
            .unwrap();
        let red_onto_intensity = OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![fixture],
                element: None,
                param: Some("Red".to_string()),
            },
            ..console_binding(vec![fixture], 1, 1, 5)
        };
        let bindings = OutputBindings {
            bindings: vec![console_binding(vec![fixture], 1, 1, 0), red_onto_intensity],
        };

        let issues = validate_console_patch(&bindings, &provider);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].message.contains("two parameters of fixture 100"));
    }

    /// A parameter binding across a whole fixture patches the elements that have that
    /// parameter and skips the rest, as output does, instead of rejecting the fixture.
    #[test]
    fn parameter_binding_skips_elements_without_the_parameter() {
        let mut provider = FixtureDataProviderExt::default();
        let head = Uuid::new_v4();
        provider
            .inner
            .add(make_fixture_with_elements(
                head,
                100,
                vec![
                    vec![param(Attribute::Pan), param(Attribute::Intensity)],
                    vec![param(Attribute::Intensity)],
                ],
            ))
            .unwrap();
        let other = add_fixtures_with_footprint(&mut provider, 1, 1)[0];
        let pan = OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![head],
                element: None,
                param: Some("Pan".to_string()),
            },
            ..console_binding(vec![head], 1, 1, 0)
        };
        let bindings = OutputBindings {
            bindings: vec![pan, console_binding(vec![other], 1, 1, 0)],
        };

        let issues = validate_console_patch(&bindings, &provider);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].involves_fixture(head) && issues[0].involves_fixture(other));
    }

    #[test]
    fn transport_overlap_strict_only() {
        let uid_a = Uuid::new_v4();
        let uid_b = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid_a, 1, vec![param(Attribute::Intensity)]))
            .unwrap();
        provider
            .inner
            .add(make_fixture(uid_b, 2, vec![param(Attribute::Intensity)]))
            .unwrap();

        let output_bindings = OutputBindings {
            bindings: vec![
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![uid_a],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(1)),
                        address: Some(1),
                    },
                    priority: 0,
                    clone: false,
                },
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![uid_b],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(1)),
                        address: Some(1),
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let settings = BindingValidationSettings {
            mode: BindingValidationMode::Strict,
        };
        let issues = validate_bindings(
            &settings,
            &InputBindings::default(),
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("Transport address overlap"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("fixture 1"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("fixture 2"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("channel 1"))
        );

        let settings = BindingValidationSettings {
            mode: BindingValidationMode::Permissive,
        };
        let issues = validate_bindings(
            &settings,
            &InputBindings::default(),
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .all(|issue| !issue.message.contains("Transport address overlap"))
        );
    }

    /// Validates fixture output spans use parameter byte width when comparing against input transport spans.
    #[test]
    fn transport_overlap_uses_multibyte_fixture_footprint() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(
                uid,
                3,
                vec![param_with_resolution(
                    Attribute::Pan,
                    DmxValueResolution::Fine,
                )],
            ))
            .unwrap();

        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::ArtNet,
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                target: InputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(2),
                },
                priority: 0,
                clone: false,
            }],
        };
        let output_bindings = OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                priority: 0,
                clone: false,
            }],
        };

        let issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues.iter().any(|issue| {
                issue.message.contains("Transport address overlap")
                    && issue.message.contains("channel 2")
            }),
            "expected overlap on the fine parameter's second byte, got {:?}",
            issues
        );
    }

    #[test]
    fn console_transport_exclusivity_strict_only() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid, 1, vec![param(Attribute::Intensity)]))
            .unwrap();

        let output_bindings = OutputBindings {
            bindings: vec![
                OutputBinding {
                    source: OutputSource::Console {
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![uid],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(1)),
                        address: Some(1),
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let settings = BindingValidationSettings {
            mode: BindingValidationMode::Strict,
        };
        let issues = validate_bindings(
            &settings,
            &InputBindings::default(),
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("Console owns transport"))
        );

        let settings = BindingValidationSettings {
            mode: BindingValidationMode::Permissive,
        };
        let issues = validate_bindings(
            &settings,
            &InputBindings::default(),
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .all(|issue| !issue.message.contains("Console owns transport"))
        );
    }

    /// Validates wildcard console output mappings do not conflict with their own collapsed target span.
    #[test]
    fn console_output_wildcard_to_single_target_does_not_self_conflict() {
        let provider = FixtureDataProviderExt::default();
        let output_bindings = OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Console {
                    universe: None,
                    address: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: None,
                },
                priority: 0,
                clone: false,
            }],
        };

        let issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &InputBindings::default(),
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .all(|issue| !issue.message.contains("Transport address overlap")),
            "single wildcard console output binding should not overlap with itself, got {:?}",
            issues
        );
    }

    #[test]
    fn strict_mode_rejects_transport_input_overlap_with_fixture_transport_output() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid, 311, vec![param(Attribute::Intensity)]))
            .unwrap();

        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: None,
                    address: None,
                },
                target: InputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: None,
                    address: None,
                },
                priority: 0,
                clone: false,
            }],
        };
        let output_bindings = OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                priority: 0,
                clone: false,
            }],
        };

        let strict_issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            strict_issues
                .iter()
                .any(|issue| issue.message.contains("Transport address overlap")),
            "expected strict mode to reject overlapping transport targets, got {:?}",
            strict_issues
        );

        let permissive_issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Permissive,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            permissive_issues
                .iter()
                .all(|issue| !issue.message.contains("Transport address overlap")),
            "did not expect transport target overlap in permissive mode, got {:?}",
            permissive_issues
        );
    }

    /// Validates console input bindings use the same transport-target conflict shape as transport input bindings.
    #[test]
    fn strict_mode_rejects_console_input_overlap_with_fixture_transport_output() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid, 312, vec![param(Attribute::Intensity)]))
            .unwrap();

        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Console {
                    universe: Some(DmxRange::single(7)),
                    address: Some(10),
                },
                target: InputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(7)),
                    address: Some(20),
                },
                priority: 0,
                clone: false,
            }],
        };
        let output_bindings = OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(7)),
                    address: Some(20),
                },
                priority: 0,
                clone: false,
            }],
        };

        let strict_issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            strict_issues
                .iter()
                .any(|issue| issue.message.contains("Transport address overlap")),
            "expected strict mode to reject console input transport target overlap, got {:?}",
            strict_issues
        );
    }

    #[test]
    fn strict_mode_rejects_console_to_transport_overlap_with_transport_input() {
        let provider = FixtureDataProviderExt::default();

        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(40)),
                    address: None,
                },
                target: InputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(40)),
                    address: None,
                },
                priority: 0,
                clone: false,
            }],
        };
        let output_bindings = OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Console {
                    universe: Some(DmxRange::single(40)),
                    address: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(40)),
                    address: None,
                },
                priority: 0,
                clone: false,
            }],
        };

        let strict_issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            strict_issues
                .iter()
                .any(|issue| issue.message.contains("Transport address overlap")),
            "expected strict mode to reject overlapping transport targets, got {:?}",
            strict_issues
        );

        let permissive_issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Permissive,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            permissive_issues
                .iter()
                .all(|issue| !issue.message.contains("Transport address overlap")),
            "did not expect transport target overlap in permissive mode, got {:?}",
            permissive_issues
        );
    }

    #[test]
    fn strict_mode_rejects_transport_input_overlap_between_two_inputs() {
        let provider = FixtureDataProviderExt::default();

        let input_bindings = InputBindings {
            bindings: vec![
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::Sacn,
                        universe: Some(DmxRange::single(40)),
                        address: None,
                    },
                    target: InputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(40)),
                        address: Some(100),
                    },
                    priority: 0,
                    clone: false,
                },
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::ArtNet,
                        universe: Some(DmxRange::single(40)),
                        address: None,
                    },
                    target: InputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(40)),
                        address: Some(100),
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &input_bindings,
            &OutputBindings::default(),
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("Transport address overlap")),
            "expected strict mode to reject overlapping transport inputs, got {:?}",
            issues
        );
    }

    #[test]
    fn strict_mode_allows_transport_input_targets_on_different_transports() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid, 311, vec![param(Attribute::Intensity)]))
            .unwrap();

        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: None,
                },
                target: InputTarget::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: None,
                },
                priority: 0,
                clone: false,
            }],
        };
        let output_bindings = OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                priority: 0,
                clone: false,
            }],
        };

        let issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .all(|issue| !issue.message.contains("Transport address overlap")),
            "did not expect overlap on different transports, got {:?}",
            issues
        );
    }

    #[test]
    fn strict_mode_allows_non_overlapping_transport_input_target_addresses() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid, 311, vec![param(Attribute::Intensity)]))
            .unwrap();

        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Transport {
                    transport: BindingTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: None,
                },
                target: InputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(200),
                },
                priority: 0,
                clone: false,
            }],
        };
        let output_bindings = OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                priority: 0,
                clone: false,
            }],
        };

        let issues = validate_bindings(
            &BindingValidationSettings {
                mode: BindingValidationMode::Strict,
            },
            &input_bindings,
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );
        assert!(
            issues
                .iter()
                .all(|issue| !issue.message.contains("Transport address overlap")),
            "did not expect overlap for disjoint address ranges, got {:?}",
            issues
        );
    }

    #[test]
    fn input_transport_console_overlap_requires_priority_difference() {
        let input_bindings = InputBindings {
            bindings: vec![
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::Sacn,
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    target: InputTarget::Console {
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    priority: 1,
                    clone: false,
                },
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::Sacn,
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    target: InputTarget::Console {
                        universe: Some(DmxRange::single(5)),
                        address: None,
                    },
                    priority: 1,
                    clone: false,
                },
            ],
        };

        let issues = validate_input_transport_console_priorities(&input_bindings);
        assert!(!issues.is_empty());

        let input_bindings = InputBindings {
            bindings: vec![
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::Sacn,
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    target: InputTarget::Console {
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    priority: 1,
                    clone: false,
                },
                InputBinding {
                    source: InputSource::Transport {
                        transport: BindingTransport::Sacn,
                        universe: Some(DmxRange::single(1)),
                        address: None,
                    },
                    target: InputTarget::Console {
                        universe: Some(DmxRange::single(5)),
                        address: None,
                    },
                    priority: 2,
                    clone: false,
                },
            ],
        };

        let issues = validate_input_transport_console_priorities(&input_bindings);
        assert!(issues.is_empty());
    }

    #[test]
    fn virtual_intensity_excluded_from_footprint() {
        let uid_a = Uuid::new_v4();
        let uid_b = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();

        // Create fixtures with VirtualIntensity + RGB (4 params, but only 3 DMX channels)
        let params_with_virtual = vec![
            param(Attribute::VirtualIntensity),
            param(Attribute::Red),
            param(Attribute::Green),
            param(Attribute::Blue),
        ];
        provider
            .inner
            .add(make_fixture(uid_a, 211, params_with_virtual.clone()))
            .unwrap();
        provider
            .inner
            .add(make_fixture(uid_b, 212, params_with_virtual))
            .unwrap();

        // Fixture A at address 1: occupies 1-3 (3 DMX channels, excluding VirtualIntensity)
        // Fixture B at address 4: occupies 4-6 (3 DMX channels, excluding VirtualIntensity)
        // If VirtualIntensity was counted, A would occupy 1-4, overlapping with B at 4
        let output_bindings = OutputBindings {
            bindings: vec![
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![uid_a],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(2)),
                        address: Some(1),
                    },
                    priority: 0,
                    clone: false,
                },
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![uid_b],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(2)),
                        address: Some(4),
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let settings = BindingValidationSettings {
            mode: BindingValidationMode::Strict,
        };
        let issues = validate_bindings(
            &settings,
            &InputBindings::default(),
            &output_bindings,
            &DisabledBindings::default(),
            &provider,
        );

        // Should NOT report transport address overlap since VirtualIntensity doesn't consume DMX
        assert!(
            !issues
                .iter()
                .any(|issue| issue.message.contains("Transport address overlap")),
            "VirtualIntensity should be excluded from footprint calculation. Issues: {:?}",
            issues
        );
    }

    #[test]
    fn fixture_to_fixture_shape_validation() {
        let uid_a = Uuid::new_v4();
        let uid_b = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(make_fixture(uid_a, 1, vec![param(Attribute::Intensity)]))
            .unwrap();
        provider
            .inner
            .add(make_fixture(uid_b, 2, vec![param(Attribute::Pan)]))
            .unwrap();

        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Fixture {
                    uids: vec![uid_a],
                    element: None,
                    param: None,
                },
                target: InputTarget::Fixture {
                    uids: vec![uid_b],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            }],
        };

        let issues = validate_fixture_to_fixture_shapes(&input_bindings, &provider);
        assert!(!issues.is_empty());
    }

    /// Builds a fixture whose elements hold the given parameter lists.
    fn make_fixture_with_elements(
        uid: Uuid,
        id: u32,
        elements: Vec<Vec<ParameterMetadata>>,
    ) -> Fixture {
        let mut fixture = make_fixture(uid, id, Vec::new());
        fixture.elements = elements
            .into_iter()
            .enumerate()
            .map(|(index, parameters)| crate::fixture::FixtureElement {
                label: format!("element-{index}"),
                parameters,
            })
            .collect();
        fixture
    }

    /// Builds parameter metadata whose bytes sit at explicit 1-based break-1 slots.
    fn param_at_slots(
        attribute: Attribute,
        resolution: DmxValueResolution,
        offsets: &[u16],
    ) -> ParameterMetadata {
        ParameterMetadata {
            dmx_slots: DmxSlots::Explicit {
                dmx_break: 1,
                offsets: offsets.to_vec(),
            },
            ..param_with_resolution(attribute, resolution)
        }
    }

    /// Validates a whole-fixture binding from `source` to `target` and returns the shape issues.
    fn fixture_to_fixture_issues(source: Fixture, target: Fixture) -> Vec<BindingValidationIssue> {
        let source_uid = source.identifiers.uid;
        let target_uid = target.identifiers.uid;
        let mut provider = FixtureDataProviderExt::default();
        provider.inner.add(source).unwrap();
        provider.inner.add(target).unwrap();
        let input_bindings = InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Fixture {
                    uids: vec![source_uid],
                    element: None,
                    param: None,
                },
                target: InputTarget::Fixture {
                    uids: vec![target_uid],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            }],
        };
        validate_fixture_to_fixture_shapes(&input_bindings, &provider)
    }

    /// Verifies one `[Pan, Tilt]` element does not match separate `[Pan]` and `[Tilt]` elements,
    /// even though their flattened parameters and bytes line up.
    #[test]
    fn fixture_to_fixture_shape_rejects_different_element_boundaries() {
        let source = make_fixture_with_elements(
            Uuid::new_v4(),
            1,
            vec![vec![param(Attribute::Pan), param(Attribute::Tilt)]],
        );
        let target = make_fixture_with_elements(
            Uuid::new_v4(),
            2,
            vec![vec![param(Attribute::Pan)], vec![param(Attribute::Tilt)]],
        );

        assert_eq!(fixture_to_fixture_issues(source, target).len(), 1);
    }

    /// Verifies fixtures with the same attributes and resolutions but different byte slots
    /// do not match, since copied bytes would land on the wrong parameter bytes.
    #[test]
    fn fixture_to_fixture_shape_rejects_different_slot_layouts() {
        let source = make_fixture_with_elements(
            Uuid::new_v4(),
            1,
            vec![vec![
                param_at_slots(Attribute::Pan, DmxValueResolution::Fine, &[1, 2]),
                param_at_slots(Attribute::Tilt, DmxValueResolution::Coarse, &[3]),
            ]],
        );
        let target = make_fixture_with_elements(
            Uuid::new_v4(),
            2,
            vec![vec![
                param_at_slots(Attribute::Pan, DmxValueResolution::Fine, &[1, 3]),
                param_at_slots(Attribute::Tilt, DmxValueResolution::Coarse, &[2]),
            ]],
        );

        assert_eq!(fixture_to_fixture_issues(source, target).len(), 1);
    }

    /// Verifies fixtures with identical element structure and slot layout match.
    #[test]
    fn fixture_to_fixture_shape_accepts_identical_layouts() {
        let elements = || {
            vec![
                vec![param_at_slots(
                    Attribute::Pan,
                    DmxValueResolution::Fine,
                    &[1, 3],
                )],
                vec![param_at_slots(
                    Attribute::Tilt,
                    DmxValueResolution::Coarse,
                    &[2],
                )],
            ]
        };
        let source = make_fixture_with_elements(Uuid::new_v4(), 1, elements());
        let target = make_fixture_with_elements(Uuid::new_v4(), 2, elements());

        assert!(fixture_to_fixture_issues(source, target).is_empty());
    }
}
