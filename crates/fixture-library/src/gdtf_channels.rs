// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Owned channel semantics compiled together from one resolved mode.

use gdtf::physical_descriptions::DmxProfile;
use serde::Serialize;

use crate::gdtf_activation::{ActivationProgram, compile_activation};
use crate::gdtf_bindings::bind_selectors;
use crate::gdtf_functions::resolve_functions;
use crate::gdtf_physical::{PhysicalMappings, compile_physical};
use crate::gdtf_profiles::compile_profiles;
use crate::gdtf_relations::{RelationPlan, plan_relations, resolve_relations};
use crate::gdtf_resolver::{ResolveError, ResolvedMode};
use crate::gdtf_wire::{ModeWires, resolve_wires};

/// Expanded semantic budgets, independent of geometry-resolution limits.
#[derive(Debug, Clone, Copy)]
pub struct ChannelLimits {
    /// Maximum total instantiated functions, checked before normalization.
    pub functions: usize,
    /// Maximum total instantiated channel sets.
    pub sets: usize,
    /// Maximum profile control points across the supplied fixture.
    pub profile_points: usize,
    /// Maximum instantiated relation edges.
    pub relations: usize,
}

impl Default for ChannelLimits {
    /// Provide the same semantic budgets used by the corpus probe.
    fn default() -> Self {
        Self {
            functions: 1_000_000,
            sets: 1_000_000,
            profile_points: 100_000,
            relations: 1_000_000,
        }
    }
}

/// Function identity and authored attribute link retained after the parser is dropped.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledFunction {
    /// Definition-local function identity.
    pub id: String,
    /// Attribute link, not an inferred semantic classification or display label.
    pub attribute: String,
    /// Authored logical channel index; several logical channels may be active together.
    pub logical_channel: usize,
    /// Authored function index within its logical channel.
    pub function: usize,
    /// Inclusive integer interval in channel precision.
    pub raw_from: u32,
    /// Inclusive final integer value.
    pub raw_to: u32,
    /// Normalized function default.
    pub default: u32,
}

/// One immutable instantiated channel's runtime metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledChannel {
    /// Identity shared with wire and geometry compilation.
    pub id: String,
    /// Geometry instance index in the same resolved definition.
    pub geometry: usize,
    /// Integer byte precision, including virtual channels.
    pub bytes: u8,
    /// Initial function index in the flattened function list.
    pub initial_function: usize,
    /// Initial raw channel value.
    pub default: u32,
    /// Optional highlight value; absence means leave the channel unchanged.
    pub highlight: Option<u32>,
    /// Authored logical/function order, aligned with activation and physical mappings.
    pub functions: Vec<CompiledFunction>,
}

/// Channel portion of a definition, owning all evaluators without retaining parser lifetimes.
/// Construction is the only mutation boundary; geometry, resource and operator grouping contracts
/// remain separate and must use the same definition identity before production adoption.
#[derive(Debug, Serialize)]
pub struct CompiledChannels {
    channels: Vec<CompiledChannel>,
    wires: ModeWires,
    activation: ActivationProgram,
    physical: PhysicalMappings,
    relations: RelationPlan,
}

/// One active function's physical value before any relation or visual interpretation.
#[derive(Debug, Serialize, PartialEq)]
pub struct ActivePhysicalValue {
    /// Index into the channel's compiled function list.
    pub function: usize,
    /// Value in the authored attribute's physical unit.
    pub value: f64,
}

/// Compile all channel passes from one mode, rejecting failures before publishing any result.
pub fn compile_channels(
    mode: &ResolvedMode<'_>,
    profiles: &[DmxProfile],
    limits: ChannelLimits,
) -> Result<CompiledChannels, ResolveError> {
    let mut count = 0usize;
    for channel in &mode.channels {
        for logical in &channel.source.logical_channels {
            count = count
                .checked_add(logical.channel_functions.len())
                .filter(|count| *count <= limits.functions)
                .ok_or_else(|| ResolveError {
                    code: "function_limit",
                    path: channel.id.clone(),
                    message: "Expanded functions exceed the compilation budget".into(),
                })?;
        }
    }
    let wires = resolve_wires(mode)?;
    let functions = resolve_functions(mode)?;
    let bindings = bind_selectors(mode, &functions)?;
    let activation = compile_activation(&functions, &bindings, limits.functions)?;
    let physical = compile_physical(
        &functions,
        compile_profiles(profiles, limits.profile_points)?,
        limits.functions,
        limits.sets,
    )?;
    let relations = plan_relations(
        &functions,
        resolve_relations(mode, &functions, limits.relations)?,
    )?;
    let channels = functions
        .iter()
        .zip(&mode.channels)
        .map(|(channel, instance)| CompiledChannel {
            id: channel.id.clone(),
            geometry: instance.geometry,
            bytes: channel.bytes,
            initial_function: channel.initial_function,
            default: channel.default,
            highlight: channel.highlight,
            functions: channel
                .functions
                .iter()
                .map(|function| CompiledFunction {
                    id: function.id.clone(),
                    attribute: function.source.attribute.to_string(),
                    logical_channel: function.logical_channel,
                    function: function.function,
                    raw_from: function.raw_from,
                    raw_to: function.raw_to,
                    default: function.default,
                })
                .collect(),
        })
        .collect();
    Ok(CompiledChannels {
        channels,
        wires,
        activation,
        physical,
        relations,
    })
}

impl CompiledChannels {
    /// Inspect metadata without permitting mutation that could invalidate evaluator indices.
    pub fn channels(&self) -> &[CompiledChannel] {
        &self.channels
    }

    /// Inspect exact wire addresses aligned with channel metadata.
    pub fn wires(&self) -> &ModeWires {
        &self.wires
    }

    /// Access validated physical conversions and channel-set choices.
    pub fn physical(&self) -> &PhysicalMappings {
        &self.physical
    }

    /// Access relation evaluation; callers must supply semantic fractions, not raw DMX.
    pub fn relations(&self) -> &RelationPlan {
        &self.relations
    }

    /// Create an initial integer snapshot including virtual controls.
    pub fn defaults(&self) -> Vec<u32> {
        self.channels
            .iter()
            .map(|channel| channel.default)
            .collect()
    }

    /// Evaluate every eligible function without silently selecting one overlapping logical channel.
    /// Returns authored physical values, not normalized fractions or relation-adjusted light output.
    pub fn evaluate_physical(
        &self,
        raw: &[u32],
    ) -> Result<Vec<Vec<ActivePhysicalValue>>, ResolveError> {
        self.activation
            .evaluate(raw)?
            .into_iter()
            .enumerate()
            .map(|(channel, functions)| {
                functions
                    .into_iter()
                    .map(|function| {
                        Ok(ActivePhysicalValue {
                            function,
                            value: self.physical.evaluate(channel, function, raw[channel])?,
                        })
                    })
                    .collect()
            })
            .collect()
    }
}
