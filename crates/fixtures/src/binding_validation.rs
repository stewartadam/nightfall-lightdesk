// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Binding validation rules for patch bindings.

use std::collections::HashMap;
use std::fmt;
use std::ops::RangeInclusive;
use std::str::FromStr;

use bevy_ecs::change_detection::DetectChanges;
use bevy_ecs::prelude::{Res, Resource};
use nightfall_dmx::prelude::*;
use nightfall_io::BindingTransport;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::bindings::{
    DmxRange, InputBindings, InputSource, InputTarget, OutputBindings, OutputSource, OutputTarget,
};
use crate::data_provider_ext::FixtureDataProviderExt;
use crate::fixture::Fixture;
use crate::parameter::ParameterMetadata;
use crate::prelude::DisabledBindings;
use crate::wire_layout::WireLayout;

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
    issues.extend(validate_console_address_uniqueness(
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

fn validate_console_address_uniqueness(
    output_bindings: &OutputBindings,
    data_provider: &FixtureDataProviderExt,
) -> Vec<BindingValidationIssue> {
    let mut issues = Vec::new();
    let mut occupancy: HashMap<(u16, u16), Uuid> = HashMap::new();

    for binding in &output_bindings.bindings {
        let (
            OutputSource::Fixture {
                uids,
                element,
                param,
            },
            OutputTarget::Console { universe, address },
        ) = (&binding.source, &binding.target)
        else {
            continue;
        };

        let universes = expand_universe_range(*universe, 1);
        for universe_id in universes {
            let start_address = address.unwrap_or(1);
            let mut next_address = start_address;

            for uid in uids {
                let shape = match fixture_shape_for_binding(
                    data_provider,
                    *uid,
                    *element,
                    param.as_deref(),
                ) {
                    Ok(shape) => shape,
                    Err(issue) => {
                        issues.push(issue);
                        continue;
                    }
                };
                let footprint = shape_footprint(&shape);
                if footprint == 0 {
                    continue;
                }

                let assigned_start = if binding.clone {
                    start_address
                } else {
                    next_address
                };
                let assigned_end = assigned_start.saturating_add(footprint - 1);
                if !binding.clone {
                    next_address = assigned_end.saturating_add(1);
                }

                for addr in assigned_start..=assigned_end {
                    let key = (universe_id, addr);
                    if let Some(existing_uid) = occupancy.get(&key) {
                        if existing_uid != uid {
                            issues.push(BindingValidationIssue::for_fixtures(
                                format!(
                                    "Console address overlap at universe {} address {} (fixtures {} and {})",
                                    universe_id,
                                    addr,
                                    existing_uid,
                                    uid
                                ),
                                [*existing_uid, *uid],
                            ));
                        }
                    } else {
                        occupancy.insert(key, *uid);
                    }
                }
            }
        }
    }

    issues
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
                OutputSource::Fixture {
                    uids,
                    element,
                    param,
                },
                OutputTarget::Transport {
                    target,
                    universe,
                    address,
                },
            ) => {
                let universes = expand_universe_range(*universe, 1);
                for universe_id in universes {
                    let mut next_address = address.unwrap_or(1);
                    for uid in uids {
                        let fixture = match data_provider.inner.get(*uid) {
                            Ok(fixture) => fixture,
                            Err(_) => continue,
                        };
                        let shape = match fixture_shape(fixture.value(), *element, param.as_deref())
                        {
                            Ok(shape) => shape,
                            Err(_) => continue,
                        };
                        let footprint = shape_footprint(&shape);
                        if footprint == 0 {
                            continue;
                        }
                        let start = if binding.clone {
                            address.unwrap_or(1)
                        } else {
                            next_address
                        };
                        let end = start.saturating_add(footprint - 1);
                        if !binding.clone {
                            next_address = end.saturating_add(1);
                        }
                        spans.push(TransportSpan {
                            transport: target.clone(),
                            universe: universe_id..=universe_id,
                            address: start..=end,
                            kind: TransportSpanKind::Fixture,
                            label: format!("fixture {}", fixture.identifiers.id),
                            fixtures: vec![*uid],
                        });
                    }
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
    /// Selected parameters of each selected element, in fixture order.
    elements: Vec<Vec<ParameterMetadata>>,
    /// Whether the binding selects only part of the fixture and starts at its first selected byte.
    partial: bool,
}

impl FixtureShape {
    /// Lays out the selection's bytes, keyed by `(element, parameter)` position.
    ///
    /// Partial selections are rebased so their first byte sits at slot zero,
    /// matching how the binding patches them at its address.
    fn layout(&self) -> WireLayout<(usize, usize)> {
        let layout = WireLayout::new(self.elements.iter().enumerate().flat_map(
            |(element_index, parameters)| {
                parameters
                    .iter()
                    .enumerate()
                    .map(move |(parameter_index, metadata)| {
                        ((element_index, parameter_index), metadata)
                    })
            },
        ));
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
        None => (0..fixture.elements.len()).collect(),
    };

    let mut elements = Vec::new();
    for idx in element_indices {
        let element = &fixture.elements[idx];
        let parameters = if let Some(param_name) = param {
            let attribute = attribute_from_param(param_name);
            let metadata = element
                .parameters
                .iter()
                .find(|param| param.attribute == attribute)
                .ok_or_else(|| {
                    BindingValidationIssue::new(format!(
                        "Fixture {} missing parameter {:?}",
                        fixture.identifiers.uid, attribute
                    ))
                })?;
            vec![metadata.clone()]
        } else {
            element.parameters.clone()
        };
        elements.push(parameters);
    }

    Ok(FixtureShape {
        elements,
        partial: element.is_some() || param.is_some(),
    })
}

/// Returns the number of DMX slots a binding's selection spans.
fn shape_footprint(shape: &FixtureShape) -> u16 {
    shape.layout().footprint()
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

fn expand_universe_range(range: Option<DmxRange>, default_universe: u16) -> Vec<u16> {
    match range {
        Some(range) => (range.start..=range.end).collect(),
        None => vec![default_universe],
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
    use crate::prelude::ParameterMetadata;

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

        let issues = validate_console_address_uniqueness(&output_bindings, &provider);
        assert!(!issues.is_empty());
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
            dmx_slots: crate::parameter::DmxSlots::Explicit {
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
