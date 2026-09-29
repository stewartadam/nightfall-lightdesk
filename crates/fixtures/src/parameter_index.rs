// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Forward and reverse index between patched fixture element attributes and parameter entities.

use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use rustc_hash::FxHashMap;
use uuid::Uuid;

use crate::parameter::Parameter;

/// Where a parameter entity sits in the patched rig.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParameterLocation {
    /// Fixture element that owns the parameter.
    pub element: FixtureRef,
    /// Attribute the parameter controls on that element.
    pub attribute: Attribute,
}

/// Index of every patched parameter entity by element attribute and by entity.
///
/// Frame-rate systems resolve parameters for every element each frame, so lookups avoid cloning
/// keys and hash with `FxHash`. Each element keeps its parameters in a small vector: an element has
/// a handful of attributes, so a linear scan beats hashing the attribute.
#[derive(Debug, Default)]
pub struct ParameterIndex {
    by_element: FxHashMap<FixtureRef, Vec<(Attribute, Instance<Parameter>)>>,
    by_parameter: FxHashMap<Instance<Parameter>, ParameterLocation>,
}

impl ParameterIndex {
    /// Returns the parameter controlling `attribute` on `element`, if one is patched.
    pub fn parameter(
        &self,
        element: &FixtureRef,
        attribute: &Attribute,
    ) -> Option<Instance<Parameter>> {
        self.element_parameters(element)
            .iter()
            .find_map(|(candidate, parameter)| (candidate == attribute).then_some(*parameter))
    }

    /// Returns every patched `(attribute, parameter)` pair of `element`, in patch order.
    pub fn element_parameters(&self, element: &FixtureRef) -> &[(Attribute, Instance<Parameter>)] {
        self.by_element.get(element).map_or(&[], Vec::as_slice)
    }

    /// Returns the element and attribute that `parameter` controls.
    pub fn location(&self, parameter: &Instance<Parameter>) -> Option<&ParameterLocation> {
        self.by_parameter.get(parameter)
    }

    /// Iterates every indexed parameter with its location, in no particular order.
    pub fn iter(&self) -> impl Iterator<Item = (Instance<Parameter>, &ParameterLocation)> {
        self.by_parameter
            .iter()
            .map(|(parameter, location)| (*parameter, location))
    }

    /// Returns the number of indexed parameters.
    pub fn len(&self) -> usize {
        self.by_parameter.len()
    }

    /// Returns whether no parameters are indexed.
    pub fn is_empty(&self) -> bool {
        self.by_parameter.is_empty()
    }

    /// Indexes `parameter` as the control for `attribute` on `element`.
    ///
    /// Like a bijection, this replaces any parameter already indexed for the same element attribute
    /// and removes any earlier location of the same parameter.
    pub fn insert(
        &mut self,
        element: FixtureRef,
        attribute: Attribute,
        parameter: Instance<Parameter>,
    ) {
        if let Some(previous) = self.by_parameter.remove(&parameter) {
            self.remove_from_element(&previous.element, &previous.attribute);
        }
        if let Some(replaced) = self.remove_from_element(&element, &attribute) {
            self.by_parameter.remove(&replaced);
        }

        self.by_element
            .entry(element.clone())
            .or_default()
            .push((attribute.clone(), parameter));
        self.by_parameter
            .insert(parameter, ParameterLocation { element, attribute });
    }

    /// Removes every parameter of the fixture identified by `fixture_uid`.
    pub fn remove_fixture(&mut self, fixture_uid: Uuid) {
        self.by_element
            .retain(|element, _| element.fixture_uid != fixture_uid);
        self.by_parameter
            .retain(|_, location| location.element.fixture_uid != fixture_uid);
    }

    /// Removes the element attribute entry and returns the parameter it pointed to.
    fn remove_from_element(
        &mut self,
        element: &FixtureRef,
        attribute: &Attribute,
    ) -> Option<Instance<Parameter>> {
        let parameters = self.by_element.get_mut(element)?;
        let position = parameters
            .iter()
            .position(|(candidate, _)| candidate == attribute)?;
        let (_, parameter) = parameters.remove(position);
        if parameters.is_empty() {
            self.by_element.remove(element);
        }
        Some(parameter)
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::world::World;
    use nightfall_fixture_model::prelude::*;

    use super::*;

    /// Spawns a default parameter entity and returns its typed instance.
    fn parameter(world: &mut World) -> Instance<Parameter> {
        let entity = world
            .spawn(Parameter {
                metadata: ParameterMetadata::default(),
                values: Default::default(),
            })
            .id();

        // SAFETY: entity was just spawned in this world with a Parameter component.
        unsafe { Instance::from_entity_unchecked(entity) }
    }

    /// Returns an element reference for the given fixture and 1-based element index.
    fn element(fixture_uid: Uuid, index: u32) -> FixtureRef {
        FixtureRef {
            fixture_uid,
            index: Some(index),
        }
    }

    /// Verifies forward, per-element and reverse lookups agree after inserts.
    #[test]
    fn lookups_resolve_in_both_directions() {
        let mut world = World::new();
        let fixture_uid = Uuid::new_v4();
        let red = parameter(&mut world);
        let green = parameter(&mut world);
        let mut index = ParameterIndex::default();
        index.insert(element(fixture_uid, 1), Attribute::Red, red);
        index.insert(element(fixture_uid, 1), Attribute::Green, green);

        assert_eq!(
            index.parameter(&element(fixture_uid, 1), &Attribute::Red),
            Some(red)
        );
        assert_eq!(
            index.parameter(&element(fixture_uid, 2), &Attribute::Red),
            None
        );
        assert_eq!(
            index.element_parameters(&element(fixture_uid, 1)),
            &[(Attribute::Red, red), (Attribute::Green, green)]
        );
        assert_eq!(
            index.location(&green),
            Some(&ParameterLocation {
                element: element(fixture_uid, 1),
                attribute: Attribute::Green,
            })
        );
        assert_eq!(index.len(), 2);
    }

    /// Verifies re-inserting either side of a pair drops the stale mapping, as a bijection would.
    #[test]
    fn insert_replaces_conflicting_entries_on_both_sides() {
        let mut world = World::new();
        let fixture_uid = Uuid::new_v4();
        let first = parameter(&mut world);
        let second = parameter(&mut world);
        let mut index = ParameterIndex::default();

        index.insert(element(fixture_uid, 1), Attribute::Red, first);
        index.insert(element(fixture_uid, 1), Attribute::Red, second);
        assert_eq!(index.location(&first), None);
        assert_eq!(
            index.parameter(&element(fixture_uid, 1), &Attribute::Red),
            Some(second)
        );

        index.insert(element(fixture_uid, 2), Attribute::Blue, second);
        assert_eq!(
            index.parameter(&element(fixture_uid, 1), &Attribute::Red),
            None
        );
        assert!(
            index
                .element_parameters(&element(fixture_uid, 1))
                .is_empty()
        );
        assert_eq!(index.len(), 1);
    }

    /// Verifies removing a fixture drops all of its elements without touching other fixtures.
    #[test]
    fn remove_fixture_only_drops_that_fixture() {
        let mut world = World::new();
        let removed_uid = Uuid::new_v4();
        let kept_uid = Uuid::new_v4();
        let removed = parameter(&mut world);
        let kept = parameter(&mut world);
        let mut index = ParameterIndex::default();
        index.insert(element(removed_uid, 1), Attribute::Red, removed);
        index.insert(element(kept_uid, 1), Attribute::Red, kept);

        index.remove_fixture(removed_uid);

        assert_eq!(index.location(&removed), None);
        assert_eq!(
            index.parameter(&element(kept_uid, 1), &Attribute::Red),
            Some(kept)
        );
        assert_eq!(index.len(), 1);
    }
}
