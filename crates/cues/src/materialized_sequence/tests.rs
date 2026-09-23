// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use bevy_app::{App, Update};
use bevy_ecs::schedule::{ApplyDeferred, IntoScheduleConfigs};
use bevy_ecs::system::SystemState;
use nightfall_clips::ClipOptions;
use nightfall_dmx::prelude::{Attribute, DmxValueResolution};
use nightfall_instances::InstanceClockSource;

use super::tracking::mark_transition_input_complete;
use super::*;
use crate::cue::{BoundCueInstruction, CueInstruction};
use crate::materialized_cue::{MaterializedColorPathGroup, MaterializedColorPathModel};

fn test_cue(id: u32, label: &str) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid: uuid::Uuid::new_v4(),
            label: label.to_string(),
        },
        ..Default::default()
    }
}

fn test_part(id: u32, label: &str) -> crate::cue::CuePart {
    crate::cue::CuePart {
        identifiers: Identifiers {
            id,
            uid: uuid::Uuid::new_v4(),
            label: label.to_string(),
        },
        ..Default::default()
    }
}

/// Verifies Back at cue one does not demand the unvisited suffix without wrapping.
#[test]
fn non_wrapping_back_at_first_cue_keeps_lazy_prefix() {
    let mut materialized = MaterializedSequence {
        wrap: false,
        steps: vec![
            test_cue(1, "First"),
            test_cue(2, "Second"),
            test_cue(3, "Third"),
        ],
        mcues: vec![MaterializedCue::default()],
        ..Default::default()
    };

    assert!(materialized.previous_step_is_materialized());
    materialized.wrap = true;
    assert!(!materialized.previous_step_is_materialized());
}

/// Verifies cue-level lookahead does not opt unflagged cue parts into materialization.
#[test]
fn cue_lookahead_does_not_enable_unflagged_part_position_values() {
    let mut position_part = test_part(1, "Position part");
    position_part.instructions.push(BoundCueInstruction {
        selection: SelectionExpr::Resolved(Vec::new()).into(),
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::Pan,
                ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
            )]),
            ..Default::default()
        },
    });
    let mut source = test_cue(2, "Source");
    source.lookahead = Some(true);
    source.parts.push(position_part);
    let mut materialized = MaterializedSequence {
        steps: vec![test_cue(1, "First"), source],
        mcues: vec![MaterializedCue::default()],
        ..Default::default()
    };

    assert!(
        !materialized.requires_full_materialization_for_lookahead(InstanceOptions::default(), None)
    );
    materialized.steps[1].parts[0].lookahead = Some(true);
    assert!(
        materialized.requires_full_materialization_for_lookahead(InstanceOptions::default(), None)
    );
}

/// Spawns a test fixture parameter and returns its typed instance handle.
fn test_parameter(world: &mut World) -> Instance<Parameter> {
    test_parameter_for_attribute(world, Attribute::Intensity)
}

/// Spawns a test fixture parameter for the requested logical attribute.
fn test_parameter_for_attribute(world: &mut World, attribute: Attribute) -> Instance<Parameter> {
    let entity = world
        .spawn(Parameter {
            metadata: ParameterMetadata {
                resolution: DmxValueResolution::Coarse,
                native_unit: attribute.native_unit(),
                value_polarity: attribute.value_polarity(),
                attribute,
                ..Default::default()
            },
            values: Default::default(),
        })
        .id();

    // SAFETY: the entity was spawned in this world with a Parameter component.
    unsafe { Instance::from_entity_unchecked(entity) }
}

/// Verifies advancing a sequence stamps the newly active cue in source-local time.
#[test]
fn sequence_step_activation_updates_cue_start_position() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let first_cue = test_cue(1, "First");
    let second_cue = test_cue(2, "Second");
    let original_activation = Instant::now() - Duration::from_millis(250);
    let original_second_start_time = Instant::now() - Duration::from_millis(200);
    let mut second_values = Layer::new("second".to_owned(), Priority::default());
    second_values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first_cue.identifiers.uid.into(),
                second_cue.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first_cue, second_cue],
        mcues: vec![
            MaterializedCue::default(),
            MaterializedCue {
                values: second_values,
                activation_time: original_second_start_time,
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), None],
        activation_time: original_activation,
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    materialized.next_at_playback_position(Some(Duration::from_millis(900)));

    assert_eq!(materialized.position_index, 1);
    assert_eq!(
        materialized.activation_time, original_activation,
        "clocked advancement should not rewrite legacy wall-clock activation anchors"
    );
    assert_eq!(
        materialized.mcues[0].release_position,
        Some(Duration::from_millis(900))
    );
    assert_eq!(
        materialized.mcues[1].activation_time, original_second_start_time,
        "clocked advancement should not rewrite incoming cue wall-clock anchors"
    );
    assert_eq!(
        materialized.cue_activation_positions[1],
        Some(Duration::from_millis(900))
    );
    assert_eq!(
        materialized.mcues[1].start_position,
        Duration::from_millis(900)
    );
    assert_eq!(
        materialized.mcues[1]
            .values
            .absolute
            .get(&parameter)
            .and_then(|(_, transition)| transition.as_ref())
            .map(|transition| transition.start_position),
        Some(Duration::from_millis(900))
    );
}

/// Verifies unclocked sequence advancement records deterministic source-local anchors.
#[test]
fn sequence_step_activation_without_clock_uses_position_anchors() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let first_cue = test_cue(1, "First");
    let second_cue = test_cue(2, "Second");
    let original_activation = Instant::now() - Duration::from_millis(250);
    let original_second_start_time = Instant::now() - Duration::from_millis(200);
    let mut second_values = Layer::new("second".to_owned(), Priority::default());
    second_values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first_cue.identifiers.uid.into(),
                second_cue.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first_cue, second_cue],
        mcues: vec![
            MaterializedCue::default(),
            MaterializedCue {
                values: second_values,
                activation_time: original_second_start_time,
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), None],
        activation_time: original_activation,
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    materialized.next();

    assert_eq!(materialized.position_index, 1);
    assert!(
        materialized.activation_time > original_activation,
        "unclocked advancement may still refresh the UI wall-clock activation timestamp"
    );
    assert_eq!(materialized.mcues[0].release_position, Some(Duration::ZERO));
    assert_eq!(
        materialized.mcues[1].activation_time, original_second_start_time,
        "unclocked advancement should not rewrite incoming cue wall-clock anchors"
    );
    assert_eq!(
        materialized.cue_activation_positions[1],
        Some(Duration::ZERO)
    );
    assert_eq!(materialized.mcues[1].start_position, Duration::ZERO);
    assert_eq!(
        materialized.mcues[1]
            .values
            .absolute
            .get(&parameter)
            .and_then(|(_, transition)| transition.as_ref())
            .map(|transition| transition.start_position),
        Some(Duration::ZERO)
    );
}

/// Verifies pre-applied sequence transitions are not applied again by the global compositor.
#[test]
fn completed_sequence_transition_does_not_refade_with_compositing_context() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let mut transition = Some(MaterializedTransition {
        delay_in: Duration::ZERO,
        fade_in: Duration::from_secs(1),
        curve_in: FadeCurve::Linear,
        delay_out: Duration::ZERO,
        fade_out: Duration::ZERO,
        curve_out: FadeCurve::Linear,
        start_position: Duration::from_millis(250),
        release_position: None,
    });
    mark_transition_input_complete(&mut transition);
    let completed_transition = transition
        .as_ref()
        .expect("transition should remain attached after completion marking");
    assert_eq!(
        completed_transition.start_position,
        Duration::ZERO,
        "pre-applied sequence transitions should be marked complete before global composition"
    );
    assert_eq!(completed_transition.delay_in, Duration::ZERO);
    assert_eq!(completed_transition.fade_in, Duration::ZERO);
    let mut layer = Layer::new("precomputed".to_owned(), Priority::default());
    layer.absolute.insert(
        parameter,
        (ParameterValue::Absolute { value: 50.0 }, transition),
    );

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let param_query = param_query_state.query_mut(&mut world);
    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut layer,
        &ComputedLayer::default(),
        &param_query,
        false,
        LayerCompositingContext {
            position: Duration::from_millis(500),
            released_at: None,
        },
    );

    assert_eq!(computed.absolute.get(&parameter).copied(), Some(50.0));
}

/// Verifies active cue transitions render from InstanceClock position when available.
#[test]
fn sequence_render_uses_instance_clock_for_active_cue_transition() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let cue = test_cue(10, "Open");
    let mut values = Layer::new("cue".to_owned(), Priority::default());
    values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![cue.identifiers.uid.into()],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![cue.clone()],
        mcues: vec![MaterializedCue {
            cue,
            values,
            activation_time: Instant::now() - Duration::from_secs(10),
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };
    let clock = InstanceClock {
        position: Duration::from_millis(500),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));
    let rendered = layer
        .absolute
        .get(&parameter)
        .map(|(value, _)| *value)
        .expect("sequence should render the cue value");

    assert_eq!(rendered, ParameterValue::Absolute { value: 50.0 });
    assert_eq!(
        layer.transitioning.get(&parameter),
        Some(&true),
        "transition activity should follow playback-clock elapsed time"
    );
}

/// Verifies unclocked sequence rendering does not fall back to wall-clock transition anchors.
#[test]
fn sequence_render_without_instance_clock_uses_zero_elapsed() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let cue = test_cue(10, "Open");
    let mut values = Layer::new("cue".to_owned(), Priority::default());
    values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![cue.identifiers.uid.into()],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![cue.clone()],
        mcues: vec![MaterializedCue {
            cue,
            values,
            activation_time: Instant::now() - Duration::from_secs(10),
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let layer = materialized.to_layer_at_clock(&mut param_query, None);
    let rendered = layer
        .absolute
        .get(&parameter)
        .map(|(value, _)| *value)
        .expect("sequence should render the cue value");

    assert_eq!(rendered, ParameterValue::Absolute { value: 0.0 });
    assert_eq!(
        layer.transitioning.get(&parameter),
        Some(&true),
        "unclocked rendering should use deterministic zero elapsed, not stale wall-clock anchors"
    );
}

/// Verifies derived color-mix emitters remain active while any RGB parent is fading.
#[test]
fn derived_color_path_emitters_track_any_active_rgb_parent() {
    let mut world = World::new();
    let red = test_parameter_for_attribute(&mut world, Attribute::Red);
    let green = test_parameter_for_attribute(&mut world, Attribute::Green);
    let blue = test_parameter_for_attribute(&mut world, Attribute::Blue);
    let white = test_parameter_for_attribute(&mut world, Attribute::White);
    let cue = test_cue(10, "Color");
    let mut values = Layer::new("cue".to_owned(), Priority::default());

    values
        .absolute
        .insert(red, (ParameterValue::Absolute { value: 255.0 }, None));
    values.absolute.insert(
        green,
        (
            ParameterValue::Absolute { value: 255.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    values
        .absolute
        .insert(blue, (ParameterValue::Absolute { value: 255.0 }, None));

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![cue.identifiers.uid.into()],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![cue.clone()],
        mcues: vec![MaterializedCue {
            cue,
            values,
            color_path_groups: vec![MaterializedColorPathGroup {
                path: ColorPath::new(1, "RGB", ColorInterpolationSpace::Rgb),
                model: MaterializedColorPathModel::Rgb,
                red,
                green,
                blue,
                auxiliary_emitters: Vec::new(),
                decomposed_emitters: vec![(Attribute::White, white)],
            }],
            activation_time: Instant::now() - Duration::from_secs(10),
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };
    let clock = InstanceClock {
        position: Duration::from_millis(500),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));

    assert!(
        layer.absolute.contains_key(&white),
        "color path sampling should insert the derived white emitter"
    );
    assert_eq!(
        layer.transitioning.get(&white),
        Some(&true),
        "derived emitters should remain active when any RGB parent is still transitioning"
    );
}

/// Verifies retained cues continue transitions from their own playback-clock anchors.
#[test]
fn sequence_render_uses_instance_clock_for_retained_cue_transition() {
    let mut world = World::new();
    let first_parameter = test_parameter(&mut world);
    let second_parameter = test_parameter(&mut world);
    let first_cue = test_cue(10, "Open");
    let second_cue = test_cue(20, "Build");

    let mut first_values = Layer::new("first".to_owned(), Priority::default());
    first_values.absolute.insert(
        first_parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut second_values = Layer::new("second".to_owned(), Priority::default());
    second_values.absolute.insert(
        second_parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first_cue.identifiers.uid.into(),
                second_cue.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first_cue.clone(), second_cue.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first_cue,
                values: first_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                ..Default::default()
            },
            MaterializedCue {
                cue: second_cue,
                values: second_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 1,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0, 1],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), Some(Duration::from_millis(500))],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::from_millis(500),
    };
    let clock = InstanceClock {
        position: Duration::from_millis(750),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));

    assert_eq!(
        layer
            .absolute
            .get(&first_parameter)
            .map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 75.0 }),
        "retained first cue should continue from its original activation position"
    );
    assert_eq!(
        layer
            .absolute
            .get(&second_parameter)
            .map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 25.0 }),
        "active second cue should render from its later activation position"
    );
}

/// Verifies retained replacement source layers render from the sequence playback clock.
#[test]
fn sequence_render_uses_instance_clock_for_transition_source_layer() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let active_cue = test_cue(10, "Open");

    let mut source_layer = Layer::new("source".to_owned(), Priority::default());
    source_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let mut active_values = Layer::new("active".to_owned(), Priority::default());
    active_values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 200.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![active_cue.identifiers.uid.into()],
            wrap: true,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: true,
        steps: vec![active_cue.clone()],
        mcues: vec![MaterializedCue {
            cue: active_cue,
            values: active_values,
            activation_time: Instant::now() - Duration::from_secs(10),
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![Some(source_layer)],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };
    let clock = InstanceClock {
        position: Duration::from_millis(500),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));

    assert_eq!(
        layer.absolute.get(&parameter).map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 125.0 }),
        "replacement cue should fade from the playback-clocked retained source value"
    );
}

/// Verifies stable retained cue prefixes are cached ahead of dynamic current cue rendering.
#[test]
fn sequence_render_caches_stable_prefix_before_active_current_cue() {
    let mut world = World::new();
    let first_parameter = test_parameter(&mut world);
    let second_parameter = test_parameter(&mut world);
    let first_cue = test_cue(10, "First");
    let second_cue = test_cue(11, "Second");

    let mut first_values = Layer::new("first".to_owned(), Priority::default());
    first_values.absolute.insert(
        first_parameter,
        (ParameterValue::Absolute { value: 80.0 }, None),
    );

    let mut second_values = Layer::new("second".to_owned(), Priority::default());
    second_values.absolute.insert(
        second_parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(10),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::from_millis(500),
                release_position: None,
            }),
        ),
    );

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first_cue.identifiers.uid.into(),
                second_cue.identifiers.uid.into(),
            ],
            wrap: true,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: true,
        steps: vec![first_cue.clone(), second_cue.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first_cue,
                values: first_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                ..Default::default()
            },
            MaterializedCue {
                cue: second_cue,
                values: second_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                start_position: Duration::from_millis(500),
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 1,
        last_rendered_layer: None,
        render_prefix_cache: None,
        composition_order: vec![0, 1],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), Some(Duration::from_millis(500))],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::from_millis(500),
    };
    let clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let _ = materialized.to_layer_at_clock(&mut param_query, Some(&clock));
    assert_eq!(
        materialized
            .render_prefix_cache
            .as_ref()
            .map(|cache| cache.order.as_slice()),
        Some([0].as_slice()),
        "stable retained cue should be cached before the active current cue"
    );

    let cached_layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));
    materialized.render_prefix_cache = None;
    let uncached_layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));

    assert_eq!(cached_layer.absolute, uncached_layer.absolute);
    assert_eq!(cached_layer.relative, uncached_layer.relative);
    assert_eq!(cached_layer.transitioning, uncached_layer.transitioning);
}

/// Verifies cached prefixes are not reused before their stable playback position.
#[test]
fn sequence_render_prefix_cache_is_not_reused_before_valid_position() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let first_cue = test_cue(10, "Fade in");
    let second_cue = test_cue(20, "Next");
    let mut first_values = Layer::new("first".to_owned(), Priority::default());
    first_values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let second_values = Layer::new("second".to_owned(), Priority::default());
    let build_materialized = || MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first_cue.identifiers.uid.into(),
                second_cue.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first_cue.clone(), second_cue.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first_cue.clone(),
                values: first_values.clone(),
                activation_time: Instant::now() - Duration::from_secs(10),
                ..Default::default()
            },
            MaterializedCue {
                cue: second_cue.clone(),
                values: second_values.clone(),
                activation_time: Instant::now() - Duration::from_secs(10),
                start_position: Duration::from_millis(500),
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 1,
        last_rendered_layer: None,
        render_prefix_cache: None,
        composition_order: vec![0, 1],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), Some(Duration::from_millis(500))],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::from_millis(500),
    };
    let complete_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let early_clock = InstanceClock {
        position: Duration::from_millis(250),
        ..Default::default()
    };

    let mut cached_materialized = build_materialized();
    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let _ = cached_materialized.to_layer_at_clock(&mut param_query, Some(&complete_clock));
    assert_eq!(
        cached_materialized
            .render_prefix_cache
            .as_ref()
            .map(|cache| cache.valid_from_position),
        Some(Some(Duration::from_secs(1))),
        "completed render should cache the stable prefix at its source position"
    );

    let cached_layer = cached_materialized.to_layer_at_clock(&mut param_query, Some(&early_clock));
    let mut cold_materialized = build_materialized();
    let cold_layer = cold_materialized.to_layer_at_clock(&mut param_query, Some(&early_clock));

    assert_eq!(cached_layer.absolute, cold_layer.absolute);
    assert_eq!(cached_layer.relative, cold_layer.relative);
    assert_eq!(cached_layer.transitioning, cold_layer.transitioning);
    assert_eq!(
        cached_layer
            .absolute
            .get(&parameter)
            .map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 25.0 }),
        "early render should sample the transition instead of reusing the completed prefix"
    );
}

/// Verifies cached stable prefixes are reused as source-local playback moves forward.
#[test]
fn sequence_render_prefix_cache_reuses_stable_prefix_for_later_playback_position() {
    let mut world = World::new();
    let first_parameter = test_parameter(&mut world);
    let second_parameter = test_parameter(&mut world);
    let first_cue = test_cue(10, "Stable");
    let second_cue = test_cue(20, "Active");
    let mut first_values = Layer::new("first".to_owned(), Priority::default());
    first_values.absolute.insert(
        first_parameter,
        (ParameterValue::Absolute { value: 80.0 }, None),
    );
    let mut second_values = Layer::new("second".to_owned(), Priority::default());
    second_values.absolute.insert(
        second_parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(10),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::from_millis(500),
                release_position: None,
            }),
        ),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first_cue.identifiers.uid.into(),
                second_cue.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first_cue.clone(), second_cue.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first_cue,
                values: first_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                ..Default::default()
            },
            MaterializedCue {
                cue: second_cue,
                values: second_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                start_position: Duration::from_millis(500),
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 1,
        last_rendered_layer: None,
        render_prefix_cache: None,
        composition_order: vec![0, 1],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), Some(Duration::from_millis(500))],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::from_millis(500),
    };
    let first_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let later_clock = InstanceClock {
        position: Duration::from_secs(2),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let _ = materialized.to_layer_at_clock(&mut param_query, Some(&first_clock));
    materialized
        .render_prefix_cache
        .as_mut()
        .expect("stable prefix should be cached")
        .visible_seq_layer
        .absolute
        .insert(
            first_parameter,
            (ParameterValue::Absolute { value: 70.0 }, None),
        );

    let later_layer = materialized.to_layer_at_clock(&mut param_query, Some(&later_clock));

    assert_eq!(
        later_layer
            .absolute
            .get(&first_parameter)
            .map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 70.0 }),
        "later render should start from the cached stable prefix"
    );
    let Some((ParameterValue::Absolute { value }, _)) = later_layer.absolute.get(&second_parameter)
    else {
        panic!("active tail should render an absolute value");
    };
    // Fade timing uses single precision even though parameter values retain double precision.
    assert!(
        (*value - 15.0).abs() < 0.000_001,
        "active tail should still render at the later playback position: {value}"
    );
}

/// Verifies a fully stable cached prefix can return the complete rendered layer.
#[test]
fn sequence_render_prefix_cache_returns_full_cached_layer_for_stable_sequence() {
    let mut world = World::new();
    let first_parameter = test_parameter(&mut world);
    let second_parameter = test_parameter(&mut world);
    let first_cue = test_cue(10, "First");
    let second_cue = test_cue(20, "Second");
    let mut first_values = Layer::new("first".to_owned(), Priority::default());
    first_values.absolute.insert(
        first_parameter,
        (ParameterValue::Absolute { value: 80.0 }, None),
    );
    let mut second_values = Layer::new("second".to_owned(), Priority::default());
    second_values.absolute.insert(
        second_parameter,
        (ParameterValue::Absolute { value: 100.0 }, None),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first_cue.identifiers.uid.into(),
                second_cue.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first_cue.clone(), second_cue.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first_cue,
                values: first_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                ..Default::default()
            },
            MaterializedCue {
                cue: second_cue,
                values: second_values,
                activation_time: Instant::now() - Duration::from_secs(10),
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 1,
        last_rendered_layer: None,
        render_prefix_cache: None,
        composition_order: vec![0, 1],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), Some(Duration::ZERO)],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };
    let first_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let later_clock = InstanceClock {
        position: Duration::from_secs(2),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let _ = materialized.to_layer_at_clock(&mut param_query, Some(&first_clock));
    let cached_activation_time = materialized
        .render_prefix_cache
        .as_ref()
        .expect("full stable sequence should be cached")
        .visible_seq_layer
        .activation_time;
    materialized
        .render_prefix_cache
        .as_mut()
        .expect("full stable sequence should be cached")
        .visible_seq_layer
        .absolute
        .insert(
            first_parameter,
            (ParameterValue::Absolute { value: 70.0 }, None),
        );

    let later_layer = materialized.to_layer_at_clock(&mut param_query, Some(&later_clock));

    assert_eq!(
        later_layer
            .absolute
            .get(&first_parameter)
            .map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 70.0 }),
        "later render should return the full cached layer without rebuilding"
    );
    assert_eq!(
        later_layer
            .absolute
            .get(&second_parameter)
            .map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 100.0 })
    );
    assert!(
        later_layer.activation_time > cached_activation_time,
        "full-cache fast path should refresh the layer activation timestamp"
    );
}

/// Verifies transition source layers are not folded into the stable prefix while present.
#[test]
fn sequence_render_keeps_transition_source_layer_dynamic_until_cleared() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let active_cue = test_cue(10, "Open");

    let mut source_layer = Layer::new("source".to_owned(), Priority::default());
    source_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let mut active_values = Layer::new("active".to_owned(), Priority::default());
    active_values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 200.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![active_cue.identifiers.uid.into()],
            wrap: true,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: true,
        steps: vec![active_cue.clone()],
        mcues: vec![MaterializedCue {
            cue: active_cue,
            values: active_values,
            activation_time: Instant::now() - Duration::from_secs(10),
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,
        composition_order: vec![0],
        transition_source_layers: vec![Some(source_layer)],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now() - Duration::from_secs(10),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };
    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);

    let active_clock = InstanceClock {
        position: Duration::from_millis(500),
        ..Default::default()
    };
    let _ = materialized.to_layer_at_clock(&mut param_query, Some(&active_clock));
    assert!(
        materialized.render_prefix_cache.is_none(),
        "active transition source should keep the cue dynamic"
    );

    let complete_clock = InstanceClock {
        position: Duration::from_millis(1500),
        ..Default::default()
    };
    let _ = materialized.to_layer_at_clock(&mut param_query, Some(&complete_clock));
    assert!(
        materialized.render_prefix_cache.is_none(),
        "source present at frame start should not be cached even when it clears"
    );
    assert_eq!(
        materialized.transition_source_layers,
        vec![None],
        "completed replacement cue should clear the transition source"
    );

    let _ = materialized.to_layer_at_clock(&mut param_query, Some(&complete_clock));
    assert_eq!(
        materialized
            .render_prefix_cache
            .as_ref()
            .map(|cache| cache.order.as_slice()),
        Some([0].as_slice()),
        "cleared source allows the stable cue to be cached on the next render"
    );
}

/// Verifies setup cue transitions use elapsed time since sequence start.
#[test]
fn sequence_setup_compositing_context_uses_sequence_start_position() {
    let mut world = World::new();
    let parameter = test_parameter(&mut world);
    let mut setup_values = Layer::new("setup".to_owned(), Priority::default());
    setup_values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(10),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: Vec::new(),
        mcues: Vec::new(),
        setup_cue: MaterializedCue {
            values: setup_values,
            ..Default::default()
        },
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: Vec::new(),
        transition_source_layers: Vec::new(),
        cue_activation_positions: Vec::new(),
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };
    materialized.set_current_transition_position(Duration::from_secs(10));
    let clock = InstanceClock {
        position: Duration::from_secs(12),
        ..Default::default()
    };

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));
    let rendered = layer
        .absolute
        .get(&parameter)
        .map(|(value, _)| *value)
        .expect("sequence should render the setup value");

    let ParameterValue::Absolute { value } = rendered else {
        panic!("setup cue should render an absolute value");
    };
    // Fade timing uses single precision even though parameter values retain double precision.
    assert!((value - 20.0).abs() < 0.000_001, "setup value: {value}");
}

/// Verifies sequence definition rematerialization preserves setup cue clock anchors.
#[test]
fn sequence_definition_change_preserves_setup_start_position() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(
        Update,
        rematerialize_sequences_after_sequence_definition_change,
    );

    let sequence = Sequence {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "Main".to_string(),
        },
        setup_cue: test_cue(1, "Setup"),
        ..Default::default()
    };
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(sequence.clone()).unwrap();
    }

    let original_start_time = Instant::now() - Duration::from_secs(10);
    let original_start_position = Duration::from_millis(850);
    let entity = app
        .world_mut()
        .spawn(MaterializedSequence {
            sequence: sequence.clone(),
            setup_cue: MaterializedCue {
                activation_time: original_start_time,
                start_position: original_start_position,
                ..Default::default()
            },
            ..Default::default()
        })
        .id();

    let updated_sequence = Sequence {
        setup_cue: test_cue(2, "Updated setup"),
        ..sequence
    };
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(updated_sequence).unwrap();
    }

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("materialized sequence should remain after definition refresh");
    assert_eq!(sequence.setup_cue.activation_time, original_start_time);
    assert_eq!(sequence.setup_cue.start_position, original_start_position);
}

/// Verifies setup Blueprint edits discard retained render state built from prior values.
#[test]
fn setup_blueprint_rematerialization_invalidates_render_prefix_cache() {
    let mut app = App::new();
    app.add_message::<BlueprintDefinitionChange>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(Update, rematerialize_after_blueprint_definition_change);

    let blueprint_uid = uuid::Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(Blueprint {
            identifiers: Identifiers {
                id: 1,
                uid: blueprint_uid,
                label: "Setup Red".to_owned(),
            },
            ..Default::default()
        })
        .expect("Blueprint should be insertable");
    let setup_cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(Vec::new()).into(),
            cue_instruction: CueInstruction {
                blueprint_application: Some(BlueprintApplication {
                    blueprint_uid,
                    selector: BlueprintSelector::Attribute(Attribute::Red),
                }),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let entity = app
        .world_mut()
        .spawn(MaterializedSequence {
            sequence: Sequence {
                setup_cue: setup_cue.clone(),
                ..Default::default()
            },
            setup_cue: MaterializedCue {
                cue: setup_cue,
                ..Default::default()
            },
            render_prefix_cache: Some(RenderPrefixCache {
                order: Vec::new(),
                valid_from_position: None,
                visible_seq_layer: Layer::new("cached".to_owned(), Priority::default()),
                visible_base_layer: ComputedLayer::default(),
                completed_base_layer: ComputedLayer::default(),
                release_marker_parameters: Vec::new(),
            }),
            ..Default::default()
        })
        .id();

    app.world_mut()
        .write_message(BlueprintDefinitionChange { uid: blueprint_uid });
    app.update();

    let sequence = app
        .world()
        .get::<MaterializedSequence>(entity)
        .expect("materialized sequence should remain active");
    assert!(sequence.render_prefix_cache.is_none());
}

/// Verifies released sequences expose their source-local release anchor to the compositor.
#[test]
fn paint_materialized_sequences_mirrors_release_position_to_layer_compositing_context() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, paint_materialized_sequences);

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(Layer::new("release".to_owned(), Priority::default())),
                release_started_position: Some(Duration::from_millis(400)),
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(900),
                ..Default::default()
            },
        ))
        .id();

    app.update();

    let clock = app
        .world()
        .entity(entity)
        .get::<LayerCompositingContext>()
        .expect("sequence layer compositing context should be mirrored from playback clock");
    assert_eq!(clock.position, Duration::from_millis(900));
    assert_eq!(clock.released_at, Some(Duration::from_millis(400)));
}

/// Verifies sequence release captures the source-local playback position when available.
#[test]
fn release_materialized_sequences_records_instance_clock_release_position() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_sequences);

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                last_rendered_layer: Some(Layer::new("rendered".to_owned(), Priority::default())),
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(650),
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("released sequence should still exist");
    assert_eq!(
        sequence.release_started_position(),
        Some(Duration::from_millis(650))
    );
}

/// Verifies releasing a lazy manual sequence does not expand its unvisited suffix.
#[test]
fn release_materialized_sequences_keeps_unvisited_manual_cues_lazy() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_sequences);
    let mut second = test_cue(2, "Second");
    second.trigger = CueTriggerType::Manual;
    let mut third = test_cue(3, "Third");
    third.trigger = CueTriggerType::Manual;
    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                steps: vec![test_cue(1, "First"), second, third],
                mcues: vec![MaterializedCue::default()],
                composition_order: vec![0],
                transition_source_layers: vec![None],
                cue_activation_positions: vec![Some(Duration::ZERO)],
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(650),
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("released sequence should still exist");
    assert_eq!(sequence.mcues.len(), 1);
}

/// Verifies release rendering cannot advance beyond the successfully materialized cue prefix.
#[test]
fn release_materialized_sequences_stops_at_materialized_prefix() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_sequences);
    let first = test_cue(1, "First");
    let mut second = test_cue(2, "Second");
    second.trigger = CueTriggerType::AfterDelay(Duration::ZERO);
    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                steps: vec![first.clone(), second],
                mcues: vec![MaterializedCue {
                    cue: first,
                    ..Default::default()
                }],
                composition_order: vec![0],
                transition_source_layers: vec![None],
                cue_activation_positions: vec![Some(Duration::ZERO)],
                ..Default::default()
            },
            InstanceClock::default(),
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("released sequence should still exist");
    assert_eq!(sequence.position(), 1);
    assert_eq!(sequence.mcues.len(), 1);
    assert!(
        sequence.is_releasing(),
        "release should freeze the available materialized prefix"
    );
}

/// Verifies unclocked sequence release records deterministic zero instead of wall-clock time.
#[test]
fn release_materialized_sequences_without_clock_uses_zero_release_position() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_sequences);
    let parameter = test_parameter(app.world_mut());
    let mut last_rendered_layer = Layer::new("rendered".to_owned(), Priority::default());
    last_rendered_layer
        .absolute
        .insert(parameter, (ParameterValue::Absolute { value: 100.0 }, None));
    let mut release_timing_overrides = ParameterMap::new();
    release_timing_overrides.insert(
        parameter,
        MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                last_rendered_layer: Some(last_rendered_layer),
                release_cue: MaterializedCue {
                    release_timing_overrides,
                    ..Default::default()
                },
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("released sequence should still exist");
    assert_eq!(sequence.release_started_position(), Some(Duration::ZERO));
    let transition = sequence
        .release_layer
        .as_ref()
        .and_then(|layer| layer.absolute.get(&parameter))
        .and_then(|(_, transition)| transition.as_ref())
        .expect("unclocked sequence release should generate a release transition");
    assert_eq!(transition.release_position, Some(Duration::ZERO));
    assert_eq!(transition.start_position, Duration::ZERO);
}

/// Verifies clocked sequence release layers use source-local transition anchors.
#[test]
fn sequence_release_layer_uses_source_local_release_anchors_when_clocked() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    let parameter = test_parameter(app.world_mut());
    let mut last_rendered_layer = Layer::new("rendered".to_owned(), Priority::default());
    last_rendered_layer
        .absolute
        .insert(parameter, (ParameterValue::Absolute { value: 100.0 }, None));
    let mut release_timing_overrides = ParameterMap::new();
    release_timing_overrides.insert(
        parameter,
        MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
    );
    let mut sequence = MaterializedSequence {
        last_rendered_layer: Some(last_rendered_layer),
        release_cue: MaterializedCue {
            release_timing_overrides,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, parameter_query) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");

    sequence.release_from_rendered_assertions_at_position(
        &fixture_data_provider,
        &parameter_query,
        Some(Duration::from_millis(650)),
    );

    let transition = sequence
        .release_layer
        .as_ref()
        .and_then(|layer| layer.absolute.get(&parameter))
        .and_then(|(_, transition)| transition.as_ref())
        .expect("clocked sequence release should generate a release transition");
    assert_eq!(
        transition.release_position,
        Some(Duration::from_millis(650))
    );
    assert_eq!(transition.start_position, Duration::from_millis(650));
}

/// Verifies timed release reconstruction freezes output at the release anchor before later release evaluation.
#[test]
fn release_materialized_sequences_renders_missing_layer_at_timed_release_position() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_sequences);

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence::default(),
            InstanceClock {
                position: Duration::from_millis(900),
                previous_position: Duration::from_millis(900),
                source: InstanceClockSource::ExternalPosition,
                ..Default::default()
            },
            PlaybackReleaseTiming {
                released_at: Duration::from_millis(250),
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("released sequence should still exist");
    assert_eq!(
        sequence.release_started_position(),
        Some(Duration::from_millis(250))
    );
    assert!(
        sequence.is_releasing(),
        "timed release should create a release layer even without a previous paint"
    );
}

/// Verifies clocked sequence release fills a missing source-local anchor.
#[test]
fn release_materialized_sequences_repairs_missing_clock_release_position() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_sequences);
    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(725),
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("released sequence should still exist");
    assert_eq!(
        sequence.release_started_position(),
        Some(Duration::from_millis(725))
    );
    let transition = sequence
        .release_layer
        .as_ref()
        .and_then(|layer| layer.absolute.get(&parameter))
        .and_then(|(_, transition)| transition.as_ref())
        .expect("repaired release layer should keep its transition");
    assert_eq!(
        transition.release_position,
        Some(Duration::from_millis(725))
    );
}

/// Verifies clocked sequence release lifetime follows source-local playback time.
#[test]
fn despawn_materialized_sequences_uses_instance_clock_release_elapsed() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: Some(Duration::from_secs(1)),
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(2500),
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(entity).is_err(),
        "sequence should despawn once playback-clock release elapsed exceeds release duration"
    );
}

/// Verifies unclocked sequence release cleanup does not advance from ReleaseMarker wall time.
#[test]
fn despawn_materialized_sequences_without_clock_uses_zero_release_elapsed() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            ReleaseMarker {
                start_time: Instant::now() - Duration::from_secs(10),
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(entity).is_ok(),
        "unclocked sequence cleanup should not use wall-clock release elapsed"
    );
}

/// Verifies live playback rows without a clock still age out of release.
#[test]
fn despawn_materialized_sequences_without_clock_uses_marker_age_for_instances() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceId::new(),
            ReleaseMarker {
                start_time: Instant::now() - Duration::from_secs(10),
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(entity).is_err(),
        "clockless live playback should despawn after its release marker exceeds release duration"
    );
}

/// Verifies paused live playback rows age out of release even when their clock is frozen.
#[test]
fn despawn_materialized_sequences_uses_marker_age_for_frozen_instances() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: Some(Duration::from_secs(1)),
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_secs(1),
                frozen: true,
                ..Default::default()
            },
            InstanceId::new(),
            ReleaseMarker {
                start_time: Instant::now() - Duration::from_secs(10),
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(entity).is_err(),
        "paused live playback should despawn after its release marker exceeds release duration"
    );
}

/// Verifies stopped timeline playback rows age out of release when the clock has stalled.
#[test]
fn despawn_materialized_sequences_uses_marker_age_for_stalled_timeline_instances() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: Some(Duration::from_secs(1)),
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_secs(1),
                delta: Duration::from_millis(16),
                source: InstanceClockSource::Timeline {
                    timeline_uid: uuid::Uuid::new_v4(),
                    started_at_timeline: Duration::from_millis(100),
                },
                ..Default::default()
            },
            InstanceId::new(),
            ReleaseMarker {
                start_time: Instant::now() - Duration::from_secs(10),
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(entity).is_err(),
        "stalled timeline playback should despawn after its release marker exceeds release duration"
    );
}

/// Verifies attached clocked instances wait for source-local release completion.
#[test]
fn despawn_materialized_sequences_keeps_slow_attached_clocked_instances() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let instance_id = InstanceId::new();
    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: Some(Duration::from_secs(1)),
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(1100),
                delta: Duration::from_millis(10),
                ..Default::default()
            },
            instance_id,
            ReleaseMarker {
                start_time: Instant::now() - Duration::from_secs(10),
            },
        ))
        .id();
    app.world_mut().spawn(MaterializedClip {
        clip_id: 1,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    assert!(
        app.world().get_entity(entity).is_ok(),
        "attached clocked playback should not despawn before source-local release completes"
    );
}

/// Verifies timed reconstructed releases remain source-local even when unbound.
#[test]
fn despawn_materialized_sequences_keeps_slow_unbound_timed_clocked_instances() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut release_layer = Layer::new("release".to_owned(), Priority::default());
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                release_layer: Some(release_layer),
                release_started_position: Some(Duration::from_secs(1)),
                release_duration_floor: Duration::ZERO,
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(1100),
                delta: Duration::from_millis(10),
                ..Default::default()
            },
            InstanceId::new(),
            PlaybackReleaseTiming {
                released_at: Duration::from_secs(1),
            },
            ReleaseMarker {
                start_time: Instant::now() - Duration::from_secs(10),
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(entity).is_ok(),
        "timed unbound playback should not despawn before source-local release completes"
    );
}

/// Builds a materialized single-cue sequence whose final cue has completed.
fn terminated_sequence() -> MaterializedSequence {
    MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![test_cue(10, "Final")],
        mcues: vec![MaterializedCue {
            cue: test_cue(10, "Final"),
            max_fade_in: std::time::Duration::from_millis(1),
            max_assertion_duration: std::time::Duration::from_millis(1),
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now() - std::time::Duration::from_millis(5),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    }
}

/// Verifies opted-in clips deactivate after a non-wrapping sequence ends.
#[test]
fn advance_sequences_deactivates_clip_after_sequence_end() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let instance_id = InstanceId::new();
    app.world_mut().spawn((
        terminated_sequence(),
        instance_id,
        InstanceClock {
            position: Duration::from_millis(5),
            ..Default::default()
        },
    ));
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 7,
            uid: uuid::Uuid::new_v4(),
            label: "exec-7".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 7,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        0,
        "expected sequence-end option to deactivate the clip"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ReleaseMarker>()
            .iter(&app.world())
            .count(),
        1,
        "expected sequence playback to release after the last attached clip deactivates"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ClipReleaseAfterInstance>()
            .iter(&app.world())
            .count(),
        1,
        "expected existing auto-release behavior to be armed at deactivation"
    );
}

/// Verifies sequence-end release prepares the release layer before the first releasing paint.
#[test]
fn advance_sequences_prepares_release_layer_before_first_release_paint() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(
        Update,
        (
            advance_sequences,
            ApplyDeferred,
            release_materialized_sequences,
            paint_materialized_sequences,
        )
            .chain(),
    );

    let parameter = test_parameter(app.world_mut());
    let mut final_cue_layer = Layer::new("final".to_owned(), Priority::default());
    final_cue_layer
        .absolute
        .insert(parameter, (ParameterValue::Absolute { value: 100.0 }, None));
    let mut release_timing_overrides = ParameterMap::new();
    release_timing_overrides.insert(
        parameter,
        MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::ZERO,
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
    );

    let instance_id = InstanceId::new();
    let mut sequence = terminated_sequence();
    sequence.mcues[0].values = final_cue_layer;
    sequence.release_cue = MaterializedCue {
        release_timing_overrides,
        ..Default::default()
    };
    let entity = app
        .world_mut()
        .spawn((
            sequence,
            instance_id,
            InstanceClock {
                position: Duration::from_millis(5),
                ..Default::default()
            },
        ))
        .id();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 7,
            uid: uuid::Uuid::new_v4(),
            label: "exec-7".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 7,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    let sequence = app
        .world()
        .entity(entity)
        .get::<MaterializedSequence>()
        .expect("sequence playback should still exist on the first release frame");
    assert!(
        sequence.is_releasing(),
        "release layer should be prepared in the same frame as sequence-end release"
    );
    let painted_layer = app
        .world()
        .entity(entity)
        .get::<Layer>()
        .expect("released sequence should be painted in the same frame");
    let compositing_context = *app
        .world()
        .entity(entity)
        .get::<LayerCompositingContext>()
        .expect("released sequence should expose source-local release timing");
    let mut painted_layer = painted_layer.clone();
    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let param_query = param_query_state.query_mut(app.world_mut());
    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut painted_layer,
        &ComputedLayer::default(),
        &param_query,
        true,
        compositing_context,
    );
    let output = computed
        .absolute
        .get(&parameter)
        .expect("release layer should keep asserting the released parameter");
    assert!(
        *output > 90.0,
        "first release frame should fade from the frozen look instead of dropping to {output}"
    );
}

/// Verifies auto-ended sequence release ignores final-cue release timing.
#[test]
fn release_materialized_sequences_ignores_final_cue_release_timing() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());

    let parameter = test_parameter(app.world_mut());
    let mut rendered_layer = Layer::new("rendered".to_owned(), Priority::default());
    rendered_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::from_secs(1),
                fade_out: Duration::from_secs(2),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut sequence = MaterializedSequence {
        last_rendered_layer: Some(rendered_layer),
        release_cue: MaterializedCue::default(),
        ..terminated_sequence()
    };
    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, parameter_query) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");

    sequence.release_from_rendered_assertions_at_position(
        &fixture_data_provider,
        &parameter_query,
        Some(Duration::from_millis(1)),
    );

    let release_layer = sequence
        .release_layer
        .as_ref()
        .expect("release should freeze the rendered final cue");
    let transition = release_layer
        .absolute
        .get(&parameter)
        .map(|(_, transition)| transition)
        .expect("release should retain the frozen parameter until immediate release completes");
    assert!(
        transition.is_none(),
        "empty release cue should not inherit final cue out timing"
    );
    assert_eq!(sequence.max_release_duration(), Duration::ZERO);
}

/// Verifies release cue timing is honored even when the frozen layer has no transitions.
#[test]
fn sequence_release_complete_waits_for_noop_release_cue_timing() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());

    let mut rendered_layer = Layer::new("empty rendered".to_owned(), Priority::default());
    rendered_layer.activation_time = Instant::now();
    let mut sequence = MaterializedSequence {
        sequence: Sequence {
            release_cue: Cue {
                transitions: PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
        last_rendered_layer: Some(rendered_layer),
        release_cue: MaterializedCue::default(),
        ..terminated_sequence()
    };
    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, parameter_query) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");

    sequence.release_from_rendered_assertions_at_position(
        &fixture_data_provider,
        &parameter_query,
        Some(Duration::ZERO),
    );

    assert_eq!(sequence.max_release_duration(), Duration::from_secs(2));
    assert!(
        !sequence.release_complete(Duration::from_millis(10), Duration::from_secs(1)),
        "release should stay alive while authored no-op release timing is still in progress"
    );
    assert!(
        sequence.release_complete(Duration::from_millis(10), Duration::from_secs(3)),
        "release should complete after the authored no-op release timing elapses"
    );
}

/// Verifies sequence-end release behavior ignores a wrapped transition back to the first cue.
#[test]
fn advance_sequences_does_not_release_after_wraparound() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let instance_id = InstanceId::new();
    let mut sequence = terminated_sequence();
    sequence.sequence.wrap = true;
    sequence.wrap = true;
    sequence.steps.push(test_cue(20, "Wrapped"));
    sequence.mcues.push(MaterializedCue {
        cue: test_cue(20, "Wrapped"),
        max_fade_in: std::time::Duration::from_millis(1),
        max_assertion_duration: std::time::Duration::from_millis(1),
        ..Default::default()
    });
    sequence.composition_order = vec![0, 1];
    sequence.transition_source_layers = vec![None, None];
    sequence.cue_activation_positions = vec![Some(Duration::ZERO), Some(Duration::from_millis(1))];
    sequence.position_index = 1;
    sequence.last_activation_position = Duration::from_millis(1);
    sequence.next_at_playback_position(Some(Duration::from_millis(5)));
    app.world_mut().spawn((
        sequence,
        instance_id,
        InstanceClock {
            position: Duration::from_millis(10),
            ..Default::default()
        },
    ));
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 27,
            uid: uuid::Uuid::new_v4(),
            label: "exec-27".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 27,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        1,
        "wrapped sequence clip should remain attached after wraparound"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ReleaseMarker>()
            .iter(&app.world())
            .count(),
        0,
        "wrapped sequence should not release when it wraps to the first cue"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ClipReleaseAfterInstance>()
            .iter(&app.world())
            .count(),
        0,
        "wrapped sequence should not arm clip auto-release on wraparound"
    );
}

/// Verifies unclocked sequence-end deactivation does not advance from host elapsed time.
#[test]
fn advance_sequences_without_clock_does_not_deactivate_from_wall_time() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let instance_id = InstanceId::new();
    app.world_mut().spawn((terminated_sequence(), instance_id));
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 17,
            uid: uuid::Uuid::new_v4(),
            label: "exec-17".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 17,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        1,
        "unclocked sequence-end cleanup should not use wall-clock elapsed time"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ReleaseMarker>()
            .iter(&app.world())
            .count(),
        0,
        "unclocked sequence should not release from stale host activation time"
    );
}

/// Verifies sequence-end deactivation preserves output when auto-release is disabled.
#[test]
fn advance_sequences_latches_final_output_without_auto_release() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let parameter = test_parameter(app.world_mut());
    let mut output_layer = OutputLayer::default();
    output_layer.0.absolute.insert(parameter, 127.0);
    app.world_mut().spawn((
        Layer::new("Manual Channel Assertions".to_string(), Priority(-127)),
        ManualAssertionLayer,
    ));

    let instance_id = InstanceId::new();
    app.world_mut().spawn((
        terminated_sequence(),
        instance_id,
        output_layer,
        InstanceClock {
            position: Duration::from_millis(5),
            ..Default::default()
        },
    ));
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 9,
            uid: uuid::Uuid::new_v4(),
            label: "exec-9".to_owned(),
        },
        options: ClipOptions {
            auto_release: false,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 9,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    let manual_value = app
        .world_mut()
        .query_filtered::<&Layer, With<ManualAssertionLayer>>()
        .single(&app.world())
        .expect("manual assertion layer should exist")
        .absolute
        .get(&parameter)
        .map(|(value, _)| *value);

    assert_eq!(
        manual_value,
        Some(ParameterValue::Absolute { value: 127.0 }),
        "expected final sequence output to be preserved as a manual assertion"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ClipReleaseAfterInstance>()
            .iter(&app.world())
            .count(),
        0,
        "expected no global auto-release watcher when auto-release is disabled"
    );
}

/// Verifies latch-required deactivation waits for computed sequence output.
#[test]
fn advance_sequences_defers_non_auto_release_until_output_exists() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    app.world_mut().spawn((
        Layer::new("Manual Channel Assertions".to_string(), Priority(-127)),
        ManualAssertionLayer,
    ));

    let instance_id = InstanceId::new();
    app.world_mut().spawn((
        terminated_sequence(),
        instance_id,
        InstanceClock {
            position: Duration::from_millis(5),
            ..Default::default()
        },
    ));
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 10,
            uid: uuid::Uuid::new_v4(),
            label: "exec-10".to_owned(),
        },
        options: ClipOptions {
            auto_release: false,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 10,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        1,
        "expected clip to remain attached until final output can be latched"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ReleaseMarker>()
            .iter(&app.world())
            .count(),
        0,
        "expected sequence release to wait for a computed output layer"
    );
}

/// Verifies default clips keep holding at the final cue.
#[test]
fn advance_sequences_keeps_clip_active_without_sequence_end_option() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let instance_id = InstanceId::new();
    app.world_mut().spawn((
        terminated_sequence(),
        instance_id,
        InstanceClock {
            position: Duration::from_millis(5),
            ..Default::default()
        },
    ));
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 8,
            uid: uuid::Uuid::new_v4(),
            label: "exec-8".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: false,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 8,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        1,
        "expected clip to remain active without sequence-end deactivation"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ReleaseMarker>()
            .iter(&app.world())
            .count(),
        0,
        "expected sequence playback to keep holding at the final cue"
    );
}

/// Verifies sequence cleanup waits for the frozen release layer instead of marker age.
#[test]
fn despawn_sequences_waits_for_release_layer_transition_elapsed() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_sequences);

    let parameter = test_parameter(app.world_mut());
    let release_time = Instant::now();
    let mut release_layer = Layer::new("release".to_string(), Priority(0));
    release_layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 200.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(2),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: Some(Duration::ZERO),
            }),
        ),
    );

    let mut sequence = terminated_sequence();
    sequence.release_layer = Some(release_layer);
    sequence.release_started_position = Some(Duration::ZERO);
    let entity = app
        .world_mut()
        .spawn((
            sequence,
            InstanceClock {
                position: Duration::from_secs(1),
                ..Default::default()
            },
            ReleaseMarker {
                start_time: release_time - Duration::from_secs(5),
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get::<MaterializedSequence>(entity).is_some(),
        "expected sequence to linger while its frozen release layer is still fading"
    );

    app.world_mut()
        .get_mut::<InstanceClock>(entity)
        .expect("sequence should have a playback clock")
        .position = Duration::from_secs(3);

    app.update();

    assert!(
        app.world().get::<MaterializedSequence>(entity).is_none(),
        "expected sequence to despawn once its frozen release transition completes"
    );
}

/// Verifies AfterDelay auto-progression uses InstanceClock elapsed time when available.
#[test]
fn advance_sequences_uses_instance_clock_for_after_delay() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let first = test_cue(10, "Open");
    let mut second = test_cue(20, "Build");
    second.trigger = CueTriggerType::AfterDelay(Duration::from_millis(100));
    let sequence = Sequence {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "Main".to_string(),
        },
        steps: vec![first.identifiers.uid.into(), second.identifiers.uid.into()],
        wrap: false,
        ..Default::default()
    };
    let instance_id = InstanceId::new();
    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                sequence,
                priority: Priority(0),
                wrap: false,
                steps: vec![first, second],
                mcues: vec![MaterializedCue::default(), MaterializedCue::default()],
                setup_cue: MaterializedCue::default(),
                release_cue: MaterializedCue::default(),
                release_layer: None,
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                position_index: 0,
                last_rendered_layer: None,
                render_prefix_cache: None,

                composition_order: vec![0],
                transition_source_layers: vec![None, None],
                cue_activation_positions: vec![Some(Duration::ZERO), None],
                activation_time: Instant::now() - Duration::from_secs(10),
                playback_start_position: Duration::ZERO,
                last_activation_position: Duration::ZERO,
            },
            instance_id,
            InstanceClock {
                position: Duration::from_millis(50),
                frozen: true,
                ..Default::default()
            },
        ))
        .id();

    app.update();
    assert_eq!(
        app.world()
            .get::<MaterializedSequence>(entity)
            .expect("sequence should still exist")
            .position(),
        1,
        "frozen playback clock should prevent wall-clock based auto-progression"
    );

    app.world_mut()
        .get_mut::<InstanceClock>(entity)
        .expect("sequence should have a playback clock")
        .position = Duration::from_millis(150);
    app.update();

    assert_eq!(
        app.world()
            .get::<MaterializedSequence>(entity)
            .expect("sequence should still exist")
            .position(),
        2,
        "sequence should advance once playback-clock elapsed time passes the delay"
    );
}

/// Verifies AfterDelay advances from the current cue start without waiting for its assertion span.
#[test]
fn advance_sequences_after_delay_allows_overlapping_assertion_transition() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let first = test_cue(10, "Open");
    let mut second = test_cue(20, "Build");
    second.trigger = CueTriggerType::AfterDelay(Duration::from_millis(100));
    let sequence = Sequence {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "Main".to_string(),
        },
        steps: vec![first.identifiers.uid.into(), second.identifiers.uid.into()],
        wrap: false,
        ..Default::default()
    };
    let instance_id = InstanceId::new();
    let entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                sequence,
                priority: Priority(0),
                wrap: false,
                steps: vec![first, second],
                mcues: vec![
                    MaterializedCue {
                        max_assertion_duration: Duration::from_secs(1),
                        ..Default::default()
                    },
                    MaterializedCue::default(),
                ],
                setup_cue: MaterializedCue::default(),
                release_cue: MaterializedCue::default(),
                release_layer: None,
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                position_index: 0,
                last_rendered_layer: None,
                render_prefix_cache: None,

                composition_order: vec![0],
                transition_source_layers: vec![None, None],
                cue_activation_positions: vec![Some(Duration::ZERO), None],
                activation_time: Instant::now(),
                playback_start_position: Duration::ZERO,
                last_activation_position: Duration::ZERO,
            },
            instance_id,
            InstanceClock {
                position: Duration::from_millis(500),
                ..Default::default()
            },
        ))
        .id();

    app.update();

    let sequence = app
        .world()
        .get::<MaterializedSequence>(entity)
        .expect("sequence should still exist");
    assert_eq!(sequence.position(), 2);
    assert_eq!(
        sequence.cue_activation_positions[1],
        Some(Duration::from_millis(100)),
        "next cue should start after its trigger delay from the prior cue start"
    );
}

/// Verifies multiple due AfterDelay cues keep retained HTP assertions composited together.
#[test]
fn after_delay_overlap_keeps_retained_htp_assertions_active() {
    let mut world = World::new();
    let parameter_606 = test_parameter(&mut world);
    let parameter_605 = test_parameter(&mut world);
    let cue_606 = test_cue(13, "606 on");
    let mut cue_605_on = test_cue(15, "605 on");
    cue_605_on.trigger = CueTriggerType::AfterDelay(Duration::ZERO);
    let mut cue_605_off = test_cue(17, "605 off");
    cue_605_off.trigger = CueTriggerType::AfterDelay(Duration::from_millis(103));

    let mut values_606 = Layer::new("606 on".to_owned(), Priority::default());
    values_606.absolute.insert(
        parameter_606,
        (
            ParameterValue::Absolute { value: 200.0 },
            Some(MaterializedTransition {
                delay_in: Duration::from_millis(500),
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::from_millis(500),
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut values_605_on = Layer::new("605 on".to_owned(), Priority::default());
    values_605_on.absolute.insert(
        parameter_605,
        (
            ParameterValue::Absolute { value: 200.0 },
            Some(MaterializedTransition {
                delay_in: Duration::from_millis(500),
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::from_millis(500),
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let mut values_605_off = Layer::new("605 off".to_owned(), Priority::default());
    values_605_off.absolute.insert(
        parameter_605,
        (
            ParameterValue::Absolute { value: 0.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 17,
                uid: uuid::Uuid::new_v4(),
                label: "repro".to_owned(),
            },
            steps: vec![
                cue_606.identifiers.uid.into(),
                cue_605_on.identifiers.uid.into(),
                cue_605_off.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![cue_606, cue_605_on, cue_605_off],
        mcues: vec![
            MaterializedCue {
                values: values_606,
                max_assertion_duration: Duration::from_millis(1500),
                ..Default::default()
            },
            MaterializedCue {
                values: values_605_on,
                max_assertion_duration: Duration::from_millis(1500),
                ..Default::default()
            },
            MaterializedCue {
                values: values_605_off,
                max_assertion_duration: Duration::from_secs(1),
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None, None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), None, None],
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };
    let clock = InstanceClock {
        position: Duration::from_millis(724),
        ..Default::default()
    };

    assert_eq!(materialized.advance_autonomous_at_clock(Some(&clock)), 2);
    assert_eq!(materialized.position(), 3);
    assert_eq!(materialized.composition_order, vec![0, 1, 2]);
    let status = materialized.runtime_status_at_clock(Some(&clock));
    let InstancePosition::Sequence { retained_cues, .. } = status.position else {
        panic!("sequence runtime status should report sequence position");
    };
    assert_eq!(
        retained_cues,
        vec![
            InstanceSequenceCueStatus {
                position: 1,
                cue_uid: materialized.steps[0].identifiers.uid,
                transition_elapsed: Some(Duration::from_millis(724)),
            },
            InstanceSequenceCueStatus {
                position: 2,
                cue_uid: materialized.steps[1].identifiers.uid,
                transition_elapsed: Some(Duration::from_millis(724)),
            },
            InstanceSequenceCueStatus {
                position: 3,
                cue_uid: materialized.steps[2].identifiers.uid,
                transition_elapsed: Some(Duration::from_millis(621)),
            },
        ],
        "retained cue progress should preserve each cue's own activation anchor"
    );

    let mut param_query_state = world.query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(&mut world);
    let sequence_layer = materialized.to_layer_at_clock(&mut param_query, Some(&clock));
    let value_606 = match sequence_layer
        .absolute
        .get(&parameter_606)
        .expect("606 on should still contribute")
        .0
    {
        ParameterValue::Absolute { value } => value,
        other => panic!("606 on should render an absolute value, got {other:?}"),
    };
    let value_605 = match sequence_layer
        .absolute
        .get(&parameter_605)
        .expect("605 on should still win over the lower off cue")
        .0
    {
        ParameterValue::Absolute { value } => value,
        other => panic!("605 should render an absolute value, got {other:?}"),
    };

    assert!(
        (44.0..46.0).contains(&value_606),
        "606 on should keep progressing from its original start, got {value_606}"
    );
    assert!(
        (44.0..46.0).contains(&value_605),
        "605 on should keep progressing above the overlapping off cue, got {value_605}"
    );
}

/// Verifies prefix reconstruction preserves prior absolute At-trigger anchors.
#[test]
fn reconstructing_prefix_preserves_prior_at_trigger_anchor() {
    let first = test_cue(1, "One");
    let mut second = test_cue(2, "Two");
    second.trigger = CueTriggerType::At(Duration::from_secs(10));
    let mut third = test_cue(3, "Three");
    third.trigger = CueTriggerType::At(Duration::from_secs(20));

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first.identifiers.uid.into(),
                second.identifiers.uid.into(),
                third.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first.clone(), second.clone(), third.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first,
                max_assertion_duration: Duration::from_secs(30),
                ..Default::default()
            },
            MaterializedCue {
                cue: second,
                max_assertion_duration: Duration::from_secs(30),
                ..Default::default()
            },
            MaterializedCue {
                cue: third,
                max_assertion_duration: Duration::from_secs(1),
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None, None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), None, None],
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    materialized
        .set_position_reconstructing_prefix_at_playback_position(3, Duration::from_secs(20));

    assert_eq!(
        materialized.cue_activation_positions,
        vec![
            Some(Duration::ZERO),
            Some(Duration::from_secs(10)),
            Some(Duration::from_secs(20)),
        ],
        "reconstruction should preserve each At cue's source-local activation anchor"
    );
    assert_eq!(
        materialized.mcues[1].release_position,
        Some(Duration::from_secs(20)),
        "the prior At cue should release from the later cue's actual activation"
    );
}

/// Verifies prefix reconstruction uses authored duration for assertion-less FollowPrevious cues.
#[test]
fn reconstructing_prefix_uses_empty_cue_authored_duration_for_follow_previous() {
    let mut first = test_cue(1, "Empty Timed");
    first.transitions = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let mut second = test_cue(2, "Follow");
    second.trigger = CueTriggerType::FollowPrevious;
    let mut third = test_cue(3, "At");
    third.trigger = CueTriggerType::At(Duration::from_millis(1500));

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first.identifiers.uid.into(),
                second.identifiers.uid.into(),
                third.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first.clone(), second.clone(), third.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first,
                max_assertion_duration: Duration::ZERO,
                ..Default::default()
            },
            MaterializedCue {
                cue: second,
                max_assertion_duration: Duration::ZERO,
                ..Default::default()
            },
            MaterializedCue {
                cue: third,
                max_assertion_duration: Duration::ZERO,
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None, None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), None, None],
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    materialized
        .set_position_reconstructing_prefix_at_playback_position(3, Duration::from_millis(1500));

    assert_eq!(
        materialized.cue_activation_positions,
        vec![
            Some(Duration::ZERO),
            Some(Duration::from_secs(1)),
            Some(Duration::from_millis(1500)),
        ],
        "FollowPrevious reconstruction should use cue duration, not only materialized assertions"
    );
    assert_eq!(
        materialized.mcues[0].release_position,
        Some(Duration::from_secs(1))
    );
    assert_eq!(
        materialized.mcues[1].release_position,
        Some(Duration::from_millis(1500))
    );
}

/// Verifies prefix reconstruction stops retained timing at manual cue boundaries.
#[test]
fn reconstructing_prefix_stops_at_manual_boundary() {
    let first = test_cue(1, "One");
    let mut second = test_cue(2, "Manual");
    second.trigger = CueTriggerType::Manual;
    let mut third = test_cue(3, "Three");
    third.trigger = CueTriggerType::AfterDelay(Duration::ZERO);

    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![
                first.identifiers.uid.into(),
                second.identifiers.uid.into(),
                third.identifiers.uid.into(),
            ],
            wrap: false,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: false,
        steps: vec![first.clone(), second.clone(), third.clone()],
        mcues: vec![
            MaterializedCue {
                cue: first,
                max_assertion_duration: Duration::from_secs(30),
                release_position: Some(Duration::from_secs(20)),
                ..Default::default()
            },
            MaterializedCue {
                cue: second,
                max_assertion_duration: Duration::ZERO,
                ..Default::default()
            },
            MaterializedCue {
                cue: third,
                max_assertion_duration: Duration::ZERO,
                ..Default::default()
            },
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None, None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), None, None],
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    materialized
        .set_position_reconstructing_prefix_at_playback_position(3, Duration::from_secs(20));

    assert_eq!(
        materialized.composition_order,
        vec![1, 2],
        "cue 1 should not remain retained across cue 2's manual trigger"
    );
    assert_eq!(
        materialized.cue_activation_positions,
        vec![
            None,
            Some(Duration::from_secs(20)),
            Some(Duration::from_secs(20))
        ],
        "manual-boundary reconstruction should clear stale prefix activation anchors"
    );
    assert_eq!(
        materialized.mcues[0].release_position, None,
        "manual-boundary reconstruction should clear stale prefix release anchors"
    );
    assert_eq!(
        materialized.termination_position(),
        Some(Duration::from_secs(20)),
        "termination should ignore cues before the manual boundary"
    );
}

/// Verifies cue 1 AfterDelay is a wrap delay, not an initial activation delay.
#[test]
fn first_cue_after_delay_only_applies_when_wrapping() {
    let mut first = test_cue(10, "Loop");
    first.trigger = CueTriggerType::AfterDelay(Duration::from_millis(100));
    let mut second = test_cue(20, "Build");
    second.trigger = CueTriggerType::AfterDelay(Duration::from_millis(500));
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![first.identifiers.uid.into(), second.identifiers.uid.into()],
            wrap: true,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: true,
        steps: vec![first, second],
        mcues: vec![MaterializedCue::default(), MaterializedCue::default()],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None, None],
        cue_activation_positions: vec![Some(Duration::ZERO), None],
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_millis(200),
            ..Default::default()
        })),
        None,
        "cue 1 AfterDelay should not act as a pre-start or initial activation delay"
    );

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_millis(501),
            ..Default::default()
        })),
        Some(Some(Duration::from_millis(500))),
        "cue 2 AfterDelay should control the initial cue 1 to cue 2 transition"
    );
    assert_eq!(
        materialized.advance_autonomous_at_clock(Some(&InstanceClock {
            position: Duration::from_millis(501),
            ..Default::default()
        })),
        1
    );
    assert_eq!(materialized.position(), 2);

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_millis(550),
            ..Default::default()
        })),
        None,
        "wrapping should wait for cue 1's AfterDelay from the final cue activation"
    );

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_millis(601),
            ..Default::default()
        })),
        Some(Some(Duration::from_millis(600))),
        "cue 1 AfterDelay should determine the wait after the final cue before wrapping"
    );
    assert_eq!(
        materialized.advance_autonomous_at_clock(Some(&InstanceClock {
            position: Duration::from_millis(601),
            ..Default::default()
        })),
        1
    );
    assert_eq!(materialized.position(), 1);
}

/// Verifies wrap delay cannot restart a cue before its assertion transition completes.
#[test]
fn wraparound_after_delay_waits_for_current_assertion_transition() {
    let mut cue = test_cue(10, "Loop");
    cue.trigger = CueTriggerType::AfterDelay(Duration::from_millis(1));
    let mut materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![cue.identifiers.uid.into()],
            wrap: true,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: true,
        steps: vec![cue],
        mcues: vec![MaterializedCue {
            max_assertion_duration: Duration::from_secs(1),
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_millis(999),
            ..Default::default()
        })),
        None,
        "single-cue wrap should wait for the current fade-in before restarting"
    );

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_secs(1),
            ..Default::default()
        })),
        Some(Some(Duration::from_secs(1))),
        "wrap activation should occur once the cue's assertion transition is complete"
    );
    assert_eq!(
        materialized.advance_autonomous_at_clock(Some(&InstanceClock {
            position: Duration::from_secs(1),
            ..Default::default()
        })),
        1
    );
    assert_eq!(materialized.position(), 1);
    assert_eq!(
        materialized.last_activation_position,
        Duration::from_secs(1)
    );
}

/// Verifies wrap delay respects authored cue timing even without materialized assertions.
#[test]
fn wraparound_after_delay_waits_for_empty_cue_authored_transition() {
    let mut cue = test_cue(10, "Empty Loop");
    cue.trigger = CueTriggerType::AfterDelay(Duration::from_millis(1));
    cue.transitions = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let materialized = MaterializedSequence {
        sequence: Sequence {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Main".to_string(),
            },
            steps: vec![cue.identifiers.uid.into()],
            wrap: true,
            ..Default::default()
        },
        priority: Priority(0),
        wrap: true,
        steps: vec![cue.clone()],
        mcues: vec![MaterializedCue {
            cue,
            max_assertion_duration: Duration::ZERO,
            ..Default::default()
        }],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: vec![None],
        cue_activation_positions: vec![Some(Duration::ZERO)],
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_millis(999),
            ..Default::default()
        })),
        None,
        "empty cue wrap should still wait for its authored fade-in"
    );

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_secs(1),
            ..Default::default()
        })),
        Some(Some(Duration::from_secs(1)))
    );
}

/// Verifies sequence-end deactivation waits for InstanceClock elapsed time when available.
#[test]
fn advance_sequences_uses_instance_clock_for_sequence_end() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let instance_id = InstanceId::new();
    let sequence_entity = app
        .world_mut()
        .spawn((
            terminated_sequence(),
            instance_id,
            InstanceClock {
                position: Duration::ZERO,
                frozen: true,
                ..Default::default()
            },
        ))
        .id();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 12,
            uid: uuid::Uuid::new_v4(),
            label: "exec-12".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 12,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        1,
        "frozen playback clock should keep the final sequence clip active"
    );

    app.world_mut()
        .get_mut::<InstanceClock>(sequence_entity)
        .expect("sequence should have a playback clock")
        .position = Duration::from_millis(5);
    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(&app.world())
            .count(),
        0,
        "sequence end should deactivate after playback-clock elapsed time completes"
    );
    let release_timing = app
        .world()
        .entity(sequence_entity)
        .get::<PlaybackReleaseTiming>()
        .expect("clocked sequence end should preserve the completion release anchor");
    assert_eq!(
        release_timing.released_at,
        Duration::from_millis(1),
        "sequence release should start at final cue completion, not the later evaluation position"
    );
}

/// Verifies sequence-end deactivation waits for the final cue's transition span.
#[test]
fn advance_sequences_waits_for_final_cue_transition_span() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let instance_id = InstanceId::new();
    let sequence_entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                sequence: Sequence {
                    identifiers: Identifiers {
                        id: 1,
                        uid: uuid::Uuid::new_v4(),
                        label: "Main".to_string(),
                    },
                    wrap: false,
                    ..Default::default()
                },
                priority: Priority(0),
                wrap: false,
                steps: vec![test_cue(10, "Full"), test_cue(20, "Zeros")],
                mcues: vec![
                    MaterializedCue {
                        cue: test_cue(10, "Full"),
                        max_assertion_duration: Duration::from_millis(200),
                        ..Default::default()
                    },
                    MaterializedCue {
                        cue: test_cue(20, "Zeros"),
                        max_assertion_duration: Duration::from_secs(1),
                        max_fade_in: Duration::ZERO,
                        max_fade_out: Duration::from_secs(1),
                        ..Default::default()
                    },
                ],
                setup_cue: MaterializedCue::default(),
                release_cue: MaterializedCue::default(),
                release_layer: None,
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                position_index: 1,
                last_rendered_layer: None,
                render_prefix_cache: None,

                composition_order: vec![0, 1],
                transition_source_layers: vec![None, None],
                cue_activation_positions: vec![
                    Some(Duration::ZERO),
                    Some(Duration::from_millis(200)),
                ],
                activation_time: Instant::now(),
                playback_start_position: Duration::ZERO,
                last_activation_position: Duration::from_millis(200),
            },
            instance_id,
            InstanceClock {
                position: Duration::from_millis(1199),
                frozen: true,
                ..Default::default()
            },
        ))
        .id();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 13,
            uid: uuid::Uuid::new_v4(),
            label: "exec-13".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 13,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(&app.world())
            .count(),
        1,
        "final cue should remain active before its full transition span completes"
    );

    app.world_mut()
        .get_mut::<InstanceClock>(sequence_entity)
        .expect("sequence should have a playback clock")
        .position = Duration::from_millis(1201);
    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(&app.world())
            .count(),
        0,
        "sequence end should deactivate after the final cue transition span completes"
    );
    let release_timing = app
        .world()
        .entity(sequence_entity)
        .get::<PlaybackReleaseTiming>()
        .expect("clocked sequence end should preserve the completion release anchor");
    assert_eq!(release_timing.released_at, Duration::from_millis(1200));
}

/// Verifies sequence-end release starts at completion before release cue entry timing elapses.
#[test]
fn advance_sequences_releases_at_completion_before_release_cue_entry_span() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let instance_id = InstanceId::new();
    let mut sequence = terminated_sequence();
    sequence.release_cue = MaterializedCue {
        cue: Cue {
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };
    let sequence_entity = app
        .world_mut()
        .spawn((
            sequence,
            instance_id,
            InstanceClock {
                position: Duration::from_secs(1),
                frozen: true,
                ..Default::default()
            },
        ))
        .id();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 15,
            uid: uuid::Uuid::new_v4(),
            label: "exec-15".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 15,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(&app.world())
            .count(),
        0,
        "release cue Delay In should not postpone sequence-end release"
    );
    assert_eq!(
        app.world_mut()
            .query::<&ReleaseMarker>()
            .iter(&app.world())
            .count(),
        1,
        "sequence should enter release at final cue completion"
    );
    let release_timing = app
        .world()
        .entity(sequence_entity)
        .get::<PlaybackReleaseTiming>()
        .expect("clocked sequence end should preserve the completion release anchor");
    assert_eq!(release_timing.released_at, Duration::from_millis(1));
}

/// Verifies sequence-end deactivation waits for authored timing on assertion-less cues.
#[test]
fn advance_sequences_waits_for_empty_final_cue_authored_duration() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let first = test_cue(10, "Initial");
    let mut final_cue = test_cue(20, "Timed Empty");
    final_cue.transitions = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let instance_id = InstanceId::new();
    let sequence_entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                sequence: Sequence {
                    identifiers: Identifiers {
                        id: 1,
                        uid: uuid::Uuid::new_v4(),
                        label: "Main".to_string(),
                    },
                    steps: vec![
                        first.identifiers.uid.into(),
                        final_cue.identifiers.uid.into(),
                    ],
                    wrap: false,
                    ..Default::default()
                },
                priority: Priority(0),
                wrap: false,
                steps: vec![first.clone(), final_cue.clone()],
                mcues: vec![
                    MaterializedCue {
                        cue: first,
                        max_assertion_duration: Duration::from_millis(200),
                        ..Default::default()
                    },
                    MaterializedCue {
                        cue: final_cue,
                        max_assertion_duration: Duration::ZERO,
                        ..Default::default()
                    },
                ],
                setup_cue: MaterializedCue::default(),
                release_cue: MaterializedCue::default(),
                release_layer: None,
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                position_index: 1,
                last_rendered_layer: None,
                render_prefix_cache: None,

                composition_order: vec![0, 1],
                transition_source_layers: vec![None, None],
                cue_activation_positions: vec![
                    Some(Duration::ZERO),
                    Some(Duration::from_millis(200)),
                ],
                activation_time: Instant::now(),
                playback_start_position: Duration::ZERO,
                last_activation_position: Duration::from_millis(200),
            },
            instance_id,
            InstanceClock {
                position: Duration::from_millis(1199),
                frozen: true,
                ..Default::default()
            },
        ))
        .id();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 14,
            uid: uuid::Uuid::new_v4(),
            label: "exec-14".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 14,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(&app.world())
            .count(),
        1,
        "empty final cue should remain active until authored timing completes"
    );

    app.world_mut()
        .get_mut::<InstanceClock>(sequence_entity)
        .expect("sequence should have a playback clock")
        .position = Duration::from_millis(1201);
    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(&app.world())
            .count(),
        0,
        "sequence end should deactivate after authored cue timing completes"
    );
    let release_timing = app
        .world()
        .entity(sequence_entity)
        .get::<PlaybackReleaseTiming>()
        .expect("clocked sequence end should preserve the completion release anchor");
    assert_eq!(release_timing.released_at, Duration::from_millis(1200));
}

/// Verifies sequence-end deactivation waits for retained prior cue transitions.
#[test]
fn advance_sequences_waits_for_retained_prior_cue_transition_span() {
    let mut app = App::new();
    app.add_systems(Update, advance_sequences);

    let first = test_cue(10, "Full");
    let mut second = test_cue(20, "Zeros");
    second.trigger = CueTriggerType::AfterDelay(Duration::from_millis(100));
    let instance_id = InstanceId::new();
    let sequence_entity = app
        .world_mut()
        .spawn((
            MaterializedSequence {
                sequence: Sequence {
                    identifiers: Identifiers {
                        id: 1,
                        uid: uuid::Uuid::new_v4(),
                        label: "Main".to_string(),
                    },
                    steps: vec![first.identifiers.uid.into(), second.identifiers.uid.into()],
                    wrap: false,
                    ..Default::default()
                },
                priority: Priority(0),
                wrap: false,
                steps: vec![first.clone(), second.clone()],
                mcues: vec![
                    MaterializedCue {
                        cue: first,
                        max_assertion_duration: Duration::from_secs(1),
                        ..Default::default()
                    },
                    MaterializedCue {
                        cue: second,
                        max_assertion_duration: Duration::ZERO,
                        ..Default::default()
                    },
                ],
                setup_cue: MaterializedCue::default(),
                release_cue: MaterializedCue::default(),
                release_layer: None,
                release_started_position: None,
                release_duration_floor: Duration::ZERO,
                position_index: 0,
                last_rendered_layer: None,
                render_prefix_cache: None,

                composition_order: vec![0],
                transition_source_layers: vec![None, None],
                cue_activation_positions: vec![Some(Duration::ZERO), None],
                activation_time: Instant::now(),
                playback_start_position: Duration::ZERO,
                last_activation_position: Duration::ZERO,
            },
            instance_id,
            InstanceClock {
                position: Duration::from_millis(500),
                frozen: true,
                ..Default::default()
            },
        ))
        .id();
    app.world_mut().spawn(Clip {
        identifiers: Identifiers {
            id: 14,
            uid: uuid::Uuid::new_v4(),
            label: "exec-14".to_owned(),
        },
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    });
    app.world_mut().spawn(MaterializedClip {
        clip_id: 14,
        attached_instance: instance_id,
        auto_release_on_stop: false,
    });

    app.update();
    let sequence = app
        .world()
        .get::<MaterializedSequence>(sequence_entity)
        .expect("sequence should still exist");
    assert_eq!(
        sequence.position(),
        2,
        "after-delay should advance to the final cue before the prior transition completes"
    );
    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        1,
        "sequence should stay active while the retained prior cue is still transitioning"
    );

    app.world_mut()
        .get_mut::<InstanceClock>(sequence_entity)
        .expect("sequence should have a playback clock")
        .position = Duration::from_millis(1001);
    app.update();

    assert_eq!(
        app.world_mut()
            .query::<&MaterializedClip>()
            .iter(app.world())
            .count(),
        0,
        "sequence end should deactivate after the retained prior transition completes"
    );
    let release_timing = app
        .world()
        .entity(sequence_entity)
        .get::<PlaybackReleaseTiming>()
        .expect("clocked sequence end should preserve the retained completion release anchor");
    assert_eq!(release_timing.released_at, Duration::from_secs(1));
}

/// Verifies runtime status reports sequence navigation metadata.
#[test]
fn runtime_status_reports_current_and_next_sequence_position() {
    let sequence = Sequence {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "Main".to_string(),
        },
        wrap: false,
        ..Default::default()
    };
    let materialized = MaterializedSequence {
        sequence,
        priority: Priority(0),
        wrap: false,
        steps: vec![
            Cue {
                parts: vec![test_part(1, "Open intensity"), test_part(2, "Open color")],
                ..test_cue(10, "Open")
            },
            Cue {
                parts: vec![test_part(1, "Build color")],
                ..test_cue(20, "Build")
            },
        ],
        mcues: Vec::new(),
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: Vec::new(),
        cue_activation_positions: Vec::new(),
        activation_time: Instant::now(),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    let sequence_uid = materialized.sequence.identifiers.uid;
    let current_cue_uid = materialized.steps[0].identifiers.uid;
    let next_cue_uid = materialized.steps[1].identifiers.uid;
    let clock = InstanceClock {
        activation_epoch_ms: Some(99.0),
        ..Default::default()
    };
    let status = materialized.runtime_status_at_clock(Some(&clock));

    assert_eq!(
        status.position,
        InstancePosition::Sequence {
            sequence_uid,
            current_position: 1,
            cue_count: 2,
            current_cue_uid: Some(current_cue_uid),
            current_label: Some("Open".to_string()),
            current_part_count: 2,
            next_position: Some(2),
            next_cue_uid: Some(next_cue_uid),
            next_label: Some("Build".to_string()),
            next_part_count: Some(1),
            retained_cues: vec![],
        }
    );
    assert_eq!(status.source_activation_epoch_ms, Some(99.0));
}

/// Verifies follow gating waits for the longest assertion transition span.
#[test]
fn follow_previous_waits_for_cue_assertion_transitions() {
    let mut sequence = Sequence {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "Main".to_string(),
        },
        wrap: false,
        ..Default::default()
    };
    let first = test_cue(10, "Open");
    let mut second = test_cue(20, "Build");
    second.trigger = CueTriggerType::FollowPrevious;
    sequence.steps = vec![first.identifiers.uid.into(), second.identifiers.uid.into()];
    let mut materialized = MaterializedSequence {
        sequence,
        priority: Priority(0),
        wrap: false,
        steps: vec![first, second],
        mcues: vec![
            MaterializedCue {
                max_assertion_duration: std::time::Duration::from_secs(5),
                ..Default::default()
            },
            MaterializedCue::default(),
        ],
        setup_cue: MaterializedCue::default(),
        release_cue: MaterializedCue::default(),
        release_layer: None,
        release_started_position: None,
        release_duration_floor: Duration::ZERO,
        position_index: 0,
        last_rendered_layer: None,
        render_prefix_cache: None,

        composition_order: vec![0],
        transition_source_layers: Vec::new(),
        cue_activation_positions: vec![Some(Duration::ZERO), None],
        activation_time: Instant::now() - std::time::Duration::from_secs(4),
        playback_start_position: Duration::ZERO,
        last_activation_position: Duration::ZERO,
    };

    assert_eq!(materialized.next_autonomous_activation_position(None), None);

    materialized.activation_time = Instant::now() - std::time::Duration::from_secs(6);

    assert_eq!(
        materialized.next_autonomous_activation_position(None),
        None,
        "unclocked follow progression should not use wall-clock elapsed time"
    );

    assert_eq!(
        materialized.next_autonomous_activation_position(Some(&InstanceClock {
            position: Duration::from_secs(6),
            ..Default::default()
        })),
        Some(Some(Duration::from_secs(5))),
        "clocked follow progression should advance at the source-local transition boundary"
    );
}
