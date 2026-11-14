// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! ECS adapters that resolve selections against live fixture and group storage.
//!
//! [`SelectionResolver`] and [`SpatialSelectionResolver`] are system params over the patched
//! fixtures and the groups. [`ResolvedSelectionCache`] keeps resolved selections for per-frame
//! renderers until the rig changes.
#![warn(missing_docs)]

use std::{collections::HashMap, hash::Hash};

use bevy_ecs::{prelude::*, system::SystemParam};
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_selection::{
    SelectionDataSource, SelectionFixture, SelectionGroup,
    SelectionResolver as PureSelectionResolver, SpatialSelectionResolution,
    SpatialSelectionResolver as PureSpatialSelectionResolver, filter_existing_selection,
};

/// Converts group storage records into the narrow selection read model.
fn selection_group_from_group(group: &Group) -> SelectionGroup {
    SelectionGroup {
        uid: group.identifiers.uid,
        id: group.identifiers.id,
        label: group.identifiers.label.clone(),
        selection: group.selection.clone(),
    }
}

/// ECS access for resolving selections against live fixture and group storage.
#[derive(SystemParam)]
pub struct FixtureSelectionDataSource<'w> {
    fixtures: Res<'w, FixtureDataProviderExt>,
    groups: Res<'w, DataProvider<Group>>,
}

impl SelectionDataSource for FixtureSelectionDataSource<'_> {
    fn fixture_by_id(&self, fixture_id: u32) -> Option<SelectionFixture> {
        self.fixtures.fixture_by_id(fixture_id)
    }

    fn fixture_by_ref(&self, fixture_ref: &FixtureRef) -> Option<SelectionFixture> {
        self.fixtures.fixture_by_ref(fixture_ref)
    }

    /// Lists the patched fixture IDs inside `range` from live fixture storage.
    fn fixture_ids_in(&self, range: std::ops::RangeInclusive<u32>) -> Vec<u32> {
        self.fixtures.fixture_ids_in(range)
    }

    /// Lists the stored group IDs inside `range` from live group storage.
    fn group_ids_in(&self, range: std::ops::RangeInclusive<u32>) -> Vec<u32> {
        self.groups.ids_in(range)
    }

    fn groups_available(&self) -> bool {
        true
    }

    fn group_by_uid(&self, uid: uuid::Uuid) -> Option<SelectionGroup> {
        self.groups
            .get(uid)
            .ok()
            .map(|group| selection_group_from_group(&group))
    }

    fn group_by_id(&self, group_id: u32) -> Option<SelectionGroup> {
        self.groups
            .from_id(group_id)
            .ok()
            .map(|group| selection_group_from_group(&group))
    }

    fn group_by_label(&self, label: &str) -> Option<SelectionGroup> {
        self.groups.iter().find_map(|group| {
            (group.identifiers.label == label).then(|| selection_group_from_group(&group))
        })
    }
}

/// Fixture-backed ECS resolver for non-spatial selection expressions.
#[derive(SystemParam)]
pub struct SelectionResolver<'w> {
    data_source: FixtureSelectionDataSource<'w>,
}

impl SelectionResolver<'_> {
    /// Resolve a `SelectionExpr` into a flat list of resolved `FixtureRef`s.
    pub fn resolve_expr(&self, expr: &SelectionExpr) -> PartialResult<Vec<FixtureRef>> {
        PureSelectionResolver::new(&self.data_source).resolve_expr(expr)
    }

    /// Resolve a `SelectionExpr` into a `SpannedSelection` that preserves span grouping.
    pub fn resolve_expr_spanned(&self, expr: &SelectionExpr) -> PartialResult<SpannedSelection> {
        PureSelectionResolver::new(&self.data_source).resolve_expr_spanned(expr)
    }

    /// Return an expression with dynamic group refs resolved to stable UID refs.
    pub fn stabilize_group_refs_expr(&self, expr: &SelectionExpr) -> PartialResult<SelectionExpr> {
        PureSelectionResolver::new(&self.data_source).stabilize_group_refs_expr(expr)
    }

    /// Return a spatial selection with dynamic group refs resolved to stable UID refs.
    pub fn stabilize_group_refs_selection(
        &self,
        selection: &SpatialSelection,
    ) -> PartialResult<SpatialSelection> {
        PureSelectionResolver::new(&self.data_source).stabilize_group_refs_selection(selection)
    }
}

/// Fixture-backed ECS resolver for spatial selections.
#[derive(SystemParam)]
pub struct SpatialSelectionResolver<'w> {
    data_source: FixtureSelectionDataSource<'w>,
}

impl SpatialSelectionResolver<'_> {
    /// Collapse element refs that cover every element in a fixture into one whole-fixture ref.
    pub fn collapse_complete_fixture_element_sets(
        &self,
        fixtures: Vec<FixtureRef>,
    ) -> Vec<FixtureRef> {
        PureSpatialSelectionResolver::new(&self.data_source)
            .collapse_complete_fixture_element_sets(fixtures)
    }

    /// Resolve a spatial selection into canonical fixture refs and projection metadata.
    pub fn resolve(&self, selection: &SpatialSelection) -> PartialResult<ResolvedSelection> {
        PureSpatialSelectionResolver::new(&self.data_source).resolve(selection)
    }

    /// Return a spatial selection with dynamic group refs resolved to stable UID refs.
    pub fn stabilize_group_refs_selection(
        &self,
        selection: &SpatialSelection,
    ) -> PartialResult<SpatialSelection> {
        PureSelectionResolver::new(&self.data_source).stabilize_group_refs_selection(selection)
    }

    /// Returns the revisions of the patched fixtures and the groups, the only inputs to
    /// resolution. A selection resolved at one revision resolves the same way until it changes.
    pub fn inputs_revision(&self) -> SelectionInputsRevision {
        SelectionInputsRevision {
            fixtures: self.data_source.fixtures.inner.revision(),
            groups: self.data_source.groups.revision(),
        }
    }
}

/// Point in the fixture and group change history a selection was resolved at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionInputsRevision {
    /// Revision of the patched fixtures.
    fixtures: DataRevision,
    /// Revision of the groups.
    groups: DataRevision,
}

/// A selection resolved against the rig, kept while its definition and the rig are unchanged.
struct CachedResolvedSelection {
    /// Selection definition the entry was resolved from.
    source: SpatialSelection,
    /// Fixture and group revisions the entry was resolved at.
    inputs_revision: SelectionInputsRevision,
    /// Resolved selection filtered down to fixtures that exist.
    resolved: ResolvedSelection,
}

/// Resolved selections for per-frame renderers such as FX and flow nodes, keyed by whatever
/// identifies one renderer instance.
///
/// Resolution walks groups, projections and shuffles, which costs far more than rendering the
/// resolved fixtures, yet its result only changes when the selection definition, the patch or
/// the groups change. Each entry records the fixture and group revisions it was resolved at, so
/// an entry is never served after the rig changed, however long its renderer went unevaluated.
pub struct ResolvedSelectionCache<K> {
    entries: HashMap<K, CachedResolvedSelection>,
}

impl<K> Default for ResolvedSelectionCache<K> {
    /// Creates an empty cache.
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<K: Eq + Hash> ResolvedSelectionCache<K> {
    /// Keeps only the entries whose key satisfies `keep`, so finished renderers do not pin memory.
    pub fn retain(&mut self, mut keep: impl FnMut(&K) -> bool) {
        self.entries.retain(|key, _| keep(key));
    }

    /// Returns `source` resolved and filtered to existing fixtures, resolving again only when
    /// `key` has no entry yet, or its entry was resolved from a different definition or before
    /// the patch or the groups last changed.
    pub fn resolve(
        &mut self,
        key: K,
        source: &SpatialSelection,
        selection_resolver: &SpatialSelectionResolver,
    ) -> &ResolvedSelection {
        let inputs_revision = selection_resolver.inputs_revision();
        let resolve_fresh = || CachedResolvedSelection {
            source: source.clone(),
            inputs_revision,
            resolved: filter_existing_selection(
                &selection_resolver.resolve(source).into_value(),
                &*selection_resolver.data_source.fixtures,
            ),
        };
        let entry = self
            .entries
            .entry(key)
            .and_modify(|cached| {
                if cached.inputs_revision != inputs_revision || cached.source != *source {
                    *cached = resolve_fresh();
                }
            })
            .or_insert_with(resolve_fresh);
        &entry.resolved
    }

    /// Returns the selection last resolved for `key` by [`Self::resolve`], without checking it
    /// against the rig, so callers resolve every key first and then share the results.
    pub fn get(&self, key: &K) -> Option<&ResolvedSelection> {
        self.entries.get(key).map(|entry| &entry.resolved)
    }
}

impl SpatialSelectionResolution for SpatialSelectionResolver<'_> {
    fn collapse_complete_fixture_element_sets(&self, fixtures: Vec<FixtureRef>) -> Vec<FixtureRef> {
        self.collapse_complete_fixture_element_sets(fixtures)
    }

    fn resolve(&self, selection: &SpatialSelection) -> PartialResult<ResolvedSelection> {
        self.resolve(selection)
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::{system::SystemState, world::World};
    use nightfall_fixtures::prelude::*;

    use super::*;

    /// Build a fixture with the requested fixture ID and element count.
    fn make_fixture(fixture_id: u32, element_count: usize) -> Fixture {
        Fixture {
            identifiers: Identifiers {
                id: fixture_id,
                uid: uuid::Uuid::from_u128(fixture_id as u128),
                label: format!("Fixture {fixture_id}"),
            },
            make: "test".to_owned(),
            model: "test".to_owned(),
            mode: "default".to_owned(),
            elements: (0..element_count)
                .map(|index| FixtureElement {
                    label: format!("Element {}", index + 1),
                    parameters: Vec::new(),
                })
                .collect(),
            ..Default::default()
        }
    }

    /// Build a group whose stored selection resolves to a whole fixture.
    fn make_group(group_id: u32, fixture_id: u32) -> Group {
        Group {
            identifiers: Identifiers {
                id: group_id,
                uid: uuid::Uuid::from_u128(10_000 + group_id as u128),
                label: format!("Group {group_id}"),
            },
            selection: SpatialSelection::pipeline(
                SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id,
                    element_index: None,
                }),
                Vec::new(),
            ),
            description: String::new(),
        }
    }

    /// Fixture-backed spatial resolver expands group labels through ECS resources.
    #[test]
    fn spatial_resolver_reads_fixture_and_group_resources() {
        let mut fixtures = FixtureDataProviderExt::default();
        fixtures.inner.add(make_fixture(1, 3)).unwrap();

        let mut groups = DataProvider::<Group>::default();
        groups.add(make_group(7, 1)).unwrap();

        let mut world = World::new();
        world.insert_resource(fixtures);
        world.insert_resource(groups);

        let mut system_state = SystemState::<SpatialSelectionResolver>::new(&mut world);
        let resolver = system_state.get(&world).unwrap();

        let result = resolver.resolve(&SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::ByLabel("Group 7".to_owned())),
            vec![SpatialClause::Expand { depth: None }],
        ));

        assert!(result.issues.is_empty());
        assert_eq!(
            result.into_value().canonical_fixtures(),
            vec![
                FixtureRef {
                    fixture_uid: uuid::Uuid::from_u128(1),
                    index: Some(1),
                },
                FixtureRef {
                    fixture_uid: uuid::Uuid::from_u128(1),
                    index: Some(2),
                },
                FixtureRef {
                    fixture_uid: uuid::Uuid::from_u128(1),
                    index: Some(3),
                },
            ]
        );
    }

    /// Resolves `selection` through `cache` against the world's current fixtures and groups.
    fn resolve_through_cache(
        world: &World,
        system_state: &mut SystemState<SpatialSelectionResolver>,
        cache: &mut ResolvedSelectionCache<u32>,
        selection: &SpatialSelection,
    ) -> Vec<FixtureRef> {
        let resolver = system_state.get(world).unwrap();
        cache
            .resolve(0, selection, &resolver)
            .canonical_fixtures()
            .to_vec()
    }

    /// The cache keeps a resolved selection while the rig is unchanged and resolves again when
    /// the definition, the groups or the patch change, including changes made between visits.
    #[test]
    fn resolved_selection_cache_resolves_again_when_inputs_change() {
        let mut fixtures = FixtureDataProviderExt::default();
        fixtures.inner.add(make_fixture(1, 1)).unwrap();
        fixtures.inner.add(make_fixture(2, 1)).unwrap();
        let mut groups = DataProvider::<Group>::default();
        groups.add(make_group(7, 1)).unwrap();

        let mut world = World::new();
        world.insert_resource(fixtures);
        world.insert_resource(groups);
        let mut system_state = SystemState::<SpatialSelectionResolver>::new(&mut world);
        let mut cache = ResolvedSelectionCache::default();
        let group_selection = SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::ByLabel("Group 7".to_owned())),
            Vec::new(),
        );
        let whole_fixture = |fixture_id: u128| FixtureRef {
            fixture_uid: uuid::Uuid::from_u128(fixture_id),
            index: None,
        };

        let first = resolve_through_cache(&world, &mut system_state, &mut cache, &group_selection);
        assert_eq!(first, vec![whole_fixture(1)]);
        let first_revision = cache.entries[&0].inputs_revision;
        resolve_through_cache(&world, &mut system_state, &mut cache, &group_selection);
        assert_eq!(cache.entries[&0].inputs_revision, first_revision);

        {
            let mut groups = world.resource_mut::<DataProvider<Group>>();
            groups.remove(&uuid::Uuid::from_u128(10_007)).unwrap();
            groups.add(make_group(7, 2)).unwrap();
        }
        let after_group_change =
            resolve_through_cache(&world, &mut system_state, &mut cache, &group_selection);
        assert_eq!(after_group_change, vec![whole_fixture(2)]);

        world
            .resource_mut::<FixtureDataProviderExt>()
            .inner
            .remove(&uuid::Uuid::from_u128(2))
            .unwrap();
        let after_unpatch =
            resolve_through_cache(&world, &mut system_state, &mut cache, &group_selection);
        assert!(after_unpatch.is_empty());

        let fixture_selection = SpatialSelection::pipeline(
            SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            }),
            Vec::new(),
        );
        let after_definition_change =
            resolve_through_cache(&world, &mut system_state, &mut cache, &fixture_selection);
        assert_eq!(after_definition_change, vec![whole_fixture(1)]);
    }
}
