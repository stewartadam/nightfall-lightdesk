// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Normalize channel-set intervals while retaining physical overrides and wheel slots.

use serde::Serialize;

use crate::gdtf_functions::{ChannelFunctions, normalize_value};
use crate::gdtf_resolver::ResolveError;

/// An authored channel set bounded by its next sibling or parent function's end.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSet {
    /// Stable definition-local identity; display labels are not selectors.
    pub id: String,
    /// Optional authored label for a discrete choice or range.
    pub name: Option<String>,
    /// Inclusive starting raw value at the parent channel's precision.
    pub raw_from: u32,
    /// Inclusive last value, never beyond the parent function.
    pub raw_to: u32,
    /// Explicit physical override; None retains inheritance from the function.
    pub physical_from: Option<f64>,
    /// Explicit upper physical override, including descending or constant ranges.
    pub physical_to: Option<f64>,
    /// Zero-based wheel slot; the parser already converts authored one-based values.
    pub wheel_slot: Option<usize>,
}

/// Sets for one function, including the endpoints needed to resolve inheritance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionSets {
    /// Corresponding normalized function identity.
    pub id: String,
    /// Authored physical start used when a set omits its own endpoint.
    pub physical_from: f64,
    /// Authored physical end used when a set omits its own endpoint.
    pub physical_to: f64,
    /// Sets in ascending authored raw order; gaps before the first set are permitted.
    pub sets: Vec<ChannelSet>,
}

impl FunctionSets {
    /// Find a set without clamping a value into a neighboring function or unlabeled gap.
    pub fn at(&self, raw: u32) -> Option<&ChannelSet> {
        let index = self
            .sets
            .partition_point(|set| set.raw_from <= raw)
            .checked_sub(1)?;
        self.sets.get(index).filter(|set| raw <= set.raw_to)
    }
}

/// Preserve the function location when a set has invalid data.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Normalize all channel sets with an explicit total expansion budget.
pub fn resolve_sets(
    channels: &[ChannelFunctions<'_>],
    limit: usize,
) -> Result<Vec<Vec<FunctionSets>>, ResolveError> {
    let mut count = 0usize;
    let mut result = Vec::with_capacity(channels.len());
    for channel in channels {
        let mut functions = Vec::with_capacity(channel.functions.len());
        for function in &channel.functions {
            let source = &function.source.channel_sets;
            count = count
                .checked_add(source.len())
                .filter(|n| *n <= limit)
                .ok_or_else(|| {
                    error(
                        "set_limit",
                        &function.id,
                        "Expanded channel sets exceed the compilation budget",
                    )
                })?;
            let starts: Vec<_> = source
                .iter()
                .map(|set| {
                    normalize_value(set.dmx_from, channel.bytes).map_err(|mut error| {
                        error.path = function.id.clone();
                        error
                    })
                })
                .collect::<Result<_, _>>()?;
            let mut sets = Vec::with_capacity(source.len());
            for (index, set) in source.iter().enumerate() {
                let id = format!("{}/s/{index}", function.id);
                let raw_from = starts[index];
                let raw_to = match starts.get(index + 1) {
                    Some(next) => next
                        .checked_sub(1)
                        .filter(|to| *to >= raw_from)
                        .ok_or_else(|| {
                            error(
                                "invalid_set_order",
                                &id,
                                "Channel set starts must be strictly increasing",
                            )
                        })?,
                    None => function.raw_to,
                };
                if raw_from < function.raw_from || raw_to > function.raw_to || raw_from > raw_to {
                    return Err(error(
                        "invalid_set_range",
                        &id,
                        "Channel set lies outside its parent function",
                    ));
                }
                if [set.physical_from, set.physical_to]
                    .into_iter()
                    .flatten()
                    .any(|value| !value.is_finite())
                {
                    return Err(error(
                        "invalid_set_physical",
                        &id,
                        "Physical overrides must be finite",
                    ));
                }
                let wheel_slot = set
                    .wheel_slot_index
                    .map(|slot| {
                        usize::try_from(slot).map_err(|_| {
                            error(
                                "invalid_wheel_slot",
                                &id,
                                "Parsed wheel slots must be nonnegative",
                            )
                        })
                    })
                    .transpose()?;
                sets.push(ChannelSet {
                    id,
                    name: set.name.as_ref().map(ToString::to_string),
                    raw_from,
                    raw_to,
                    physical_from: set.physical_from,
                    physical_to: set.physical_to,
                    wheel_slot,
                });
            }
            functions.push(FunctionSets {
                id: function.id.clone(),
                physical_from: function.physical_from,
                physical_to: function.physical_to,
                sets,
            });
        }
        result.push(functions);
    }
    Ok(result)
}
