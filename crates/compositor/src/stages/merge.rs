// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor stage for merging computed layers according to merge strategies.
use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;

use crate::types::{CompositorParameter, ComputedLayer};

/// Merges another computed layer onto this one, honoring HTP/LTP merge rules for same-priority layers.
pub fn merge<P: CompositorParameter>(
    base: &mut ComputedLayer,
    other: &ComputedLayer,
    same_priority: bool,
    param_query: &Query<InstanceMut<P>>,
) {
    // Apply absolute values from the upper layer
    for (param, value) in other.absolute.iter() {
        let should_update = if same_priority {
            // For same priority, honor the parameter's merge strategy
            if let Ok(parameter) = param_query.get(param.entity()) {
                if parameter.uses_htp_merge() {
                    base.absolute
                        .get(param)
                        .is_none_or(|existing| *value > *existing)
                } else {
                    true
                }
            } else {
                true
            }
        } else {
            // Different priority: higher priority always wins (processed later in sorted order)
            true
        };

        if should_update {
            base.absolute.insert(param, *value);
        }
    }

    // Accumulate relative values from the upper layer
    for (param, value) in other.relative.iter() {
        let current_relative = base.relative.get(param).unwrap_or(&0.0);
        base.relative.insert(param, *current_relative + *value);
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::world::World;
    use moonshine_kind::Instance;
    use nightfall_dmx::prelude::*;

    use super::*;
    use crate::types::test_support::{TestMergeMode, TestParameter};
    use crate::types::ParameterRef;

    fn create_test_parameter(
        world: &mut World,
        merge_type: TestMergeMode,
        attribute: Attribute,
    ) -> Instance<TestParameter> {
        let entity = world.spawn(TestParameter::new(merge_type, attribute)).id();

        unsafe { Instance::from_entity_unchecked(entity) }
    }

    #[test]
    fn test_merge_absolute_different_priority() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 50.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(param, 100.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, false, &param_query);

        // Different priority: higher priority (other) always wins
        assert_eq!(*base.absolute.get(&param).unwrap(), 100.0);
    }

    #[test]
    fn test_merge_absolute_same_priority_ltp() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 50.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(param, 100.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, true, &param_query);

        // Same priority with LTP: last value wins
        assert_eq!(*base.absolute.get(&param).unwrap(), 100.0);
    }

    #[test]
    fn test_merge_absolute_same_priority_htp_higher_value_wins() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 150.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(param, 100.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, true, &param_query);

        // Same priority with HTP: highest value wins (150 > 100)
        assert_eq!(*base.absolute.get(&param).unwrap(), 150.0);
    }

    #[test]
    fn test_merge_absolute_same_priority_htp_new_value_higher() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 100.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(param, 200.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, true, &param_query);

        // Same priority with HTP: highest value wins (200 > 100)
        assert_eq!(*base.absolute.get(&param).unwrap(), 200.0);
    }

    #[test]
    fn test_merge_absolute_same_priority_htp_equal_values() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 100.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(param, 100.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, true, &param_query);

        // Same priority with HTP and equal values: keeps the value
        assert_eq!(*base.absolute.get(&param).unwrap(), 100.0);
    }

    #[test]
    fn test_merge_absolute_new_parameter() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let param2 = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Green);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param1, 50.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(param2, 100.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, false, &param_query);

        // Should have both parameters
        assert_eq!(*base.absolute.get(&param1).unwrap(), 50.0);
        assert_eq!(*base.absolute.get(&param2).unwrap(), 100.0);
    }

    #[test]
    fn test_merge_relative_values_accumulate() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut base = ComputedLayer::default();
        base.relative.insert(param, 30.0);

        let mut other = ComputedLayer::default();
        other.relative.insert(param, 20.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, false, &param_query);

        // Relative values accumulate
        assert_eq!(*base.relative.get(&param).unwrap(), 50.0);
    }

    #[test]
    fn test_merge_relative_values_accumulate_same_priority() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);

        let mut base = ComputedLayer::default();
        base.relative.insert(param, 15.0);

        let mut other = ComputedLayer::default();
        other.relative.insert(param, 35.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, true, &param_query);

        // Relative values accumulate regardless of priority or merge strategy
        assert_eq!(*base.relative.get(&param).unwrap(), 50.0);
    }

    #[test]
    fn test_merge_relative_new_parameter() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let param2 = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Green);

        let mut base = ComputedLayer::default();
        base.relative.insert(param1, 25.0);

        let mut other = ComputedLayer::default();
        other.relative.insert(param2, 75.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, false, &param_query);

        // Should have both parameters
        assert_eq!(*base.relative.get(&param1).unwrap(), 25.0);
        assert_eq!(*base.relative.get(&param2).unwrap(), 75.0);
    }

    #[test]
    fn test_merge_empty_base() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut base = ComputedLayer::default();

        let mut other = ComputedLayer::default();
        other.absolute.insert(param, 100.0);
        other.relative.insert(param, 25.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, false, &param_query);

        // Should add all values from other
        assert_eq!(*base.absolute.get(&param).unwrap(), 100.0);
        assert_eq!(*base.relative.get(&param).unwrap(), 25.0);
    }

    #[test]
    fn test_merge_empty_other() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 50.0);
        base.relative.insert(param, 10.0);

        let other = ComputedLayer::default();

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, false, &param_query);

        // Base should remain unchanged
        assert_eq!(*base.absolute.get(&param).unwrap(), 50.0);
        assert_eq!(*base.relative.get(&param).unwrap(), 10.0);
    }

    #[test]
    fn test_merge_mixed_absolute_and_relative() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let param2 = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);

        let mut base = ComputedLayer::default();
        base.absolute.insert(param1, 50.0);
        base.relative.insert(param2, 10.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(param1, 100.0);
        other.relative.insert(param2, 20.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, false, &param_query);

        // Absolute should be replaced, relative should accumulate
        assert_eq!(*base.absolute.get(&param1).unwrap(), 100.0);
        assert_eq!(*base.relative.get(&param2).unwrap(), 30.0);
    }

    #[test]
    fn test_merge_missing_parameter_in_query() {
        let mut world = World::new();

        let mut base = ComputedLayer::default();

        // Create a fake parameter reference that doesn't exist in the world
        let fake_param = ParameterRef::from_entity(Entity::from_bits(9999));

        let mut other = ComputedLayer::default();
        other.absolute.insert(fake_param, 100.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, true, &param_query);

        // Should still merge (defaults to accepting the value when parameter not found)
        assert_eq!(*base.absolute.get(&fake_param).unwrap(), 100.0);
    }

    #[test]
    fn test_merge_multiple_parameters_mixed_strategies() {
        let mut world = World::new();
        let htp_param1 =
            create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);
        let htp_param2 =
            create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);
        let ltp_param1 = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let ltp_param2 = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Green);

        let mut base = ComputedLayer::default();
        base.absolute.insert(htp_param1, 150.0);
        base.absolute.insert(htp_param2, 50.0);
        base.absolute.insert(ltp_param1, 100.0);
        base.absolute.insert(ltp_param2, 200.0);

        let mut other = ComputedLayer::default();
        other.absolute.insert(htp_param1, 100.0); // Lower than base
        other.absolute.insert(htp_param2, 200.0); // Higher than base
        other.absolute.insert(ltp_param1, 75.0); // LTP always takes
        other.absolute.insert(ltp_param2, 150.0); // LTP always takes

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        merge(&mut base, &other, true, &param_query);

        // HTP: highest wins
        assert_eq!(*base.absolute.get(&htp_param1).unwrap(), 150.0);
        assert_eq!(*base.absolute.get(&htp_param2).unwrap(), 200.0);
        // LTP: latest wins
        assert_eq!(*base.absolute.get(&ltp_param1).unwrap(), 75.0);
        assert_eq!(*base.absolute.get(&ltp_param2).unwrap(), 150.0);
    }
}
