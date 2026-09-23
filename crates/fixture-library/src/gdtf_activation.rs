// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compile bounded, nonrecursive evaluation of channel-function mode dependencies.

use serde::Serialize;

use crate::gdtf_bindings::SelectorBindings;
use crate::gdtf_functions::ChannelFunctions;
use crate::gdtf_resolver::ResolveError;

/// One owned raw-value gate, optionally dependent on another function's activation.
#[derive(Debug, Serialize)]
struct Gate {
    channel: usize,
    from: u32,
    to: u32,
    dependency: Option<usize>,
}

/// One compiled function, retaining its channel-local index for returned selections.
#[derive(Debug, Serialize)]
struct Function {
    channel: usize,
    index: usize,
    from: u32,
    to: u32,
    gate: Option<Gate>,
}

/// Immutable activation program; construction validates all indices and dependencies.
#[derive(Debug, Serialize)]
pub struct ActivationProgram {
    maxima: Vec<u32>,
    functions: Vec<Function>,
    order: Vec<usize>,
}

/// Associate a failed activation invariant with its definition-local identity.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Compile inclusive raw gates and a dependency-first order without recursive traversal.
pub fn compile_activation(
    channels: &[ChannelFunctions<'_>],
    bindings: &SelectorBindings,
    function_limit: usize,
) -> Result<ActivationProgram, ResolveError> {
    if channels.len() != bindings.channels.len()
        || channels
            .iter()
            .zip(&bindings.channels)
            .any(|(c, b)| c.functions.len() != b.len())
    {
        return Err(error(
            "mismatched_bindings",
            "activation",
            "Every function must have a corresponding selector binding",
        ));
    }
    let mut offsets = Vec::with_capacity(channels.len());
    let mut count = 0usize;
    let mut maxima = Vec::with_capacity(channels.len());
    for channel in channels {
        offsets.push(count);
        count = count
            .checked_add(channel.functions.len())
            .filter(|n| *n <= function_limit)
            .ok_or_else(|| {
                error(
                    "function_limit",
                    &channel.id,
                    "Expanded function count exceeds activation budget",
                )
            })?;
        if !(1..=4).contains(&channel.bytes) {
            return Err(error(
                "invalid_channel_width",
                &channel.id,
                "Activation requires one to four byte channels",
            ));
        }
        maxima.push(u32::MAX >> (32 - u32::from(channel.bytes) * 8));
    }
    let mut functions = Vec::with_capacity(count);
    for (channel, source) in channels.iter().enumerate() {
        for (index, function) in source.functions.iter().enumerate() {
            if function.raw_from > function.raw_to || function.raw_to > maxima[channel] {
                return Err(error(
                    "invalid_function_range",
                    &function.id,
                    "Function interval is outside channel precision",
                ));
            }
            let gate = bindings.channels[channel][index]
                .as_ref()
                .map(|bound| {
                    let master = channels.get(bound.channel).ok_or_else(|| {
                        error(
                            "invalid_selector_instance",
                            &function.id,
                            "Selector channel is missing",
                        )
                    })?;
                    if bound.raw_from > bound.raw_to || bound.raw_to > maxima[bound.channel] {
                        return Err(error(
                            "invalid_mode_range",
                            &function.id,
                            "Selector interval is outside master precision",
                        ));
                    }
                    let dependency = bound
                        .function
                        .map(|target| {
                            if target >= master.functions.len() {
                                return Err(error(
                                    "invalid_selector_function",
                                    &function.id,
                                    "Selector function is missing",
                                ));
                            }
                            Ok(offsets[bound.channel] + target)
                        })
                        .transpose()?;
                    Ok(Gate {
                        channel: bound.channel,
                        from: bound.raw_from,
                        to: bound.raw_to,
                        dependency,
                    })
                })
                .transpose()?;
            functions.push(Function {
                channel,
                index,
                from: function.raw_from,
                to: function.raw_to,
                gate,
            });
        }
    }
    let mut states = vec![0u8; count];
    let mut order = Vec::with_capacity(count);
    let mut path = Vec::new();
    for start in 0..count {
        let mut cursor = Some(start);
        while let Some(node) = cursor {
            match states[node] {
                2 => break,
                1 => {
                    let function = &functions[node];
                    return Err(error(
                        "selector_cycle",
                        &channels[function.channel].functions[function.index].id,
                        "Function selectors contain a dependency cycle",
                    ));
                }
                _ => {}
            }
            states[node] = 1;
            path.push(node);
            cursor = functions[node]
                .gate
                .as_ref()
                .and_then(|gate| gate.dependency);
        }
        while let Some(node) = path.pop() {
            states[node] = 2;
            order.push(node);
        }
    }
    Ok(ActivationProgram {
        maxima,
        functions,
        order,
    })
}

impl ActivationProgram {
    /// Return all eligible function indices per channel without choosing among overlapping logical channels.
    pub fn evaluate(&self, values: &[u32]) -> Result<Vec<Vec<usize>>, ResolveError> {
        if values.len() != self.maxima.len()
            || values
                .iter()
                .zip(&self.maxima)
                .any(|(value, max)| value > max)
        {
            return Err(error(
                "invalid_raw_snapshot",
                "activation",
                "Snapshot must contain one in-range raw value per compiled channel",
            ));
        }
        let mut active = vec![false; self.functions.len()];
        for &node in &self.order {
            let function = &self.functions[node];
            let value = values[function.channel];
            active[node] = (function.from..=function.to).contains(&value)
                && function.gate.as_ref().is_none_or(|gate| {
                    (gate.from..=gate.to).contains(&values[gate.channel])
                        && gate.dependency.is_none_or(|target| active[target])
                });
        }
        let mut result = vec![Vec::new(); values.len()];
        for (function, active) in self.functions.iter().zip(active) {
            if active {
                result[function.channel].push(function.index);
            }
        }
        Ok(result)
    }
}
