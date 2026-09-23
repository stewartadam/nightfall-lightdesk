// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Normalize authored function ranges without flattening mutually exclusive controls.
//!
//! Raw DMX values remain integers through 32 bits. Source functions stay available
//! to subsequent selector, profile, relation, and optical-resource compilation.

use std::collections::HashMap;

use gdtf::dmx_mode::{ChannelFunction, DmxChannel, DmxMode, ModeMasterNode};
use gdtf::values::{DmxValue, Node};
use serde::Serialize;

use crate::gdtf_resolver::{ResolveError, ResolvedMode};

/// Inclusive raw range of one authored function within one logical channel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionRange<'a> {
    /// Stable definition-local identity, including its instantiated parent channel.
    pub id: String,
    /// Authored logical-channel index; ranges in distinct logical channels may overlap.
    pub logical_channel: usize,
    /// Authored function index within that logical channel.
    pub function: usize,
    /// First raw value in the function's range.
    pub raw_from: u32,
    /// Last raw value before the next function, or the channel's maximum.
    pub raw_to: u32,
    /// Function default normalized to the channel resolution.
    pub default: u32,
    /// Physical endpoints preserve descending ranges and constant/discrete values.
    pub physical_from: f64,
    /// Physical value at the end of the raw range.
    pub physical_to: f64,
    /// Normalized source selector; binding to an instance is a subsequent pass.
    pub condition: Option<FunctionCondition>,
    /// Complete source retains selectors, sets, units' attribute links and resources.
    #[serde(skip)]
    pub source: &'a ChannelFunction,
}

/// Source selector identity and inclusive activation range in the master's resolution.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionCondition {
    /// Authored master channel index, before reference-instance binding.
    pub source_channel: usize,
    /// Optional logical/function indices when the selector targets a function.
    pub source_function: Option<(usize, usize)>,
    /// Inclusive lower selector value.
    pub raw_from: u32,
    /// Inclusive upper selector value.
    pub raw_to: u32,
}

/// Normalized values and range boundaries for a single instantiated channel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelFunctions<'a> {
    /// Channel identity shared with geometry and wire passes.
    pub id: String,
    /// Physical byte width, or declared precision for a virtual channel.
    pub bytes: u8,
    /// Function selected by InitialFunction, or the first function when absent.
    pub initial_function: usize,
    /// Channel default taken from the selected initial function.
    pub default: u32,
    /// None means that highlight must leave this channel alone.
    pub highlight: Option<u32>,
    /// Logical-channel order followed by authored function order.
    pub functions: Vec<FunctionRange<'a>>,
}

/// Report malformed ranges or links against a stable channel/function identity.
fn error(code: &'static str, path: &str, message: impl Into<String>) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Convert mirroring/shifting values with explicit width and magnitude validation.
pub fn normalize_value(value: DmxValue, bytes: u8) -> Result<u32, ResolveError> {
    let source_bytes = value.bytes().get();
    if !(1..=4).contains(&bytes) || source_bytes > 8 {
        return Err(error(
            "invalid_value_width",
            "DMXValue",
            "Destination must be 1–4 bytes and source at most 8 bytes",
        ));
    }
    let maximum = if source_bytes == 8 {
        u64::MAX
    } else {
        (1_u64 << (source_bytes * 8)) - 1
    };
    if value.value() > maximum {
        return Err(error(
            "invalid_dmx_value",
            "DMXValue",
            "Value exceeds its declared byte width",
        ));
    }
    let storage = value.value().to_be_bytes();
    let source = &storage[8 - usize::from(source_bytes)..];
    let mut result = 0_u32;
    for index in 0..usize::from(bytes) {
        let byte = if index < source.len() {
            source[index]
        } else if value.shifting() {
            0
        } else {
            source[index % source.len()]
        };
        result = (result << 8) | u32::from(byte);
    }
    Ok(result)
}

/// Attach channel/function context to low-level value failures.
fn value_at(value: DmxValue, bytes: u8, path: &str) -> Result<u32, ResolveError> {
    normalize_value(value, bytes).map_err(|mut error| {
        error.path = path.into();
        error
    })
}

/// Determine precision without assigning physical wire slots to virtual channels.
fn channel_bytes(channel: &DmxChannel, path: &str) -> Result<u8, ResolveError> {
    let bytes = match &channel.offset {
        Some(offsets) => offsets.len(),
        None => channel
            .logical_channels
            .iter()
            .flat_map(|l| &l.channel_functions)
            .flat_map(|f| [f.dmx_from.bytes().get(), f.default.bytes().get()])
            .chain(channel.highlight.map(|value| value.bytes().get()))
            .max()
            .unwrap_or(1) as usize,
    };
    if !(1..=4).contains(&bytes) {
        return Err(error(
            "invalid_channel_width",
            path,
            "Channel precision must be one to four bytes",
        ));
    }
    Ok(bytes as u8)
}

/// Authored control identity shared by selector and relation link resolution.
pub(crate) struct SourceLink {
    /// Index into the authored mode channel list.
    pub channel: usize,
    /// Optional authored logical-channel and function indices.
    pub function: Option<(usize, usize)>,
}

/// Resolve exact source channel/function names without depending on parser convenience methods.
pub(crate) fn resolve_source_link(
    node: &Node,
    mode: &DmxMode,
    path: &str,
) -> Result<SourceLink, ResolveError> {
    let parts = node.as_ref();
    if parts.len() != 1 && parts.len() != 3 {
        return Err(error(
            "invalid_source_link",
            path,
            "Link must reference a channel or a channel function",
        ));
    }
    let matches: Vec<_> = mode
        .dmx_channels
        .iter()
        .enumerate()
        .filter(|(_, channel)| {
            let attribute = channel
                .logical_channels
                .first()
                .and_then(|l| l.attribute.first());
            attribute.is_some_and(|attribute| {
                format!("{}_{}", channel.geometry, attribute) == parts[0].as_ref()
            })
        })
        .collect();
    let [(source_channel, master)] = matches.as_slice() else {
        return Err(error(
            "invalid_source_link",
            path,
            "Source channel is missing or ambiguous",
        ));
    };
    let source_function = if parts.len() == 3 {
        let functions: Vec<_> =
            master
                .logical_channels
                .iter()
                .enumerate()
                .flat_map(|(li, logical)| {
                    logical.channel_functions.iter().enumerate().filter_map(
                        move |(fi, function)| {
                            (logical.attribute.first() == Some(&parts[1])
                                && function.name.as_ref() == Some(&parts[2]))
                            .then_some((li, fi))
                        },
                    )
                })
                .collect();
        match functions.as_slice() {
            [indices] => Some(*indices),
            _ => {
                return Err(error(
                    "invalid_source_link",
                    path,
                    "Source function is missing or ambiguous",
                ));
            }
        }
    } else {
        None
    };
    Ok(SourceLink {
        channel: *source_channel,
        function: source_function,
    })
}

/// Normalize a selector's interval in its resolved master's byte width.
fn condition(
    source: &ModeMasterNode,
    mode: &DmxMode,
    path: &str,
) -> Result<FunctionCondition, ResolveError> {
    let link = resolve_source_link(&source.node, mode, path).map_err(|mut error| {
        error.code = "invalid_mode_master";
        error
    })?;
    let bytes = channel_bytes(&mode.dmx_channels[link.channel], path)?;
    let raw_from = value_at(source.from, bytes, path)?;
    let raw_to = value_at(source.to, bytes, path)?;
    if raw_from > raw_to {
        return Err(error("invalid_mode_range", path, "ModeFrom exceeds ModeTo"));
    }
    Ok(FunctionCondition {
        source_channel: link.channel,
        source_function: link.function,
        raw_from,
        raw_to,
    })
}

/// Compile integer ranges and initial/highlight values for every instantiated channel.
pub fn resolve_functions<'a>(
    mode: &ResolvedMode<'a>,
) -> Result<Vec<ChannelFunctions<'a>>, ResolveError> {
    let mut result = Vec::with_capacity(mode.channels.len());
    for channel in &mode.channels {
        let bytes = channel_bytes(channel.source, &channel.id)?;
        let maximum = if bytes == 4 {
            u32::MAX
        } else {
            (1_u32 << (bytes * 8)) - 1
        };
        let mut functions = Vec::new();
        for (logical_channel, logical) in channel.source.logical_channels.iter().enumerate() {
            let conditions = logical
                .channel_functions
                .iter()
                .map(|f| {
                    f.mode_master
                        .as_ref()
                        .map(|m| condition(m, mode.source, &channel.id))
                        .transpose()
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut following = HashMap::new();
            let mut next_in_group = vec![None; conditions.len()];
            for (index, condition) in conditions.iter().enumerate().rev() {
                next_in_group[index] = following.insert(condition, index);
            }
            for (function, source) in logical.channel_functions.iter().enumerate() {
                let id = format!("{}/l/{logical_channel}/f/{function}", channel.id);
                let raw_from = value_at(source.dmx_from, bytes, &id)?;
                let next = next_in_group[function].map(|index| &logical.channel_functions[index]);
                let raw_to = match next {
                    Some(next) => value_at(next.dmx_from, bytes, &id)?.checked_sub(1)
                        .filter(|end| *end >= raw_from)
                        .ok_or_else(|| error("invalid_function_order", &id, "Function ranges must have increasing starts within a logical channel"))?,
                    None => maximum,
                };
                if !source.physical_from.is_finite() || !source.physical_to.is_finite() {
                    return Err(error(
                        "invalid_physical_range",
                        &id,
                        "Physical endpoints must be finite",
                    ));
                }
                functions.push(FunctionRange {
                    default: value_at(source.default, bytes, &id)?,
                    physical_from: source.physical_from,
                    physical_to: source.physical_to,
                    condition: conditions[function].clone(),
                    id,
                    logical_channel,
                    function,
                    raw_from,
                    raw_to,
                    source,
                });
            }
        }
        if functions.is_empty() {
            return Err(error(
                "missing_function",
                &channel.id,
                "Channel has no functions",
            ));
        }
        let initial_function = match channel.source.initial_function.as_ref() {
            None => 0,
            Some(link) => {
                let first_attribute = channel
                    .source
                    .logical_channels
                    .first()
                    .and_then(|l| l.attribute.first())
                    .map(|name| name.as_ref())
                    .unwrap_or("");
                let expected_channel = format!("{}_{}", channel.source.geometry, first_attribute);
                let [channel_name, logical_name, function_name] = link.as_ref() else {
                    return Err(error(
                        "invalid_initial_function",
                        &channel.id,
                        "InitialFunction must identify channel, logical channel, and function",
                    ));
                };
                if channel_name.as_ref() != expected_channel {
                    return Err(error(
                        "invalid_initial_function",
                        &channel.id,
                        "InitialFunction refers to another channel",
                    ));
                }
                let matches: Vec<_> = functions
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| {
                        let logical = &channel.source.logical_channels[f.logical_channel];
                        logical.attribute.first() == Some(logical_name)
                            && f.source.name.as_ref() == Some(function_name)
                    })
                    .map(|(index, _)| index)
                    .collect();
                match matches.as_slice() {
                    [index] => *index,
                    _ => {
                        return Err(error(
                            "invalid_initial_function",
                            &channel.id,
                            "InitialFunction does not identify exactly one function",
                        ));
                    }
                }
            }
        };
        result.push(ChannelFunctions {
            id: channel.id.clone(),
            bytes,
            initial_function,
            default: functions[initial_function].default,
            highlight: channel
                .source
                .highlight
                .map(|v| value_at(v, bytes, &channel.id))
                .transpose()?,
            functions,
        });
    }
    Ok(result)
}
