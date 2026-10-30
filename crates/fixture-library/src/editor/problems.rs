// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Checks a draft for problems before it is previewed or saved.
//!
//! Every mode is also converted the way the library converts a saved file,
//! so anything the converter rejects or tolerates shows up here first.

use std::collections::{HashMap, HashSet};

use gdtf::dmx_mode::{DmxBreak, DmxMode};
use gdtf::fixture_type::FixtureType;

use super::draft::FixtureDraft;
use super::edit::wheel_slot_counts;
use super::view::{DraftProblem, ProblemSeverity, channel_resolution, footprint, value_at};
use crate::converters::gdtf::convert_gdtf_mode;
use crate::converters::gdtf_resolve::GdtfDiagnostic;

/// Addresses in one DMX universe.
const UNIVERSE_SIZE: u32 = 512;

/// Finds every problem in a draft, errors first.
pub(super) fn find_problems(draft: &FixtureDraft) -> Vec<DraftProblem> {
    let fixture_type = draft.fixture_type();
    let mut problems = Vec::new();
    check_info(fixture_type, &mut problems);
    if fixture_type.dmx_modes.is_empty() {
        problems.push(problem(
            ProblemSeverity::Error,
            "The fixture needs at least one mode",
            None,
            None,
        ));
    }
    let mut names = HashSet::new();
    for (index, mode) in fixture_type.dmx_modes.iter().enumerate() {
        let index = index as u32;
        let name = mode
            .name
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default();
        if name.is_empty() {
            problems.push(problem(
                ProblemSeverity::Error,
                "Every mode needs a name",
                Some(index),
                None,
            ));
        } else if !names.insert(name.clone()) {
            problems.push(problem(
                ProblemSeverity::Error,
                &format!("Two modes are named {name}"),
                Some(index),
                None,
            ));
        }
        check_mode(fixture_type, mode, index, &mut problems);
    }
    if !fixture_type.dmx_modes.is_empty() && !controls_intensity(fixture_type) {
        problems.push(problem(
            ProblemSeverity::Warning,
            "No channel controls intensity (Dimmer or Shutter), so the fixture cannot be faded or blacked out",
            None,
            None,
        ));
    }
    problems.extend(conversion_problems(draft));
    problems.sort_by_key(|problem| problem.severity != ProblemSeverity::Error);
    problems
}

/// Whether any problem blocks saving.
pub(super) fn has_errors(problems: &[DraftProblem]) -> bool {
    problems
        .iter()
        .any(|problem| problem.severity == ProblemSeverity::Error)
}

/// Builds one problem.
fn problem(
    severity: ProblemSeverity,
    message: &str,
    mode: Option<u32>,
    channel: Option<u32>,
) -> DraftProblem {
    DraftProblem {
        severity,
        message: message.to_string(),
        mode,
        channel,
    }
}

/// Checks the names a library entry is identified by.
fn check_info(fixture_type: &FixtureType, problems: &mut Vec<DraftProblem>) {
    if fixture_type
        .name
        .as_ref()
        .is_none_or(|name| name.trim().is_empty())
    {
        problems.push(problem(
            ProblemSeverity::Error,
            "The fixture needs a name",
            None,
            None,
        ));
    }
    if fixture_type.manufacturer.trim().is_empty() {
        problems.push(problem(
            ProblemSeverity::Error,
            "The fixture needs a manufacturer",
            None,
            None,
        ));
    }
}

/// Checks one mode's channels, addresses, functions and wheel links.
fn check_mode(
    fixture_type: &FixtureType,
    mode: &DmxMode,
    index: u32,
    problems: &mut Vec<DraftProblem>,
) {
    if mode.dmx_channels.is_empty() {
        problems.push(problem(
            ProblemSeverity::Error,
            "The mode has no channels",
            Some(index),
            None,
        ));
    }
    if footprint(mode) > UNIVERSE_SIZE {
        problems.push(problem(
            ProblemSeverity::Error,
            &format!("The mode uses more than {UNIVERSE_SIZE} addresses"),
            Some(index),
            None,
        ));
    }
    let wheels = wheel_slot_counts(fixture_type);
    let mut used: HashMap<(DmxBreak, i32), u32> = HashMap::new();
    let mut channel_names = HashSet::new();
    for (channel_index, channel) in mode.dmx_channels.iter().enumerate() {
        let channel_index = channel_index as u32;
        let at = |severity, message: String| {
            problem(severity, &message, Some(index), Some(channel_index))
        };
        for &address in channel.offset.iter().flatten() {
            if address < 1 {
                problems.push(at(
                    ProblemSeverity::Error,
                    format!("Address {address} is not a DMX address"),
                ));
            } else if let Some(other) = used.insert((channel.dmx_break, address), channel_index) {
                problems.push(at(
                    ProblemSeverity::Error,
                    format!("Address {address} is also used by channel {}", other + 1),
                ));
            }
        }
        let channel_name = channel.name();
        if !channel_names.insert(channel_name.clone()) {
            problems.push(at(
                ProblemSeverity::Error,
                format!(
                    "Another channel is also named {channel_name}; channels on the same part need different attributes"
                ),
            ));
        }
        if channel.logical_channels.is_empty() {
            problems.push(at(
                ProblemSeverity::Error,
                "The channel has no functions".to_string(),
            ));
        }
        let max = (1u64 << (8 * u32::from(channel_resolution(channel)))) - 1;
        for (logical_index, logical) in channel.logical_channels.iter().enumerate() {
            let mut previous: Option<u64> = None;
            for (function_index, function) in logical.channel_functions.iter().enumerate() {
                let name = function
                    .name
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default();
                let start = u64::from(value_at(function.dmx_from, channel_resolution(channel)));
                if previous.is_some_and(|previous| start <= previous) {
                    problems.push(at(
                        ProblemSeverity::Error,
                        format!("Function {name} must start after the function before it"),
                    ));
                }
                if logical_index == 0 && function_index == 0 && start > 0 {
                    problems.push(at(
                        ProblemSeverity::Warning,
                        format!("DMX values below {start} do nothing"),
                    ));
                }
                let end = logical
                    .channel_functions
                    .get(function_index + 1)
                    .map_or(max, |next| {
                        u64::from(value_at(next.dmx_from, channel_resolution(channel)))
                            .saturating_sub(1)
                    });
                let sets_outside = function.channel_sets.iter().any(|set| {
                    let value = u64::from(value_at(set.dmx_from, channel_resolution(channel)));
                    value < start || value > end
                });
                if sets_outside {
                    problems.push(at(
                        ProblemSeverity::Warning,
                        format!("Function {name} has ranges outside its DMX values"),
                    ));
                }
                let slots = function.wheel.as_ref().map(|wheel| {
                    wheels
                        .iter()
                        .find(|(name, _)| wheel.as_ref() == std::slice::from_ref(name))
                        .map(|(_, slots)| *slots)
                });
                if let (Some(wheel), Some(None)) = (&function.wheel, slots) {
                    problems.push(at(
                        ProblemSeverity::Error,
                        format!("Function {name} uses a missing wheel {wheel}"),
                    ));
                }
                let slot_count = slots.flatten().unwrap_or(0);
                if function.channel_sets.iter().any(|set| {
                    set.wheel_slot_index
                        .is_some_and(|slot| slot < 1 || slot as usize > slot_count)
                }) {
                    problems.push(at(
                        ProblemSeverity::Error,
                        format!("Function {name} has ranges that select missing wheel slots"),
                    ));
                }
                previous = Some(start);
            }
        }
    }
}

/// Whether any channel controls a dimmer or shutter attribute.
fn controls_intensity(fixture_type: &FixtureType) -> bool {
    fixture_type
        .dmx_modes
        .iter()
        .flat_map(|mode| &mode.dmx_channels)
        .flat_map(|channel| &channel.logical_channels)
        .flat_map(|logical| &logical.channel_functions)
        .any(|function| {
            let attribute = function.attribute.to_string();
            attribute == "Dimmer" || attribute.starts_with("Shutter")
        })
}

/// Converts every mode like the library does and reports what the converter rejected or tolerated.
fn conversion_problems(draft: &FixtureDraft) -> Vec<DraftProblem> {
    let mut gdtf = match super::save::gdtf_file(draft, false) {
        Ok(gdtf) => gdtf,
        Err(error) => {
            return vec![problem(
                ProblemSeverity::Error,
                &format!("The fixture cannot be read: {error}"),
                None,
                None,
            )];
        }
    };
    let metadata = super::save::metadata(draft);
    let mut problems = Vec::new();
    for (index, mode) in draft.fixture_type().dmx_modes.iter().enumerate() {
        let Some(name) = mode
            .name
            .as_ref()
            .map(ToString::to_string)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let index = Some(index as u32);
        match convert_gdtf_mode(&mut gdtf, &metadata, &name, 0) {
            Ok(converted) => problems.extend(converted.diagnostics.iter().map(|diagnostic| {
                problem(
                    ProblemSeverity::Warning,
                    &diagnostic_message(diagnostic),
                    index,
                    None,
                )
            })),
            Err(error) => problems.push(problem(
                ProblemSeverity::Error,
                &format!("The mode cannot be loaded: {error}"),
                index,
                None,
            )),
        }
    }
    problems
}

/// Explains a converter diagnostic to an operator.
fn diagnostic_message(diagnostic: &GdtfDiagnostic) -> String {
    match diagnostic {
        GdtfDiagnostic::MissingModeRoot { root } => {
            format!("The mode's geometry {root} is not a top-level part; the first part is used")
        }
        GdtfDiagnostic::DanglingReference { reference, target } => {
            format!("Part {reference} refers to a missing part {target}")
        }
        GdtfDiagnostic::ReferenceCycle { reference } => {
            format!("Part {reference} refers to itself")
        }
        GdtfDiagnostic::ExpansionLimit => {
            "The geometry has too many parts; some were left out".to_string()
        }
        GdtfDiagnostic::UnreachableChannel {
            geometry,
            bound_to_root,
        } => {
            if *bound_to_root {
                format!("A channel controls {geometry}, which is not part of this mode's geometry")
            } else {
                format!(
                    "A virtual channel controls {geometry}, which is not part of this mode's geometry, and is ignored"
                )
            }
        }
        GdtfDiagnostic::MissingReferenceBreak {
            reference,
            dmx_break,
        } => {
            format!("Part {reference} has no address for DMX break {dmx_break}")
        }
        GdtfDiagnostic::DuplicateGeometryName { name } => format!("Two parts are named {name}"),
        GdtfDiagnostic::UnrepresentableChannel { instance, .. } => {
            format!(
                "A channel on {instance} uses more than four bytes or crosses a universe and is ignored"
            )
        }
        GdtfDiagnostic::UnresolvedLink { link } => {
            format!("Link {link} names a channel that does not exist")
        }
        GdtfDiagnostic::SharedSlots { instance, offsets } => {
            format!("A channel on {instance} reuses addresses {offsets:?} and does not output")
        }
    }
}
