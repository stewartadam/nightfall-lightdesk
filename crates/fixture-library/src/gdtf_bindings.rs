// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bind authored selectors to independent instances of repeated fixture parts.

use serde::Serialize;

use crate::gdtf_functions::ChannelFunctions;
use crate::gdtf_resolver::{ResolveError, ResolvedMode};

/// A selector targeting a resolved channel and optionally one of its functions.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundCondition {
    /// Instantiated channel index, never an authored template index.
    pub channel: usize,
    /// Index in the target channel's normalized functions, if explicitly selected.
    pub function: Option<usize>,
    /// Inclusive raw activation interval in the target channel's precision.
    pub raw_from: u32,
    /// Inclusive upper activation value.
    pub raw_to: u32,
}

/// Selector arrays aligned with normalized channels and their functions.
#[derive(Debug, Serialize)]
pub struct SelectorBindings {
    /// None denotes a function without a ModeMaster condition.
    pub channels: Vec<Vec<Option<BoundCondition>>>,
}

/// Report an invalid compiler input or ambiguous instance without choosing arbitrarily.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Resolve local masters in the same reference scope, or a shared enclosing scope.
pub fn bind_selectors(
    mode: &ResolvedMode<'_>,
    functions: &[ChannelFunctions<'_>],
) -> Result<SelectorBindings, ResolveError> {
    if functions.len() != mode.channels.len()
        || functions
            .iter()
            .zip(&mode.channels)
            .any(|(f, c)| f.id != c.id)
    {
        return Err(error(
            "mismatched_functions",
            &mode.name,
            "Functions must belong to the same resolved mode and channel order",
        ));
    }
    let mut instances = vec![Vec::new(); mode.source.dmx_channels.len()];
    for (index, channel) in mode.channels.iter().enumerate() {
        instances[channel.source_index].push(index);
    }
    let mut channels = Vec::with_capacity(functions.len());
    for (index, channel) in functions.iter().enumerate() {
        let scope = mode.channel_scope(&mode.channels[index]);
        let mut bindings = Vec::with_capacity(channel.functions.len());
        for function in &channel.functions {
            let Some(condition) = &function.condition else {
                bindings.push(None);
                continue;
            };
            let candidates = instances.get(condition.source_channel).ok_or_else(|| {
                error(
                    "invalid_selector_instance",
                    &function.id,
                    "Selector source channel is outside this mode",
                )
            })?;
            let target = if let [single] = candidates.as_slice() {
                *single
            } else {
                let mut best = None;
                let mut ambiguous = false;
                for &candidate in candidates {
                    let target_scope = mode.channel_scope(&mode.channels[candidate]);
                    if target_scope.len() > scope.len()
                        || !target_scope
                            .iter()
                            .zip(scope)
                            .all(|(a, b)| std::ptr::eq(*a, *b))
                    {
                        continue;
                    }
                    match best {
                        Some((depth, _)) if depth > target_scope.len() => {}
                        Some((depth, _)) if depth == target_scope.len() => ambiguous = true,
                        _ => {
                            best = Some((target_scope.len(), candidate));
                            ambiguous = false;
                        }
                    }
                }
                match best {
                    Some((_, target)) if !ambiguous => target,
                    _ => {
                        return Err(error(
                            "ambiguous_selector_instance",
                            &function.id,
                            "Selector does not identify one master in this part's reference scope",
                        ));
                    }
                }
            };
            let target_function = condition
                .source_function
                .map(|(logical, authored)| {
                    functions[target]
                        .functions
                        .iter()
                        .position(|f| f.logical_channel == logical && f.function == authored)
                        .ok_or_else(|| {
                            error(
                                "invalid_selector_function",
                                &function.id,
                                "Selector function is missing from its resolved channel",
                            )
                        })
                })
                .transpose()?;
            bindings.push(Some(BoundCondition {
                channel: target,
                function: target_function,
                raw_from: condition.raw_from,
                raw_to: condition.raw_to,
            }));
        }
        channels.push(bindings);
    }
    Ok(SelectorBindings { channels })
}
