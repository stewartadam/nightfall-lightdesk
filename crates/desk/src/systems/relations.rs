// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Console-side application of fixture profile relations.
//!
//! Virtual channels exist only in the console, so every relation that
//! involves one is the console's to apply: a virtual master's level never
//! reaches the fixture, and a virtual follower (such as a pixel dimmer that
//! follows the body dimmer) is computed here before its own followers read
//! it. Relations between two real channels are evaluated by the fixture
//! itself and are left to the visualizer to simulate.
//!
//! Masters can follow masters of their own (pixel colour ← pixel dimmer ←
//! plate dimmer), so followers are resolved through their chains before any
//! value is written.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::universe::parameter_to_dmx_value;

/// Longest chain of masters followed before a relation cycle is assumed.
const MAX_RELATION_DEPTH: usize = 8;

/// A function's links as declared, used to notice profile edits.
type LinkSignature = Vec<(Option<ModeMasterCondition>, Vec<FunctionRelation>)>;

/// Parameter entities a follower's links resolve to, per function.
struct FollowerLinks {
    /// The declared links these entities were resolved from.
    signature: LinkSignature,
    /// Mode master entity of each function.
    mode_masters: Vec<Option<Entity>>,
    /// Masters the console applies for each function, in declaration order.
    masters: Vec<Vec<(Entity, RelationKind)>>,
}

/// Link entities resolved once per follower and reused until the fixture
/// data or the follower's declared links change.
#[derive(Default)]
pub struct RelationLinkCache {
    /// Links by follower parameter entity.
    followers: HashMap<Entity, FollowerLinks>,
}

/// A follower's active function with the masters the console applies to it.
struct ActiveFollower {
    /// Logical value at the function's first DMX value.
    from: ParameterDmxValue,
    /// Logical value at the function's last DMX value.
    to: ParameterDmxValue,
    /// Masters in declaration order.
    masters: Vec<(Entity, RelationKind)>,
}

/// Applies the relations the console is responsible for to their followers'
/// current values.
///
/// The follower's active function is the first whose DMX range contains its
/// current DMX value and whose mode master condition holds. `Multiply`
/// scales the follower's position within that function by the master's
/// level, and `Override` replaces the position with the master's level; both
/// keep the value inside the function's DMX range. A master's level includes
/// the relations it follows itself.
pub fn apply_virtual_relations(
    mut param_query: Query<InstanceMut<Parameter>>,
    data_provider: Res<FixtureDataProviderExt>,
    mut cache: Local<RelationLinkCache>,
) {
    if data_provider.is_changed() {
        cache.followers.clear();
    }

    let mut followers: HashMap<Entity, ActiveFollower> = HashMap::new();
    for follower in param_query.iter() {
        let metadata = &follower.metadata;
        if !metadata
            .functions
            .iter()
            .any(|function| !function.relations.is_empty())
        {
            continue;
        }
        let entity = follower.entity();
        let stale = cache
            .followers
            .get(&entity)
            .is_none_or(|links| !signature_matches(&links.signature, metadata));
        if stale {
            let links = resolve_links(&follower.instance(), metadata, &param_query, &data_provider);
            cache.followers.insert(entity, links);
        }
        let links = &cache.followers[&entity];
        let dmx = parameter_to_dmx_value(&follower);
        let Some(index) = metadata
            .functions
            .iter()
            .enumerate()
            .position(|(index, function)| {
                (function.dmx_from..=function.dmx_to).contains(&dmx)
                    && mode_master_holds(function, links.mode_masters[index], &param_query)
            })
        else {
            continue;
        };
        if links.masters[index].is_empty() {
            continue;
        }
        let function = &metadata.functions[index];
        followers.insert(
            entity,
            ActiveFollower {
                from: metadata.logical_value_from_dmx(function.dmx_from),
                to: metadata.logical_value_from_dmx(function.dmx_to),
                masters: links.masters[index].clone(),
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

/// Returns true when cached links were resolved from the metadata's current declarations.
fn signature_matches(signature: &LinkSignature, metadata: &ParameterMetadata) -> bool {
    signature.len() == metadata.functions.len()
        && signature
            .iter()
            .zip(&metadata.functions)
            .all(|((mode_master, relations), function)| {
                *mode_master == function.mode_master && *relations == function.relations
            })
}

/// Resolves a follower's mode masters and console-applied relation masters to entities.
///
/// A relation is the console's when its master or its follower is virtual.
fn resolve_links(
    follower: &Instance<Parameter>,
    metadata: &ParameterMetadata,
    param_query: &Query<InstanceMut<Parameter>>,
    data_provider: &FixtureDataProviderExt,
) -> FollowerLinks {
    let fixture_ref = data_provider.try_fixture_ref_for_parameter(follower);
    let entity_of = |reference: &ElementParameterRef| {
        let fixture_ref = fixture_ref.as_ref()?;
        let element = FixtureRef {
            fixture_uid: fixture_ref.fixture_uid,
            index: Some(reference.element + 1),
        };
        data_provider
            .try_parameter_for_element_attribute(&element, &reference.attribute)
            .map(|parameter| parameter.entity())
    };
    let follower_is_virtual = metadata.dmx_slots == DmxSlots::Virtual;
    FollowerLinks {
        signature: metadata
            .functions
            .iter()
            .map(|function| (function.mode_master.clone(), function.relations.clone()))
            .collect(),
        mode_masters: metadata
            .functions
            .iter()
            .map(|function| {
                function
                    .mode_master
                    .as_ref()
                    .and_then(|condition| entity_of(&condition.master))
            })
            .collect(),
        masters: metadata
            .functions
            .iter()
            .map(|function| {
                function
                    .relations
                    .iter()
                    .filter_map(|relation| {
                        let master = entity_of(&relation.master)?;
                        let master_is_virtual = param_query
                            .get(master)
                            .is_ok_and(|master| master.metadata.dmx_slots == DmxSlots::Virtual);
                        (follower_is_virtual || master_is_virtual)
                            .then_some((master, relation.kind))
                    })
                    .collect()
            })
            .collect(),
    }
}

/// Returns true when a function has no mode master, its master cannot be
/// found, or the master's DMX value lies in the condition's range.
fn mode_master_holds(
    function: &ParameterFunction,
    master: Option<Entity>,
    param_query: &Query<InstanceMut<Parameter>>,
) -> bool {
    let (Some(condition), Some(master)) = (&function.mode_master, master) else {
        return true;
    };
    let Ok(master) = param_query.get(master) else {
        return true;
    };
    (condition.dmx_from..=condition.dmx_to).contains(&parameter_to_dmx_value(&master))
}

/// Returns a parameter's value after the console-applied relations it
/// follows, memoizing followers in `resolved`.
fn resolve(
    entity: Entity,
    followers: &HashMap<Entity, ActiveFollower>,
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
