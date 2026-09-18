// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Provides access to fixture data and associated parameters.
use std::sync::RwLock;

use bevy_ecs::prelude::*;
use bimap::BiMap;
use dashmap::{DashMap, iter::Iter};
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use uuid::Uuid;

use crate::fixture::Fixture;
use crate::prelude::*;

/// Provides access to fixtures and their associated parameters.
#[derive(Resource, Default)]
pub struct FixtureDataProviderExt {
    /// Underlying data provider for fixtures.
    pub inner: DataProvider<Fixture>,
    /// Map of fixture element references to their parameter entities.
    pub parameter_map: DashMap<FixtureRef, Vec<Instance<Parameter>>>,
    /// Bi-directional map of (fixture element reference, attribute) to parameter entity.
    pub parameter_attribute_map: RwLock<BiMap<(FixtureRef, Attribute), Instance<Parameter>>>,
    /// Default color path assignments keyed by fixture or fixture element.
    pub color_path_defaults: DashMap<FixtureRef, ColorPathId>,
}

/// A concrete parameter resolved from a logical fixture attribute request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedElementParameter {
    /// Runtime parameter instance to write into.
    pub instance: Instance<Parameter>,
    /// Concrete fixture attribute represented by the parameter instance.
    pub attribute: Attribute,
}

impl FixtureDataProviderExt {
    /// Returns parameter entities for a given fixture element reference.
    pub fn parameter_entities_for_element(
        &self,
        element_ref: &FixtureRef,
    ) -> Vec<Instance<Parameter>> {
        if element_ref.index.is_none() {
            let fixture = self.inner.get(element_ref.fixture_uid).unwrap();
            fixture
                .elements
                .iter()
                .enumerate()
                .flat_map(|(index, _element)| {
                    self.parameter_entities_for_element(&FixtureRef {
                        fixture_uid: fixture.identifiers.uid,
                        index: Some(index as u32 + 1),
                    })
                })
                .collect::<Vec<_>>()
        } else {
            self.parameter_map
                .get(element_ref)
                .unwrap_or_else(|| {
                    panic!(
                        "failed to obtain parameter for element reference {:?}",
                        element_ref
                    )
                })
                .clone()
        }
    }

    /// Returns the fixture reference for a given parameter entity.
    pub fn fixture_ref_for_parameter(&self, parameter: &Instance<Parameter>) -> FixtureRef {
        self.parameter_attribute_map
            .read()
            .unwrap()
            .get_by_right(parameter)
            .unwrap_or_else(|| {
                panic!(
                    "failed to obtain element reference for parameter {:?}",
                    parameter
                )
            })
            .clone()
            .0
    }

    /// Looks up a fixture reference by parameter, returning None if not found.
    pub fn try_fixture_ref_for_parameter(
        &self,
        parameter: &Instance<Parameter>,
    ) -> Option<FixtureRef> {
        self.parameter_attribute_map
            .read()
            .unwrap()
            .get_by_right(parameter)
            .map(|(fixture_ref, _)| fixture_ref.clone())
    }

    /// Returns parameter entities for all elements of a given fixture.
    pub fn parameter_entities_for_fixture(&self, uuid: Uuid) -> Vec<Instance<Parameter>> {
        let fixture = self.inner.get(uuid).unwrap();
        fixture
            .elements
            .iter()
            .enumerate()
            .map(|(index, _element)| FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1 + index as u32),
            })
            .flat_map(|fixture_ref| self.parameter_entities_for_element(&fixture_ref))
            .collect()
    }

    /// Looks up a parameter by element and attribute.
    pub fn parameter_for_element_attribute(
        &self,
        element_ref: &FixtureRef,
        attribute: &Attribute,
    ) -> Instance<Parameter> {
        return *self
            .parameter_attribute_map
            .read()
            .unwrap()
            .get_by_left(&(element_ref.clone(), attribute.clone()))
            .unwrap_or_else(|| {
                panic!(
                    "failed to obtain parameter for element reference {:?}, attribute {:?}",
                    element_ref, attribute
                )
            });
    }

    /// Looks up a parameter by element and attribute, returning None if not found.
    pub fn try_parameter_for_element_attribute(
        &self,
        element_ref: &FixtureRef,
        attribute: &Attribute,
    ) -> Option<Instance<Parameter>> {
        self.parameter_attribute_map
            .read()
            .unwrap()
            .get_by_left(&(element_ref.clone(), attribute.clone()))
            .cloned()
    }

    /// Resolves a logical attribute request to a concrete fixture element attribute.
    pub fn resolve_logical_attribute_for_element(
        &self,
        element_ref: &FixtureRef,
        attribute: &Attribute,
    ) -> Option<Attribute> {
        let element_index = element_ref.index?.checked_sub(1)? as usize;
        let fixture = self.inner.get(element_ref.fixture_uid).ok()?;
        let element = fixture.elements.get(element_index)?;

        if element
            .parameters
            .iter()
            .any(|parameter| parameter.attribute == *attribute)
        {
            return Some(attribute.clone());
        }

        if *attribute == Attribute::Intensity
            && element
                .parameters
                .iter()
                .any(|parameter| parameter.attribute == Attribute::VirtualIntensity)
        {
            return Some(Attribute::VirtualIntensity);
        }

        None
    }

    /// Looks up a parameter by element and logical attribute, returning None if not found.
    pub fn try_parameter_for_logical_attribute(
        &self,
        element_ref: &FixtureRef,
        attribute: &Attribute,
    ) -> Option<ResolvedElementParameter> {
        let attribute = self.resolve_logical_attribute_for_element(element_ref, attribute)?;
        let instance = self.try_parameter_for_element_attribute(element_ref, &attribute)?;
        Some(ResolvedElementParameter {
            instance,
            attribute,
        })
    }

    /// Sets or clears the default color path for a fixture or fixture element.
    pub fn set_color_path_default(
        &mut self,
        fixture_ref: FixtureRef,
        color_path_id: Option<ColorPathId>,
    ) {
        match color_path_id {
            Some(color_path_id) => {
                self.color_path_defaults.insert(fixture_ref, color_path_id);
            }
            None => {
                self.color_path_defaults.remove(&fixture_ref);
            }
        }
    }

    /// Returns the default color path for an element, falling back to its whole fixture.
    pub fn color_path_default_for_element(&self, element_ref: &FixtureRef) -> Option<ColorPathId> {
        self.color_path_defaults
            .get(element_ref)
            .map(|entry| *entry.value())
            .or_else(|| {
                let fixture_ref = FixtureRef {
                    fixture_uid: element_ref.fixture_uid,
                    index: None,
                };
                self.color_path_defaults
                    .get(&fixture_ref)
                    .map(|entry| *entry.value())
            })
    }

    /// Replaces all color path defaults with the provided persisted entries.
    pub fn replace_color_path_defaults(
        &mut self,
        defaults: impl IntoIterator<Item = ColorPathDefault>,
    ) {
        self.color_path_defaults.clear();
        for default in defaults {
            self.color_path_defaults
                .insert(default.fixture, default.color_path_id);
        }
    }

    /// Returns color path defaults in a stable vector representation for persistence.
    pub fn color_path_default_entries(&self) -> Vec<ColorPathDefault> {
        self.color_path_defaults
            .iter()
            .map(|entry| ColorPathDefault {
                fixture: entry.key().clone(),
                color_path_id: *entry.value(),
            })
            .collect()
    }

    /// Returns an iterator over the parameter map.
    pub fn iter_parameter_map(&self) -> Iter<'_, FixtureRef, Vec<Instance<Parameter>>> {
        self.parameter_map.iter()
    }

    /// Returns the number of elements for a fixture, or None if fixture not found.
    pub fn element_count(&self, fixture_uid: Uuid) -> Option<usize> {
        self.inner.get(fixture_uid).ok().map(|f| f.elements.len())
    }

    /// Returns a read guard for batch parameter lookups.
    /// Use this when performing many lookups to avoid repeated lock acquisitions.
    pub fn parameter_attribute_map_guard(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, BiMap<(FixtureRef, Attribute), Instance<Parameter>>> {
        self.parameter_attribute_map.read().unwrap()
    }

    /// Adds a parameter entity for a given fixture element and attribute.
    pub fn add_parameter(
        &self,
        element_ref: FixtureRef,
        attribute: Attribute,
        parameter: Instance<Parameter>,
    ) {
        tracing::trace!(
            parameter = %parameter,
            ?attribute,
            fixture_uid = %element_ref.fixture_uid,
            element_index = ?element_ref.index,
            "Adding parameter for fixture element"
        );
        let parameters = self.parameter_map.get_mut(&element_ref);
        if let Some(mut parameter_vec) = parameters {
            parameter_vec.push(parameter);
        } else {
            self.parameter_map
                .insert(element_ref.clone(), vec![parameter]);
        }

        let key = (element_ref.clone(), attribute.clone());
        self.parameter_attribute_map
            .write()
            .unwrap()
            .insert(key, parameter);
    }

    /// Removes a fixture and returns parameter entities for despawning.
    ///
    /// Cleans up all parameter_map and parameter_attribute_map entries
    /// associated with the fixture, returning the Parameter entity instances.
    pub fn remove_fixture(
        &mut self,
        uuid: &Uuid,
    ) -> Result<(Fixture, Vec<Instance<Parameter>>), DataStoreError<Fixture>> {
        let fixture = self.inner.remove(uuid)?;
        let mut removed_parameters = Vec::new();

        // Collect element refs for this fixture
        let element_count = fixture.elements.len();
        for idx in 0..element_count {
            let element_ref = FixtureRef {
                fixture_uid: *uuid,
                index: Some(idx as u32 + 1),
            };

            // Remove from parameter_map
            if let Some((_, params)) = self.parameter_map.remove(&element_ref) {
                removed_parameters.extend(params);
            }

            // Remove from parameter_attribute_map
            let mut attr_map = self.parameter_attribute_map.write().unwrap();
            let keys_to_remove: Vec<_> = attr_map
                .iter()
                .filter(|((ref_, _), _)| ref_.fixture_uid == *uuid)
                .map(|(k, _)| k.clone())
                .collect();
            for key in keys_to_remove {
                attr_map.remove_by_left(&key);
            }
        }
        self.color_path_defaults
            .retain(|fixture_ref, _| fixture_ref.fixture_uid != *uuid);

        tracing::debug!(
            "Removed fixture {} with {} parameter entities",
            fixture.identifiers.id,
            removed_parameters.len()
        );

        Ok((fixture, removed_parameters))
    }

    /// Removes all fixtures and returns parameter entities for despawning.
    pub fn clear_all(&mut self) -> Vec<Instance<Parameter>> {
        let fixture_uids: Vec<Uuid> = self.inner.iter().map(|entry| *entry.key()).collect();
        let mut removed_parameters = Vec::new();

        for fixture_uid in fixture_uids {
            match self.remove_fixture(&fixture_uid) {
                Ok((_fixture, parameters)) => removed_parameters.extend(parameters),
                Err(error) => tracing::warn!(
                    "Failed to remove fixture {} while clearing provider: {}",
                    fixture_uid,
                    error
                ),
            }
        }

        removed_parameters
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::world::World;

    use super::*;

    fn parameter(attribute: Attribute) -> ParameterMetadata {
        ParameterMetadata {
            attribute,
            ..Default::default()
        }
    }

    fn fixture(uid: Uuid, attributes: Vec<Attribute>) -> Fixture {
        Fixture {
            identifiers: Identifiers {
                id: 1,
                uid,
                label: "fixture".to_owned(),
            },
            make: "test".to_owned(),
            model: "test".to_owned(),
            mode: "default".to_owned(),
            elements: vec![FixtureElement {
                label: "element".to_owned(),
                parameters: attributes.into_iter().map(parameter).collect(),
            }],
            ..Default::default()
        }
    }

    fn spawn_parameter(world: &mut World, attribute: Attribute) -> Instance<Parameter> {
        let entity = world
            .spawn(Parameter {
                metadata: ParameterMetadata {
                    attribute,
                    ..Default::default()
                },
                values: Default::default(),
            })
            .id();

        // SAFETY: entity was just spawned in this world with a Parameter component.
        unsafe { Instance::from_entity_unchecked(entity) }
    }

    #[test]
    fn logical_attribute_resolution_uses_native_attribute_when_present() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(fixture(
                uid,
                vec![Attribute::Intensity, Attribute::VirtualIntensity],
            ))
            .unwrap();

        let element_ref = FixtureRef {
            fixture_uid: uid,
            index: Some(1),
        };

        assert_eq!(
            provider.resolve_logical_attribute_for_element(&element_ref, &Attribute::Intensity),
            Some(Attribute::Intensity)
        );
    }

    #[test]
    fn logical_attribute_resolution_maps_intensity_to_virtual_parameter_metadata() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(fixture(uid, vec![Attribute::VirtualIntensity]))
            .unwrap();

        let element_ref = FixtureRef {
            fixture_uid: uid,
            index: Some(1),
        };

        assert_eq!(
            provider.resolve_logical_attribute_for_element(&element_ref, &Attribute::Intensity),
            Some(Attribute::VirtualIntensity)
        );
    }

    #[test]
    fn logical_parameter_lookup_returns_concrete_parameter_instance() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        provider
            .inner
            .add(fixture(uid, vec![Attribute::VirtualIntensity]))
            .unwrap();

        let element_ref = FixtureRef {
            fixture_uid: uid,
            index: Some(1),
        };
        let mut world = World::new();
        let parameter = spawn_parameter(&mut world, Attribute::VirtualIntensity);
        provider.add_parameter(element_ref.clone(), Attribute::VirtualIntensity, parameter);

        assert_eq!(
            provider.try_parameter_for_logical_attribute(&element_ref, &Attribute::Intensity),
            Some(ResolvedElementParameter {
                instance: parameter,
                attribute: Attribute::VirtualIntensity,
            })
        );
    }

    /// Verifies element defaults override fixture defaults and clear back to fallback behavior.
    #[test]
    fn color_path_defaults_use_element_override_then_fixture_fallback() {
        let uid = Uuid::new_v4();
        let mut provider = FixtureDataProviderExt::default();
        let fixture_ref = FixtureRef {
            fixture_uid: uid,
            index: None,
        };
        let element_ref = FixtureRef {
            fixture_uid: uid,
            index: Some(1),
        };

        provider.set_color_path_default(fixture_ref, Some(ColorPathId(2)));
        assert_eq!(
            provider.color_path_default_for_element(&element_ref),
            Some(ColorPathId(2))
        );

        provider.set_color_path_default(element_ref.clone(), Some(ColorPathId(3)));
        assert_eq!(
            provider.color_path_default_for_element(&element_ref),
            Some(ColorPathId(3))
        );

        provider.set_color_path_default(element_ref.clone(), None);
        assert_eq!(
            provider.color_path_default_for_element(&element_ref),
            Some(ColorPathId(2))
        );
    }
}
