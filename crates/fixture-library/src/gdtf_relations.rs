// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Bind authored relationships to instantiated controls without applying them twice.

use std::collections::HashSet;

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
