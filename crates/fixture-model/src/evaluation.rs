// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Evaluation of a fixture's channels through its profile's mode masters,
//! relations, functions, channel sets and DMX profiles.
//!
//! The console and the visualizer both evaluate fixtures with this module so
//! they agree on what a fixture does. Each applies the relations it is
//! responsible for ([`RelationScope`]): the console applies every relation
//! involving a virtual channel, which never reaches the fixture, and the
//! visualizer simulates the relations between two real channels, which the
//! fixture evaluates itself.
//!
//! Values are logical parameter values as the console holds them, before
//! calibration offset and inversion. A relation keeps its follower inside the
//! active function's DMX range: `Multiply` scales the follower's position in
//! the function by the master's level, and `Override` replaces it. The
//! follower's active function is the first whose DMX range contains its DMX
//! value and whose mode master condition holds, judged by the mode master's
//! value after the relations it follows itself.

use crate::parameter::{ElementParameterRef, ParameterMetadata, RelationKind, evaluate_profile};

/// Longest chain of masters followed before a relation cycle is assumed.
pub const MAX_RELATION_DEPTH: usize = 8;

/// The party responsible for applying a relation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationScope {
    /// Relations whose master or follower is virtual, which only the console sees.
    Console,
    /// Relations between two real channels, which the fixture applies itself.
    Fixture,
}

impl RelationScope {
    /// Returns true when this party applies a relation between a follower and
    /// master of the given virtualness.
    fn applies(self, follower_is_virtual: bool, master_is_virtual: bool) -> bool {
        let console = follower_is_virtual || master_is_virtual;
        match self {
            RelationScope::Console => console,
            RelationScope::Fixture => !console,
        }
    }
}

/// Links of one parameter's functions, resolved to parameter indices.
#[derive(Debug, Clone, Default)]
struct ParameterLinks {
    /// Mode master of each function.
    mode_masters: Vec<Option<usize>>,
    /// Relation masters of each function, in declaration order.
    relations: Vec<Vec<(usize, RelationKind)>>,
    /// Whether any function declares a relation.
    follows: bool,
}

/// A fixture's parameters, indexed element by element, with the links of
/// their functions resolved once.
#[derive(Debug, Clone)]
pub struct FixtureModel {
    /// Parameter metadata, element by element.
    parameters: Vec<ParameterMetadata>,
    /// Element of each parameter.
    elements: Vec<usize>,
    /// Index of each element's first parameter, followed by the parameter count.
    element_starts: Vec<usize>,
    /// Resolved links of each parameter.
    links: Vec<ParameterLinks>,
    /// Whether each parameter is virtual.
    virtual_parameters: Vec<bool>,
    /// Real dimmers that master no relation.
    unlinked_dimmers: Vec<usize>,
}

impl FixtureModel {
    /// Builds the model of a fixture from its elements' parameters.
    ///
    /// With `linked` false, mode masters and relations are ignored; this
    /// evaluates a lone element whose references into other elements cannot
    /// be followed.
    pub fn new<E, P>(elements: E, linked: bool) -> Self
    where
        E: IntoIterator<Item = P>,
        P: IntoIterator<Item = ParameterMetadata>,
    {
        let mut parameters = Vec::new();
        let mut element_of = Vec::new();
        let mut element_starts = Vec::new();
        for (element, element_parameters) in elements.into_iter().enumerate() {
            element_starts.push(parameters.len());
            for parameter in element_parameters {
                parameters.push(parameter);
                element_of.push(element);
            }
        }
        element_starts.push(parameters.len());

        let resolve = |reference: &ElementParameterRef| -> Option<usize> {
            let element = reference.element as usize;
            let start = *element_starts.get(element)?;
            let end = *element_starts.get(element + 1)?;
            (start..end).find(|&index| parameters[index].attribute == reference.attribute)
        };
        let links: Vec<ParameterLinks> = parameters
            .iter()
            .map(|parameter| {
                if !linked {
                    return ParameterLinks {
                        mode_masters: vec![None; parameter.functions.len()],
                        relations: vec![Vec::new(); parameter.functions.len()],
                        follows: false,
                    };
                }
                let relations: Vec<Vec<(usize, RelationKind)>> = parameter
                    .functions
                    .iter()
                    .map(|function| {
                        function
                            .relations
                            .iter()
                            .filter_map(|relation| {
                                Some((resolve(&relation.master)?, relation.kind))
                            })
                            .collect()
                    })
                    .collect();
                ParameterLinks {
                    mode_masters: parameter
                        .functions
                        .iter()
                        .map(|function| {
                            function
                                .mode_master
                                .as_ref()
                                .and_then(|condition| resolve(&condition.master))
                        })
                        .collect(),
                    follows: relations.iter().any(|masters| !masters.is_empty()),
                    relations,
                }
            })
            .collect();

        let mut masters = vec![false; parameters.len()];
        for (master, _) in links
            .iter()
            .flat_map(|links| links.relations.iter().flatten())
        {
            masters[*master] = true;
        }
        let virtual_parameters: Vec<bool> = parameters
            .iter()
            .map(ParameterMetadata::is_virtual)
            .collect();
        let unlinked_dimmers = (0..parameters.len())
            .filter(|&index| {
                parameters[index].is_dimmer() && !virtual_parameters[index] && !masters[index]
            })
            .collect();

        Self {
            parameters,
            elements: element_of,
            element_starts,
            links,
            virtual_parameters,
            unlinked_dimmers,
        }
    }

    /// Returns the number of parameters across all elements.
    pub fn len(&self) -> usize {
        self.parameters.len()
    }

    /// Returns true when the fixture has no parameters.
    pub fn is_empty(&self) -> bool {
        self.parameters.is_empty()
    }

    /// Returns the metadata of every parameter, element by element.
    pub fn parameters(&self) -> &[ParameterMetadata] {
        &self.parameters
    }

    /// Returns the index of an element's parameter, or `None` when either is out of range.
    pub fn index(&self, element: usize, parameter: usize) -> Option<usize> {
        let start = *self.element_starts.get(element)?;
        let end = *self.element_starts.get(element + 1)?;
        (start + parameter < end).then_some(start + parameter)
    }

    /// Returns true when any relation between two of the fixture's parameters
    /// is applied by `scope`.
    pub fn has_relations(&self, scope: RelationScope) -> bool {
        self.links.iter().enumerate().any(|(follower, links)| {
            links.relations.iter().flatten().any(|(master, _)| {
                scope.applies(
                    self.virtual_parameters[follower],
                    self.virtual_parameters[*master],
                )
            })
        })
    }
}

/// A parameter's output as the fixture interprets it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ChannelReading {
    /// Logical value after the relations applied by the evaluating party.
    pub value: f32,
    /// DMX value the fixture receives, at the parameter's resolution.
    pub dmx: u32,
    /// Index of the function active at `dmx`, if the parameter declares functions.
    pub function: Option<usize>,
    /// Index of the active function's channel set containing `dmx`.
    pub set: Option<usize>,
    /// Position within the active function (or the whole range without
    /// functions), 0-1, after the function's DMX profile.
    pub fraction: f32,
    /// Physical value of the active function, from its set's own range when
    /// the set declares one. Without functions, the logical output value.
    pub physical: f32,
    /// Output level 0-1, the same as `fraction`.
    pub level: f32,
    /// Whether this parameter masters an emitter (color) channel of its own
    /// element through that emitter's active function, so it sets the
    /// emitter's brightness through the relation rather than dimming the
    /// element directly.
    pub masters_own_emitters: bool,
}

/// Evaluates a [`FixtureModel`] repeatedly, reusing its buffers.
#[derive(Debug, Clone)]
pub struct FixtureEvaluator {
    /// Model being evaluated.
    model: FixtureModel,
    /// Values after relations, per parameter.
    values: Vec<Option<f32>>,
    /// Whether each follower's value has been resolved this evaluation.
    resolved: Vec<bool>,
    /// Readings of the last [`Self::read`].
    readings: Vec<Option<ChannelReading>>,
}

impl FixtureEvaluator {
    /// Creates an evaluator for a fixture model.
    pub fn new(model: FixtureModel) -> Self {
        let len = model.len();
        Self {
            model,
            values: vec![None; len],
            resolved: vec![false; len],
            readings: vec![None; len],
        }
    }

    /// Returns the model being evaluated.
    pub fn model(&self) -> &FixtureModel {
        &self.model
    }

    /// Applies the relations `scope` is responsible for to logical `inputs`,
    /// one per parameter (`None` without a value), and returns every
    /// parameter's value afterwards.
    pub fn resolve(&mut self, scope: RelationScope, inputs: &[Option<f32>]) -> &[Option<f32>] {
        self.resolved.fill(false);
        let mut resolution = Resolution {
            model: &self.model,
            scope,
            inputs,
            values: &mut self.values,
            resolved: &mut self.resolved,
        };
        for index in 0..inputs.len().min(resolution.model.len()) {
            let value = resolution.value(index, 0);
            resolution.values[index] = value;
        }
        &self.values
    }

    /// Evaluates logical `inputs` the way the fixture does: applies the
    /// relations between real channels, then reads each parameter's DMX
    /// value, active function, channel set and profiled position.
    ///
    /// Relations involving virtual channels are expected to be applied to
    /// `inputs` already, as the console does before output.
    pub fn read(&mut self, inputs: &[Option<f32>]) -> &[Option<ChannelReading>] {
        self.resolve(RelationScope::Fixture, inputs);
        let model = &self.model;
        let dmx_of = |index: usize, values: &[Option<f32>]| {
            values[index].map(|value| model.parameters[index].dmx_value(value))
        };
        for index in 0..model.len() {
            let metadata = &model.parameters[index];
            let Some(value) = self.values[index].filter(|_| metadata.max > 0.0) else {
                self.readings[index] = None;
                continue;
            };
            let dmx = metadata.dmx_value(value);
            let function =
                active_function(model, index, dmx, |master| dmx_of(master, &self.values));
            self.readings[index] = Some(interpret(metadata, value, dmx, function));
        }

        for index in 0..model.len() {
            let (Some(reading), true) =
                (self.readings[index], model.parameters[index].is_emitter())
            else {
                continue;
            };
            let Some(function) = reading.function else {
                continue;
            };
            for (master, _) in &model.links[index].relations[function] {
                if model.elements[*master] == model.elements[index]
                    && let Some(master_reading) = &mut self.readings[*master]
                {
                    master_reading.masters_own_emitters = true;
                }
            }
        }
        &self.readings
    }

    /// Returns the level of the real dimmers that master no relation in the
    /// last [`Self::read`]: the brightest of them, 0 when none has output, or
    /// `None` when the fixture has none.
    ///
    /// A profile states what a relation master controls; any other dimmer,
    /// including one that only follows another channel, is taken to master
    /// the whole fixture. Virtual dimmers never reach the fixture.
    pub fn fixture_dimmer_level(&self) -> Option<f32> {
        if self.model.unlinked_dimmers.is_empty() {
            return None;
        }
        Some(
            self.model
                .unlinked_dimmers
                .iter()
                .filter_map(|&index| self.readings[index].map(|reading| reading.level))
                .fold(0.0, f32::max),
        )
    }
}

/// One pass of relation resolution over a fixture's inputs.
struct Resolution<'a> {
    /// Model being resolved.
    model: &'a FixtureModel,
    /// Relations applied.
    scope: RelationScope,
    /// Values before relations.
    inputs: &'a [Option<f32>],
    /// Memoized follower values.
    values: &'a mut [Option<f32>],
    /// Whether each follower's memoized value is set.
    resolved: &'a mut [bool],
}

impl Resolution<'_> {
    /// Returns a parameter's value after the relations it follows,
    /// memoizing followers.
    fn value(&mut self, index: usize, depth: usize) -> Option<f32> {
        if self.resolved[index] {
            return self.values[index];
        }
        let mut value = (*self.inputs.get(index)?)?;
        let model = self.model;
        let links = &model.links[index];
        if !links.follows || depth >= MAX_RELATION_DEPTH {
            return Some(value);
        }
        let metadata = &model.parameters[index];
        let dmx = metadata.dmx_value(value);
        let active = active_function(model, index, dmx, |master| {
            self.value(master, depth + 1)
                .map(|value| model.parameters[master].dmx_value(value))
        });
        if let Some(function_index) = active {
            let function = &metadata.functions[function_index];
            let from = metadata.logical_value_from_dmx(function.dmx_from);
            let to = metadata.logical_value_from_dmx(function.dmx_to);
            for &(master, kind) in &links.relations[function_index] {
                if !self.scope.applies(
                    model.virtual_parameters[index],
                    model.virtual_parameters[master],
                ) {
                    continue;
                }
                let Some(master_value) = self.value(master, depth + 1) else {
                    continue;
                };
                let level = model.parameters[master].level(master_value);
                value = match kind {
                    RelationKind::Multiply => from + (value - from) * level,
                    RelationKind::Override => from + (to - from) * level,
                };
            }
        }
        self.values[index] = Some(value);
        self.resolved[index] = true;
        Some(value)
    }
}

/// Returns the index of the function active at a parameter's DMX value: the
/// first whose range contains it and whose mode master condition holds.
///
/// A condition holds when its master is missing or has no value, or when the
/// master's DMX value, as returned by `master_dmx`, is in range.
fn active_function(
    model: &FixtureModel,
    index: usize,
    dmx: u32,
    mut master_dmx: impl FnMut(usize) -> Option<u32>,
) -> Option<usize> {
    let metadata = &model.parameters[index];
    let links = &model.links[index];
    metadata
        .functions
        .iter()
        .enumerate()
        .position(|(function_index, function)| {
            if !(function.dmx_from..=function.dmx_to).contains(&dmx) {
                return false;
            }
            let (Some(condition), Some(master)) =
                (&function.mode_master, links.mode_masters[function_index])
            else {
                return true;
            };
            master_dmx(master).is_none_or(|master_dmx| {
                (condition.dmx_from..=condition.dmx_to).contains(&master_dmx)
            })
        })
}

/// Returns a value's 0-1 position within an inclusive DMX range.
fn position(dmx: u32, from: u32, to: u32) -> f32 {
    if to > from {
        ((dmx as f64 - from as f64) / (to as f64 - from as f64)).clamp(0.0, 1.0) as f32
    } else {
        1.0
    }
}

/// Reads a parameter's value through the function at `function`, or over
/// its whole range when it has none.
fn interpret(
    metadata: &ParameterMetadata,
    value: f32,
    dmx: u32,
    function: Option<usize>,
) -> ChannelReading {
    let mut reading = ChannelReading {
        value,
        dmx,
        function,
        ..Default::default()
    };
    let Some(function) = function.map(|index| &metadata.functions[index]) else {
        reading.fraction = position(dmx, 0, metadata.resolution.dmx_max());
        reading.physical = metadata.logical_output(value);
        reading.level = reading.fraction;
        return reading;
    };
    let linear = position(dmx, function.dmx_from, function.dmx_to);
    reading.fraction = if function.profile.is_empty() {
        linear
    } else {
        (evaluate_profile(&function.profile, linear * 100.0) / 100.0).clamp(0.0, 1.0)
    };
    reading.physical =
        function.physical_from + (function.physical_to - function.physical_from) * reading.fraction;
    reading.set = function
        .sets
        .iter()
        .position(|set| (set.dmx_from..=set.dmx_to).contains(&dmx));
    if let Some(set) = reading.set.map(|index| &function.sets[index])
        && let (Some(from), Some(to)) = (set.physical_from, set.physical_to)
    {
        reading.physical = from + (to - from) * position(dmx, set.dmx_from, set.dmx_to);
    }
    reading.level = reading.fraction;
    reading
}

#[cfg(test)]
mod tests;
