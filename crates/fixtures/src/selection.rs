// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture-backed adapters for pure selection resolution.

use bevy_ecs::{prelude::*, system::SystemParam};
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_selection::{
    SelectionDataSource, SelectionFixture, SelectionGroup,
    SelectionResolver as PureSelectionResolver, SpatialSelectionResolution,
    SpatialSelectionResolver as PureSpatialSelectionResolver,
};

use crate::prelude::FixtureDataProviderExt;

/// Converts fixture storage records into the narrow selection read model.
fn selection_fixture_from_parts(fixture_uid: uuid::Uuid, element_count: usize) -> SelectionFixture {
    SelectionFixture {
        fixture_ref: FixtureRef {
            fixture_uid,
            index: None,
        },
        element_count: element_count as u32,
    }
}

/// Converts group storage records into the narrow selection read model.
fn selection_group_from_group(group: &Group) -> SelectionGroup {
    SelectionGroup {
        uid: group.identifiers.uid,
        id: group.identifiers.id,
        label: group.identifiers.label.clone(),
        selection: group.selection.clone(),
    }
}

impl SelectionDataSource for FixtureDataProviderExt {
    fn fixture_by_id(&self, fixture_id: u32) -> Option<SelectionFixture> {
        self.inner.from_id(fixture_id).ok().map(|fixture| {
            selection_fixture_from_parts(fixture.identifiers.uid, fixture.elements.len())
        })
    }

    fn fixture_by_ref(&self, fixture_ref: &FixtureRef) -> Option<SelectionFixture> {
        self.inner.get(fixture_ref.fixture_uid).ok().map(|fixture| {
            selection_fixture_from_parts(fixture.identifiers.uid, fixture.elements.len())
        })
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
    /// Returns the fixture metadata backing this resolver for compatibility checks.
    pub fn fixture_data_provider(&self) -> &FixtureDataProviderExt {
        &self.data_source.fixtures
    }

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

    use super::*;
    use crate::prelude::*;

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
}
