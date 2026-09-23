// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Function-level physical conversion; selection and channel-set overrides remain separate.

use serde::Serialize;

use crate::gdtf_functions::ChannelFunctions;
use crate::gdtf_profiles::ProfileLibrary;
use crate::gdtf_resolver::ResolveError;

/// Owned endpoints and an optional immutable profile index for one function.
#[derive(Debug, Serialize)]
struct Mapping {
    id: String,
    raw_from: u32,
    raw_to: u32,
    physical_from: f64,
    physical_to: f64,
    profile: Option<usize>,
}

/// Owned mappings in normalized channel/function order sharing one profile library.
#[derive(Debug, Serialize)]
pub struct PhysicalMappings {
    profiles: ProfileLibrary,
    channels: Vec<Vec<Mapping>>,
}

/// Report conversion failures against the exact function rather than guessing a value.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Bind function profiles and physical endpoints without retaining parser references.
pub fn compile_physical(
    channels: &[ChannelFunctions<'_>],
    profiles: ProfileLibrary,
    function_limit: usize,
) -> Result<PhysicalMappings, ResolveError> {
    let mut count = 0usize;
    let mut result = Vec::with_capacity(channels.len());
    for channel in channels {
        count = count
            .checked_add(channel.functions.len())
            .filter(|n| *n <= function_limit)
            .ok_or_else(|| {
                error(
                    "function_limit",
                    &channel.id,
                    "Physical mappings exceed the compilation budget",
                )
            })?;
        let mut mappings = Vec::with_capacity(channel.functions.len());
        for function in &channel.functions {
            let profile = function
                .source
                .dmx_profile
                .as_ref()
                .map(|link| {
                    profiles.resolve(link).map_err(|mut error| {
                        error.path = function.id.clone();
                        error
                    })
                })
                .transpose()?;
            let (from, to) = if profile.is_some() {
                (
                    function.source.min.unwrap_or(function.physical_from),
                    function.source.max.unwrap_or(function.physical_to),
                )
            } else {
                (function.physical_from, function.physical_to)
            };
            if !from.is_finite()
                || !to.is_finite()
                || !(to - from).is_finite()
                || function.raw_from > function.raw_to
            {
                return Err(error(
                    "invalid_physical_mapping",
                    &function.id,
                    "Physical endpoints and span must be finite, with ordered raw bounds",
                ));
            }
            mappings.push(Mapping {
                id: function.id.clone(),
                raw_from: function.raw_from,
                raw_to: function.raw_to,
                physical_from: from,
                physical_to: to,
                profile,
            });
        }
        result.push(mappings);
    }
    Ok(PhysicalMappings {
        profiles,
        channels: result,
    })
}

impl PhysicalMappings {
    /// Reject stale or mismatched indices instead of reading a different function.
    fn mapping(&self, channel: usize, function: usize) -> Result<&Mapping, ResolveError> {
        self.channels
            .get(channel)
            .and_then(|c| c.get(function))
            .ok_or_else(|| {
                error(
                    "missing_physical_mapping",
                    "physical",
                    "Channel/function index is outside the compiled definition",
                )
            })
    }

    /// Evaluate the parent function's physical value, without selecting it or applying channel sets/relations.
    pub fn evaluate_function(
        &self,
        channel: usize,
        function: usize,
        raw: u32,
    ) -> Result<f64, ResolveError> {
        let mapping = self.mapping(channel, function)?;
        if raw < mapping.raw_from || raw > mapping.raw_to {
            return Err(error(
                "raw_outside_function",
                &mapping.id,
                "Raw value lies outside the selected function",
            ));
        }
        let fraction = match mapping.profile {
            Some(index) => {
                self.profiles
                    .get(index)
                    .expect("profile index validated during compilation")
                    .evaluate_raw(raw, mapping.raw_from, mapping.raw_to)?
                    / 100.0
            }
            None if mapping.raw_from == mapping.raw_to => 0.0,
            None => {
                f64::from(raw - mapping.raw_from) / f64::from(mapping.raw_to - mapping.raw_from)
            }
        };
        let value =
            mapping.physical_from + (mapping.physical_to - mapping.physical_from) * fraction;
        if !value.is_finite() {
            return Err(error(
                "physical_output_overflow",
                &mapping.id,
                "Physical evaluation produced a nonfinite value",
            ));
        }
        Ok(value)
    }

    /// Quantize a linear physical target to the nearest raw integer, rejecting ambiguous or unsupported inverses.
    pub fn encode_linear(
        &self,
        channel: usize,
        function: usize,
        value: f64,
    ) -> Result<u32, ResolveError> {
        let mapping = self.mapping(channel, function)?;
        if mapping.profile.is_some() {
            return Err(error(
                "profile_inverse_unavailable",
                &mapping.id,
                "A profile requires explicit inverse analysis before physical encoding",
            ));
        }
        if !value.is_finite()
            || value < mapping.physical_from.min(mapping.physical_to)
            || value > mapping.physical_from.max(mapping.physical_to)
        {
            return Err(error(
                "physical_outside_function",
                &mapping.id,
                "Physical target lies outside the function's range",
            ));
        }
        if mapping.raw_from == mapping.raw_to {
            return if value == mapping.physical_from {
                Ok(mapping.raw_from)
            } else {
                Err(error(
                    "unrepresentable_physical_value",
                    &mapping.id,
                    "A single raw value represents only the starting physical value",
                ))
            };
        }
        if mapping.physical_from == mapping.physical_to {
            return Err(error(
                "ambiguous_physical_inverse",
                &mapping.id,
                "Multiple raw values represent this constant physical value",
            ));
        }
        let fraction =
            (value - mapping.physical_from) / (mapping.physical_to - mapping.physical_from);
        let delta = (fraction * f64::from(mapping.raw_to - mapping.raw_from)).round() as u32;
        Ok(mapping.raw_from + delta)
    }
}
