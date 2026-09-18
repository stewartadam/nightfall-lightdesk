// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Integration tests for the full compositor pipeline
use std::time::Duration;

use bevy_ecs::prelude::{Entity, Query};
use bevy_ecs::world::World;
use moonshine_kind::{Instance, InstanceMut};
use nightfall::prelude::*;
use nightfall_compositor::pipeline::CompositorPipeline;
use nightfall_compositor::types::{ComputedLayer, Layer, LayerCompositingContext};
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;

fn create_test_parameter(
    world: &mut World,
    merge_type: MergeStrategy,
    attribute: Attribute,
) -> Instance<Parameter> {
    let entity = world
        .spawn(Parameter {
            metadata: ParameterMetadata {
                resolution: DmxValueResolution::Coarse,
                native_unit: attribute.native_unit(),
                value_polarity: attribute.value_polarity(),
                attribute,
                min: 0.0,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                is_inverted: false,
                is_snap: false,
                merge_type,
                use_grandmaster: false,
            },
            values: Default::default(),
        })
        .id();

    unsafe { Instance::from_entity_unchecked(entity) }
}

fn create_object_ref(id: u32) -> ObjectRef {
    ObjectRef::ById {
        object_type: ObjectType::Cue,
        id,
    }
}

/// Composes layers with the production context-aware API using absent layer contexts.
fn compose_without_layer_contexts(
    layers: Vec<(Entity, ObjectRef, Layer, bool)>,
    param_query: &Query<InstanceMut<Parameter>>,
) -> (
    ComputedLayer,
    nightfall_compositor::types::AttributedAssertionsLayer,
    Vec<(Entity, ComputedLayer)>,
) {
    let layers = layers
        .into_iter()
        .map(|(entity, object_ref, layer, is_releasing)| {
            (entity, object_ref, layer, is_releasing, None)
        })
        .collect();
    CompositorPipeline::compose_with_layer_compositing_contexts(layers, param_query)
}

#[cfg(test)]
mod pipeline_tests {
    use super::*;

    #[test]
    fn test_pipeline_single_layer_no_transition() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let layers = vec![(entity, create_object_ref(1), layer, false)];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, attributed_assertions_layer, output_layers) =
            compose_without_layer_contexts(layers, &param_query);

        // Verify base layer
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 100.0);
        assert!(base_layer.relative.is_empty());

        // Verify attributed assertions layer.
        assert!(attributed_assertions_layer.absolute.contains_key(&param));

        // Verify output layers
        assert_eq!(output_layers.len(), 1);
        assert_eq!(output_layers[0].0, entity);
        assert_eq!(*output_layers[0].1.absolute.get(&param).unwrap(), 100.0);
    }

    #[test]
    fn test_pipeline_multiple_layers_different_priorities() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();
        let entity3 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 50.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let mut layer3 = Layer::new("cue3".to_string(), Priority(3));
        layer3
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 150.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
            (entity3, create_object_ref(3), layer3, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _attributed_assertions_layer, output_layers) =
            compose_without_layer_contexts(layers, &param_query);

        // Highest priority wins (layer3 with value 150)
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 150.0);
        assert_eq!(output_layers.len(), 3);

        // First layer sees base of 0 (default) + its value
        assert_eq!(*output_layers[0].1.absolute.get(&param).unwrap(), 50.0);
        // Second layer sees base of 50 (from layer1) + its value
        assert_eq!(*output_layers[1].1.absolute.get(&param).unwrap(), 100.0);
        // Third layer sees base of 100 (from layer1+2) + its value
        assert_eq!(*output_layers[2].1.absolute.get(&param).unwrap(), 150.0);
    }

    #[test]
    fn test_pipeline_same_priority_htp() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::HTP, Attribute::Intensity);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();
        let entity3 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 150.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(1));
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 200.0 }, None));

        let mut layer3 = Layer::new("cue3".to_string(), Priority(1));
        layer3
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
            (entity3, create_object_ref(3), layer3, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // With HTP, highest value wins (200)
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 200.0);
    }

    #[test]
    fn test_pipeline_same_priority_ltp() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();
        let entity3 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 150.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(1));
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 200.0 }, None));

        let mut layer3 = Layer::new("cue3".to_string(), Priority(1));
        layer3
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
            (entity3, create_object_ref(3), layer3, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // With LTP, last value wins (100)
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 100.0);
    }

    #[test]
    fn test_pipeline_relative_values_accumulate() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();
        let entity3 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .relative
            .insert(param, (ParameterValue::Relative { offset: 10.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .relative
            .insert(param, (ParameterValue::Relative { offset: 20.0 }, None));

        let mut layer3 = Layer::new("cue3".to_string(), Priority(3));
        layer3
            .relative
            .insert(param, (ParameterValue::Relative { offset: 30.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
            (entity3, create_object_ref(3), layer3, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // Relative values accumulate in transition processing (sees increasing base each time)
        // Layer 1: 10 offset + 0 base = 10
        // Layer 2: 20 offset + 10 base = 30
        // Layer 3: 30 offset + 40 base = 70
        // Total = 10 + 30 + 70 = 110
        assert_eq!(*base_layer.relative.get(&param).unwrap(), 110.0);
    }

    #[test]
    fn test_pipeline_mixed_absolute_and_relative() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .relative
            .insert(param, (ParameterValue::Relative { offset: 25.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _output_layers) = compose_without_layer_contexts(layers, &param_query);

        // Base should have both absolute and relative
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 100.0);
        assert_eq!(*base_layer.relative.get(&param).unwrap(), 25.0);

        // Effective value should combine them
        assert_eq!(base_layer.get_effective_value(&param), 125.0);
    }

    #[test]
    fn test_pipeline_with_transitions() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![(
            entity,
            create_object_ref(1),
            layer,
            false,
            Some(nightfall_compositor::types::LayerCompositingContext {
                position: Duration::from_secs(10),
                released_at: None,
            }),
        )];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) =
            CompositorPipeline::compose_with_layer_compositing_contexts(layers, &param_query);

        // Transition is complete, should reach target
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 200.0);
    }

    /// Verifies explicit source-local clocks override host-time transition anchors.
    #[test]
    fn pipeline_uses_explicit_compositing_context_when_provided() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![(
            entity,
            create_object_ref(1),
            layer,
            false,
            Some(nightfall_compositor::types::LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            }),
        )];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) =
            CompositorPipeline::compose_with_layer_compositing_contexts(layers, &param_query);

        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 100.0);
    }

    /// Verifies source-local composition does not fall back to legacy host-time transition anchors.
    #[test]
    fn source_local_pipeline_missing_compositing_context_uses_zero_elapsed() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![(entity, create_object_ref(1), layer, false, None)];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) =
            CompositorPipeline::compose_with_layer_compositing_contexts(layers, &param_query);

        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 0.0);
    }

    /// Verifies the default pipeline entry point does not evaluate legacy host-time anchors.
    #[test]
    fn default_pipeline_compose_uses_zero_elapsed_for_missing_context() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![(entity, create_object_ref(1), layer, false)];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 0.0);
    }

    /// Verifies layer compositing contexts drive transition progress from playback position.
    #[test]
    fn source_local_pipeline_compositing_context_drives_transition_elapsed() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![(
            entity,
            create_object_ref(1),
            layer,
            false,
            Some(LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            }),
        )];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) =
            CompositorPipeline::compose_with_layer_compositing_contexts(layers, &param_query);

        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 100.0);
    }

    #[test]
    fn test_pipeline_releasing_layer() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();

        // Base layer
        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 50.0 }, None));

        // Releasing layer (should revert to base)
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false, None),
            (
                entity2,
                create_object_ref(2),
                layer2,
                true,
                Some(LayerCompositingContext {
                    position: Duration::from_secs(10),
                    released_at: Some(Duration::ZERO),
                }),
            ), // is_releasing = true
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) =
            CompositorPipeline::compose_with_layer_compositing_contexts(layers, &param_query);

        // Should revert to base layer value (50)
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 50.0);
    }

    #[test]
    fn test_pipeline_multiple_parameters() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, MergeStrategy::HTP, Attribute::Intensity);
        let param2 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let param3 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Green);
        let entity = world.spawn_empty().id();

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer
            .absolute
            .insert(param1, (ParameterValue::Absolute { value: 255.0 }, None));
        layer
            .absolute
            .insert(param2, (ParameterValue::Absolute { value: 128.0 }, None));
        layer
            .relative
            .insert(param3, (ParameterValue::Relative { offset: 50.0 }, None));

        let layers = vec![(entity, create_object_ref(1), layer, false)];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // Verify all parameters composited
        assert_eq!(*base_layer.absolute.get(&param1).unwrap(), 255.0);
        assert_eq!(*base_layer.absolute.get(&param2).unwrap(), 128.0);
        assert_eq!(*base_layer.relative.get(&param3).unwrap(), 50.0);
    }

    #[test]
    fn test_pipeline_empty_layers() {
        let mut world = World::new();
        let layers = vec![];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, attributed_assertions_layer, output_layers) =
            compose_without_layer_contexts(layers, &param_query);

        // Should return empty results
        assert!(base_layer.absolute.is_empty());
        assert!(base_layer.relative.is_empty());
        assert!(attributed_assertions_layer.absolute.is_empty());
        assert!(attributed_assertions_layer.relative.is_empty());
        assert!(output_layers.is_empty());
    }

    #[test]
    fn test_pipeline_attribution_tracking() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 200.0 }, None));

        let object1 = create_object_ref(1);
        let object2 = create_object_ref(2);

        let layers = vec![
            (entity1, object1.clone(), layer1, false),
            (entity2, object2.clone(), layer2, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (_, attributed_assertions_layer, _) =
            compose_without_layer_contexts(layers, &param_query);

        // Verify attribution tracked (object2 should be the final owner)
        assert!(attributed_assertions_layer.absolute.contains_key(&param));
        let (owner, (value, _)) = attributed_assertions_layer.absolute.get(&param).unwrap();
        assert_eq!(owner, &object2);
        if let ParameterValue::Absolute { value: v } = value {
            assert_eq!(*v, 200.0);
        }
    }

    #[test]
    fn test_pipeline_complex_scenario() {
        let mut world = World::new();
        let htp_param = create_test_parameter(&mut world, MergeStrategy::HTP, Attribute::Intensity);
        let ltp_param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();
        let entity3 = world.spawn_empty().id();

        // Layer 1: Priority 1, HTP=100, LTP=50
        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(htp_param, (ParameterValue::Absolute { value: 100.0 }, None));
        layer1
            .absolute
            .insert(ltp_param, (ParameterValue::Absolute { value: 50.0 }, None));

        // Layer 2: Priority 1 (same), HTP=200, LTP=75, +Relative on LTP
        let mut layer2 = Layer::new("cue2".to_string(), Priority(1));
        layer2
            .absolute
            .insert(htp_param, (ParameterValue::Absolute { value: 200.0 }, None));
        layer2
            .absolute
            .insert(ltp_param, (ParameterValue::Absolute { value: 75.0 }, None));
        layer2
            .relative
            .insert(ltp_param, (ParameterValue::Relative { offset: 25.0 }, None));

        // Layer 3: Priority 2 (higher), HTP=150, +Relative on LTP
        let mut layer3 = Layer::new("cue3".to_string(), Priority(2));
        layer3
            .absolute
            .insert(htp_param, (ParameterValue::Absolute { value: 150.0 }, None));
        layer3
            .relative
            .insert(ltp_param, (ParameterValue::Relative { offset: 10.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
            (entity3, create_object_ref(3), layer3, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // HTP: Priority 2 wins (150), but same priority layers 1&2 merge with HTP (200 > 100)
        // Final: layer3's 150 wins due to priority
        assert_eq!(*base_layer.absolute.get(&htp_param).unwrap(), 150.0);

        // LTP: Same priority layers, last wins (75), then layer3 doesn't have absolute so keeps 75
        assert_eq!(*base_layer.absolute.get(&ltp_param).unwrap(), 75.0);

        // Relative: layer2 adds 25 on base 75, layer3 adds 10 on base (75+25)=100
        // Total relative = 25 + (75) + 10 + (100) but that's not right...
        // Actually: layer2 relative resolves to 25, layer3 relative resolves to 10
        // But during transition they see base, so: 25+75 from layer2, 10+100 from layer3
        // Hmm, let's check actual: relative should just be offsets: 25 + 10 + bases = 60
        assert_eq!(*base_layer.relative.get(&ltp_param).unwrap(), 60.0);

        // Effective LTP value: 75 + 60 = 135
        assert_eq!(base_layer.get_effective_value(&ltp_param), 135.0);
    }
}

#[cfg(test)]
mod edge_case_tests {
    use super::*;

    #[test]
    fn test_computed_layer_to_effective_combines_values() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let param2 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Green);

        let mut layer = ComputedLayer::default();
        layer.absolute.insert(param1, 100.0);
        layer.relative.insert(param1, 25.0);
        layer.absolute.insert(param2, 50.0);

        let effective = layer.to_effective();

        // param1 should combine absolute + relative
        assert_eq!(*effective.absolute.get(&param1).unwrap(), 125.0);
        // param2 has no relative, should stay the same
        assert_eq!(*effective.absolute.get(&param2).unwrap(), 50.0);
    }

    #[test]
    fn test_computed_layer_all_parameters_no_duplicates() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let param2 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Green);

        let mut layer = ComputedLayer::default();
        layer.absolute.insert(param1, 100.0);
        layer.relative.insert(param1, 25.0);
        layer.absolute.insert(param2, 50.0);

        let all_params: Vec<_> = layer.all_parameters().collect();

        // Should have 2 unique parameters
        assert_eq!(all_params.len(), 2);
    }

    #[test]
    fn test_layer_squash_combines_layers() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let param2 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Green);

        let mut base_layer = Layer::new("base".to_string(), Priority(1));
        base_layer
            .absolute
            .insert(param1, (ParameterValue::Absolute { value: 100.0 }, None));

        let mut upper_layer = Layer::new("upper".to_string(), Priority(1));
        upper_layer
            .absolute
            .insert(param1, (ParameterValue::Absolute { value: 200.0 }, None)); // Override
        upper_layer
            .absolute
            .insert(param2, (ParameterValue::Absolute { value: 50.0 }, None)); // New param

        base_layer.squash(upper_layer);

        // param1 should be overridden
        if let Some((ParameterValue::Absolute { value }, _)) = base_layer.absolute.get(&param1) {
            assert_eq!(*value, 200.0);
        } else {
            panic!("Expected param1 to be present");
        }

        // param2 should be added
        assert!(base_layer.absolute.contains_key(&param2));
    }

    #[test]
    fn test_pipeline_with_zero_delay_zero_fade() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        // Transition with zero delay and zero fade = instant
        let transition = MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![(entity, create_object_ref(1), layer, false)];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // Should instantly reach target
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 200.0);
    }

    /// Verifies delayed assertions do not contribute output before their fade starts.
    #[test]
    fn test_pipeline_with_very_long_delay() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity = world.spawn_empty().id();

        // Transition with very long delay that hasn't elapsed
        let transition = MaterializedTransition {
            delay_in: Duration::from_secs(1000),
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        };

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let layers = vec![(entity, create_object_ref(1), layer, false)];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        assert!(
            !base_layer.absolute.contains_key(&param),
            "delayed assertions should not assert the base/default value"
        );
    }

    #[test]
    fn test_pipeline_negative_relative_values() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .relative
            .insert(param, (ParameterValue::Relative { offset: -30.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // Negative relative should subtract
        assert_eq!(base_layer.get_effective_value(&param), 70.0);
    }

    #[test]
    fn test_pipeline_only_relative_values_no_absolute() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .relative
            .insert(param, (ParameterValue::Relative { offset: 50.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .relative
            .insert(param, (ParameterValue::Relative { offset: 25.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // No absolute, only relative
        // Layer1: 50 offset on base 0 = 50
        // Layer2: 25 offset on base 50 = 75
        // Total = 50 + 75 = 125
        assert!(base_layer.absolute.is_empty());
        assert_eq!(*base_layer.relative.get(&param).unwrap(), 125.0);
        assert_eq!(base_layer.get_effective_value(&param), 125.0);
    }

    #[test]
    fn test_pipeline_many_layers_performance() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::HTP, Attribute::Intensity);

        // Create 100 layers
        let mut layers = Vec::new();
        for i in 0..100 {
            let entity = world.spawn_empty().id();
            let mut layer = Layer::new(format!("cue{}", i), Priority(1));
            layer
                .absolute
                .insert(param, (ParameterValue::Absolute { value: i as f32 }, None));
            layers.push((entity, create_object_ref(i), layer, false));
        }

        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, attributed_assertions_layer, output_layers) =
            compose_without_layer_contexts(layers, &param_query);

        // With HTP and same priority, highest value (99) should win
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 99.0);
        assert_eq!(output_layers.len(), 100);
        assert_eq!(attributed_assertions_layer.absolute.len(), 1);
    }

    #[test]
    fn test_pipeline_alternating_priorities() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();
        let entity3 = world.spawn_empty().id();
        let entity4 = world.spawn_empty().id();

        let mut layer1 = Layer::new("cue1".to_string(), Priority(1));
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 10.0 }, None));

        let mut layer2 = Layer::new("cue2".to_string(), Priority(2));
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 20.0 }, None));

        let mut layer3 = Layer::new("cue3".to_string(), Priority(1)); // Back to priority 1
        layer3
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 30.0 }, None));

        let mut layer4 = Layer::new("cue4".to_string(), Priority(3)); // Highest priority
        layer4
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 40.0 }, None));

        let layers = vec![
            (entity1, create_object_ref(1), layer1, false),
            (entity2, create_object_ref(2), layer2, false),
            (entity3, create_object_ref(3), layer3, false),
            (entity4, create_object_ref(4), layer4, false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // Highest priority (3) should win
        assert_eq!(*base_layer.absolute.get(&param).unwrap(), 40.0);
    }

    #[test]
    fn test_pipeline_all_parameters_types() {
        let mut world = World::new();
        let param1 = create_test_parameter(&mut world, MergeStrategy::HTP, Attribute::Intensity);
        let param2 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Red);
        let param3 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Green);
        let param4 = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Blue);
        let entity = world.spawn_empty().id();

        let mut layer = Layer::new("cue1".to_string(), Priority(1));
        layer
            .absolute
            .insert(param1, (ParameterValue::Absolute { value: 255.0 }, None));
        layer
            .absolute
            .insert(param2, (ParameterValue::Absolute { value: 200.0 }, None));
        layer
            .relative
            .insert(param2, (ParameterValue::Relative { offset: 25.0 }, None));
        layer
            .absolute
            .insert(param3, (ParameterValue::Absolute { value: 100.0 }, None));
        layer
            .relative
            .insert(param4, (ParameterValue::Relative { offset: 50.0 }, None));

        let layers = vec![(entity, create_object_ref(1), layer, false)];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (base_layer, _, _) = compose_without_layer_contexts(layers, &param_query);

        // Verify all parameters
        assert_eq!(*base_layer.absolute.get(&param1).unwrap(), 255.0);
        assert_eq!(*base_layer.absolute.get(&param2).unwrap(), 200.0);
        assert_eq!(*base_layer.relative.get(&param2).unwrap(), 25.0);
        assert_eq!(*base_layer.absolute.get(&param3).unwrap(), 100.0);
        assert_eq!(*base_layer.relative.get(&param4).unwrap(), 50.0);

        // Check effective values
        assert_eq!(base_layer.get_effective_value(&param1), 255.0);
        assert_eq!(base_layer.get_effective_value(&param2), 225.0);
        assert_eq!(base_layer.get_effective_value(&param3), 100.0);
        assert_eq!(base_layer.get_effective_value(&param4), 50.0);
    }

    #[test]
    fn test_pipeline_same_priority_activation_order() {
        use std::thread::sleep;
        use std::time::Duration;

        let mut world = World::new();
        let param = create_test_parameter(&mut world, MergeStrategy::LTP, Attribute::Intensity);
        let entity1 = world.spawn_empty().id();
        let entity2 = world.spawn_empty().id();
        let entity3 = world.spawn_empty().id();

        // Create layers with same priority but different activation times
        let layer1 = Layer::new("cue1".to_string(), Priority(1));
        sleep(Duration::from_millis(2)); // Ensure different activation times
        let layer2 = Layer::new("cue2".to_string(), Priority(1));
        sleep(Duration::from_millis(2));
        let layer3 = Layer::new("cue3".to_string(), Priority(1));

        // Add values to the layers
        let mut layer1 = layer1;
        layer1
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 100.0 }, None));

        let mut layer2 = layer2;
        layer2
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 150.0 }, None));

        let mut layer3 = layer3;
        layer3
            .absolute
            .insert(param, (ParameterValue::Absolute { value: 200.0 }, None));

        // Pass layers in a different order than activation time to verify sorting works
        let layers = vec![
            (entity2, create_object_ref(2), layer2.clone(), false),
            (entity1, create_object_ref(1), layer1.clone(), false),
            (entity3, create_object_ref(3), layer3.clone(), false),
        ];
        let mut param_query_state = world.query::<InstanceMut<Parameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let (_, attributed_assertions_layer, _) =
            compose_without_layer_contexts(layers, &param_query);

        // With LTP and same priority, the latest activated layer should win (layer3 with value 200)
        // The attributed assertions layer should track which object set the final value.
        let (object_ref, (param_value, _)) =
            attributed_assertions_layer.absolute.get(&param).unwrap();

        // Verify that layer3 (object_ref 3) won because it was activated last
        match object_ref {
            ObjectRef::ById { object_type: _, id } => assert_eq!(*id, 3),
            _ => panic!("Expected ObjectRef::ById"),
        }
        match param_value {
            ParameterValue::Absolute { value } => assert_eq!(*value, 200.0),
            _ => panic!("Expected absolute value"),
        }
    }
}
