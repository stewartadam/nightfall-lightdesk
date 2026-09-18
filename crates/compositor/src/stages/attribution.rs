// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor stage for merging layers with attribution tracking.
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;

use crate::types::{AttributedAssertionsLayer, Layer};

/// Merges raw layer data for a materialized object into the attributed assertions layer.
pub fn merge_layer_with_attribution(
    assertions: &mut AttributedAssertionsLayer,
    upper_layer: &Layer,
    object_ref: ObjectRef,
) {
    // Absolute values override one another
    upper_layer
        .absolute
        .iter()
        .for_each(|(param, (value, transition))| {
            assertions
                .absolute
                .insert(param, (object_ref.clone(), (*value, transition.clone())));
        });

    // Relative values accumulate
    upper_layer
        .relative
        .iter()
        .for_each(|(param, (value, transition))| {
            if let Some((_existing_object_ref, (existing_value, _existing_transition))) =
                assertions.relative.get(param)
            {
                // Sum the relative values according to their types
                let summed_value = match (existing_value, value) {
                    (
                        ParameterValue::Relative {
                            offset: existing_offset,
                        },
                        ParameterValue::Relative { offset: new_offset },
                    ) => ParameterValue::Relative {
                        offset: existing_offset + new_offset,
                    },
                    (
                        ParameterValue::RelativePercent {
                            offset: existing_offset,
                        },
                        ParameterValue::RelativePercent { offset: new_offset },
                    ) => ParameterValue::RelativePercent {
                        offset: (*existing_offset + *new_offset),
                    },
                    _ => {
                        // If types don't match, just replace (this shouldn't normally happen)
                        tracing::warn!(
                            "Mismatched relative parameter types during merge: {} and {}",
                            existing_value,
                            value
                        );
                        *value
                    }
                };

                // Keep the most recent object reference and transition for tracking purposes
                assertions.relative.insert(
                    param,
                    (object_ref.clone(), (summed_value, transition.clone())),
                );
            } else {
                // No existing value, just insert
                assertions
                    .relative
                    .insert(param, (object_ref.clone(), (*value, transition.clone())));
            }
        });
}

#[cfg(test)]
mod tests {
    use bevy_ecs::world::World;
    use moonshine_kind::Instance;

    use super::*;
    use crate::types::test_support::{TestMergeMode, TestParameter};

    fn create_object_ref(id: u32) -> ObjectRef {
        ObjectRef::ById {
            object_type: ObjectType::Cue,
            id,
        }
    }

    fn create_test_parameter(world: &mut World) -> Instance<TestParameter> {
        let entity = world
            .spawn(TestParameter::new(TestMergeMode::Ltp, Attribute::Red))
            .id();

        unsafe { Instance::from_entity_unchecked(entity) }
    }

    #[test]
    fn test_merge_layer_absolute_values_override() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world);

        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);
        let object2 = create_object_ref(2);

        // First layer sets value
        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer1, object1.clone());

        // Verify first layer is tracked
        assert!(composited.absolute.contains_key(&param));
        let (owner, (value, _)) = composited.absolute.get(&param).unwrap();
        assert_eq!(owner, &object1);
        if let ParameterValue::Absolute { value: v } = value {
            assert_eq!(*v, 100.0);
        } else {
            panic!("Expected Absolute value");
        }

        // Second layer overrides
        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 200.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer2, object2.clone());

        // Verify second layer overwrote the first
        let (owner, (value, _)) = composited.absolute.get(&param).unwrap();
        assert_eq!(owner, &object2);
        if let ParameterValue::Absolute { value: v } = value {
            assert_eq!(*v, 200.0);
        } else {
            panic!("Expected Absolute value");
        }
    }

    #[test]
    fn test_merge_layer_relative_values_accumulate() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world);

        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);
        let object2 = create_object_ref(2);

        // First layer sets relative offset
        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .relative
            .insert(param, (ParameterValue::Relative { offset: 30.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer1, object1.clone());

        // Verify first layer
        assert!(composited.relative.contains_key(&param));
        let (owner, (value, _)) = composited.relative.get(&param).unwrap();
        assert_eq!(owner, &object1);
        if let ParameterValue::Relative { offset } = value {
            assert_eq!(*offset, 30.0);
        } else {
            panic!("Expected Relative value");
        }

        // Second layer adds to relative offset
        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .relative
            .insert(param, (ParameterValue::Relative { offset: 20.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer2, object2.clone());

        // Verify values accumulated and owner updated to most recent
        let (owner, (value, _)) = composited.relative.get(&param).unwrap();
        assert_eq!(owner, &object2); // Most recent object
        if let ParameterValue::Relative { offset } = value {
            assert_eq!(*offset, 50.0); // 30 + 20
        } else {
            panic!("Expected Relative value");
        }
    }

    #[test]
    fn test_merge_layer_relative_percent_accumulate() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world);

        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);
        let object2 = create_object_ref(2);

        // First layer sets relative percent offset
        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1.relative.insert(
            param,
            (
                ParameterValue::RelativePercent {
                    offset: Percentage::from(25.0),
                },
                None,
            ),
        );

        merge_layer_with_attribution(&mut composited, &layer1, object1.clone());

        // Second layer adds to relative percent offset
        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2.relative.insert(
            param,
            (
                ParameterValue::RelativePercent {
                    offset: Percentage::from(15.0),
                },
                None,
            ),
        );

        merge_layer_with_attribution(&mut composited, &layer2, object2.clone());

        // Verify values accumulated
        let (owner, (value, _)) = composited.relative.get(&param).unwrap();
        assert_eq!(owner, &object2);
        if let ParameterValue::RelativePercent { offset } = value {
            // Values accumulated (25 + 15 = 40)
            assert_eq!(*offset, Percentage::from(40.0));
        } else {
            panic!("Expected RelativePercent value");
        }
    }

    #[test]
    fn test_merge_layer_tracks_transitions() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world);

        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);

        let transition = MaterializedTransition {
            delay_in: std::time::Duration::from_secs(1),
            fade_in: std::time::Duration::from_secs(2),
            curve_in: FadeCurve::Linear,
            delay_out: std::time::Duration::from_secs(1),
            fade_out: std::time::Duration::from_secs(2),
            curve_out: FadeCurve::Linear,
            start_position: std::time::Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (
                ParameterValue::Absolute { value: 100.0 },
                Some(transition.clone()),
            ),
        );

        merge_layer_with_attribution(&mut composited, &layer, object1.clone());

        // Verify transition is tracked
        let (_, (_, stored_transition)) = composited.absolute.get(&param).unwrap();
        assert!(stored_transition.is_some());
        assert_eq!(stored_transition.as_ref().unwrap(), &transition);
    }

    #[test]
    fn test_merge_layer_multiple_parameters() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world);
        let param2 = create_test_parameter(&mut world);
        let param3 = create_test_parameter(&mut world);

        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer
            .absolute
            .insert(param1, (ParameterValue::Absolute { value: 100.0 }, None));
        layer
            .absolute
            .insert(param2, (ParameterValue::Absolute { value: 150.0 }, None));
        layer
            .relative
            .insert(param3, (ParameterValue::Relative { offset: 25.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer, object1.clone());

        // Verify all parameters tracked
        assert_eq!(composited.absolute.len(), 2);
        assert_eq!(composited.relative.len(), 1);

        let (owner1, _) = composited.absolute.get(&param1).unwrap();
        let (owner2, _) = composited.absolute.get(&param2).unwrap();
        let (owner3, _) = composited.relative.get(&param3).unwrap();

        assert_eq!(owner1, &object1);
        assert_eq!(owner2, &object1);
        assert_eq!(owner3, &object1);
    }

    #[test]
    fn test_merge_layer_empty_layer() {
        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);

        let layer = Layer::new("cue1".to_string(), Priority(1));

        merge_layer_with_attribution(&mut composited, &layer, object1);

        // Should remain empty
        assert!(composited.absolute.is_empty());
        assert!(composited.relative.is_empty());
    }

    #[test]
    fn test_merge_layer_different_objects_same_parameter() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world);

        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);
        let object2 = create_object_ref(2);
        let object3 = create_object_ref(3);

        // Layer 1
        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 50.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer1, object1.clone());

        // Layer 2
        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer2, object2.clone());

        // Layer 3
        let mut layer3 = Layer::new("cue3".to_string(), Priority(3));
        layer3
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 200.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer3, object3.clone());

        // Verify final owner is object3
        let (owner, (value, _)) = composited.absolute.get(&param).unwrap();
        assert_eq!(owner, &object3);
        if let ParameterValue::Absolute { value: v } = value {
            assert_eq!(*v, 200.0);
        } else {
            panic!("Expected Absolute value");
        }
    }

    #[test]
    fn test_merge_layer_mismatched_relative_types_warning() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world);

        let mut composited = AttributedAssertionsLayer::default();
        let object1 = create_object_ref(1);
        let object2 = create_object_ref(2);

        // First layer with Relative offset
        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .relative
            .insert(param, (ParameterValue::Relative { offset: 30.0 }, None));

        merge_layer_with_attribution(&mut composited, &layer1, object1.clone());

        // Second layer with RelativePercent (mismatched type)
        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2.relative.insert(
            param,
            (
                ParameterValue::RelativePercent {
                    offset: Percentage::from(20.0),
                },
                None,
            ),
        );

        merge_layer_with_attribution(&mut composited, &layer2, object2.clone());

        // Should replace with the new value (and log warning)
        let (owner, (value, _)) = composited.relative.get(&param).unwrap();
        assert_eq!(owner, &object2);
        if let ParameterValue::RelativePercent { offset } = value {
            assert_eq!(*offset, Percentage::from(20.0));
        } else {
            panic!("Expected RelativePercent value after mismatch");
        }
    }
}
