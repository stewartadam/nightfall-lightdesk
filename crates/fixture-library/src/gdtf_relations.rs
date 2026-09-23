// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bind authored relationships to instantiated controls without applying them twice.

use std::collections::{HashSet, VecDeque};

use gdtf::dmx_mode::RelationType;
use serde::Serialize;

use crate::gdtf_bindings::bind_channel_instance;
use crate::gdtf_functions::{ChannelFunctions, resolve_source_link};
use crate::gdtf_resolver::{ResolveError, ResolvedMode};

/// One relation for one instantiated follower function and its local or shared master.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationBinding {
    /// Definition-local identity based on authored relation order and follower instance.
    pub id: String,
    /// Optional source label, independent of relation identity.
    pub name: Option<String>,
    /// Master channel instance, with its original physical/virtual distinction retained.
    pub master: usize,
    /// Follower channel instance.
    pub follower: usize,
    /// Normalized function index within the follower channel.
    pub function: usize,
    /// Authored operation; compilation does not reinterpret Override as Multiply.
    pub operation: RelationType,
    /// Whether the master has no physical wire slots.
    pub master_virtual: bool,
    /// Whether the follower has no physical wire slots.
    pub follower_virtual: bool,
}

/// Validated dependency order for relationship evaluation without recursive traversal.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationPlan {
    channel_order: Vec<usize>,
    relations: Vec<RelationBinding>,
    incoming: Vec<Vec<usize>>,
    function_counts: Vec<usize>,
}

/// Separate unquantized results derived from the same original semantic values.
#[derive(Debug, Serialize)]
pub struct RelationValues {
    /// Fractions with virtual-master operations applied, ready for subsequent physical-to-wire encoding.
    pub output: Vec<f64>,
    /// Fractions with all declared operations applied, ready for visual simulation.
    pub visual: Vec<f64>,
}

impl RelationPlan {
    /// Evaluate original semantic fractions and active function indices, never raw or already-adjusted DMX.
    /// Both output and visual results start from the original snapshot to prevent double application.
    pub fn evaluate_normalized(
        &self,
        values: &[f64],
        active: &[Vec<usize>],
    ) -> Result<RelationValues, ResolveError> {
        if values.len() != self.function_counts.len()
            || active.len() != values.len()
            || values
                .iter()
                .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
            || active
                .iter()
                .zip(&self.function_counts)
                .any(|(active, count)| active.iter().any(|index| index >= count))
        {
            return Err(error(
                "invalid_relation_snapshot",
                "relations",
                "Supply one finite semantic fraction and valid active function indices per channel",
            ));
        }
        Ok(RelationValues {
            output: self.evaluate_pass(values, active, true)?,
            visual: self.evaluate_pass(values, active, false)?,
        })
    }

    /// Apply a dependency-ordered pass while retaining authored order for commuting multiplication inputs.
    fn evaluate_pass(
        &self,
        values: &[f64],
        active: &[Vec<usize>],
        virtual_only: bool,
    ) -> Result<Vec<f64>, ResolveError> {
        let mut result = values.to_vec();
        for &channel in &self.channel_order {
            let mut selected_function = None;
            let mut applied = 0usize;
            let mut override_seen = false;
            for &index in &self.incoming[channel] {
                let relation = &self.relations[index];
                if (virtual_only && !relation.master_virtual)
                    || !active[channel].contains(&relation.function)
                {
                    continue;
                }
                if selected_function.is_some_and(|function| function != relation.function) {
                    return Err(error(
                        "ambiguous_relation_functions",
                        &relation.id,
                        "Several active follower functions require different values on one channel",
                    ));
                }
                selected_function = Some(relation.function);
                if override_seen || (relation.operation == RelationType::Override && applied > 0) {
                    return Err(error(
                        "ambiguous_relation_override",
                        &relation.id,
                        "An active override competes with another incoming operation",
                    ));
                }
                match relation.operation {
                    RelationType::Multiply => result[channel] *= result[relation.master],
                    RelationType::Override => {
                        result[channel] = result[relation.master];
                        override_seen = true;
                    }
                }
                applied += 1;
            }
        }
        Ok(result)
    }

    /// Visit masters before followers, including channels without relationships.
    pub fn channel_order(&self) -> &[usize] {
        &self.channel_order
    }

    /// Inspect immutable operations; physical/virtual distinctions remain available to the evaluator.
    pub fn relations(&self) -> &[RelationBinding] {
        &self.relations
    }

    /// Return indices of incoming operations in authored relation order for a valid channel.
    pub fn incoming(&self, channel: usize) -> Option<&[usize]> {
        self.incoming.get(channel).map(Vec::as_slice)
    }
}

/// Validate bound edges and build a deterministic master-first order, rejecting cyclic dependencies.
pub fn plan_relations(
    functions: &[ChannelFunctions<'_>],
    relations: Vec<RelationBinding>,
) -> Result<RelationPlan, ResolveError> {
    let mut incoming = vec![Vec::new(); functions.len()];
    let mut outgoing = vec![Vec::new(); functions.len()];
    let mut pending = vec![0usize; functions.len()];
    let mut seen = HashSet::new();
    for (index, relation) in relations.iter().enumerate() {
        if relation.master >= functions.len()
            || relation.follower >= functions.len()
            || relation.function >= functions[relation.follower].functions.len()
        {
            return Err(error(
                "invalid_relation_binding",
                &relation.id,
                "Relation channel or function is outside the compiled definition",
            ));
        }
        if !seen.insert((
            relation.master,
            relation.follower,
            relation.function,
            relation.operation,
        )) {
            return Err(error(
                "duplicate_relation",
                &relation.id,
                "A relation operation is duplicated",
            ));
        }
        incoming[relation.follower].push(index);
        outgoing[relation.master].push(relation.follower);
        pending[relation.follower] += 1;
    }
    let mut ready: VecDeque<_> = pending
        .iter()
        .enumerate()
        .filter_map(|(channel, count)| (*count == 0).then_some(channel))
        .collect();
    let mut channel_order = Vec::with_capacity(functions.len());
    while let Some(channel) = ready.pop_front() {
        channel_order.push(channel);
        for &follower in &outgoing[channel] {
            pending[follower] -= 1;
            if pending[follower] == 0 {
                ready.push_back(follower);
            }
        }
    }
    if channel_order.len() != functions.len() {
        let channel = pending
            .iter()
            .position(|count| *count > 0)
            .expect("unvisited channels retain incoming edges");
        return Err(error(
            "relation_dependency_cycle",
            &functions[channel].id,
            "Relation channels contain a dependency cycle; no unconditional evaluation order exists",
        ));
    }
    Ok(RelationPlan {
        channel_order,
        relations,
        incoming,
        function_counts: functions
            .iter()
            .map(|channel| channel.functions.len())
            .collect(),
    })
}

/// Report source faults against a relation and its instantiated follower.
fn error(code: &'static str, path: &str, message: &str) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Expand followers and bind masters using the same reference scopes as function selectors.
pub fn resolve_relations(
    mode: &ResolvedMode<'_>,
    functions: &[ChannelFunctions<'_>],
    limit: usize,
) -> Result<Vec<RelationBinding>, ResolveError> {
    if functions.len() != mode.channels.len()
        || functions
            .iter()
            .zip(&mode.channels)
            .any(|(f, c)| f.id != c.id)
    {
        return Err(error(
            "mismatched_functions",
            &mode.name,
            "Relation bindings require the same normalized channel order",
        ));
    }
    let mut instances = vec![Vec::new(); mode.source.dmx_channels.len()];
    for (index, channel) in mode.channels.iter().enumerate() {
        instances[channel.source_index].push(index);
    }
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for (index, source) in mode.source.relations.iter().enumerate() {
        let path = format!("r/{index}");
        if source.master.len() != 1 || source.follower.len() != 3 {
            return Err(error(
                "invalid_relation_link",
                &path,
                "Relations require a master channel and a follower channel function",
            ));
        }
        let master = resolve_source_link(&source.master, mode.source, &path)?;
        let follower = resolve_source_link(&source.follower, mode.source, &path)?;
        let (logical, authored) = follower
            .function
            .expect("three-component function link validated");
        for &target in &instances[follower.channel] {
            let id = format!("{path}/{}", mode.channels[target].id);
            if result.len() >= limit {
                return Err(error(
                    "relation_limit",
                    &id,
                    "Expanded relations exceed the compilation budget",
                ));
            }
            let master = bind_channel_instance(mode, target, &instances[master.channel], &id)
                .map_err(|mut error| {
                    error.code = "ambiguous_relation_instance";
                    error
                })?;
            let function = functions[target]
                .functions
                .iter()
                .position(|f| f.logical_channel == logical && f.function == authored)
                .ok_or_else(|| {
                    error(
                        "invalid_relation_function",
                        &id,
                        "Follower function is missing from the compiled channel",
                    )
                })?;
            if !seen.insert((master, target, function, source.type_)) {
                return Err(error(
                    "duplicate_relation",
                    &id,
                    "The same master operation targets this follower function more than once",
                ));
            }
            result.push(RelationBinding {
                id,
                name: source.name.as_ref().map(ToString::to_string),
                master,
                follower: target,
                function,
                operation: source.type_,
                master_virtual: mode.channels[master].source.offset.is_none(),
                follower_virtual: mode.channels[target].source.offset.is_none(),
            });
        }
    }
    Ok(result)
}
