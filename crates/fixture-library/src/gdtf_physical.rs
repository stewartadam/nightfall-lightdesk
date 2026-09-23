// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Physical conversion for functions and channel-set overrides; activation remains separate.

use std::collections::HashSet;

use gdtf::attribute::{PhysicalUnit, SubPhysicalUnitType};
use serde::Serialize;

use crate::gdtf_attributes::AttributeLibrary;
use crate::gdtf_functions::ChannelFunctions;
use crate::gdtf_profiles::ProfileLibrary;
use crate::gdtf_resolver::ResolveError;
use crate::gdtf_sets::{FunctionSets, resolve_sets};

/// Owned endpoints and an optional immutable profile index for one function.
#[derive(Debug, Serialize)]
struct Mapping {
    id: String,
    raw_from: u32,
    raw_to: u32,
    physical_from: f64,
    physical_to: f64,
    profile: Option<usize>,
    sets: FunctionSets,
    auxiliary: Vec<AuxiliaryMapping>,
}

/// One resolved auxiliary quantity belonging to a function, using the parent's raw interval.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxiliaryMapping {
    /// Attribute table index of the linked declaration.
    pub attribute: usize,
    /// Auxiliary declaration index within the attribute.
    pub subunit: usize,
    /// Authored purpose, independent of operator labels.
    pub kind: SubPhysicalUnitType,
    /// Unit of the evaluated physical value.
    pub unit: PhysicalUnit,
    /// Optional function-specific label; absent for inherited defaults.
    pub name: Option<String>,
    /// Whether a SubChannelSet explicitly overrides the declaration's default range.
    pub explicit: bool,
    /// Effective starting value.
    pub physical_from: f64,
    /// Effective ending value.
    pub physical_to: f64,
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

/// Quantize one interval; explicit set selection permits the first of several equivalent constant values.
fn inverse_interval(
    id: &str,
    raw_from: u32,
    raw_to: u32,
    from: f64,
    to: f64,
    value: f64,
    selected: bool,
) -> Result<Option<u32>, ResolveError> {
    if !value.is_finite() {
        return Err(error(
            "physical_outside_function",
            id,
            "Physical target must be finite",
        ));
    }
    if value < from.min(to) || value > from.max(to) {
        return Ok(None);
    }
    if from == to {
        if selected || raw_from == raw_to {
            return Ok(Some(raw_from));
        }
        return Err(error(
            "ambiguous_physical_inverse",
            id,
            "Multiple raw values represent this constant physical target; select a set explicitly",
        ));
    }
    let fraction = (value - from) / (to - from);
    Ok(Some(
        raw_from + (fraction * f64::from(raw_to - raw_from)).round() as u32,
    ))
}

/// Bind function profiles and physical endpoints without retaining parser references.
pub fn compile_physical(
    channels: &[ChannelFunctions<'_>],
    profiles: ProfileLibrary,
    function_limit: usize,
    set_limit: usize,
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
    }
    let sets = resolve_sets(channels, set_limit)?;
    for (channel, sets) in channels.iter().zip(sets) {
        let mut mappings = Vec::with_capacity(channel.functions.len());
        for (function, sets) in channel.functions.iter().zip(sets) {
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
                sets,
                auxiliary: Vec::new(),
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
    /// Finish construction by binding auxiliary defaults and function-specific overrides to shared profiles.
    pub(crate) fn with_subchannels(
        mut self,
        channels: &[ChannelFunctions<'_>],
        attributes: &AttributeLibrary,
        limit: usize,
    ) -> Result<Self, ResolveError> {
        let mut count = 0usize;
        for (channel, mappings) in channels.iter().zip(&mut self.channels) {
            for (function, mapping) in channel.functions.iter().zip(mappings) {
                let attribute =
                    attributes
                        .resolve(&function.source.attribute)
                        .map_err(|mut error| {
                            error.message = format!("{}: {}", error.message, error.path);
                            error.path = function.id.clone();
                            error
                        })?;
                let declared = &attributes.attributes()[attribute];
                count = count
                    .checked_add(declared.subphysical_units.len())
                    .filter(|count| *count <= limit)
                    .ok_or_else(|| {
                        error(
                            "subchannel_limit",
                            &mapping.id,
                            "Expanded auxiliary mappings exceed the compilation budget",
                        )
                    })?;
                mapping.auxiliary = declared
                    .subphysical_units
                    .iter()
                    .enumerate()
                    .map(|(subunit, unit)| AuxiliaryMapping {
                        attribute,
                        subunit,
                        kind: unit.kind,
                        unit: unit.unit,
                        name: None,
                        explicit: false,
                        physical_from: unit.physical_from,
                        physical_to: unit.physical_to,
                        profile: None,
                    })
                    .collect();
                let mut seen = HashSet::new();
                for source in &function.source.sub_channel_sets {
                    let target = attributes.resolve_subunit(&source.sub_physical_unit)?;
                    if !seen.insert(target) {
                        return Err(error(
                            "duplicate_subchannel",
                            &mapping.id,
                            "Several subchannel sets override the same auxiliary quantity",
                        ));
                    }
                    if !source.physical_from.is_finite()
                        || !source.physical_to.is_finite()
                        || !(source.physical_to - source.physical_from).is_finite()
                    {
                        return Err(error(
                            "invalid_subchannel_range",
                            &mapping.id,
                            "Subchannel endpoints and span must be finite",
                        ));
                    }
                    let unit = &attributes.attributes()[target.0].subphysical_units[target.1];
                    let replacement = AuxiliaryMapping {
                        attribute: target.0,
                        subunit: target.1,
                        kind: unit.kind,
                        unit: unit.unit,
                        name: source.name.as_ref().map(ToString::to_string),
                        explicit: true,
                        physical_from: source.physical_from,
                        physical_to: source.physical_to,
                        profile: source
                            .dmx_profile
                            .as_ref()
                            .map(|link| self.profiles.resolve(link))
                            .transpose()?,
                    };
                    if let Some(existing) = mapping
                        .auxiliary
                        .iter_mut()
                        .find(|entry| (entry.attribute, entry.subunit) == target)
                    {
                        *existing = replacement;
                    } else {
                        count = count
                            .checked_add(1)
                            .filter(|count| *count <= limit)
                            .ok_or_else(|| {
                                error(
                                    "subchannel_limit",
                                    &mapping.id,
                                    "Expanded auxiliary mappings exceed the compilation budget",
                                )
                            })?;
                        mapping.auxiliary.push(replacement);
                    }
                }
            }
        }
        Ok(self)
    }

    /// Inspect auxiliary purposes, labels, units and effective ranges for one compiled function.
    pub fn auxiliary(
        &self,
        channel: usize,
        function: usize,
    ) -> Result<&[AuxiliaryMapping], ResolveError> {
        self.channels
            .get(channel)
            .and_then(|channel| channel.get(function))
            .map(|mapping| mapping.auxiliary.as_slice())
            .ok_or_else(|| {
                error(
                    "invalid_physical_function",
                    "auxiliary",
                    "Compiled function is missing",
                )
            })
    }

    /// Evaluate a default or explicit auxiliary range over the parent function's raw interval.
    /// A subchannel profile replaces linear interpolation independently of the main function's profile.
    pub fn evaluate_auxiliary(
        &self,
        channel: usize,
        function: usize,
        auxiliary: usize,
        raw: u32,
    ) -> Result<f64, ResolveError> {
        let mapping = self
            .channels
            .get(channel)
            .and_then(|channel| channel.get(function))
            .ok_or_else(|| {
                error(
                    "invalid_physical_function",
                    "auxiliary",
                    "Compiled function is missing",
                )
            })?;
        let target = mapping.auxiliary.get(auxiliary).ok_or_else(|| {
            error(
                "invalid_auxiliary_index",
                &mapping.id,
                "Auxiliary mapping is missing",
            )
        })?;
        if raw < mapping.raw_from || raw > mapping.raw_to {
            return Err(error(
                "raw_outside_function",
                &mapping.id,
                "Raw value lies outside the function interval",
            ));
        }
        let fraction = if let Some(profile) = target.profile {
            self.profiles
                .get(profile)
                .expect("compiled profile index")
                .evaluate_raw(raw, mapping.raw_from, mapping.raw_to)?
                / 100.0
        } else if mapping.raw_from == mapping.raw_to {
            0.0
        } else {
            f64::from(raw - mapping.raw_from) / f64::from(mapping.raw_to - mapping.raw_from)
        };
        let value = target.physical_from + fraction * (target.physical_to - target.physical_from);
        if !value.is_finite() {
            return Err(error(
                "physical_output_overflow",
                &mapping.id,
                "Auxiliary mapping produced a nonfinite result",
            ));
        }
        Ok(value)
    }

    /// Encode within an explicitly selected set; constant sets deterministically use their first raw value.
    pub fn encode_set_linear(
        &self,
        channel: usize,
        function: usize,
        set_index: usize,
        value: f64,
    ) -> Result<u32, ResolveError> {
        let mapping = self.mapping(channel, function)?;
        if mapping.profile.is_some() {
            return Err(error(
                "profile_inverse_unavailable",
                &mapping.id,
                "Profile inversion requires explicit inverse analysis",
            ));
        }
        let set = mapping.sets.sets.get(set_index).ok_or_else(|| {
            error(
                "missing_channel_set",
                &mapping.id,
                "Selected channel set is outside this function",
            )
        })?;
        let from = self.evaluate(channel, function, set.raw_from)?;
        let to = self.evaluate(channel, function, set.raw_to)?;
        inverse_interval(&set.id, set.raw_from, set.raw_to, from, to, value, true)?.ok_or_else(
            || {
                error(
                    "physical_outside_set",
                    &set.id,
                    "Physical target lies outside the selected channel set",
                )
            },
        )
    }

    /// Search each piecewise linear interval, rejecting multiple candidates rather than picking a set.
    fn encode_sets(
        &self,
        channel: usize,
        function: usize,
        value: f64,
    ) -> Result<u32, ResolveError> {
        let mapping = self.mapping(channel, function)?;
        let prefix = mapping
            .sets
            .sets
            .first()
            .filter(|set| set.raw_from > mapping.raw_from)
            .map(|set| (mapping.raw_from, set.raw_from - 1));
        let intervals = prefix.into_iter().chain(
            mapping
                .sets
                .sets
                .iter()
                .map(|set| (set.raw_from, set.raw_to)),
        );
        let mut candidate = None;
        for (from, to) in intervals {
            if let Some(raw) = inverse_interval(
                &mapping.id,
                from,
                to,
                self.evaluate(channel, function, from)?,
                self.evaluate(channel, function, to)?,
                value,
                false,
            )? {
                if candidate.replace(raw).is_some() {
                    return Err(error(
                        "ambiguous_physical_inverse",
                        &mapping.id,
                        "Several channel-set ranges represent this physical target; select a set explicitly",
                    ));
                }
            }
        }
        candidate.ok_or_else(|| {
            error(
                "physical_outside_function",
                &mapping.id,
                "No channel-set range represents this physical target",
            )
        })
    }

    /// Expose immutable labeled ranges for operator choices and capability checks.
    pub fn channel_sets(
        &self,
        channel: usize,
        function: usize,
    ) -> Result<&[crate::gdtf_sets::ChannelSet], ResolveError> {
        Ok(&self.mapping(channel, function)?.sets.sets)
    }

    /// Evaluate an explicitly selected function including its active channel-set override.
    /// Labels without overrides retain the parent function's continuous mapping.
    pub fn evaluate(&self, channel: usize, function: usize, raw: u32) -> Result<f64, ResolveError> {
        let parent = self.evaluate_function(channel, function, raw)?;
        let mapping = self.mapping(channel, function)?;
        let Some(set) = mapping.sets.at(raw) else {
            return Ok(parent);
        };
        if set.physical_from.is_none() && set.physical_to.is_none() {
            return Ok(parent);
        }
        if mapping.profile.is_some() {
            return Err(error(
                "profile_set_composition_unavailable",
                &set.id,
                "Combining an explicit channel-set physical override with a function profile requires a verified composition rule",
            ));
        }
        let from = set.physical_from.unwrap_or(mapping.sets.physical_from);
        let to = set.physical_to.unwrap_or(mapping.sets.physical_to);
        let fraction = if set.raw_from == set.raw_to {
            0.0
        } else {
            f64::from(raw - set.raw_from) / f64::from(set.raw_to - set.raw_from)
        };
        let value = from + (to - from) * fraction;
        if !value.is_finite() {
            return Err(error(
                "physical_output_overflow",
                &set.id,
                "Channel-set physical evaluation produced a nonfinite value",
            ));
        }
        Ok(value)
    }

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
        if mapping
            .sets
            .sets
            .iter()
            .any(|set| set.physical_from.is_some() || set.physical_to.is_some())
        {
            return self.encode_sets(channel, function, value);
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
