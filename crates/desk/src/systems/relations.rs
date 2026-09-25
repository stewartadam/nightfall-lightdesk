// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Console-side application of fixture profile relations.
//!
//! A relation's master that occupies no DMX slots never reaches the fixture,
//! so the console applies it to the follower's output value. Relations whose
//! master is a real channel are evaluated by the fixture itself and are left
//! to the visualizer to simulate.
//!
//! Virtual masters can themselves follow other virtual masters (a pixel
//! dimmer following a group dimmer), so followers are resolved through their
//! chain of masters before any value is written.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::universe::parameter_to_dmx_value;

/// Longest chain of masters followed before a relation cycle is assumed.
const MAX_RELATION_DEPTH: usize = 8;

/// A follower's active function with its relations resolved to virtual master entities.
struct Follower {
    /// Logical value at the function's first DMX value.
    from: ParameterDmxValue,
    /// Logical value at the function's last DMX value.
    to: ParameterDmxValue,
    /// Virtual masters in declaration order.
    masters: Vec<(Entity, RelationKind)>,
}

/// Applies relations whose master is virtual to their followers' current values.
///
/// The follower's active function is selected from its current DMX value.
/// `Multiply` scales the follower's position within that function by the
/// master's level, and `Override` replaces the position with the master's
/// level; both keep the value inside the function's DMX range. A master's
/// level includes the relations it follows itself.
pub fn apply_virtual_relations(
    mut param_query: Query<InstanceMut<Parameter>>,
    data_provider: Res<FixtureDataProviderExt>,
) {
    let mut followers: HashMap<Entity, Follower> = HashMap::new();
    for follower in param_query.iter() {
        let Some(function) = follower
            .metadata
            .function_at(parameter_to_dmx_value(&follower))
            .filter(|function| !function.relations.is_empty())
        else {
            continue;
        };
        let Some(fixture_ref) = data_provider.try_fixture_ref_for_parameter(&follower.instance())
        else {
            continue;
        };
        let masters: Vec<(Entity, RelationKind)> = function
            .relations
            .iter()
            .filter_map(|relation| {
                let master_ref = FixtureRef {
                    fixture_uid: fixture_ref.fixture_uid,
                    index: Some(relation.master.element + 1),
                };
                let master = data_provider
                    .try_parameter_for_element_attribute(&master_ref, &relation.master.attribute)?;
                let is_virtual = param_query
                    .get(master.entity())
                    .is_ok_and(|master| master.metadata.dmx_slots == DmxSlots::Virtual);
                is_virtual.then_some((master.entity(), relation.kind))
            })
            .collect();
        if masters.is_empty() {
            continue;
        }
        followers.insert(
            follower.entity(),
            Follower {
                from: follower.metadata.logical_value_from_dmx(function.dmx_from),
                to: follower.metadata.logical_value_from_dmx(function.dmx_to),
                masters,
            },
        );
    }

    let mut resolved: HashMap<Entity, ParameterDmxValue> = HashMap::new();
    for entity in followers.keys() {
        resolve(*entity, &followers, &param_query, &mut resolved, 0);
    }
    for (entity, value) in resolved {
        if let Ok(mut follower) = param_query.get_mut(entity) {
            follower.values.current_value = value;
        }
    }
}

/// Returns a parameter's value after the virtual relations it follows,
/// memoizing followers in `resolved`.
fn resolve(
    entity: Entity,
    followers: &HashMap<Entity, Follower>,
    param_query: &Query<InstanceMut<Parameter>>,
    resolved: &mut HashMap<Entity, ParameterDmxValue>,
    depth: usize,
) -> Option<ParameterDmxValue> {
    if let Some(value) = resolved.get(&entity) {
        return Some(*value);
    }
    let parameter = param_query.get(entity).ok()?;
    let mut value = parameter.values.current_value;
    let Some(follower) = followers
        .get(&entity)
        .filter(|_| depth < MAX_RELATION_DEPTH)
    else {
        return Some(value);
    };
    for (master, kind) in &follower.masters {
        let Some(master_value) = resolve(*master, followers, param_query, resolved, depth + 1)
        else {
            continue;
        };
        let Ok(master_parameter) = param_query.get(*master) else {
            continue;
        };
        let level = level(&master_parameter.metadata, master_value);
        value = match kind {
            RelationKind::Multiply => follower.from + (value - follower.from) * level,
            RelationKind::Override => follower.from + (follower.to - follower.from) * level,
        };
    }
    resolved.insert(entity, value);
    Some(value)
}

/// Returns a value as a 0-1 level of a parameter's logical range.
fn level(metadata: &ParameterMetadata, value: ParameterDmxValue) -> ParameterDmxValue {
    let range = metadata.logical_range();
    if range <= 0.0 {
        return 0.0;
    }
    ((value - metadata.logical_min()) / range).clamp(0.0, 1.0)
}
