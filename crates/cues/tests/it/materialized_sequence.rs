// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;
use std::time::{Duration, Instant};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_ecs::schedule::ApplyDeferred;
use bevy_ecs::system::SystemState;
use moonshine_kind::{Instance, InstanceMut, InstanceRef};
use nightfall::prelude::*;
use nightfall_clips::{Clip, Source};
use nightfall_compositor::prelude::ReleaseMarker;
use nightfall_cues::cue::FixtureAttributeTransition;
use nightfall_cues::cue::TrackingMode;
use nightfall_cues::lookahead_projection::project_authored_sequence_lookahead;
use nightfall_cues::materialized_sequence::{
    MaterializedSequence, rematerialize_sequences_after_cue_definition_change,
    rematerialize_sequences_after_sequence_definition_change,
};
use nightfall_cues::prelude::{
    BoundCueInstruction, Cue, CueInstruction, CueTriggerType, Sequence, TrackingFlags,
    sequence_release_duration_for_clip,
};
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{InstanceClock, InstanceId, InstanceOptions};
use uuid::Uuid;

fn build_sequence(label: &str, steps: Vec<SimpleUuid>) -> Sequence {
    let mut sequence = Sequence::default();
    sequence.identifiers.id = 1;
    sequence.identifiers.uid = Uuid::new_v4();
    sequence.identifiers.label = label.to_string();
    sequence.steps = steps;
    sequence
}

#[test]
fn default_sequence_owned_cues_use_expected_tracking_modes() {
    let sequence = Sequence::default();

    assert_eq!(
        sequence.setup_cue.tracking_mode,
        Some(TrackingMode::Flags(TrackingFlags::default()))
    );
    assert_eq!(
        sequence.release_cue.tracking_mode,
        Some(TrackingMode::Inherit)
    );
}

fn spawn_parameter(world: &mut World, attribute: Attribute) -> Instance<Parameter> {
    let parameter_entity = world
        .spawn(Parameter {
            metadata: ParameterMetadata {
                attribute,
                resolution: DmxValueResolution::Coarse,
                min: 0.0,
                max: 255.0,
                ..Default::default()
            },
            values: Default::default(),
        })
        .id();

    // SAFETY: parameter_entity was spawned in this world with a Parameter component.
    unsafe { Instance::from_entity_unchecked(parameter_entity) }
}

fn add_two_element_fixture(world: &mut World, fixture_id: u32) -> Vec<FixtureRef> {
    let fixture_uid = Uuid::new_v4();
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("fixture-{fixture_id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![
            FixtureElement {
                label: "element-1".to_string(),
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Intensity,
                    native_unit: Attribute::Intensity.native_unit(),
                    value_polarity: Attribute::Intensity.value_polarity(),
                    resolution: DmxValueResolution::Coarse,
                    ..Default::default()
                }],
            },
            FixtureElement {
                label: "element-2".to_string(),
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Intensity,
                    native_unit: Attribute::Intensity.native_unit(),
                    value_polarity: Attribute::Intensity.value_polarity(),
                    resolution: DmxValueResolution::Coarse,
                    ..Default::default()
                }],
            },
        ],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    (1..=2)
        .map(|index| {
            let fixture_ref = FixtureRef {
                fixture_uid,
                index: Some(index),
            };
            let parameter = spawn_parameter(world, Attribute::Intensity);
            world.resource::<FixtureDataProviderExt>().add_parameter(
                fixture_ref.clone(),
                Attribute::Intensity,
                parameter,
            );
            fixture_ref
        })
        .collect()
}

/// Adds a fixture with one parameter and returns its fixture and parameter references.
fn add_single_parameter_fixture(
    world: &mut World,
    fixture_id: u32,
    attribute: Attribute,
) -> (FixtureRef, Instance<Parameter>) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("fixture-{fixture_id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "element-1".to_string(),
            parameters: vec![ParameterMetadata {
                attribute: attribute.clone(),
                native_unit: attribute.clone().native_unit(),
                value_polarity: attribute.clone().value_polarity(),
                resolution: DmxValueResolution::Coarse,
                ..Default::default()
            }],
        }],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let parameter = spawn_parameter(world, attribute.clone());
    world.resource::<FixtureDataProviderExt>().add_parameter(
        fixture_ref.clone(),
        attribute,
        parameter,
    );

    (fixture_ref, parameter)
}

/// Adds a fixture with red, green, and blue LTP parameters.
fn add_rgb_fixture(
    world: &mut World,
    fixture_id: u32,
) -> (
    FixtureRef,
    Instance<Parameter>,
    Instance<Parameter>,
    Instance<Parameter>,
) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let attributes = [Attribute::Red, Attribute::Green, Attribute::Blue];
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("fixture-{fixture_id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "element-1".to_string(),
            parameters: attributes
                .iter()
                .cloned()
                .map(|attribute| ParameterMetadata {
                    native_unit: attribute.clone().native_unit(),
                    value_polarity: attribute.clone().value_polarity(),
                    attribute,
                    resolution: DmxValueResolution::Coarse,
                    merge_type: MergeStrategy::LTP,
                    ..Default::default()
                })
                .collect(),
        }],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let red_parameter = spawn_parameter(world, Attribute::Red);
    let green_parameter = spawn_parameter(world, Attribute::Green);
    let blue_parameter = spawn_parameter(world, Attribute::Blue);
    for (attribute, parameter) in [
        (Attribute::Red, red_parameter),
        (Attribute::Green, green_parameter),
        (Attribute::Blue, blue_parameter),
    ] {
        world
            .get_mut::<Parameter>(parameter.entity())
            .expect("rgb parameter should exist")
            .metadata
            .merge_type = MergeStrategy::LTP;
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            attribute,
            parameter,
        );
    }

    (fixture_ref, red_parameter, green_parameter, blue_parameter)
}

/// Adds a single-element fixture with HTP intensity and LTP red parameters.
fn add_intensity_red_fixture(
    world: &mut World,
    fixture_id: u32,
) -> (FixtureRef, Instance<Parameter>, Instance<Parameter>) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("fixture-{fixture_id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "element-1".to_string(),
            parameters: vec![
                ParameterMetadata {
                    attribute: Attribute::Intensity,
                    native_unit: Attribute::Intensity.native_unit(),
                    value_polarity: Attribute::Intensity.value_polarity(),
                    resolution: DmxValueResolution::Coarse,
                    merge_type: MergeStrategy::HTP,
                    ..Default::default()
                },
                ParameterMetadata {
                    attribute: Attribute::Red,
                    native_unit: Attribute::Red.native_unit(),
                    value_polarity: Attribute::Red.value_polarity(),
                    resolution: DmxValueResolution::Coarse,
                    merge_type: MergeStrategy::LTP,
                    ..Default::default()
                },
            ],
        }],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let intensity_parameter = spawn_parameter(world, Attribute::Intensity);
    let red_parameter = spawn_parameter(world, Attribute::Red);
    world
        .get_mut::<Parameter>(intensity_parameter.entity())
        .expect("intensity parameter should exist")
        .metadata
        .merge_type = MergeStrategy::HTP;
    world
        .get_mut::<Parameter>(red_parameter.entity())
        .expect("red parameter should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;

    for (attribute, parameter) in [
        (Attribute::Intensity, intensity_parameter),
        (Attribute::Red, red_parameter),
    ] {
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            attribute,
            parameter,
        );
    }

    (fixture_ref, intensity_parameter, red_parameter)
}

/// Adds a single-element moving fixture with intensity, pan, and tilt parameters.
fn add_moving_fixture(
    world: &mut World,
    fixture_id: u32,
) -> (
    FixtureRef,
    Instance<Parameter>,
    Instance<Parameter>,
    Instance<Parameter>,
) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let attributes = [Attribute::Intensity, Attribute::Pan, Attribute::Tilt];
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("fixture-{fixture_id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "element-1".to_string(),
            parameters: attributes
                .iter()
                .cloned()
                .map(|attribute| ParameterMetadata {
                    native_unit: attribute.clone().native_unit(),
                    value_polarity: attribute.clone().value_polarity(),
                    attribute,
                    resolution: DmxValueResolution::Coarse,
                    merge_type: MergeStrategy::LTP,
                    ..Default::default()
                })
                .collect(),
        }],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let intensity_parameter = spawn_parameter(world, Attribute::Intensity);
    let pan_parameter = spawn_parameter(world, Attribute::Pan);
    let tilt_parameter = spawn_parameter(world, Attribute::Tilt);
    for (attribute, parameter) in [
        (Attribute::Intensity, intensity_parameter),
        (Attribute::Pan, pan_parameter),
        (Attribute::Tilt, tilt_parameter),
    ] {
        if attribute != Attribute::Intensity {
            world
                .get_mut::<Parameter>(parameter.entity())
                .expect("moving fixture parameter should exist")
                .metadata
                .merge_type = MergeStrategy::LTP;
        }
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            attribute,
            parameter,
        );
    }

    (
        fixture_ref,
        intensity_parameter,
        pan_parameter,
        tilt_parameter,
    )
}

/// Adds a fixture with red, green, blue, and white LTP parameters.
fn add_rgbw_fixture(
    world: &mut World,
    fixture_id: u32,
) -> (
    FixtureRef,
    Instance<Parameter>,
    Instance<Parameter>,
    Instance<Parameter>,
    Instance<Parameter>,
) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let attributes = [
        Attribute::Red,
        Attribute::Green,
        Attribute::Blue,
        Attribute::White,
    ];
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("fixture-{fixture_id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "element-1".to_string(),
            parameters: attributes
                .iter()
                .cloned()
                .map(|attribute| ParameterMetadata {
                    native_unit: attribute.clone().native_unit(),
                    value_polarity: attribute.clone().value_polarity(),
                    attribute,
                    resolution: DmxValueResolution::Coarse,
                    merge_type: MergeStrategy::LTP,
                    ..Default::default()
                })
                .collect(),
        }],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let red_parameter = spawn_parameter(world, Attribute::Red);
    let green_parameter = spawn_parameter(world, Attribute::Green);
    let blue_parameter = spawn_parameter(world, Attribute::Blue);
    let white_parameter = spawn_parameter(world, Attribute::White);
    for (attribute, parameter) in [
        (Attribute::Red, red_parameter),
        (Attribute::Green, green_parameter),
        (Attribute::Blue, blue_parameter),
        (Attribute::White, white_parameter),
    ] {
        world
            .get_mut::<Parameter>(parameter.entity())
            .expect("rgbw parameter should exist")
            .metadata
            .merge_type = MergeStrategy::LTP;
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            attribute,
            parameter,
        );
    }

    (
        fixture_ref,
        red_parameter,
        green_parameter,
        blue_parameter,
        white_parameter,
    )
}

/// Adds a fixture with cyan, magenta, and yellow LTP parameters.
fn add_cmy_fixture(
    world: &mut World,
    fixture_id: u32,
) -> (
    FixtureRef,
    Instance<Parameter>,
    Instance<Parameter>,
    Instance<Parameter>,
) {
    let fixture_uid = Uuid::new_v4();
    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let attributes = [Attribute::Cyan, Attribute::Magenta, Attribute::Yellow];
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("fixture-{fixture_id}"),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        mode: "default".to_string(),
        elements: vec![FixtureElement {
            label: "element-1".to_string(),
            parameters: attributes
                .iter()
                .cloned()
                .map(|attribute| ParameterMetadata {
                    native_unit: attribute.clone().native_unit(),
                    value_polarity: attribute.clone().value_polarity(),
                    attribute,
                    resolution: DmxValueResolution::Coarse,
                    merge_type: MergeStrategy::LTP,
                    ..Default::default()
                })
                .collect(),
        }],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let cyan_parameter = spawn_parameter(world, Attribute::Cyan);
    let magenta_parameter = spawn_parameter(world, Attribute::Magenta);
    let yellow_parameter = spawn_parameter(world, Attribute::Yellow);
    for (attribute, parameter) in [
        (Attribute::Cyan, cyan_parameter),
        (Attribute::Magenta, magenta_parameter),
        (Attribute::Yellow, yellow_parameter),
    ] {
        world
            .get_mut::<Parameter>(parameter.entity())
            .expect("cmy parameter should exist")
            .metadata
            .merge_type = MergeStrategy::LTP;
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            attribute,
            parameter,
        );
    }

    (
        fixture_ref,
        cyan_parameter,
        magenta_parameter,
        yellow_parameter,
    )
}

/// Builds a cue that asserts a single fixture parameter value.
fn cue_with_parameter(
    id: u32,
    uid: Uuid,
    label: &str,
    fixture_ref: FixtureRef,
    attribute: Attribute,
    value: ParameterValue,
    transitions: PartialTransition,
) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(attribute, ValueSource::Inline(value))]),
                transitions,
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Builds a cue that stores a single fixture value source.
fn cue_with_value_source(
    id: u32,
    uid: Uuid,
    label: &str,
    fixture_ref: FixtureRef,
    attribute: Attribute,
    value_source: ValueSource,
    transitions: PartialTransition,
) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(attribute, value_source)]),
                transitions,
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Builds an RGB cue for one fixture element.
fn rgb_cue(
    id: u32,
    uid: Uuid,
    label: &str,
    fixture_ref: FixtureRef,
    color: ColorPathRgb,
    transitions: PartialTransition,
    color_path_id: Option<ColorPathId>,
) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        transitions,
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.red.into(),
                        }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.green.into(),
                        }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.blue.into(),
                        }),
                    ),
                ]),
                color_path_id,
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Builds an RGBW cue for one fixture element.
fn rgbw_cue(
    id: u32,
    uid: Uuid,
    label: &str,
    fixture_ref: FixtureRef,
    color: ColorPathRgb,
    white: f32,
    transitions: PartialTransition,
    color_path_id: Option<ColorPathId>,
) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        transitions,
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.red.into(),
                        }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.green.into(),
                        }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.blue.into(),
                        }),
                    ),
                    (
                        Attribute::White,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: white.into(),
                        }),
                    ),
                ]),
                color_path_id,
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Builds a CMY cue for one fixture element.
fn cmy_cue(
    id: u32,
    uid: Uuid,
    label: &str,
    fixture_ref: FixtureRef,
    color: ColorPathRgb,
    transitions: PartialTransition,
    color_path_id: Option<ColorPathId>,
) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        transitions,
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Cyan,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.red.into(),
                        }),
                    ),
                    (
                        Attribute::Magenta,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.green.into(),
                        }),
                    ),
                    (
                        Attribute::Yellow,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: color.blue.into(),
                        }),
                    ),
                ]),
                color_path_id,
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Materializes a sequence using the app's cue and fixture resources.
fn materialize_sequence(app: &mut App, sequence: &Sequence) -> MaterializedSequence {
    let mut system_state = SystemState::<(
        Res<DataProvider<Cue>>,
        Res<FixtureDataProviderExt>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (cue_data_provider, fixture_data_provider, selection_resolver, parameter_query) =
        system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");

    MaterializedSequence::materialize(
        sequence,
        &cue_data_provider,
        &fixture_data_provider,
        &parameter_query,
        &selection_resolver,
    )
}

/// Materializes a sequence with showfile color path definitions.
fn materialize_sequence_with_color_paths(
    app: &mut App,
    sequence: &Sequence,
) -> MaterializedSequence {
    let mut system_state = SystemState::<(
        Res<DataProvider<Cue>>,
        Res<DataProvider<ColorPath>>,
        Res<FixtureDataProviderExt>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (
        cue_data_provider,
        color_path_data_provider,
        fixture_data_provider,
        selection_resolver,
        parameter_query,
    ) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");

    MaterializedSequence::materialize_with_color_paths(
        sequence,
        &cue_data_provider,
        Some(&color_path_data_provider),
        &fixture_data_provider,
        &parameter_query,
        &selection_resolver,
    )
}

/// Renders a materialized sequence into computed parameter values.
fn render_sequence_layer(
    app: &mut App,
    msequence: &mut MaterializedSequence,
) -> nightfall_compositor::prelude::ComputedLayer {
    let clock = InstanceClock {
        position: legacy_current_cue_elapsed(msequence),
        ..Default::default()
    };
    render_sequence_layer_at_clock(app, msequence, Some(&clock))
}

/// Renders a materialized sequence at an optional source-local playback clock.
fn render_sequence_layer_at_clock(
    app: &mut App,
    msequence: &mut MaterializedSequence,
    clock: Option<&InstanceClock>,
) -> nightfall_compositor::prelude::ComputedLayer {
    render_sequence_layer_at_clock_with_instance_options(
        app,
        msequence,
        clock,
        InstanceOptions {
            lookahead_enabled: None,
        },
    )
}

/// Renders a materialized sequence with explicit playback options.
fn render_sequence_layer_at_clock_with_instance_options(
    app: &mut App,
    msequence: &mut MaterializedSequence,
    clock: Option<&InstanceClock>,
    instance_options: InstanceOptions,
) -> nightfall_compositor::prelude::ComputedLayer {
    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceMut<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, mut param_query) = system_state
        .get_mut(app.world_mut())
        .expect("test system parameters should be available");
    let mut sequence_layer = msequence.to_layer_at_clock(&mut param_query, clock);
    let lookahead_assertions = msequence.lookahead_lookahead_assertions(
        &sequence_layer,
        &fixture_data_provider,
        &param_query,
        instance_options,
    );
    lookahead_assertions.apply_to_layer(&mut sequence_layer);
    nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut sequence_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        false,
        nightfall_compositor::types::LayerCompositingContext {
            position: clock.map(|clock| clock.position).unwrap_or_default(),
            released_at: None,
        },
    )
}

/// Runs native authored lookahead projection for one sequence cue.
fn project_sequence_lookahead_for_target(
    app: &mut App,
    sequence: &Sequence,
    steps: &[Cue],
    target_cue_uid: Uuid,
) -> Vec<nightfall_lookahead_projection::ProjectedLookaheadValue> {
    let mut system_state = SystemState::<SpatialSelectionResolver>::new(app.world_mut());
    let selection_resolver = system_state
        .get(app.world_mut())
        .expect("test selection resolver should be available");

    project_authored_sequence_lookahead(sequence, steps, target_cue_uid, &selection_resolver)
}

/// Verifies lookahead pre-asserts downstream pan and tilt while the fixture is dark.
#[test]
fn lookahead_preasserts_downstream_position_for_dark_fixture() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, tilt_parameter) = add_moving_fixture(app.world_mut(), 1801);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "dark",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let mut cue_2 = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_2_uid,
            label: "position and light".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                    ),
                    (
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    ),
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    cue_2.lookahead = Some(true);
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let sequence = build_sequence("lookahead", vec![cue_1_uid.into(), cue_2_uid.into()]);
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), Some(&45.0));
    assert_eq!(layer.absolute.get(&tilt_parameter), Some(&90.0));
}

/// Verifies native authored projection matches runtime lookahead assertions for a dark fixture.
#[test]
fn authored_lookahead_projection_matches_runtime_dark_fixture_assertions() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, tilt_parameter) = add_moving_fixture(app.world_mut(), 1831);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "dark",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let cue_2 = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_2_uid,
            label: "position source".to_string(),
        },
        lookahead: Some(true),
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                    ),
                    (
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    ),
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let steps = vec![cue_1.clone(), cue_2.clone()];
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let sequence = build_sequence("lookahead parity", vec![cue_1_uid.into(), cue_2_uid.into()]);
    let projected = project_sequence_lookahead_for_target(&mut app, &sequence, &steps, cue_1_uid);
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), Some(&45.0));
    assert_eq!(layer.absolute.get(&tilt_parameter), Some(&90.0));
    assert_eq!(projected.len(), 2);
    assert!(projected.iter().all(|value| value.source.cue_id == 2));
    assert!(projected.iter().any(|value| {
        value.fixture == fixture_ref
            && value.attribute == "Pan"
            && value.value == (ParameterValue::Absolute { value: 45.0 })
    }));
    assert!(projected.iter().any(|value| {
        value.fixture == fixture_ref
            && value.attribute == "Tilt"
            && value.value == (ParameterValue::Absolute { value: 90.0 })
    }));
}

/// Verifies position-only fixtures are considered dark for lookahead.
#[test]
fn lookahead_preasserts_position_for_fixture_without_intensity_parameter() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (lit_fixture_ref, _, _, _) = add_moving_fixture(app.world_mut(), 1811);
    let (position_fixture_ref, tilt_parameter) =
        add_single_parameter_fixture(app.world_mut(), 1812, Attribute::Tilt);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "unrelated light",
        lit_fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 255.0 },
        PartialTransition::default(),
    );
    let mut cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "position only",
        position_fixture_ref,
        Attribute::Tilt,
        ParameterValue::Absolute { value: 90.0 },
        PartialTransition::default(),
    );
    cue_2.lookahead = Some(true);
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let sequence = build_sequence(
        "lookahead position only",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&tilt_parameter), Some(&90.0));
}

/// Verifies sequence Lookahead ignores global current intensity when the sequence has not lit the fixture.
#[test]
fn lookahead_preasserts_position_when_only_global_intensity_is_on() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (lit_fixture_ref, _, _, _) = add_moving_fixture(app.world_mut(), 1821);
    let (target_fixture_ref, target_intensity_parameter, _, target_tilt_parameter) =
        add_moving_fixture(app.world_mut(), 1822);
    app.world_mut()
        .get_mut::<Parameter>(target_intensity_parameter.entity())
        .expect("target intensity parameter should exist")
        .values
        .current_value = 255.0;

    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "unrelated light",
        lit_fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 255.0 },
        PartialTransition::default(),
    );
    let mut cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "target position",
        target_fixture_ref,
        Attribute::Tilt,
        ParameterValue::Absolute { value: 90.0 },
        PartialTransition::default(),
    );
    cue_2.lookahead = Some(true);
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let sequence = build_sequence(
        "lookahead sequence-local darkness",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&target_tilt_parameter), Some(&90.0));
}

/// Verifies downstream pan and tilt are left untouched when lookahead is disabled.
#[test]
fn lookahead_disabled_does_not_preassert_downstream_position() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, _) = add_moving_fixture(app.world_mut(), 1802);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "dark",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "position",
        fixture_ref,
        Attribute::Pan,
        ParameterValue::Absolute { value: 45.0 },
        PartialTransition::default(),
    );
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let sequence = build_sequence(
        "lookahead disabled",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), None);
}

/// Verifies a forced playback disable suppresses cue-authored lookahead.
#[test]
fn lookahead_force_disabled_does_not_preassert_cue_authored_position() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, _) = add_moving_fixture(app.world_mut(), 1803);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "dark",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let mut cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "cue-authored position",
        fixture_ref,
        Attribute::Pan,
        ParameterValue::Absolute { value: 45.0 },
        PartialTransition::default(),
    );
    cue_2.lookahead = Some(true);
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let sequence = build_sequence(
        "lookahead force disabled",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let clock = InstanceClock {
        position: legacy_current_cue_elapsed(&msequence),
        ..Default::default()
    };

    let layer = render_sequence_layer_at_clock_with_instance_options(
        &mut app,
        &mut msequence,
        Some(&clock),
        InstanceOptions {
            lookahead_enabled: Some(false),
        },
    );

    assert_eq!(layer.absolute.get(&pan_parameter), None);
}

/// Verifies relative downstream position values are ignored by lookahead.
#[test]
fn lookahead_ignores_relative_position_values() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, _) = add_moving_fixture(app.world_mut(), 1803);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "dark",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "relative position",
        fixture_ref,
        Attribute::Pan,
        ParameterValue::Relative { offset: 10.0 },
        PartialTransition::default(),
    );
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let sequence = build_sequence(
        "lookahead relative",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), None);
}

/// Verifies lookahead does not look through an intervening cue that makes the fixture visible.
#[test]
fn lookahead_stops_at_intervening_visible_cue() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, _) = add_moving_fixture(app.world_mut(), 1804);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_3_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "dark",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "visible",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 255.0 },
        PartialTransition::default(),
    );
    let mut cue_3 = cue_with_parameter(
        3,
        cue_3_uid,
        "late position",
        fixture_ref,
        Attribute::Pan,
        ParameterValue::Absolute { value: 45.0 },
        PartialTransition::default(),
    );
    cue_3.lookahead = Some(true);
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
        cue_data_provider.add(cue_3).unwrap();
    }
    let sequence = build_sequence(
        "lookahead visible blocker",
        vec![cue_1_uid.into(), cue_2_uid.into(), cue_3_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), None);
}

/// Verifies native authored projection and runtime assertions both stop at visible blockers.
#[test]
fn authored_lookahead_projection_matches_runtime_visible_blocker() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, _) = add_moving_fixture(app.world_mut(), 1832);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_3_uid = Uuid::new_v4();
    let cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "dark",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "visible blocker",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 255.0 },
        PartialTransition::default(),
    );
    let mut cue_3 = cue_with_parameter(
        3,
        cue_3_uid,
        "late position",
        fixture_ref,
        Attribute::Pan,
        ParameterValue::Absolute { value: 45.0 },
        PartialTransition::default(),
    );
    cue_3.lookahead = Some(true);
    let steps = vec![cue_1.clone(), cue_2.clone(), cue_3.clone()];
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
        cue_data_provider.add(cue_3).unwrap();
    }
    let sequence = build_sequence(
        "lookahead blocker parity",
        vec![cue_1_uid.into(), cue_2_uid.into(), cue_3_uid.into()],
    );
    let projected = project_sequence_lookahead_for_target(&mut app, &sequence, &steps, cue_1_uid);
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), None);
    assert!(projected.is_empty());
}

/// Verifies native authored projection follows runtime wrap lookahead ordering.
#[test]
fn authored_lookahead_projection_matches_runtime_wrapped_source() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, _) = add_moving_fixture(app.world_mut(), 1833);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let mut cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "wrapped source",
        fixture_ref.clone(),
        Attribute::Pan,
        ParameterValue::Absolute { value: 45.0 },
        PartialTransition::default(),
    );
    cue_1.lookahead = Some(true);
    let cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "dark target",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    let steps = vec![cue_1.clone(), cue_2.clone()];
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let mut sequence = build_sequence(
        "lookahead wrap parity",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    sequence.wrap = true;
    let projected = project_sequence_lookahead_for_target(&mut app, &sequence, &steps, cue_2_uid);
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.set_position(2);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), Some(&45.0));
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].fixture, fixture_ref);
    assert_eq!(projected[0].attribute, "Pan");
    assert_eq!(projected[0].value, ParameterValue::Absolute { value: 45.0 });
    assert_eq!(projected[0].source.cue_id, 1);
}

/// Verifies wrapped runtime lookahead uses the first visible cue part instead of flattened values.
#[test]
fn wrapped_lookahead_uses_ordered_cue_part_source() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, pan_parameter, _) = add_moving_fixture(app.world_mut(), 1834);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_1 = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_1_uid,
            label: "wrapped multi-part source".to_owned(),
        },
        lookahead: Some(true),
        tracking_mode: Some(TrackingMode::Flags(TrackingFlags::from(0))),
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                    ),
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        parts: vec![nightfall_cues::cue::CuePart {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "later part".to_owned(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 90.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            lookahead: Some(false),
            tracking_flags: TrackingFlags::from(0),
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "dark target",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition::default(),
    );
    cue_2.tracking_mode = Some(TrackingMode::Flags(TrackingFlags::from(0)));
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }
    let mut sequence = build_sequence(
        "wrapped cue-part lookahead",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.set_position(2);

    let layer = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(layer.absolute.get(&pan_parameter), Some(&45.0));
}

/// Derives a source-local playback position from legacy test start-time anchors.
fn legacy_current_cue_elapsed(msequence: &MaterializedSequence) -> Duration {
    let current_index = msequence.position().saturating_sub(1) as usize;
    msequence
        .mcues
        .get(current_index)
        .map(|cue| cue.activation_time.elapsed())
        .unwrap_or_default()
}

/// Verifies assigned HSV color paths derive grouped RGB emitter values at render time.
#[test]
fn sequence_rgb_color_path_uses_grouped_hsv_midpoint() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 718);
    let red_cue_uid = Uuid::new_v4();
    let blue_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let blue_cue = rgb_cue(
        2,
        blue_cue_uid,
        "blue via hsv",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(2)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(blue_cue).unwrap();
    }

    let sequence = build_sequence(
        "hsv color path",
        vec![red_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    let red = *midpoint_layer
        .absolute
        .get(&red_parameter)
        .expect("color path midpoint should assert red");
    let green = *midpoint_layer
        .absolute
        .get(&green_parameter)
        .expect("color path midpoint should assert green");
    let blue = *midpoint_layer
        .absolute
        .get(&blue_parameter)
        .expect("color path midpoint should assert blue");

    assert!(red > 240.0, "HSV midpoint should stay red-heavy, got {red}");
    assert!(
        green < 10.0,
        "HSV midpoint should avoid green on the shortest red-blue route, got {green}"
    );
    assert!(
        blue > 240.0,
        "HSV midpoint should be blue-heavy, got {blue}"
    );
}

/// Verifies path midpoint brightness affects the fade interior without changing endpoints.
#[test]
fn sequence_rgb_color_path_applies_midpoint_brightness_only_inside_fade() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath {
            identifiers: Identifiers {
                id: 82,
                label: "dim midpoint rgb".to_string(),
                ..Default::default()
            },
            interpolation_space: ColorInterpolationSpace::Rgb,
            hue_direction: HueDirection::Shortest,
            timing: ColorPathTiming {
                brightness_percent: Some(0.5),
                ..Default::default()
            },
            curve: FadeCurve::Linear,
        })
        .expect("custom midpoint brightness color path should be added");

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 724);
    let red_cue_uid = Uuid::new_v4();
    let green_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let green_cue = rgb_cue(
        2,
        green_cue_uid,
        "green with dim midpoint",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 1.0,
            blue: 0.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(82)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(green_cue).unwrap();
    }

    let sequence = build_sequence(
        "midpoint brightness color path",
        vec![red_cue_uid.into(), green_cue_uid.into()],
    );
    let mut msequence = materialize_sequence_with_color_paths(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    let red_midpoint = *midpoint_layer
        .absolute
        .get(&red_parameter)
        .expect("midpoint brightness should assert red");
    let green_midpoint = *midpoint_layer
        .absolute
        .get(&green_parameter)
        .expect("midpoint brightness should assert green");
    let blue_midpoint = *midpoint_layer
        .absolute
        .get(&blue_parameter)
        .expect("midpoint brightness should assert blue");

    assert!(
        (60.0..=68.0).contains(&red_midpoint),
        "dimmed midpoint should halve interpolated red, got {red_midpoint}"
    );
    assert!(
        (60.0..=68.0).contains(&green_midpoint),
        "dimmed midpoint should halve interpolated green, got {green_midpoint}"
    );
    assert_eq!(blue_midpoint, 0.0);

    let completed_clock = InstanceClock {
        position: settled_clock.position + Duration::from_secs(1),
        ..Default::default()
    };
    let completed_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&completed_clock));

    assert!(
        completed_layer
            .absolute
            .get(&red_parameter)
            .copied()
            .unwrap_or_default()
            < 10.0,
        "completed fade should not keep red from midpoint brightness"
    );
    assert!(
        completed_layer
            .absolute
            .get(&green_parameter)
            .copied()
            .unwrap_or_default()
            > 240.0,
        "completed fade should reach undimmed destination green"
    );
}

/// Verifies RGBW auxiliary emitters follow color path timing at render time.
#[test]
fn sequence_rgbw_color_path_applies_auxiliary_emitter_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath {
            identifiers: Identifiers {
                id: 79,
                label: "delayed white rgbw".to_string(),
                ..Default::default()
            },
            interpolation_space: ColorInterpolationSpace::Rgb,
            hue_direction: HueDirection::Shortest,
            timing: ColorPathTiming {
                attributes: HashMap::from([(
                    Attribute::White,
                    ColorAttributeTiming {
                        delay_percent: 0.75,
                        time_percent: 0.25,
                        curve: FadeCurve::Linear,
                    },
                )]),
                ..Default::default()
            },
            curve: FadeCurve::Linear,
        })
        .expect("custom RGBW timing color path should be added");

    let (fixture_ref, _red_parameter, _green_parameter, _blue_parameter, white_parameter) =
        add_rgbw_fixture(app.world_mut(), 727);
    let red_white_cue_uid = Uuid::new_v4();
    let blue_cue_uid = Uuid::new_v4();
    let red_white_cue = rgbw_cue(
        1,
        red_white_cue_uid,
        "red white",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        1.0,
        PartialTransition::default(),
        None,
    );
    let blue_cue = rgbw_cue(
        2,
        blue_cue_uid,
        "blue delayed white",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        0.0,
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(79)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_white_cue).unwrap();
        cue_data_provider.add(blue_cue).unwrap();
    }

    let sequence = build_sequence(
        "rgbw color path auxiliary timing",
        vec![red_white_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut msequence = materialize_sequence_with_color_paths(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    assert_eq!(
        midpoint_layer.absolute.get(&white_parameter).copied(),
        Some(255.0),
        "white should hold its start value until the color path emitter delay has elapsed"
    );

    let completed_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(1500),
        ..Default::default()
    };
    let completed_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&completed_clock));
    assert_eq!(
        completed_layer.absolute.get(&white_parameter).copied(),
        Some(0.0),
        "white should reach its destination after the delayed emitter timing completes"
    );
}

/// Verifies RGBW fixtures decompose sampled RGB color into the white emitter at runtime.
#[test]
fn sequence_rgbw_color_path_decomposes_rgb_sample_to_white_emitter() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter, white_parameter) =
        add_rgbw_fixture(app.world_mut(), 729);
    let red_cue_uid = Uuid::new_v4();
    let white_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red rgbw",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let white_cue = rgb_cue(
        2,
        white_cue_uid,
        "white via rgbw decomposition",
        fixture_ref,
        ColorPathRgb {
            red: 1.0,
            green: 1.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(2)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(white_cue).unwrap();
    }

    let sequence = build_sequence(
        "rgbw color path decomposition",
        vec![red_cue_uid.into(), white_cue_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    let red = *midpoint_layer
        .absolute
        .get(&red_parameter)
        .expect("midpoint should assert red residual");
    let green = *midpoint_layer
        .absolute
        .get(&green_parameter)
        .expect("midpoint should assert green residual");
    let blue = *midpoint_layer
        .absolute
        .get(&blue_parameter)
        .expect("midpoint should assert blue residual");
    let white = *midpoint_layer
        .absolute
        .get(&white_parameter)
        .expect("midpoint should assert decomposed white");

    assert!(
        (120.0..=140.0).contains(&red),
        "RGBW midpoint should leave red residual around half, got {red}"
    );
    assert!(
        green < 5.0,
        "RGBW midpoint should move neutral green into white, got {green}"
    );
    assert!(
        blue < 5.0,
        "RGBW midpoint should move neutral blue into white, got {blue}"
    );
    assert!(
        (120.0..=140.0).contains(&white),
        "RGBW midpoint should emit decomposed white around half, got {white}"
    );

    let completed_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(1500),
        ..Default::default()
    };
    let completed_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&completed_clock));
    assert_eq!(
        completed_layer.absolute.get(&red_parameter).copied(),
        Some(0.0),
        "completed RGBW decomposition should leave no red residual"
    );
    assert_eq!(
        completed_layer.absolute.get(&green_parameter).copied(),
        Some(0.0),
        "completed RGBW decomposition should leave no green residual"
    );
    assert_eq!(
        completed_layer.absolute.get(&blue_parameter).copied(),
        Some(0.0),
        "completed RGBW decomposition should leave no blue residual"
    );
    assert_eq!(
        completed_layer.absolute.get(&white_parameter).copied(),
        Some(255.0),
        "completed RGBW decomposition should emit full white"
    );
}

/// Verifies RGBW decomposition honors derived emitter timing from the color path.
#[test]
fn sequence_rgbw_color_path_decomposition_applies_white_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath {
            identifiers: Identifiers {
                id: 81,
                label: "delayed decomposed white".to_string(),
                ..Default::default()
            },
            interpolation_space: ColorInterpolationSpace::Rgb,
            hue_direction: HueDirection::Shortest,
            timing: ColorPathTiming {
                attributes: HashMap::from([(
                    Attribute::White,
                    ColorAttributeTiming {
                        delay_percent: 0.75,
                        time_percent: 0.25,
                        curve: FadeCurve::Linear,
                    },
                )]),
                ..Default::default()
            },
            curve: FadeCurve::Linear,
        })
        .expect("custom RGBW decomposition timing color path should be added");

    let (fixture_ref, red_parameter, green_parameter, blue_parameter, white_parameter) =
        add_rgbw_fixture(app.world_mut(), 730);
    let red_cue_uid = Uuid::new_v4();
    let white_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red rgbw",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let white_cue = rgb_cue(
        2,
        white_cue_uid,
        "white delayed decomposition",
        fixture_ref,
        ColorPathRgb {
            red: 1.0,
            green: 1.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(81)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(white_cue).unwrap();
    }

    let sequence = build_sequence(
        "rgbw delayed decomposition timing",
        vec![red_cue_uid.into(), white_cue_uid.into()],
    );
    let mut msequence = materialize_sequence_with_color_paths(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    assert_eq!(
        midpoint_layer.absolute.get(&red_parameter).copied(),
        Some(255.0),
        "red should remain full while delayed white has not started"
    );
    let green = *midpoint_layer
        .absolute
        .get(&green_parameter)
        .expect("midpoint should retain green residual");
    let blue = *midpoint_layer
        .absolute
        .get(&blue_parameter)
        .expect("midpoint should retain blue residual");
    assert!(
        (120.0..=140.0).contains(&green),
        "green residual should stay on RGB while white is delayed, got {green}"
    );
    assert!(
        (120.0..=140.0).contains(&blue),
        "blue residual should stay on RGB while white is delayed, got {blue}"
    );
    assert_eq!(
        midpoint_layer.absolute.get(&white_parameter).copied(),
        Some(0.0),
        "white should hold its start value until its color path timing begins"
    );

    let completed_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(1500),
        ..Default::default()
    };
    let completed_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&completed_clock));
    assert_eq!(
        completed_layer.absolute.get(&red_parameter).copied(),
        Some(0.0),
        "completed delayed decomposition should leave no red residual"
    );
    assert_eq!(
        completed_layer.absolute.get(&green_parameter).copied(),
        Some(0.0),
        "completed delayed decomposition should leave no green residual"
    );
    assert_eq!(
        completed_layer.absolute.get(&blue_parameter).copied(),
        Some(0.0),
        "completed delayed decomposition should leave no blue residual"
    );
    assert_eq!(
        completed_layer.absolute.get(&white_parameter).copied(),
        Some(255.0),
        "completed delayed decomposition should emit full white"
    );
}

/// Verifies scalar color emitters can be path-driven without an RGB or CMY vector.
#[test]
fn sequence_scalar_color_path_applies_emitter_timing_without_rgb_vector() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath {
            identifiers: Identifiers {
                id: 80,
                label: "delayed scalar white".to_string(),
                ..Default::default()
            },
            interpolation_space: ColorInterpolationSpace::Rgb,
            hue_direction: HueDirection::Shortest,
            timing: ColorPathTiming {
                attributes: HashMap::from([(
                    Attribute::White,
                    ColorAttributeTiming {
                        delay_percent: 0.75,
                        time_percent: 0.25,
                        curve: FadeCurve::Linear,
                    },
                )]),
                ..Default::default()
            },
            curve: FadeCurve::Linear,
        })
        .expect("custom scalar timing color path should be added");

    let (fixture_ref, white_parameter) =
        add_single_parameter_fixture(app.world_mut(), 728, Attribute::White);
    app.world_mut()
        .get_mut::<Parameter>(white_parameter.entity())
        .expect("white parameter should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;
    let white_on_uid = Uuid::new_v4();
    let white_off_uid = Uuid::new_v4();
    let white_on = cue_with_parameter(
        1,
        white_on_uid,
        "white on",
        fixture_ref.clone(),
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition::default(),
    );
    let mut white_off = cue_with_parameter(
        2,
        white_off_uid,
        "white off path",
        fixture_ref,
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
    );
    white_off.instructions[0].cue_instruction.color_path_id = Some(ColorPathId(80));

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(white_on).unwrap();
        cue_data_provider.add(white_off).unwrap();
    }

    let sequence = build_sequence(
        "scalar color path emitter timing",
        vec![white_on_uid.into(), white_off_uid.into()],
    );
    let mut msequence = materialize_sequence_with_color_paths(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    assert_eq!(
        midpoint_layer.absolute.get(&white_parameter).copied(),
        Some(255.0),
        "white should hold its start value until scalar color path emitter delay has elapsed"
    );

    let completed_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(1500),
        ..Default::default()
    };
    let completed_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&completed_clock));
    assert_eq!(
        completed_layer.absolute.get(&white_parameter).copied(),
        Some(0.0),
        "white should reach its destination after scalar color path timing completes"
    );
}

/// Verifies assigned color paths derive subtractive CMY emitter values at render time.
#[test]
fn sequence_cmy_color_path_uses_grouped_hsv_midpoint() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, cyan_parameter, magenta_parameter, yellow_parameter) =
        add_cmy_fixture(app.world_mut(), 726);
    let cyan_cue_uid = Uuid::new_v4();
    let yellow_cue_uid = Uuid::new_v4();
    let cyan_cue = cmy_cue(
        1,
        cyan_cue_uid,
        "cyan",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let yellow_cue = cmy_cue(
        2,
        yellow_cue_uid,
        "yellow via hsv",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(2)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cyan_cue).unwrap();
        cue_data_provider.add(yellow_cue).unwrap();
    }

    let sequence = build_sequence(
        "cmy hsv color path",
        vec![cyan_cue_uid.into(), yellow_cue_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    let cyan = *midpoint_layer
        .absolute
        .get(&cyan_parameter)
        .expect("CMY color path midpoint should assert cyan");
    let magenta = *midpoint_layer
        .absolute
        .get(&magenta_parameter)
        .expect("CMY color path midpoint should assert magenta");
    let yellow = *midpoint_layer
        .absolute
        .get(&yellow_parameter)
        .expect("CMY color path midpoint should assert yellow");

    assert!(
        cyan > 240.0,
        "CMY HSV midpoint should keep cyan high to pass through green, got {cyan}"
    );
    assert!(
        magenta < 10.0,
        "CMY HSV midpoint should avoid magenta on the cyan-yellow route, got {magenta}"
    );
    assert!(
        yellow > 240.0,
        "CMY HSV midpoint should keep yellow high to pass through green, got {yellow}"
    );
}

/// Verifies RGB fades without a color path retain native per-emitter interpolation.
#[test]
fn sequence_rgb_without_color_path_uses_native_interpolation() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 724);
    let red_cue_uid = Uuid::new_v4();
    let blue_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let blue_cue = rgb_cue(
        2,
        blue_cue_uid,
        "blue native",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        None,
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(blue_cue).unwrap();
    }

    let sequence = build_sequence(
        "native color fade",
        vec![red_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));

    assert_eq!(
        midpoint_layer.absolute.get(&red_parameter).copied(),
        Some(127.5)
    );
    assert_eq!(
        midpoint_layer.absolute.get(&green_parameter).copied(),
        Some(0.0)
    );
    assert_eq!(
        midpoint_layer.absolute.get(&blue_parameter).copied(),
        Some(127.5)
    );
}

/// Verifies the same destination cue recomputes its path from the actual start color.
#[test]
fn sequence_rgb_color_path_recomputes_when_start_color_changes() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 725);
    let red_cue_uid = Uuid::new_v4();
    let green_cue_uid = Uuid::new_v4();
    let blue_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red start",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let green_cue = rgb_cue(
        2,
        green_cue_uid,
        "green start",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 0.0,
            green: 1.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let blue_cue = rgb_cue(
        3,
        blue_cue_uid,
        "same blue destination",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(2)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(green_cue).unwrap();
        cue_data_provider.add(blue_cue).unwrap();
    }

    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };

    let red_start_sequence = build_sequence(
        "red start color path",
        vec![red_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut red_start = materialize_sequence(&mut app, &red_start_sequence);
    let _ = render_sequence_layer_at_clock(&mut app, &mut red_start, Some(&settled_clock));
    red_start.next_at_playback_position(Some(settled_clock.position));
    let red_start_midpoint =
        render_sequence_layer_at_clock(&mut app, &mut red_start, Some(&midpoint_clock));

    assert!(
        red_start_midpoint
            .absolute
            .get(&red_parameter)
            .copied()
            .unwrap_or_default()
            > 240.0,
        "red-start path should pass through magenta"
    );
    assert!(
        red_start_midpoint
            .absolute
            .get(&green_parameter)
            .copied()
            .unwrap_or_default()
            < 10.0,
        "red-start path should avoid green"
    );
    assert!(
        red_start_midpoint
            .absolute
            .get(&blue_parameter)
            .copied()
            .unwrap_or_default()
            > 240.0,
        "red-start path should keep blue high"
    );

    let green_start_sequence = build_sequence(
        "green start color path",
        vec![green_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut green_start = materialize_sequence(&mut app, &green_start_sequence);
    let _ = render_sequence_layer_at_clock(&mut app, &mut green_start, Some(&settled_clock));
    green_start.next_at_playback_position(Some(settled_clock.position));
    let green_start_midpoint =
        render_sequence_layer_at_clock(&mut app, &mut green_start, Some(&midpoint_clock));

    assert!(
        green_start_midpoint
            .absolute
            .get(&red_parameter)
            .copied()
            .unwrap_or_default()
            < 10.0,
        "green-start path should avoid red"
    );
    assert!(
        green_start_midpoint
            .absolute
            .get(&green_parameter)
            .copied()
            .unwrap_or_default()
            > 240.0,
        "green-start path should keep green high"
    );
    assert!(
        green_start_midpoint
            .absolute
            .get(&blue_parameter)
            .copied()
            .unwrap_or_default()
            > 240.0,
        "green-start path should keep blue high"
    );
}

/// Verifies materialized sequences resolve custom color path definitions by ID.
#[test]
fn sequence_rgb_color_path_resolves_custom_showfile_path() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath {
            identifiers: Identifiers {
                id: 42,
                label: "clockwise hsv".to_string(),
                ..Default::default()
            },
            interpolation_space: ColorInterpolationSpace::Hsv,
            hue_direction: HueDirection::Clockwise,
            timing: ColorPathTiming::default(),
            curve: FadeCurve::Linear,
        })
        .expect("custom color path should be added");

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 719);
    let red_cue_uid = Uuid::new_v4();
    let blue_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let blue_cue = rgb_cue(
        2,
        blue_cue_uid,
        "blue clockwise",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(42)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(blue_cue).unwrap();
    }

    let sequence = build_sequence(
        "custom hsv color path",
        vec![red_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut msequence = materialize_sequence_with_color_paths(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    let red = *midpoint_layer
        .absolute
        .get(&red_parameter)
        .expect("custom path midpoint should assert red");
    let green = *midpoint_layer
        .absolute
        .get(&green_parameter)
        .expect("custom path midpoint should assert green");
    let blue = *midpoint_layer
        .absolute
        .get(&blue_parameter)
        .expect("custom path midpoint should assert blue");

    assert!(
        red < 10.0,
        "clockwise HSV midpoint should avoid red, got {red}"
    );
    assert!(
        green > 240.0,
        "clockwise HSV midpoint should pass through green, got {green}"
    );
    assert!(
        blue < 10.0,
        "clockwise HSV midpoint should avoid blue, got {blue}"
    );
}

/// Verifies emitter timing can delay an individual color emitter while the path continues.
#[test]
fn sequence_rgb_color_path_applies_emitter_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath {
            identifiers: Identifiers {
                id: 78,
                label: "delayed green rgb".to_string(),
                ..Default::default()
            },
            interpolation_space: ColorInterpolationSpace::Rgb,
            hue_direction: HueDirection::Shortest,
            timing: ColorPathTiming {
                attributes: HashMap::from([(
                    Attribute::Green,
                    ColorAttributeTiming {
                        delay_percent: 0.5,
                        time_percent: 0.5,
                        curve: FadeCurve::Linear,
                    },
                )]),
                ..Default::default()
            },
            curve: FadeCurve::Linear,
        })
        .expect("custom emitter timing color path should be added");

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 723);
    let red_cue_uid = Uuid::new_v4();
    let green_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let green_cue = rgb_cue(
        2,
        green_cue_uid,
        "delayed green",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 1.0,
            blue: 0.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(78)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(green_cue).unwrap();
    }

    let sequence = build_sequence(
        "color path emitter timing",
        vec![red_cue_uid.into(), green_cue_uid.into()],
    );
    let mut msequence = materialize_sequence_with_color_paths(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));

    assert_eq!(
        midpoint_layer.absolute.get(&red_parameter).copied(),
        Some(127.5)
    );
    assert_eq!(
        midpoint_layer.absolute.get(&green_parameter).copied(),
        Some(0.0)
    );
    assert_eq!(
        midpoint_layer.absolute.get(&blue_parameter).copied(),
        Some(0.0)
    );
}

/// Verifies fixture color path defaults apply when a cue has no explicit path.
#[test]
fn sequence_rgb_color_path_uses_fixture_default() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 720);
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .set_color_path_default(
            FixtureRef {
                fixture_uid: fixture_ref.fixture_uid,
                index: None,
            },
            Some(ColorPathId(2)),
        );

    let red_cue_uid = Uuid::new_v4();
    let blue_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let blue_cue = rgb_cue(
        2,
        blue_cue_uid,
        "blue via default hsv",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        None,
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(blue_cue).unwrap();
    }

    let sequence = build_sequence(
        "fixture default color path",
        vec![red_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    let red = *midpoint_layer
        .absolute
        .get(&red_parameter)
        .expect("default color path midpoint should assert red");
    let green = *midpoint_layer
        .absolute
        .get(&green_parameter)
        .expect("default color path midpoint should assert green");
    let blue = *midpoint_layer
        .absolute
        .get(&blue_parameter)
        .expect("default color path midpoint should assert blue");

    assert!(
        red > 240.0,
        "HSV default midpoint should stay red-heavy, got {red}"
    );
    assert!(
        green < 10.0,
        "HSV default midpoint should avoid green, got {green}"
    );
    assert!(
        blue > 240.0,
        "HSV default midpoint should be blue-heavy, got {blue}"
    );
}

/// Verifies explicit cue color paths override fixture color path defaults.
#[test]
fn sequence_rgb_color_path_explicit_assignment_overrides_fixture_default() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<ColorPath>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath {
            identifiers: Identifiers {
                id: 42,
                label: "clockwise default".to_string(),
                ..Default::default()
            },
            interpolation_space: ColorInterpolationSpace::Hsv,
            hue_direction: HueDirection::Clockwise,
            timing: ColorPathTiming::default(),
            curve: FadeCurve::Linear,
        })
        .expect("custom default color path should be added");

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 721);
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .set_color_path_default(
            FixtureRef {
                fixture_uid: fixture_ref.fixture_uid,
                index: None,
            },
            Some(ColorPathId(42)),
        );

    let red_cue_uid = Uuid::new_v4();
    let blue_cue_uid = Uuid::new_v4();
    let red_cue = rgb_cue(
        1,
        red_cue_uid,
        "red",
        fixture_ref.clone(),
        ColorPathRgb {
            red: 1.0,
            green: 0.0,
            blue: 0.0,
        },
        PartialTransition::default(),
        None,
    );
    let blue_cue = rgb_cue(
        2,
        blue_cue_uid,
        "blue via explicit hsv",
        fixture_ref,
        ColorPathRgb {
            red: 0.0,
            green: 0.0,
            blue: 1.0,
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        Some(ColorPathId(2)),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(red_cue).unwrap();
        cue_data_provider.add(blue_cue).unwrap();
    }

    let sequence = build_sequence(
        "explicit color path overrides default",
        vec![red_cue_uid.into(), blue_cue_uid.into()],
    );
    let mut msequence = materialize_sequence_with_color_paths(&mut app, &sequence);
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(settled_clock.position));

    let midpoint_clock = InstanceClock {
        position: settled_clock.position + Duration::from_millis(500),
        ..Default::default()
    };
    let midpoint_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&midpoint_clock));
    let red = *midpoint_layer
        .absolute
        .get(&red_parameter)
        .expect("explicit color path midpoint should assert red");
    let green = *midpoint_layer
        .absolute
        .get(&green_parameter)
        .expect("explicit color path midpoint should assert green");
    let blue = *midpoint_layer
        .absolute
        .get(&blue_parameter)
        .expect("explicit color path midpoint should assert blue");

    assert!(
        red > 240.0,
        "explicit HSV midpoint should stay red-heavy, got {red}"
    );
    assert!(
        green < 10.0,
        "explicit HSV should override green clockwise default, got {green}"
    );
    assert!(
        blue > 240.0,
        "explicit HSV midpoint should be blue-heavy, got {blue}"
    );
}

/// Starts sequence release using the frozen rendered output path.
fn release_sequence_preserving_look(app: &mut App, msequence: &mut MaterializedSequence) {
    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, parameter_query) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");
    msequence.release_from_rendered_assertions(&fixture_data_provider, &parameter_query);
}

/// Verifies cues with tracking disabled do not carry their values into later sequence cues.
#[test]
fn cue_with_tracking_none_does_not_track_values_into_next_cue() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 701, Attribute::Intensity);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();
    let cue_3_uid = Uuid::new_v4();

    let cue_1 = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_1_uid,
            label: "empty before".to_string(),
        },
        ..Default::default()
    };
    let mut cue_2 = cue_with_parameter(
        2,
        cue_2_uid,
        "tracking none intensity",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    cue_2.tracking_mode = Some(TrackingMode::Flags(TrackingFlags::from(0)));
    let cue_3 = Cue {
        identifiers: Identifiers {
            id: 3,
            uid: cue_3_uid,
            label: "empty after".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
        cue_data_provider.add(cue_3).unwrap();
    }

    let sequence = build_sequence(
        "tracking none sequence",
        vec![cue_1_uid.into(), cue_2_uid.into(), cue_3_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.set_position(2);
    let cue_2_layer = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        cue_2_layer.absolute.get(&parameter),
        Some(&200.0),
        "cue 2 should still output its own value while it is the active cue"
    );

    msequence.set_position(3);
    let cue_3_layer = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        cue_3_layer.absolute.get(&parameter),
        None,
        "cue 2 value should not remain tracked into cue 3 when cue 2 tracking is none"
    );
}

/// Verifies cues without a stored tracking mode preserve legacy tracking flag behavior.
#[test]
fn cue_without_tracking_mode_uses_legacy_tracking_flags() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 703, Attribute::Intensity);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();

    let mut cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "legacy tracking none intensity",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    cue_1.tracking_flags = TrackingFlags::from(0);
    cue_1.tracking_mode = None;
    let cue_2 = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_2_uid,
            label: "empty after legacy tracking".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }

    let sequence = build_sequence(
        "legacy cue tracking flags",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.set_position(1);
    let cue_1_layer = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        cue_1_layer.absolute.get(&parameter),
        Some(&200.0),
        "legacy cue should output its own value while active"
    );

    msequence.set_position(2);
    let cue_2_layer = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        cue_2_layer.absolute.get(&parameter),
        None,
        "missing tracking mode should preserve legacy tracking_flags behavior"
    );
}

/// Verifies sequence cues inherit tracking behavior from the owning sequence by default.
#[test]
fn sequence_cue_default_tracking_mode_inherits_sequence_tracking_mode() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 702, Attribute::Intensity);
    let cue_1_uid = Uuid::new_v4();
    let cue_2_uid = Uuid::new_v4();

    let mut cue_1 = cue_with_parameter(
        1,
        cue_1_uid,
        "inherited intensity tracking",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    cue_1.tracking_mode = Some(TrackingMode::Inherit);
    let cue_2 = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_2_uid,
            label: "empty after inherited tracking".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_1).unwrap();
        cue_data_provider.add(cue_2).unwrap();
    }

    let mut sequence = build_sequence(
        "sequence tracking mode",
        vec![cue_1_uid.into(), cue_2_uid.into()],
    );
    sequence.tracking_mode = TrackingMode::Flags(TrackingFlags::LTP);
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.set_position(1);
    let cue_1_layer = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        cue_1_layer.absolute.get(&parameter),
        Some(&200.0),
        "cue 1 should output its own value while it is active"
    );

    msequence.set_position(2);
    let cue_2_layer = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        cue_2_layer.absolute.get(&parameter),
        None,
        "inherited sequence tracking should prevent HTP values from tracking"
    );
}

#[test]
fn test_materialize_sequence_skips_missing_cues() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let missing_uid = Uuid::new_v4();
    let sequence = build_sequence("seq missing", vec![missing_uid.into()]);

    let mut system_state = SystemState::<(
        Res<DataProvider<Cue>>,
        Res<FixtureDataProviderExt>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (cue_data_provider, fixture_data_provider, selection_resolver, parameter_query) =
        system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");

    let msequence = MaterializedSequence::materialize(
        &sequence,
        &cue_data_provider,
        &fixture_data_provider,
        &parameter_query,
        &selection_resolver,
    );

    assert!(msequence.mcues.is_empty());
}

#[test]
fn test_materialize_sequence_filters_missing_cues_preserving_order() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let missing_uid = Uuid::new_v4();
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_uid,
            label: "cue 2".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue.clone()).unwrap();
    }

    let sequence = build_sequence("seq mixed", vec![missing_uid.into(), cue_uid.into()]);

    let mut system_state = SystemState::<(
        Res<DataProvider<Cue>>,
        Res<FixtureDataProviderExt>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (cue_data_provider, fixture_data_provider, selection_resolver, parameter_query) =
        system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");

    let msequence = MaterializedSequence::materialize(
        &sequence,
        &cue_data_provider,
        &fixture_data_provider,
        &parameter_query,
        &selection_resolver,
    );

    assert_eq!(msequence.mcues.len(), 1);
    assert_eq!(msequence.current().identifiers.uid, cue_uid);
}

/// Verifies wrapped sequences use the last cue as the tracking base for the first cue.
#[test]
fn wrapped_sequence_tracks_values_through_loop_boundary() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 602, Attribute::Tilt);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let tilt_value = ParameterValue::AbsolutePercent { value: 0.7.into() };
    let transition = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let cue_one = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_one_uid,
            label: "tilt first".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(Attribute::Tilt, ValueSource::Inline(tilt_value))]),
                transitions: transition.clone(),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let cue_two = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_two_uid,
            label: "tilt second".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(Attribute::Tilt, ValueSource::Inline(tilt_value))]),
                transitions: transition.clone(),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence("wrapped tilt", vec![cue_one_uid.into(), cue_two_uid.into()]);
    sequence.wrap = true;
    let mut msequence = {
        let mut system_state = SystemState::<(
            Res<DataProvider<Cue>>,
            Res<FixtureDataProviderExt>,
            SpatialSelectionResolver,
            Query<InstanceRef<Parameter>>,
        )>::new(app.world_mut());
        let (cue_data_provider, fixture_data_provider, selection_resolver, parameter_query) =
            system_state
                .get(app.world_mut())
                .expect("test system parameters should be available");

        MaterializedSequence::materialize(
            &sequence,
            &cue_data_provider,
            &fixture_data_provider,
            &parameter_query,
            &selection_resolver,
        )
    };

    msequence.set_position_at_playback_position(2, Some(Duration::ZERO));
    let settled_clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    msequence.next_at_playback_position(Some(Duration::from_secs(10)));

    let expected = app
        .world()
        .get::<Parameter>(parameter.entity())
        .expect("parameter should exist")
        .resolve_value(&tilt_value);
    let wrapped_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&settled_clock));
    let wrapped_value = wrapped_layer
        .absolute
        .get(&parameter)
        .expect("wrapped cue should assert tilt");
    assert_eq!(
        *wrapped_value, expected,
        "wrapping from a cue with the same tilt should not fade through default"
    );
}

/// Verifies untracked cue values do not become the wrap base for cue 1.
#[test]
fn wrapped_sequence_does_not_track_none_values_through_loop_boundary() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 713, Attribute::Blue);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_one_uid,
            label: "empty first".to_string(),
        },
        ..Default::default()
    };
    let mut cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "untracked blue",
        fixture_ref,
        Attribute::Blue,
        ParameterValue::Absolute { value: 255.0 },
        PartialTransition::default(),
    );
    cue_two.tracking_mode = Some(TrackingMode::Flags(TrackingFlags::from(0)));

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence(
        "wrapped untracked blue",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.next();
    let cue_two_layer = render_sequence_layer(&mut app, &mut msequence);
    assert!(
        cue_two_layer.absolute.contains_key(&parameter),
        "cue 2 should still output blue while it is active"
    );

    msequence.next();
    let wrapped_layer = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        wrapped_layer.absolute.get(&parameter),
        None,
        "cue 2 blue should not remain active after wrapping to cue 1 when cue 2 tracking is none"
    );
}

/// Verifies advancing through wrap-enabled relative color cues does not double tracked values.
#[test]
fn wrapped_sequence_relative_color_cues_do_not_accumulate_previous_values() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 715);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_three_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "relative red",
        fixture_ref.clone(),
        Attribute::Red,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        PartialTransition::default(),
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "relative green",
        fixture_ref.clone(),
        Attribute::Green,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        PartialTransition::default(),
    );
    let cue_three = cue_with_parameter(
        3,
        cue_three_uid,
        "relative blue",
        fixture_ref,
        Attribute::Blue,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        PartialTransition::default(),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
        cue_data_provider.add(cue_three).unwrap();
    }

    let mut sequence = build_sequence(
        "wrapped relative rgb",
        vec![cue_one_uid.into(), cue_two_uid.into(), cue_three_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let cue_one_layer = render_sequence_layer(&mut app, &mut msequence);
    let cue_one_red = *cue_one_layer
        .relative
        .get(&red_parameter)
        .expect("cue 1 should assert red");
    assert!(
        (-130.0..=-125.0).contains(&cue_one_red),
        "cue 1 should assert a half negative red value, got {cue_one_red}"
    );

    msequence.next();
    let cue_two_layer = render_sequence_layer(&mut app, &mut msequence);
    let cue_two_red = *cue_two_layer
        .relative
        .get(&red_parameter)
        .expect("cue 2 should keep tracked red");
    let cue_two_green = *cue_two_layer
        .relative
        .get(&green_parameter)
        .expect("cue 2 should assert green");

    assert!(
        (-130.0..=-125.0).contains(&cue_two_red),
        "cue 2 should keep red at one tracked half-step, got {cue_two_red}"
    );
    assert!(
        (-130.0..=-125.0).contains(&cue_two_green),
        "cue 2 should assert one green half-step, got {cue_two_green}"
    );
    assert_eq!(
        cue_two_layer.relative.get(&blue_parameter),
        None,
        "cue 2 should not assert blue before cue 3"
    );

    msequence.next();
    let cue_three_layer = render_sequence_layer(&mut app, &mut msequence);
    let cue_three_red = *cue_three_layer
        .relative
        .get(&red_parameter)
        .expect("cue 3 should keep tracked red");
    let cue_three_green = *cue_three_layer
        .relative
        .get(&green_parameter)
        .expect("cue 3 should keep tracked green");
    let cue_three_blue = *cue_three_layer
        .relative
        .get(&blue_parameter)
        .expect("cue 3 should assert blue");
    assert!(
        (-130.0..=-125.0).contains(&cue_three_red),
        "cue 3 should keep red at one tracked half-step, got {cue_three_red}"
    );
    assert!(
        (-130.0..=-125.0).contains(&cue_three_green),
        "cue 3 should keep green at one tracked half-step, got {cue_three_green}"
    );
    assert!(
        (-130.0..=-125.0).contains(&cue_three_blue),
        "cue 3 should assert one blue half-step, got {cue_three_blue}"
    );

    msequence.next();
    let wrapped_cue_one_layer = render_sequence_layer(&mut app, &mut msequence);
    assert!(
        wrapped_cue_one_layer.relative.contains_key(&red_parameter),
        "wrapped cue 1 should still assert red"
    );
    assert!(
        wrapped_cue_one_layer
            .relative
            .contains_key(&green_parameter),
        "wrapped cue 1 should keep tracked green"
    );
    assert!(
        wrapped_cue_one_layer.relative.contains_key(&blue_parameter),
        "wrapped cue 1 should keep tracked blue"
    );

    msequence.next();
    let wrapped_cue_two_layer = render_sequence_layer(&mut app, &mut msequence);
    assert!(
        wrapped_cue_two_layer.relative.contains_key(&red_parameter),
        "wrapped cue 2 should keep tracked red"
    );
    assert!(
        wrapped_cue_two_layer
            .relative
            .contains_key(&green_parameter),
        "wrapped cue 2 should assert green"
    );
    assert!(
        wrapped_cue_two_layer.relative.contains_key(&blue_parameter),
        "wrapped cue 2 should keep tracked blue from the previous cycle"
    );
}

/// Verifies rapid wrap playback derives transition bases from retained sequence order.
#[test]
fn wrapped_sequence_uses_retained_order_when_wrapping_mid_fade() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 716);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_three_uid = Uuid::new_v4();
    let fade = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "relative red fade",
        fixture_ref.clone(),
        Attribute::Red,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        fade.clone(),
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "relative green fade",
        fixture_ref.clone(),
        Attribute::Green,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        fade.clone(),
    );
    let cue_three = cue_with_parameter(
        3,
        cue_three_uid,
        "relative blue fade",
        fixture_ref,
        Attribute::Blue,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        fade,
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
        cue_data_provider.add(cue_three).unwrap();
    }

    let mut sequence = build_sequence(
        "rapid wrapped relative rgb",
        vec![cue_one_uid.into(), cue_two_uid.into(), cue_three_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let mut clock = InstanceClock {
        position: Duration::from_secs(10),
        ..Default::default()
    };
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));

    msequence.next_at_playback_position(Some(clock.position));
    clock.position += Duration::from_millis(100);
    let _ = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));

    msequence.next_at_playback_position(Some(clock.position));
    clock.position += Duration::from_millis(100);
    let cue_three_layer = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));
    let in_flight_blue = *cue_three_layer
        .relative
        .get(&blue_parameter)
        .expect("cue 3 should assert in-flight blue");
    assert!(
        (-20.0..0.0).contains(&in_flight_blue),
        "cue 3 should still be fading blue before wrap, got {in_flight_blue}"
    );

    msequence.next_at_playback_position(Some(clock.position));
    let wrapped_cue_one_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));
    let wrapped_red = *wrapped_cue_one_layer
        .relative
        .get(&red_parameter)
        .expect("wrapped cue 1 should assert red");
    let wrapped_green = *wrapped_cue_one_layer
        .relative
        .get(&green_parameter)
        .expect("wrapped cue 1 should keep tracked green");
    let wrapped_blue = *wrapped_cue_one_layer
        .relative
        .get(&blue_parameter)
        .expect("wrapped cue 1 should keep visible blue in flight");

    assert!(
        (-1.0..=1.0).contains(&wrapped_red),
        "wrapped cue 1 should start its new transition from the deterministic retained base, got {wrapped_red}"
    );
    assert!(
        (-30.0..-20.0).contains(&wrapped_green),
        "wrapped cue 1 should keep visible green 200 ms into its fade instead of snapping to the target, got {wrapped_green}"
    );
    assert!(
        (-20.0..0.0).contains(&wrapped_blue),
        "wrapped cue 1 should keep visible blue in flight instead of snapping to the target, got {wrapped_blue}"
    );

    msequence.next_at_playback_position(Some(clock.position));
    clock.position += Duration::from_millis(100);
    let second_cycle_cue_two_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));
    let second_cycle_red = *second_cycle_cue_two_layer
        .relative
        .get(&red_parameter)
        .expect("second-cycle cue 2 should keep tracked red");
    let second_cycle_green = *second_cycle_cue_two_layer
        .relative
        .get(&green_parameter)
        .expect("second-cycle cue 2 should keep green transition in flight");
    let second_cycle_blue = *second_cycle_cue_two_layer
        .relative
        .get(&blue_parameter)
        .expect("second-cycle cue 2 should keep visible blue in flight");

    assert!(
        (-15.0..=-10.0).contains(&second_cycle_red),
        "second-cycle cue 2 should keep red from the retained sequence order, got {second_cycle_red}"
    );
    assert!(
        (-15.0..=-10.0).contains(&second_cycle_green),
        "second-cycle cue 2 should restart green from the retained sequence order, got {second_cycle_green}"
    );
    assert!(
        (-30.0..-20.0).contains(&second_cycle_blue),
        "second-cycle cue 2 should keep visible blue 200 ms into its fade instead of clearing it, got {second_cycle_blue}"
    );
}

/// Verifies an absolute RGB cycle still fades after wrapping and advancing again.
#[test]
fn wrapped_absolute_sequence_keeps_transitioning_after_fifth_go() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, blue_parameter) =
        add_rgb_fixture(app.world_mut(), 717);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_three_uid = Uuid::new_v4();
    let cue_four_uid = Uuid::new_v4();
    let fade = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let make_rgb_cue = |id, uid, label: &str, red: f32, green: f32, blue: f32| Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: fade.clone(),
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: red.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent {
                            value: green.into(),
                        }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: blue.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let cue_one = make_rgb_cue(1, cue_one_uid, "red", 1.0, 0.0, 0.0);
    let cue_two = make_rgb_cue(2, cue_two_uid, "green", 0.0, 1.0, 0.0);
    let cue_three = make_rgb_cue(3, cue_three_uid, "blue", 0.0, 0.0, 1.0);
    let cue_four = make_rgb_cue(4, cue_four_uid, "white", 1.0, 1.0, 1.0);

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
        cue_data_provider.add(cue_three).unwrap();
        cue_data_provider.add(cue_four).unwrap();
    }

    let mut sequence = build_sequence(
        "clip 1 absolute rgb cycle",
        vec![
            cue_one_uid.into(),
            cue_two_uid.into(),
            cue_three_uid.into(),
            cue_four_uid.into(),
        ],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.mcues[0].set_activation_time(Instant::now() - Duration::from_secs(10));
    let _ = render_sequence_layer(&mut app, &mut msequence);

    for index in [1, 2, 3, 0, 1] {
        msequence.next();
        msequence.mcues[index].set_activation_time(Instant::now() - Duration::from_millis(100));
        let _ = render_sequence_layer(&mut app, &mut msequence);
    }

    let fifth_go_layer = render_sequence_layer(&mut app, &mut msequence);
    let red = *fifth_go_layer
        .absolute
        .get(&red_parameter)
        .expect("cue 2 after wrap should include red while fading away");
    let green = *fifth_go_layer
        .absolute
        .get(&green_parameter)
        .expect("cue 2 after wrap should include green while fading in");
    let blue = *fifth_go_layer
        .absolute
        .get(&blue_parameter)
        .expect("cue 2 after wrap should include blue while fading away");

    assert!(
        red > 1.0,
        "fifth go should not snap red to cue 2 target, got {red}"
    );
    assert!(
        (1.0..254.0).contains(&green),
        "fifth go should fade green toward cue 2 target instead of snapping, got {green}"
    );
    assert!(
        blue > 1.0,
        "fifth go should not snap blue to cue 2 target, got {blue}"
    );
}

/// Verifies grouped intensity-only cue-part pulses restart on every repeated hit.
#[test]
fn grouped_intensity_cue_part_pulse_restarts_on_each_timed_hit() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixtures_and_parameters = (3..=10)
        .map(|fixture_id| {
            add_single_parameter_fixture(app.world_mut(), fixture_id, Attribute::Intensity)
        })
        .collect::<Vec<_>>();
    let fixture_refs = fixtures_and_parameters
        .iter()
        .map(|(fixture_ref, _)| fixture_ref.clone())
        .collect::<Vec<_>>();
    let intensity_parameters = fixtures_and_parameters
        .iter()
        .map(|(_, parameter)| *parameter)
        .collect::<Vec<_>>();
    let cue_uids = (0..18).map(|_| Uuid::new_v4()).collect::<Vec<_>>();

    let make_pulse_cue = |id, uid, label: &str| Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_owned(),
        },
        trigger: CueTriggerType::Manual,
        parts: vec![
            nightfall_cues::cue::CuePart {
                identifiers: Identifiers {
                    id: 1,
                    uid: Uuid::new_v4(),
                    label: "Full".to_owned(),
                },
                transitions: PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SelectionExpr::Resolved(fixture_refs.clone()).into(),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::AbsolutePercent {
                                value: 1.0.into(),
                            }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
            nightfall_cues::cue::CuePart {
                identifiers: Identifiers {
                    id: 2,
                    uid: Uuid::new_v4(),
                    label: "Half".to_owned(),
                },
                transitions: PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SelectionExpr::Resolved(fixture_refs.clone()).into(),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::AbsolutePercent {
                                value: 0.6.into(),
                            }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
        ],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for (index, uid) in cue_uids.iter().copied().enumerate() {
            cue_data_provider
                .add(make_pulse_cue(
                    index as u32 + 1,
                    uid,
                    &format!("hit {}", index + 1),
                ))
                .unwrap();
        }
    }

    let mut sequence = build_sequence(
        "grouped intensity hits",
        cue_uids.iter().copied().map(Into::into).collect(),
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    for hit_index in 0..cue_uids.len() {
        if hit_index > 0 {
            msequence
                .next_at_playback_position(Some(Duration::from_millis(hit_index as u64 * 1000)));
        }
        let clock = InstanceClock {
            position: Duration::from_millis(hit_index as u64 * 1000 + 250),
            ..Default::default()
        };
        let layer = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));
        for parameter in &intensity_parameters {
            let value = *layer
                .absolute
                .get(parameter)
                .expect("grouped hit should assert intensity");
            assert!(
                (200.0..=210.0).contains(&value),
                "hit {} should restart the 100% to 60% pulse midpoint, got {value}",
                hit_index + 1
            );
        }
    }

    msequence.next_at_playback_position(Some(Duration::from_millis(18_000)));
    let wrapped_clock = InstanceClock {
        position: Duration::from_millis(18_250),
        ..Default::default()
    };
    let wrapped_layer =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&wrapped_clock));
    for parameter in &intensity_parameters {
        let value = *wrapped_layer
            .absolute
            .get(parameter)
            .expect("wrapped hit should assert intensity");
        assert!(
            (200.0..=210.0).contains(&value),
            "wrapped hit should restart the 100% to 60% pulse midpoint, got {value}"
        );
    }
}

/// Verifies cue 1 keeps fading from the pre-wrap base on later render frames.
#[test]
fn wrapped_sequence_preserves_pre_wrap_base_during_multi_frame_fade() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 603, Attribute::Tilt);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one_value = ParameterValue::AbsolutePercent { value: 0.8.into() };
    let cue_two_value = ParameterValue::AbsolutePercent { value: 0.2.into() };
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "tilt first",
        fixture_ref.clone(),
        Attribute::Tilt,
        cue_one_value,
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "tilt second",
        fixture_ref,
        Attribute::Tilt,
        cue_two_value,
        Default::default(),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence("wrapped tilt", vec![cue_one_uid.into(), cue_two_uid.into()]);
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.set_position(2);
    let _ = render_sequence_layer(&mut app, &mut msequence);
    msequence.next();

    msequence.mcues[0].set_activation_time(Instant::now() - Duration::from_millis(500));
    let first_frame = render_sequence_layer(&mut app, &mut msequence);
    msequence.mcues[0].set_activation_time(Instant::now() - Duration::from_millis(500));
    let second_frame = render_sequence_layer(&mut app, &mut msequence);

    let parameter_component = app
        .world()
        .get::<Parameter>(parameter.entity())
        .expect("parameter should exist");
    let base = parameter_component.resolve_value(&cue_two_value);
    let target = parameter_component.resolve_value(&cue_one_value);
    let expected = (base + target) / 2.0;
    let first_value = first_frame
        .absolute
        .get(&parameter)
        .expect("first frame should assert tilt");
    let second_value = second_frame
        .absolute
        .get(&parameter)
        .expect("second frame should assert tilt");

    assert!(
        (*first_value - expected).abs() < 2.0,
        "first frame should fade from the pre-wrap base"
    );
    assert!(
        (*second_value - expected).abs() < 2.0,
        "second frame should not use the partially faded first frame as its base"
    );
}

/// Verifies skipped zero-duration wrap cues still establish the next cue's transition base.
#[test]
fn wrapped_zero_duration_cue_tracks_into_immediate_follow_previous_transition() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 718, Attribute::White);
    app.world_mut()
        .get_mut::<Parameter>(parameter.entity())
        .expect("white parameter should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let mut cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "wrapped white on",
        fixture_ref.clone(),
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition::default(),
    );
    cue_one.trigger = CueTriggerType::AfterDelay(Duration::from_millis(100));
    let mut cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "wrapped white off",
        fixture_ref,
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
    );
    cue_two.trigger = CueTriggerType::FollowPrevious;

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence(
        "wrapped zero-duration white",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.next_at_playback_position(Some(Duration::ZERO));
    let off_complete_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let off_complete =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&off_complete_clock));
    assert_eq!(
        *off_complete
            .absolute
            .get(&parameter)
            .expect("off cue should assert white"),
        0.0,
        "setup should leave the last rendered look at white off"
    );

    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    assert_eq!(
        msequence.position(),
        2,
        "test should simulate autonomous catch-up through the zero-duration wrapped cue"
    );

    let one_millisecond_into_off = InstanceClock {
        position: Duration::from_millis(1001),
        ..Default::default()
    };
    let caught_up =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&one_millisecond_into_off));
    let value = *caught_up
        .absolute
        .get(&parameter)
        .expect("caught-up off cue should still assert white");

    assert!(
        value > 250.0,
        "off transition should fade from the skipped wrapped on cue target, got {value}"
    );
}

/// Verifies autonomous wrap catch-up retains a zero-duration cue before its follower renders.
#[test]
fn wrapped_zero_duration_cue_tracks_through_autonomous_catch_up() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 719, Attribute::White);
    app.world_mut()
        .get_mut::<Parameter>(parameter.entity())
        .expect("white parameter should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let mut cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "wrapped white on",
        fixture_ref.clone(),
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition::default(),
    );
    cue_one.trigger = CueTriggerType::AfterDelay(Duration::from_secs(1));
    let mut cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "wrapped white hold",
        fixture_ref,
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
    );
    cue_two.trigger = CueTriggerType::FollowPrevious;

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence(
        "wrapped autonomous zero-duration white",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    sequence.wrap = true;
    let msequence = materialize_sequence(&mut app, &sequence);

    let catch_up_clock = InstanceClock {
        position: Duration::from_millis(1001),
        ..Default::default()
    };
    app.init_resource::<nightfall_compositor::prelude::FinalLayerAttributedAssertions>();
    app.add_systems(
        Update,
        (
            nightfall_cues::materialized_sequence::advance_sequences,
            nightfall_cues::materialized_sequence::paint_materialized_sequences,
            ApplyDeferred,
            nightfall_compositor::prelude::compositor::<Parameter>,
        )
            .chain(),
    );
    let sequence_entity = app
        .world_mut()
        .spawn((
            msequence,
            InstanceId::new(),
            catch_up_clock,
            nightfall_compositor::prelude::ObjectRefMarker(ObjectRef::ByUid {
                object_type: ObjectType::Sequence,
                uid: sequence.identifiers.uid,
            }),
        ))
        .id();
    app.update();

    assert_eq!(
        app.world()
            .get::<MaterializedSequence>(sequence_entity)
            .expect("sequence should remain active")
            .position(),
        2
    );

    let output_layer = app
        .world()
        .get::<nightfall_compositor::prelude::OutputLayer>(sequence_entity)
        .expect("sequence should have painted output");
    let value = *output_layer
        .0
        .absolute
        .get(&parameter)
        .expect("caught-up follower should assert white");

    assert!(
        value > 250.0,
        "follower should render from the retained wrapped cue assertion, got {value}"
    );
}

/// Verifies wrapped autonomous playback advances beyond cue 1 after cycling.
#[test]
fn wrapped_part_timed_sequence_advances_after_returning_to_first_cue() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, _, _, _) = add_moving_fixture(app.world_mut(), 723);
    let transition_duration = Duration::from_secs(1);
    let cue_uids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];

    let make_cue =
        |id: u32, uid: Uuid, label: &str, trigger: CueTriggerType, pan: f32, tilt: f32| Cue {
            identifiers: Identifiers {
                id,
                uid,
                label: label.to_owned(),
            },
            trigger,
            parts: vec![nightfall_cues::cue::CuePart {
                identifiers: Identifiers {
                    id: 1,
                    uid: Uuid::new_v4(),
                    label: "Position".to_owned(),
                },
                transitions_by_attribute: HashMap::from([
                    (
                        Attribute::Pan,
                        PartialTransition {
                            fade_in: Some(TransitionMode::Fixed(transition_duration)),
                            ..Default::default()
                        },
                    ),
                    (
                        Attribute::Tilt,
                        PartialTransition {
                            fade_in: Some(TransitionMode::Fixed(transition_duration)),
                            ..Default::default()
                        },
                    ),
                ]),
                instructions: vec![BoundCueInstruction {
                    selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([
                            (
                                Attribute::Pan,
                                ValueSource::Inline(ParameterValue::AbsolutePercent {
                                    value: pan.into(),
                                }),
                            ),
                            (
                                Attribute::Tilt,
                                ValueSource::Inline(ParameterValue::AbsolutePercent {
                                    value: tilt.into(),
                                }),
                            ),
                        ]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider
            .add(make_cue(
                1,
                cue_uids[0],
                "Cue 1",
                CueTriggerType::AfterDelay(Duration::ZERO),
                0.2,
                0.3,
            ))
            .unwrap();
        cue_data_provider
            .add(make_cue(
                2,
                cue_uids[1],
                "Cue 2",
                CueTriggerType::FollowPrevious,
                0.4,
                0.5,
            ))
            .unwrap();
        cue_data_provider
            .add(make_cue(
                3,
                cue_uids[2],
                "Cue 3",
                CueTriggerType::FollowPrevious,
                0.6,
                0.7,
            ))
            .unwrap();
    }

    let mut sequence = build_sequence(
        "wrapped part-timed positions",
        cue_uids.iter().copied().map(SimpleUuid::from).collect(),
    );
    sequence.wrap = true;
    let msequence = materialize_sequence(&mut app, &sequence);
    assert_eq!(
        msequence.mcues[0].duration_profile().cue_entry_duration(),
        transition_duration,
        "part-layer transition timing should contribute to cue duration"
    );

    app.add_systems(
        Update,
        (
            nightfall_cues::materialized_sequence::advance_sequences,
            ApplyDeferred,
        )
            .chain(),
    );
    let sequence_entity = app
        .world_mut()
        .spawn((msequence, InstanceId::new(), InstanceClock::default()))
        .id();

    let set_clock_and_update = |app: &mut App, position: Duration| {
        app.world_mut()
            .get_mut::<InstanceClock>(sequence_entity)
            .expect("sequence playback clock should exist")
            .seek_to(position);
        app.update();
        app.world()
            .get::<MaterializedSequence>(sequence_entity)
            .expect("sequence should remain active")
            .position()
    };

    assert_eq!(set_clock_and_update(&mut app, transition_duration), 2);
    assert_eq!(set_clock_and_update(&mut app, transition_duration * 2), 3);
    assert_eq!(set_clock_and_update(&mut app, transition_duration * 3), 1);
    assert_eq!(
        set_clock_and_update(&mut app, transition_duration * 4),
        2,
        "wrapped cue 1 should advance to cue 2 after its assertion duration"
    );
}

/// Verifies wrapped HTP off cues use assertion timing after a skipped on cue.
#[test]
fn wrapped_htp_off_cue_fades_from_skipped_on_cue_after_wrap() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 720, Attribute::White);
    app.world_mut()
        .get_mut::<Parameter>(parameter.entity())
        .expect("white parameter should exist")
        .metadata
        .merge_type = MergeStrategy::HTP;
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let mut cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "wrapped white on",
        fixture_ref.clone(),
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition::default(),
    );
    cue_one.trigger = CueTriggerType::AfterDelay(Duration::from_secs(1));
    let mut cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "wrapped white off",
        fixture_ref,
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(414))),
            ..Default::default()
        },
    );
    cue_two.trigger = CueTriggerType::FollowPrevious;

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence(
        "wrapped htp white snap",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.next_at_playback_position(Some(Duration::ZERO));
    let off_complete_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let off_complete =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&off_complete_clock));
    assert_eq!(
        *off_complete
            .absolute
            .get(&parameter)
            .expect("off cue should assert white"),
        0.0,
        "setup should leave the last rendered look at white off"
    );

    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    let caught_up_clock = InstanceClock {
        position: Duration::from_millis(1001),
        ..Default::default()
    };
    let caught_up =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&caught_up_clock));
    let value = *caught_up
        .absolute
        .get(&parameter)
        .expect("caught-up off cue should still assert white");

    assert!(
        value > 250.0,
        "HTP off cue should hold the retained on cue during delay-in, got {value}"
    );
}

/// Verifies explicit zero out timing keeps HTP downward assertions snapping.
#[test]
fn htp_downward_assertion_with_explicit_zero_out_timing_snaps() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 721, Attribute::White);
    app.world_mut()
        .get_mut::<Parameter>(parameter.entity())
        .expect("white parameter should exist")
        .metadata
        .merge_type = MergeStrategy::HTP;
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "white on",
        fixture_ref.clone(),
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition::default(),
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "explicit snap off",
        fixture_ref,
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(414))),
            fade_out: Some(TransitionMode::Fixed(Duration::ZERO)),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let sequence = build_sequence(
        "explicit htp snap",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.next_at_playback_position(Some(Duration::ZERO));
    let clock = InstanceClock {
        position: Duration::from_millis(1),
        ..Default::default()
    };
    let off_layer = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));
    let value = *off_layer
        .absolute
        .get(&parameter)
        .expect("off cue should assert white");

    assert_eq!(
        value, 0.0,
        "explicit zero fade-out should keep HTP downward assertion snapping"
    );
}

/// Verifies explicit out timing on one HTP parameter does not affect another parameter.
#[test]
fn mixed_htp_out_timing_preserves_implicit_parameter_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (implicit_fixture_ref, implicit_parameter) =
        add_single_parameter_fixture(app.world_mut(), 722, Attribute::White);
    let (explicit_fixture_ref, explicit_parameter) =
        add_single_parameter_fixture(app.world_mut(), 723, Attribute::White);
    for parameter in [implicit_parameter, explicit_parameter] {
        app.world_mut()
            .get_mut::<Parameter>(parameter.entity())
            .expect("white parameter should exist")
            .metadata
            .merge_type = MergeStrategy::HTP;
    }

    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let mut cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "mixed white on",
        implicit_fixture_ref.clone(),
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition::default(),
    );
    cue_one.instructions.push(BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![explicit_fixture_ref.clone()]).into(),
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::White,
                ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
            )]),
            transitions: PartialTransition::default(),
            ..Default::default()
        },
    });
    cue_one.trigger = CueTriggerType::AfterDelay(Duration::from_secs(1));

    let mut cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "mixed white off",
        implicit_fixture_ref,
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(414))),
            ..Default::default()
        },
    );
    cue_two.instructions.push(BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![explicit_fixture_ref]).into(),
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::White,
                ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
            )]),
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
                fade_in: Some(TransitionMode::Fixed(Duration::from_millis(414))),
                fade_out: Some(TransitionMode::Fixed(Duration::ZERO)),
                ..Default::default()
            },
            ..Default::default()
        },
    });
    cue_two.trigger = CueTriggerType::FollowPrevious;

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence(
        "mixed htp timing wrap",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.next_at_playback_position(Some(Duration::ZERO));
    let off_complete_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let off_complete =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&off_complete_clock));
    assert_eq!(
        *off_complete
            .absolute
            .get(&implicit_parameter)
            .expect("implicit fixture should assert white off"),
        0.0
    );
    assert_eq!(
        *off_complete
            .absolute
            .get(&explicit_parameter)
            .expect("explicit fixture should assert white off"),
        0.0
    );

    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    let caught_up_clock = InstanceClock {
        position: Duration::from_millis(1001),
        ..Default::default()
    };
    let caught_up =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&caught_up_clock));
    let implicit_value = *caught_up
        .absolute
        .get(&implicit_parameter)
        .expect("implicit fixture should hold retained white on");
    let explicit_value = *caught_up
        .absolute
        .get(&explicit_parameter)
        .expect("explicit fixture should snap white off");

    assert!(
        implicit_value > 250.0,
        "implicit HTP off timing should hold retained on value, got {implicit_value}"
    );
    assert_eq!(
        explicit_value, 0.0,
        "explicit HTP off timing should keep snapping only its parameter"
    );
}

/// Verifies sequence tracking lets a later cue fade a relative assertion down to zero.
#[test]
fn sequence_relative_values_override_tracked_previous_cue() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 707, Attribute::White);
    app.world_mut()
        .get_mut::<Parameter>(parameter.entity())
        .expect("white parameter should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let transition = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "relative full",
        fixture_ref.clone(),
        Attribute::White,
        ParameterValue::RelativePercent { offset: 1.0.into() },
        transition.clone(),
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "relative zero",
        fixture_ref,
        Attribute::White,
        ParameterValue::RelativePercent { offset: 0.0.into() },
        transition,
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let sequence = build_sequence(
        "relative fade down",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.mcues[0].set_activation_time(Instant::now() - Duration::from_secs(10));
    let cue_one_computed = render_sequence_layer(&mut app, &mut msequence);
    let cue_one_value = *cue_one_computed
        .relative
        .get(&parameter)
        .expect("cue 1 should assert relative white before advancing");
    assert!(
        (250.0..=255.0).contains(&cue_one_value),
        "cue 1 should establish the tracked relative contribution, got {cue_one_value}"
    );

    msequence.next();
    msequence.mcues[1].set_activation_time(Instant::now() - Duration::from_millis(500));

    let computed = render_sequence_layer(&mut app, &mut msequence);
    let value = *computed
        .relative
        .get(&parameter)
        .expect("sequence should still assert the relative intensity while fading");

    assert!(
        (60.0..=70.0).contains(&value),
        "cue 2 should keep fading the tracked relative contribution toward zero, got {value}"
    );
}

/// Verifies a cue-stored release marker clears tracked assertions from that cue onward.
#[test]
fn sequence_release_value_clears_tracked_assertion() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 1701, Attribute::Intensity);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_three_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "tracked intensity",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    let cue_two = cue_with_value_source(
        2,
        cue_two_uid,
        "release intensity",
        fixture_ref,
        Attribute::Intensity,
        ValueSource::Release,
        PartialTransition::default(),
    );
    let mut cue_three = Cue::default();
    cue_three.identifiers.id = 3;
    cue_three.identifiers.uid = cue_three_uid;
    cue_three.identifiers.label = "future cue".to_string();

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
        cue_data_provider.add(cue_three).unwrap();
    }

    let sequence = build_sequence(
        "release marker tracking",
        vec![cue_one_uid.into(), cue_two_uid.into(), cue_three_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let cue_one_computed = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(cue_one_computed.absolute.get(&parameter), Some(&200.0));

    msequence.next();
    let cue_two_computed = render_sequence_layer(&mut app, &mut msequence);
    assert!(
        cue_two_computed.absolute.get(&parameter).is_none(),
        "release marker should clear the tracked assertion on its cue"
    );

    msequence.next();
    let cue_three_computed = render_sequence_layer(&mut app, &mut msequence);
    assert!(
        cue_three_computed.absolute.get(&parameter).is_none(),
        "release marker should keep the assertion cleared for future cues"
    );
}

/// Verifies a release marker stored in a cue part waits for the part's assertion delay.
#[test]
fn sequence_release_value_in_cue_part_waits_for_part_delay() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 1705, Attribute::Intensity);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "tracked intensity",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    let cue_two = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_two_uid,
            label: "delayed release marker".to_string(),
        },
        parts: vec![nightfall_cues::cue::CuePart {
            identifiers: Identifiers {
                id: 2,
                uid: Uuid::new_v4(),
                label: "Part 2".to_string(),
            },
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                ..Default::default()
            },
            instructions: vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(Attribute::Intensity, ValueSource::Release)]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let sequence = build_sequence(
        "delayed release marker",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let cue_one_computed = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(cue_one_computed.absolute.get(&parameter), Some(&200.0));

    msequence.next_at_playback_position(Some(Duration::ZERO));
    let before_delay_clock = InstanceClock {
        position: Duration::from_millis(500),
        ..Default::default()
    };
    let before_delay_computed =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&before_delay_clock));
    assert_eq!(
        before_delay_computed.absolute.get(&parameter),
        Some(&200.0),
        "release marker should not clear tracked intensity before part delay elapses"
    );

    let at_delay_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let at_delay_computed =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&at_delay_clock));
    assert!(
        at_delay_computed.absolute.get(&parameter).is_none(),
        "release marker should clear tracked intensity once part delay elapses"
    );
}

/// Verifies a delayed release marker clears an earlier assertion from the same cue.
#[test]
fn sequence_release_value_in_later_part_clears_earlier_part_assertion() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 1706, Attribute::Intensity);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_three_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "tracked intensity",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    let cue_two = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_two_uid,
            label: "assert then delayed release".to_string(),
        },
        parts: vec![
            nightfall_cues::cue::CuePart {
                identifiers: Identifiers {
                    id: 1,
                    uid: Uuid::new_v4(),
                    label: "Part 1".to_string(),
                },
                instructions: vec![BoundCueInstruction {
                    selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Intensity,
                            ValueSource::Inline(ParameterValue::Absolute { value: 120.0 }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
            nightfall_cues::cue::CuePart {
                identifiers: Identifiers {
                    id: 2,
                    uid: Uuid::new_v4(),
                    label: "Part 2".to_string(),
                },
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                instructions: vec![BoundCueInstruction {
                    selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(Attribute::Intensity, ValueSource::Release)]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let mut cue_three = Cue::default();
    cue_three.identifiers.id = 3;
    cue_three.identifiers.uid = cue_three_uid;
    cue_three.identifiers.label = "future cue".to_string();

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
        cue_data_provider.add(cue_three).unwrap();
    }

    let sequence = build_sequence(
        "same cue delayed release marker",
        vec![cue_one_uid.into(), cue_two_uid.into(), cue_three_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let cue_one_computed = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(cue_one_computed.absolute.get(&parameter), Some(&200.0));

    msequence.next_at_playback_position(Some(Duration::ZERO));
    let before_delay_clock = InstanceClock {
        position: Duration::from_millis(500),
        ..Default::default()
    };
    let before_delay_computed =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&before_delay_clock));
    assert_eq!(
        before_delay_computed.absolute.get(&parameter),
        Some(&120.0),
        "earlier part assertion should remain active before later release marker delay elapses"
    );
    msequence.next_at_playback_position(Some(Duration::from_millis(500)));
    let inactive_future_computed =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&before_delay_clock));
    assert_eq!(
        inactive_future_computed.absolute.get(&parameter),
        Some(&120.0),
        "inactive release-only part should preserve the earlier part assertion for tracking"
    );

    let mut msequence = materialize_sequence(&mut app, &sequence);
    render_sequence_layer(&mut app, &mut msequence);
    msequence.next_at_playback_position(Some(Duration::ZERO));
    let at_delay_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let at_delay_computed =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&at_delay_clock));
    assert!(
        at_delay_computed.absolute.get(&parameter).is_none(),
        "later release marker should clear earlier same-cue part assertion"
    );

    msequence.next_at_playback_position(Some(Duration::from_secs(2)));
    let future_clock = InstanceClock {
        position: Duration::from_secs(2),
        ..Default::default()
    };
    let future_computed =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&future_clock));
    assert!(
        future_computed.absolute.get(&parameter).is_none(),
        "same-cue release marker should prevent the earlier part assertion from tracking forward"
    );
}

/// Verifies a later cue part assertion reasserts a value released by the parent cue.
#[test]
fn sequence_release_then_part_assertion_reasserts_value() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 1704, Attribute::Red);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "tracked red",
        fixture_ref.clone(),
        Attribute::Red,
        ParameterValue::Absolute { value: 120.0 },
        PartialTransition::default(),
    );
    let cue_two = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: cue_two_uid,
            label: "release then reassert red".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(Attribute::Red, ValueSource::Release)]),
                ..Default::default()
            },
        }],
        parts: vec![nightfall_cues::cue::CuePart {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "Part 1".to_string(),
            },
            instructions: vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 40.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let sequence = build_sequence(
        "release then part assertion",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let cue_one_computed = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(cue_one_computed.absolute.get(&parameter), Some(&120.0));

    msequence.next();
    let cue_two_computed = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(
        cue_two_computed.absolute.get(&parameter),
        Some(&40.0),
        "a later cue part assertion should win over an earlier parent-cue release"
    );
}

/// Verifies a tracked-value assertion reasserts the prior value with current cue timing.
#[test]
fn sequence_block_value_reasserts_prior_tracked_value() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 1702, Attribute::Red);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "tracked red",
        fixture_ref.clone(),
        Attribute::Red,
        ParameterValue::Absolute { value: 120.0 },
        PartialTransition::default(),
    );
    let block_transition = PartialTransition {
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        ..Default::default()
    };
    let cue_two = cue_with_value_source(
        2,
        cue_two_uid,
        "block red",
        fixture_ref,
        Attribute::Red,
        ValueSource::Inline(ParameterValue::Absolute { value: 120.0 }),
        block_transition,
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let sequence = build_sequence(
        "tracked value assertion",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let cue_one_computed = render_sequence_layer(&mut app, &mut msequence);
    assert_eq!(cue_one_computed.absolute.get(&parameter), Some(&120.0));

    msequence.next();
    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let sequence_layer = msequence.to_layer(&mut param_query);
    let (value, transition) = sequence_layer
        .absolute
        .get(&parameter)
        .expect("tracked-value assertion should assert the prior tracked red value");
    assert_eq!(*value, ParameterValue::Absolute { value: 120.0 });
    assert!(
        transition.is_some(),
        "tracked-value assertion should reassert using the current cue transition"
    );
}

/// Verifies hold-position markers resolve through fixture attribute lookup.
#[test]
fn sequence_hold_position_value_tracks_resolved_parameter() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 1703, Attribute::Pan);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_value_source(
        1,
        cue_uid,
        "hold pan",
        fixture_ref,
        Attribute::Pan,
        ValueSource::HoldPosition,
        PartialTransition::default(),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let sequence = build_sequence("hold position marker", vec![cue_uid.into()]);
    let msequence = materialize_sequence(&mut app, &sequence);

    assert!(
        msequence.mcues[0]
            .hold_position_values
            .contains(&parameter.into()),
        "hold-position marker should resolve to the concrete position parameter"
    );
}

/// Verifies setup cue values are asserted before the first sequence step.
#[test]
fn sequence_setup_cue_asserts_initial_tracking_values() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (setup_fixture, setup_parameter) =
        add_single_parameter_fixture(app.world_mut(), 708, Attribute::Intensity);
    let (step_fixture, step_parameter) =
        add_single_parameter_fixture(app.world_mut(), 709, Attribute::Pan);
    let step_uid = Uuid::new_v4();
    let step_cue = cue_with_parameter(
        1,
        step_uid,
        "pan step",
        step_fixture,
        Attribute::Pan,
        ParameterValue::AbsolutePercent { value: 0.6.into() },
        PartialTransition::default(),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(step_cue).unwrap();
    }

    let mut sequence = build_sequence("setup sequence", vec![step_uid.into()]);
    sequence.setup_cue = cue_with_parameter(
        0,
        Uuid::new_v4(),
        "setup",
        setup_fixture,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 128.0 },
        PartialTransition::default(),
    );

    let mut msequence = materialize_sequence(&mut app, &sequence);
    let computed = render_sequence_layer(&mut app, &mut msequence);

    assert_eq!(
        computed.absolute.get(&setup_parameter),
        Some(&128.0),
        "setup cue should assert intensity before cue tracking"
    );
    assert!(
        computed.absolute.contains_key(&step_parameter),
        "regular cue should still assert its own step value"
    );
}

/// Verifies stale last-cue releases do not make ordinary navigation look like a wrap.
#[test]
fn wrapped_sequence_does_not_reuse_tracking_layer_for_non_wrap_return_to_first() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (cue_one_fixture_ref, cue_one_parameter) =
        add_single_parameter_fixture(app.world_mut(), 604, Attribute::Red);
    let (cue_two_fixture_ref, cue_two_parameter) =
        add_single_parameter_fixture(app.world_mut(), 605, Attribute::Green);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "red first",
        cue_one_fixture_ref,
        Attribute::Red,
        ParameterValue::AbsolutePercent { value: 0.1.into() },
        Default::default(),
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "green second",
        cue_two_fixture_ref,
        Attribute::Green,
        ParameterValue::AbsolutePercent { value: 0.6.into() },
        Default::default(),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let mut sequence = build_sequence(
        "wrapped colors",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    msequence.next();
    let _ = render_sequence_layer(&mut app, &mut msequence);
    msequence.next();
    let _ = render_sequence_layer(&mut app, &mut msequence);
    msequence.next();
    let _ = render_sequence_layer(&mut app, &mut msequence);
    msequence.prev();
    let computed = render_sequence_layer(&mut app, &mut msequence);

    assert!(
        computed.absolute.contains_key(&cue_one_parameter),
        "cue 1 should remain active"
    );
    assert!(
        !computed.absolute.contains_key(&cue_two_parameter),
        "cue 2 should not leak through the wrapped tracking cache"
    );
}

/// Verifies timeline reconstruction timing renders the same value as organic playback.
#[test]
fn timeline_reconstruction_timing_matches_organic_playback_value() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 704, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "fade-in",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let sequence = build_sequence("fade sequence", vec![cue_uid.into()]);
    let mut organic_sequence = materialize_sequence(&mut app, &sequence);
    let organic_start = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    organic_sequence.activation_time = organic_start;
    organic_sequence.mcues[0].set_activation_time(organic_start);
    let organic_layer = render_sequence_layer(&mut app, &mut organic_sequence);
    let organic_value = *organic_layer
        .absolute
        .get(&parameter)
        .expect("organic playback should render intensity");

    let mut reconstructed_sequence = materialize_sequence(&mut app, &sequence);
    reconstructed_sequence.set_current_transition_position(Duration::from_secs(1));
    let clock = InstanceClock {
        position: Duration::from_secs(2),
        ..Default::default()
    };
    let reconstructed_layer =
        render_sequence_layer_at_clock(&mut app, &mut reconstructed_sequence, Some(&clock));
    let reconstructed_value = *reconstructed_layer
        .absolute
        .get(&parameter)
        .expect("timeline reconstruction should render intensity");

    assert!(
        (organic_value - reconstructed_value).abs() <= 5.0,
        "timeline reconstruction should match organic playback value: organic={organic_value}, reconstructed={reconstructed_value}"
    );
}

/// Verifies sequence-internal fades expose current values while retaining transition status.
#[test]
fn sequence_layer_preserves_current_value_and_transition_status() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 705, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "fade-in",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(5))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let sequence = build_sequence("fade sequence", vec![cue_uid.into()]);
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let active_start = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    msequence.mcues[0].set_activation_time(active_start);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let mut sequence_layer = msequence.to_layer_at_clock(&mut param_query, Some(&clock));
    let displayed_value = match sequence_layer
        .absolute
        .get(&parameter)
        .expect("sequence layer should contain the current fade value")
        .0
    {
        ParameterValue::Absolute { value } => value,
        other => panic!("sequence layer should store an absolute current value, got {other:?}"),
    };
    assert!(
        (displayed_value - 100.0).abs() <= 5.0,
        "sequence layer should expose the current fade value, got {displayed_value}"
    );
    assert_eq!(
        sequence_layer.transitioning.get(&parameter),
        Some(&true),
        "sequence layer should retain transition status after squashing current values"
    );

    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut sequence_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        false,
        nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(500),
            released_at: None,
        },
    );
    let composited_value = *computed
        .absolute
        .get(&parameter)
        .expect("global compositor should render the sequence value");
    assert!(
        (composited_value - displayed_value).abs() <= 1.0,
        "global compositor should not apply the sequence fade a second time: displayed={displayed_value}, composited={composited_value}"
    );

    drop(param_query);
    drop(param_query_state);

    let mut completed_sequence = materialize_sequence(&mut app, &sequence);
    let completed_start = Instant::now()
        .checked_sub(Duration::from_secs(3))
        .unwrap_or_else(Instant::now);
    completed_sequence.mcues[0].set_activation_time(completed_start);
    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let clock = InstanceClock {
        position: Duration::from_secs(3),
        ..Default::default()
    };
    let completed_layer = completed_sequence.to_layer_at_clock(&mut param_query, Some(&clock));
    assert_eq!(
        completed_layer.transitioning.get(&parameter),
        Some(&false),
        "sequence layer should clear transition status after fade completion"
    );
}

/// Verifies Go does not snap an already-running cue transition to its asserted target.
#[test]
fn sequence_go_preserves_previous_cue_in_flight_transition() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, red_parameter, green_parameter, _) = add_rgb_fixture(app.world_mut(), 717);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "red fade",
        fixture_ref.clone(),
        Attribute::Red,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "green snap",
        fixture_ref,
        Attribute::Green,
        ParameterValue::RelativePercent {
            offset: (-0.5).into(),
        },
        PartialTransition::default(),
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let sequence = build_sequence(
        "preserve previous fade",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.mcues[0].set_activation_time(Instant::now() - Duration::from_millis(100));
    let cue_one_layer = render_sequence_layer(&mut app, &mut msequence);
    let in_flight_red = *cue_one_layer
        .relative
        .get(&red_parameter)
        .expect("cue 1 should assert red while fading");
    assert!(
        (-20.0..0.0).contains(&in_flight_red),
        "cue 1 should still be near the beginning of its red fade, got {in_flight_red}"
    );

    msequence.next();
    msequence.mcues[0].set_activation_time(Instant::now() - Duration::from_millis(100));
    let cue_two_layer = render_sequence_layer(&mut app, &mut msequence);
    let carried_red = *cue_two_layer
        .relative
        .get(&red_parameter)
        .expect("cue 2 should carry cue 1 red while it finishes fading");
    let cue_two_green = *cue_two_layer
        .relative
        .get(&green_parameter)
        .expect("cue 2 should assert green");

    assert!(
        (-20.0..0.0).contains(&carried_red),
        "Go should keep cue 1 red in-flight instead of snapping to the target, got {carried_red}"
    );
    assert!(
        (-130.0..=-125.0).contains(&cue_two_green),
        "cue 2 should assert one green half-step, got {cue_two_green}"
    );
}

/// Verifies HTP off cues remain active while their delay-out span is holding.
#[test]
fn sequence_intensity_off_holds_during_delay_out() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 718, Attribute::Intensity);
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let cue_one = cue_with_parameter(
        1,
        cue_one_uid,
        "intensity on",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    let cue_two = cue_with_parameter(
        2,
        cue_two_uid,
        "intensity off",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 0.0 },
        PartialTransition {
            delay_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two).unwrap();
    }

    let sequence = build_sequence(
        "intensity off delay-out",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let mut clock = InstanceClock {
        position: Duration::from_secs(5),
        ..Default::default()
    };
    let first_layer = render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&clock));
    let first_value = *first_layer
        .absolute
        .get(&parameter)
        .expect("first cue should assert intensity");
    assert_eq!(first_value, 200.0);

    msequence.next_at_playback_position(Some(clock.position));
    clock.position += Duration::from_millis(500);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut sequence_layer = msequence.to_layer_at_clock(&mut param_query, Some(&clock));
    let held_value = match sequence_layer
        .absolute
        .get(&parameter)
        .expect("off cue should still contribute intensity during delay-out")
        .0
    {
        ParameterValue::Absolute { value } => value,
        other => panic!("sequence layer should store an absolute current value, got {other:?}"),
    };

    assert_eq!(
        held_value, 200.0,
        "off cue should hold the previous intensity during delay-out"
    );
    assert_eq!(
        sequence_layer.transitioning.get(&parameter),
        Some(&true),
        "off cue should remain active while delay-out is holding"
    );

    let composited = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut sequence_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        false,
        nightfall_compositor::types::LayerCompositingContext {
            position: clock.position,
            released_at: None,
        },
    );
    let composited_value = *composited
        .absolute
        .get(&parameter)
        .expect("global compositor should render the delayed off cue");
    assert_eq!(
        composited_value, 200.0,
        "global compositor should not snap the delayed off cue to zero"
    );
}

/// Verifies cue parts inherit sequence default timing during sequence playback materialization.
#[test]
fn sequence_default_timing_applies_to_cue_parts() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 707, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "part inherits sequence timing".to_string(),
        },
        parts: vec![nightfall_cues::cue::CuePart {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "Part 1".to_string(),
            },
            transitions: PartialTransition {
                fade_in: Some(TransitionMode::Fixed(Duration::from_secs(5))),
                ..Default::default()
            },
            instructions: vec![BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    )]),
                    ..Default::default()
                },
            }],
            ..Default::default()
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("sequence defaults", vec![cue_uid.into()]);
    sequence.default_timing = Transition {
        delay_in: TransitionMode::Fixed(Duration::from_secs(1)),
        fade_in: TransitionMode::Fixed(Duration::from_secs(2)),
        delay_out: TransitionMode::Fixed(Duration::from_secs(3)),
        fade_out: TransitionMode::Fixed(Duration::from_secs(4)),
        ..Default::default()
    };

    let msequence = materialize_sequence(&mut app, &sequence);
    let transition = msequence.mcues[0]
        .values
        .absolute
        .get(&parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("cue part value should materialize with inherited sequence timing");

    assert_eq!(transition.delay_in, Duration::from_secs(1));
    assert_eq!(transition.fade_in, Duration::from_secs(5));
    assert_eq!(transition.delay_out, Duration::from_secs(3));
    assert_eq!(transition.fade_out, Duration::from_secs(4));
}

/// Verifies a sequence release cue overrides release delay and fade timing per parameter.
#[test]
fn sequence_release_uses_release_cue_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 706, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "active",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(10))),
            ..Default::default()
        },
    );
    let release_cue = cue_with_parameter(
        2,
        Uuid::new_v4(),
        "release",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            delay_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.mcues[0].set_activation_time(
        Instant::now()
            .checked_sub(Duration::from_secs(5))
            .unwrap_or_else(Instant::now),
    );

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(msequence.max_release_duration(), Duration::from_secs(3));

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let computed_during_delay =
        nightfall_compositor::stages::apply_transitions_with_compositing_context(
            &mut release_layer,
            &nightfall_compositor::prelude::ComputedLayer::default(),
            &param_query,
            true,
            nightfall_compositor::types::LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: Some(Duration::ZERO),
            },
        );
    let delayed_value = *computed_during_delay
        .absolute
        .get(&parameter)
        .expect("release compositor should hold the frozen value during delay");
    assert!(
        (delayed_value - 200.0).abs() <= 5.0,
        "release cue should hold during delay-out, got {delayed_value}"
    );

    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(1500),
            released_at: Some(Duration::ZERO),
        },
    );
    let released_value = *computed
        .absolute
        .get(&parameter)
        .expect("release compositor should render the fading value");

    assert!(
        (released_value - 150.0).abs() <= 5.0,
        "release cue should place the fade one-quarter through after its delay, got {released_value}"
    );
}

/// Verifies release cue fade-in timing controls LTP release movement.
#[test]
fn sequence_release_uses_release_cue_fade_in_for_ltp_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 715, Attribute::Red);
    app.world_mut()
        .get_mut::<Parameter>(parameter.entity())
        .expect("red parameter component should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "active red",
        fixture_ref.clone(),
        Attribute::Red,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    let release_cue = cue_with_parameter(
        2,
        Uuid::new_v4(),
        "release red",
        fixture_ref,
        Attribute::Red,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("ltp release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(msequence.max_release_duration(), Duration::from_secs(2));

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let computed_release = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_secs(1),
            released_at: Some(Duration::ZERO),
        },
    );
    let released_value = *computed_release
        .absolute
        .get(&parameter)
        .expect("release compositor should render the fading LTP value");

    assert!(
        (released_value - 100.0).abs() <= 5.0,
        "release cue fade-in should move the LTP value halfway to default, got {released_value}"
    );
}

/// Verifies same-fixture LTP release timing starts after HTP intensity release finishes.
#[test]
fn sequence_release_holds_ltp_until_htp_release_completes() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, intensity_parameter, red_parameter) =
        add_intensity_red_fixture(app.world_mut(), 718);
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "active intensity red".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    ),
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "global release".to_string(),
        },
        transitions: PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("held ltp release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(
        msequence.max_release_duration(),
        Duration::from_millis(3500)
    );

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let intensity_transition = release_layer
        .absolute
        .get(&intensity_parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("intensity release should keep global HTP timing");
    assert_eq!(intensity_transition.fade_out, Duration::from_secs(1));
    let red_transition = release_layer
        .absolute
        .get(&red_parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("red release should keep global LTP timing");
    assert_eq!(red_transition.delay_out, Duration::from_millis(1500));
    assert_eq!(red_transition.fade_out, Duration::from_secs(2));

    let held_release = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer.clone(),
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::prelude::LayerCompositingContext {
            position: Duration::from_millis(1250),
            released_at: Some(Duration::ZERO),
        },
    );
    let held_red = *held_release
        .absolute
        .get(&red_parameter)
        .expect("release compositor should render held LTP value");
    assert!(
        (held_red - 200.0).abs() <= 1.0,
        "LTP value should hold while HTP intensity fades, got {held_red}"
    );

    let fading_release = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::prelude::LayerCompositingContext {
            position: Duration::from_millis(2500),
            released_at: Some(Duration::ZERO),
        },
    );
    let fading_red = *fading_release
        .absolute
        .get(&red_parameter)
        .expect("release compositor should render fading LTP value");
    assert!(
        (fading_red - 100.0).abs() <= 5.0,
        "LTP value should begin fading after HTP release completes, got {fading_red}"
    );
}

/// Verifies a sequence release cue can apply global release timing without instructions.
#[test]
fn sequence_release_uses_global_release_cue_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 707, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "active",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    let release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "release".to_string(),
        },
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_millis(1667))),
            ..Default::default()
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("global release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(
        msequence.max_release_duration(),
        Duration::from_millis(1667)
    );

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let (_, transition) = release_layer
        .absolute
        .get_mut(&parameter)
        .expect("release layer should freeze the active parameter");
    transition
        .as_ref()
        .expect("global release timing should create a transition");
    let computed_release = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::prelude::LayerCompositingContext {
            position: Duration::from_millis(834),
            released_at: Some(Duration::ZERO),
        },
    );
    let released_value = *computed_release
        .absolute
        .get(&parameter)
        .expect("release compositor should render the fading global release value");

    assert!(
        (released_value - 100.0).abs() <= 5.0,
        "global release cue fade should be about halfway through, got {released_value}"
    );
}

/// Verifies explicit zero global release timing overrides inherited source timing.
#[test]
fn sequence_release_global_zero_timing_overrides_source_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 717, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "active",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );
    let release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "release".to_string(),
        },
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::ZERO)),
            ..Default::default()
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("global zero release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(
        msequence.max_release_duration(),
        Duration::ZERO,
        "explicit zero global release timing should not fall back to source fade timing"
    );

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let release_layer = msequence.to_layer(&mut param_query);
    let (_, transition) = release_layer
        .absolute
        .get(&parameter)
        .expect("release layer should freeze the active parameter");
    let transition = transition
        .as_ref()
        .expect("explicit zero timing should still create an override transition");
    assert_eq!(transition.release_duration(), Duration::ZERO);
}

/// Verifies cue-level release timing does not leak outside scoped release instructions.
#[test]
fn sequence_release_global_timing_respects_release_cue_scope() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (scoped_fixture_ref, scoped_parameter) =
        add_single_parameter_fixture(app.world_mut(), 708, Attribute::Intensity);
    let (unscoped_fixture_ref, unscoped_parameter) =
        add_single_parameter_fixture(app.world_mut(), 709, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "active".to_string(),
        },
        instructions: vec![
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![scoped_fixture_ref.clone()]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    )]),
                    ..Default::default()
                },
            },
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![unscoped_fixture_ref]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                    )]),
                    ..Default::default()
                },
            },
        ],
        ..Default::default()
    };
    let release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "release".to_string(),
        },
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![scoped_fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("scoped release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(msequence.max_release_duration(), Duration::from_secs(2));

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let release_layer = msequence.to_layer(&mut param_query);
    let (_, transition) = release_layer
        .absolute
        .get(&scoped_parameter)
        .expect("release layer should retain the release-cue scoped parameter");
    assert!(
        transition.is_some(),
        "scoped parameter should inherit the release cue fade timing"
    );
    let (_, unscoped_transition) = release_layer
        .absolute
        .get(&unscoped_parameter)
        .expect("release layer should retain unmatched parameters for HTP-gated holds");
    let unscoped_transition = unscoped_transition
        .as_ref()
        .expect("unmatched parameter should receive hold-only release timing");
    assert_eq!(unscoped_transition.delay_out, Duration::ZERO);
    assert_eq!(unscoped_transition.fade_out, Duration::ZERO);
}

/// Verifies scoped release cues hold unmatched LTP values until same-fixture HTP release completes.
#[test]
fn sequence_release_scoped_delay_holds_unmatched_parameters() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (scoped_fixture_ref, scoped_parameter, unmatched_parameter) =
        add_intensity_red_fixture(app.world_mut(), 710);
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "active".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![scoped_fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    ),
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "release".to_string(),
        },
        transitions: PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            delay_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![scoped_fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("scoped delayed release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let (_, scoped_transition) = release_layer
        .absolute
        .get(&scoped_parameter)
        .expect("release layer should retain the release-cue scoped parameter");
    assert!(
        scoped_transition.is_some(),
        "scoped parameter should inherit the release cue delay and fade"
    );
    let (_, unmatched_transition) = release_layer.absolute.get(&unmatched_parameter).expect(
        "release layer should hold unmatched LTP parameters during same-fixture HTP release",
    );
    let unmatched_transition = unmatched_transition
        .as_ref()
        .expect("unmatched LTP parameter should receive HTP-gated hold timing");
    assert_eq!(unmatched_transition.delay_out, Duration::from_secs(3));
    assert_eq!(unmatched_transition.fade_out, Duration::ZERO);

    let computed_during_delay =
        nightfall_compositor::stages::apply_transitions_with_compositing_context(
            &mut release_layer,
            &nightfall_compositor::prelude::ComputedLayer::default(),
            &param_query,
            true,
            nightfall_compositor::types::LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: Some(Duration::ZERO),
            },
        );
    assert_eq!(
        computed_during_delay
            .absolute
            .get(&scoped_parameter)
            .copied(),
        Some(200.0)
    );
    assert_eq!(
        computed_during_delay
            .absolute
            .get(&unmatched_parameter)
            .copied(),
        Some(100.0)
    );

    let computed_after_delay =
        nightfall_compositor::stages::apply_transitions_with_compositing_context(
            &mut release_layer,
            &nightfall_compositor::prelude::ComputedLayer::default(),
            &param_query,
            true,
            nightfall_compositor::types::LayerCompositingContext {
                position: Duration::from_millis(1500),
                released_at: Some(Duration::ZERO),
            },
        );
    assert_eq!(
        computed_after_delay
            .absolute
            .get(&unmatched_parameter)
            .copied(),
        Some(100.0),
        "unmatched LTP parameter should hold through the same-fixture HTP release span"
    );
}

/// Verifies planned release duration matches runtime release for timing-only HTP overrides.
#[test]
fn sequence_release_duration_planner_matches_timing_only_htp_release() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, intensity_parameter, red_parameter) =
        add_intensity_red_fixture(app.world_mut(), 711);
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "active intensity red".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    ),
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("timing-only htp release sequence", vec![cue_uid.into()]);
    sequence.release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "release".to_string(),
        },
        transitions: PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(sequence.clone()).unwrap();
    }

    let planned_release_duration = {
        let mut system_state = SystemState::<(
            Res<DataProvider<Sequence>>,
            Res<FixtureDataProviderExt>,
            SpatialSelectionResolver,
        )>::new(app.world_mut());
        let (sequence_data_provider, fixture_data_provider, selection_resolver) = system_state
            .get(app.world_mut())
            .expect("test system parameters should be available");
        sequence_release_duration_for_clip(
            &Clip {
                source: Some(Source::Sequence(sequence.identifiers.uid)),
                ..Default::default()
            },
            Some(&sequence_data_provider),
            &fixture_data_provider,
            &selection_resolver,
        )
        .expect("sequence clip should have a planned release duration")
    };

    let mut msequence = materialize_sequence(&mut app, &sequence);
    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(planned_release_duration, Duration::from_secs(3));
    assert_eq!(msequence.max_release_duration(), planned_release_duration);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let release_layer = msequence.to_layer(&mut param_query);
    let intensity_transition = release_layer
        .absolute
        .get(&intensity_parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("timing-only HTP override should release frozen intensity");
    let red_transition = release_layer
        .absolute
        .get(&red_parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("scoped LTP value should receive release timing");

    assert_eq!(intensity_transition.fade_out, Duration::from_secs(2));
    assert_eq!(red_transition.delay_out, Duration::from_secs(2));
    assert_eq!(red_transition.fade_out, Duration::from_secs(1));
}

/// Verifies a global fade-out-only release cue holds LTP while same-fixture HTP fades.
#[test]
fn sequence_release_global_fade_out_only_holds_ltp_until_htp_release_completes() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, intensity_parameter, red_parameter) =
        add_intensity_red_fixture(app.world_mut(), 712);
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "active".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    ),
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("global fade-out release sequence", vec![cue_uid.into()]);
    sequence.release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "release".to_string(),
        },
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
        ..Default::default()
    };
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let computed_mid_release =
        nightfall_compositor::stages::apply_transitions_with_compositing_context(
            &mut release_layer,
            &nightfall_compositor::prelude::ComputedLayer::default(),
            &param_query,
            true,
            nightfall_compositor::types::LayerCompositingContext {
                position: Duration::from_secs(1),
                released_at: Some(Duration::ZERO),
            },
        );

    assert_eq!(
        computed_mid_release
            .absolute
            .get(&intensity_parameter)
            .copied(),
        Some(100.0),
        "HTP intensity should fade out over the authored release fade"
    );
    assert_eq!(
        computed_mid_release.absolute.get(&red_parameter).copied(),
        Some(100.0),
        "LTP color should hold while same-fixture HTP fades"
    );
}

/// Verifies fixture-level dimmer release holds LTP emitters on sibling fixture elements.
#[test]
fn sequence_release_fixture_level_htp_holds_ltp_on_sibling_element() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixture_uid = Uuid::new_v4();
    let dimmer_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let emitter_ref = FixtureRef {
        fixture_uid,
        index: Some(2),
    };
    let intensity_metadata = ParameterMetadata {
        attribute: Attribute::Intensity,
        native_unit: Attribute::Intensity.native_unit(),
        value_polarity: Attribute::Intensity.value_polarity(),
        resolution: DmxValueResolution::Coarse,
        merge_type: MergeStrategy::HTP,
        ..Default::default()
    };
    let red_metadata = ParameterMetadata {
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        resolution: DmxValueResolution::Coarse,
        merge_type: MergeStrategy::LTP,
        ..Default::default()
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 713,
            uid: fixture_uid,
            label: "fixture-713".to_string(),
        },
        elements: vec![
            FixtureElement {
                label: "dimmer".to_string(),
                parameters: vec![intensity_metadata.clone()],
            },
            FixtureElement {
                label: "emitter".to_string(),
                parameters: vec![red_metadata.clone()],
            },
        ],
        ..Default::default()
    };

    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let intensity_parameter = spawn_parameter(app.world_mut(), Attribute::Intensity);
    let red_parameter = spawn_parameter(app.world_mut(), Attribute::Red);
    app.world_mut()
        .get_mut::<Parameter>(intensity_parameter.entity())
        .expect("intensity parameter should exist")
        .metadata = intensity_metadata;
    app.world_mut()
        .get_mut::<Parameter>(red_parameter.entity())
        .expect("red parameter should exist")
        .metadata = red_metadata;
    app.world()
        .resource::<FixtureDataProviderExt>()
        .add_parameter(
            dimmer_ref.clone(),
            Attribute::Intensity,
            intensity_parameter,
        );
    app.world()
        .resource::<FixtureDataProviderExt>()
        .add_parameter(emitter_ref.clone(), Attribute::Red, red_parameter);

    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: cue_uid,
            label: "active".to_string(),
        },
        instructions: vec![
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![dimmer_ref]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 200.0 }),
                    )]),
                    ..Default::default()
                },
            },
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![emitter_ref]).into(),
                cue_instruction: CueInstruction {
                    blueprint_application: None,
                    values: HashMap::from([(
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                    )]),
                    ..Default::default()
                },
            },
        ],
        ..Default::default()
    };

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .unwrap();

    let mut sequence = build_sequence(
        "sibling fixture-element release sequence",
        vec![cue_uid.into()],
    );
    sequence.release_cue = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "release".to_string(),
        },
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
        ..Default::default()
    };
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let _ = render_sequence_layer(&mut app, &mut msequence);
    release_sequence_preserving_look(&mut app, &mut msequence);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let computed_mid_release =
        nightfall_compositor::stages::apply_transitions_with_compositing_context(
            &mut release_layer,
            &nightfall_compositor::prelude::ComputedLayer::default(),
            &param_query,
            true,
            nightfall_compositor::types::LayerCompositingContext {
                position: Duration::from_secs(1),
                released_at: Some(Duration::ZERO),
            },
        );

    assert_eq!(
        computed_mid_release
            .absolute
            .get(&intensity_parameter)
            .copied(),
        Some(100.0),
        "fixture-level HTP dimmer should fade out"
    );
    assert_eq!(
        computed_mid_release.absolute.get(&red_parameter).copied(),
        Some(100.0),
        "sibling LTP emitter should hold while fixture-level HTP fades"
    );
}

/// Verifies sequence release asserts frozen rendered values instead of mutating active cues.
#[test]
fn sequence_release_uses_frozen_rendered_assertions() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 708, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "active",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );
    let release_cue = cue_with_parameter(
        2,
        Uuid::new_v4(),
        "release",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.mcues[0].set_activation_time(
        Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now),
    );

    let computed_before_release = render_sequence_layer(&mut app, &mut msequence);
    let frozen_value = *computed_before_release
        .absolute
        .get(&parameter)
        .expect("sequence should render the in-flight fade-in value");
    assert!(
        (95.0..=105.0).contains(&frozen_value),
        "source cue should be halfway through fade-in, got {frozen_value}"
    );

    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, parameter_query) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");
    msequence.release_from_rendered_assertions(&fixture_data_provider, &parameter_query);
    let _ = parameter_query;
    drop(fixture_data_provider);
    drop(system_state);

    assert_eq!(msequence.mcues[0].release_position, None);
    let active_transition = msequence.mcues[0]
        .values
        .absolute
        .get(&parameter)
        .expect("active cue should still own the parameter")
        .1
        .as_ref()
        .expect("active cue should still own its original transition");
    assert_eq!(active_transition.release_position, None);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let computed_release = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::types::LayerCompositingContext {
            position: Duration::ZERO,
            released_at: Some(Duration::ZERO),
        },
    );
    let released_value = *computed_release
        .absolute
        .get(&parameter)
        .expect("release layer should assert the frozen value");

    assert!(
        (95.0..=105.0).contains(&released_value),
        "release should start from frozen rendered value, got {released_value}"
    );
}

/// Verifies clocked sequence release fades from the frozen partial output.
#[test]
fn sequence_clocked_release_fades_from_partial_transition_source() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 715, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "active",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );
    let release_cue = cue_with_parameter(
        2,
        Uuid::new_v4(),
        "release",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("clocked release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.set_current_transition_position(Duration::ZERO);

    let active_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let computed_before_release =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&active_clock));
    let frozen_value = *computed_before_release
        .absolute
        .get(&parameter)
        .expect("sequence should render the in-flight fade-in value");
    assert!(
        (95.0..=105.0).contains(&frozen_value),
        "source cue should be halfway through fade-in, got {frozen_value}"
    );

    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, parameter_query) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");
    msequence.release_from_rendered_assertions_at_position(
        &fixture_data_provider,
        &parameter_query,
        Some(Duration::from_secs(1)),
    );
    let _ = parameter_query;
    drop(fixture_data_provider);
    drop(system_state);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer_at_clock(&mut param_query, Some(&active_clock));
    let computed_release = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::prelude::LayerCompositingContext {
            position: Duration::from_millis(1500),
            released_at: Some(Duration::from_secs(1)),
        },
    );
    let released_value = *computed_release
        .absolute
        .get(&parameter)
        .expect("release layer should fade the frozen value");

    assert!(
        (45.0..=55.0).contains(&released_value),
        "release should fade halfway from frozen value toward default, got {released_value}"
    );
}

/// Verifies untracked active cue values still freeze for release with release-cue timing.
#[test]
fn sequence_release_freezes_untracked_active_cue_with_release_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 714, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let mut cue = cue_with_parameter(
        1,
        cue_uid,
        "untracked active",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition::default(),
    );
    cue.tracking_flags = TrackingFlags::from(0);
    let release_cue = cue_with_parameter(
        2,
        Uuid::new_v4(),
        "release timing",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            delay_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("untracked release sequence", vec![cue_uid.into()]);
    sequence.release_cue = release_cue;
    let mut msequence = materialize_sequence(&mut app, &sequence);

    let before_release = render_sequence_layer(&mut app, &mut msequence);
    let visible_value = *before_release
        .absolute
        .get(&parameter)
        .expect("untracked active cue should still render while active");
    assert_eq!(visible_value, 200.0);

    release_sequence_preserving_look(&mut app, &mut msequence);

    assert_eq!(msequence.max_release_duration(), Duration::from_secs(3));

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let mut param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = msequence.to_layer(&mut param_query);
    let computed_release = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &nightfall_compositor::prelude::ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(1500),
            released_at: Some(Duration::ZERO),
        },
    );
    let released_value = *computed_release
        .absolute
        .get(&parameter)
        .expect("release compositor should render the frozen untracked value");

    assert!(
        (released_value - 150.0).abs() <= 5.0,
        "release should fade the frozen untracked cue look with release timing, got {released_value}"
    );
}

/// Verifies active sequences pick up edits to their embedded release cue.
#[test]
fn sequence_definition_change_rematerializes_embedded_release_cue() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(
        Update,
        rematerialize_sequences_after_sequence_definition_change,
    );

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 707, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        1,
        cue_uid,
        "active",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(10))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue).unwrap();
    }

    let mut sequence = build_sequence("release sequence", vec![cue_uid.into()]);
    sequence.release_cue = cue_with_parameter(
        2,
        Uuid::new_v4(),
        "release",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(10))),
            ..Default::default()
        },
    );

    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(sequence.clone()).unwrap();
    }

    let msequence = materialize_sequence(&mut app, &sequence);
    let msequence_entity = app.world_mut().spawn(msequence).id();

    let mut updated_sequence = sequence.clone();
    updated_sequence.default_timing = Transition {
        delay_in: TransitionMode::Fixed(Duration::from_secs(1)),
        fade_in: TransitionMode::Fixed(Duration::from_secs(2)),
        ..Default::default()
    };
    updated_sequence.release_cue = cue_with_parameter(
        2,
        Uuid::new_v4(),
        "release",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 200.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
    );
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(updated_sequence).unwrap();
    }

    app.update();

    let msequence = app
        .world()
        .get::<MaterializedSequence>(msequence_entity)
        .expect("materialized sequence should exist after sequence update");
    let transition = msequence.mcues[0]
        .values
        .absolute
        .get(&parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("active cue should rematerialize with sequence default timing");
    assert_eq!(transition.delay_in, Duration::from_secs(1));
    assert_eq!(transition.fade_in, Duration::from_secs(2));
    assert_eq!(transition.fade_out, Duration::from_secs(10));

    {
        let mut system_state = SystemState::<(
            Query<&mut MaterializedSequence>,
            Query<InstanceMut<Parameter>>,
        )>::new(app.world_mut());
        let (mut msequence_query, mut parameter_query) = system_state
            .get_mut(app.world_mut())
            .expect("test system parameters should be available");
        let mut msequence = msequence_query
            .single_mut()
            .expect("materialized sequence should exist");
        let _ = msequence.to_layer(&mut parameter_query);
    }

    let mut system_state = SystemState::<(
        Query<&mut MaterializedSequence>,
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (mut msequence_query, fixture_data_provider, parameter_query) = system_state
        .get_mut(app.world_mut())
        .expect("test system parameters should be available");
    let mut msequence = msequence_query
        .single_mut()
        .expect("materialized sequence should exist");
    msequence.release_from_rendered_assertions(&fixture_data_provider, &parameter_query);

    assert_eq!(msequence.max_release_duration(), Duration::from_secs(2));
}

/// Verifies running sequence rematerialization preserves the active cue by UID after reorder.
#[test]
fn sequence_definition_reorder_preserves_active_cue_identity() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(
        Update,
        rematerialize_sequences_after_sequence_definition_change,
    );

    let cue_a = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::new_v4(),
            label: "A".to_string(),
        },
        ..Default::default()
    };
    let cue_b = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "B".to_string(),
        },
        ..Default::default()
    };
    let cue_c = Cue {
        identifiers: Identifiers {
            id: 3,
            uid: Uuid::new_v4(),
            label: "C".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_a.clone()).unwrap();
        cue_data_provider.add(cue_b.clone()).unwrap();
        cue_data_provider.add(cue_c.clone()).unwrap();
    }

    let sequence = build_sequence(
        "reordered sequence",
        vec![
            cue_a.identifiers.uid.into(),
            cue_b.identifiers.uid.into(),
            cue_c.identifiers.uid.into(),
        ],
    );
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(sequence.clone()).unwrap();
    }

    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.set_position_at_playback_position(2, Some(Duration::from_secs(5)));
    let msequence_entity = app.world_mut().spawn(msequence).id();

    let mut updated_sequence = sequence.clone();
    updated_sequence.steps = vec![
        cue_c.identifiers.uid.into(),
        cue_a.identifiers.uid.into(),
        cue_b.identifiers.uid.into(),
    ];
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(updated_sequence).unwrap();
    }

    app.update();

    let msequence = app
        .world()
        .get::<MaterializedSequence>(msequence_entity)
        .expect("materialized sequence should remain active after reorder");
    assert_eq!(msequence.position(), 3);
    assert_eq!(msequence.current().identifiers.uid, cue_b.identifiers.uid);
}

/// Verifies deleting an active cue activates the prior surviving cue in the updated sequence.
#[test]
fn sequence_definition_delete_active_cue_activates_prior_survivor() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(
        Update,
        rematerialize_sequences_after_sequence_definition_change,
    );

    let cue_a = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::new_v4(),
            label: "A".to_string(),
        },
        ..Default::default()
    };
    let cue_b = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "B".to_string(),
        },
        ..Default::default()
    };
    let cue_c = Cue {
        identifiers: Identifiers {
            id: 3,
            uid: Uuid::new_v4(),
            label: "C".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_a.clone()).unwrap();
        cue_data_provider.add(cue_b.clone()).unwrap();
        cue_data_provider.add(cue_c.clone()).unwrap();
    }

    let sequence = build_sequence(
        "delete active middle cue",
        vec![
            cue_a.identifiers.uid.into(),
            cue_b.identifiers.uid.into(),
            cue_c.identifiers.uid.into(),
        ],
    );
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(sequence.clone()).unwrap();
    }

    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.set_position_at_playback_position(2, Some(Duration::from_secs(5)));
    let msequence_entity = app.world_mut().spawn(msequence).id();

    let mut updated_sequence = sequence.clone();
    updated_sequence.steps = vec![cue_a.identifiers.uid.into(), cue_c.identifiers.uid.into()];
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(updated_sequence).unwrap();
    }

    app.update();

    let msequence = app
        .world()
        .get::<MaterializedSequence>(msequence_entity)
        .expect("materialized sequence should remain active after active cue deletion");
    assert_eq!(msequence.position(), 1);
    assert_eq!(msequence.current().identifiers.uid, cue_a.identifiers.uid);
}

/// Verifies deleting the active first cue activates the new first cue when no prior cue survives.
#[test]
fn sequence_definition_delete_active_first_cue_activates_new_first_cue() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(
        Update,
        rematerialize_sequences_after_sequence_definition_change,
    );

    let cue_a = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::new_v4(),
            label: "A".to_string(),
        },
        ..Default::default()
    };
    let cue_b = Cue {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::new_v4(),
            label: "B".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_a.clone()).unwrap();
        cue_data_provider.add(cue_b.clone()).unwrap();
    }

    let sequence = build_sequence(
        "delete active first cue",
        vec![cue_a.identifiers.uid.into(), cue_b.identifiers.uid.into()],
    );
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(sequence.clone()).unwrap();
    }

    let msequence = materialize_sequence(&mut app, &sequence);
    let msequence_entity = app
        .world_mut()
        .spawn((
            msequence,
            InstanceClock {
                position: Duration::from_secs(5),
                ..Default::default()
            },
        ))
        .id();

    let mut updated_sequence = sequence.clone();
    updated_sequence.steps = vec![cue_b.identifiers.uid.into()];
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(updated_sequence).unwrap();
    }

    app.update();

    let msequence = app
        .world()
        .get::<MaterializedSequence>(msequence_entity)
        .expect("materialized sequence should remain active after first cue deletion");
    assert_eq!(msequence.position(), 1);
    assert_eq!(msequence.current().identifiers.uid, cue_b.identifiers.uid);
    assert_eq!(
        msequence
            .runtime_status_at_clock(app.world().get::<InstanceClock>(msequence_entity))
            .transition_elapsed,
        Some(Duration::ZERO)
    );
}

/// Verifies deleting the final runnable cue releases the running sequence playback.
#[test]
fn sequence_definition_delete_all_cues_marks_playback_for_release() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(
        Update,
        rematerialize_sequences_after_sequence_definition_change,
    );

    let cue = Cue {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::new_v4(),
            label: "Only".to_string(),
        },
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue.clone()).unwrap();
    }

    let sequence = build_sequence("delete all cues", vec![cue.identifiers.uid.into()]);
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(sequence.clone()).unwrap();
    }

    let msequence = materialize_sequence(&mut app, &sequence);
    let msequence_entity = app.world_mut().spawn(msequence).id();

    let mut updated_sequence = sequence.clone();
    updated_sequence.steps = Vec::new();
    {
        let mut sequence_data_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_data_provider.add(updated_sequence).unwrap();
    }

    app.update();

    assert!(
        app.world().get::<ReleaseMarker>(msequence_entity).is_some(),
        "empty updated sequence should release the running instance"
    );
}

#[test]
fn cue_definition_change_rematerializes_fixture_timing_overrides() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixture_refs = add_two_element_fixture(app.world_mut(), 601);
    let cue_uid = Uuid::new_v4();
    let cue = Cue {
        identifiers: Identifiers {
            id: 29,
            uid: cue_uid,
            label: "fanned timing".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(fixture_refs.clone()).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                )]),
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Interpolated {
                        start: Duration::ZERO,
                        end: Duration::from_secs(2),
                    }),
                    ..Default::default()
                },
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue.clone()).unwrap();
    }

    let sequence = build_sequence("seq", vec![cue_uid.into()]);
    let mut msequence = {
        let mut system_state = SystemState::<(
            Res<DataProvider<Cue>>,
            Res<FixtureDataProviderExt>,
            SpatialSelectionResolver,
            Query<InstanceRef<Parameter>>,
        )>::new(app.world_mut());
        let (cue_data_provider, fixture_data_provider, selection_resolver, parameter_query) =
            system_state
                .get(app.world_mut())
                .expect("test system parameters should be available");

        MaterializedSequence::materialize(
            &sequence,
            &cue_data_provider,
            &fixture_data_provider,
            &parameter_query,
            &selection_resolver,
        )
    };

    assert_eq!(
        msequence.mcues[0].max_delay_in,
        Duration::from_secs(2),
        "initial materialization should use the instruction fan"
    );
    let original_start_time = Instant::now() - Duration::from_secs(10);
    let original_start_position = Duration::from_millis(250);
    msequence.mcues[0].set_activation_time(original_start_time);
    msequence.mcues[0].set_start_position(original_start_position);
    let msequence_entity = app.world_mut().spawn(msequence).id();

    app.add_systems(Update, rematerialize_sequences_after_cue_definition_change);

    let updated_cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(fixture_refs.clone()).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                )]),
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Interpolated {
                        start: Duration::ZERO,
                        end: Duration::from_secs(2),
                    }),
                    ..Default::default()
                },
                transitions_by_fixture_attribute: vec![FixtureAttributeTransition {
                    fixture: FixtureRef {
                        fixture_uid: fixture_refs[0].fixture_uid,
                        index: None,
                    },
                    transitions_by_attribute: HashMap::from([(
                        Attribute::Intensity,
                        PartialTransition {
                            delay_in: Some(TransitionMode::Fixed(Duration::from_secs(5))),
                            ..Default::default()
                        },
                    )]),
                }],
                ..Default::default()
            },
        }],
        ..cue
    };

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(updated_cue).unwrap();
    }

    app.update();

    let msequence = app
        .world()
        .get::<MaterializedSequence>(msequence_entity)
        .expect("materialized sequence should still exist");
    assert_eq!(msequence.mcues[0].max_delay_in, Duration::from_secs(5));
    for (_, (_, transition)) in msequence.mcues[0].values.absolute.iter() {
        assert_eq!(
            transition
                .as_ref()
                .expect("updated materialized value should have a transition")
                .start_position,
            original_start_position
        );
    }
}

/// Verifies cue rematerialization preserves implicit HTP assertion timing metadata.
#[test]
fn cue_definition_change_rematerializes_implicit_htp_timing() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 604, Attribute::White);
    app.world_mut()
        .get_mut::<Parameter>(parameter.entity())
        .expect("white parameter should exist")
        .metadata
        .merge_type = MergeStrategy::HTP;
    let cue_one_uid = Uuid::new_v4();
    let cue_two_uid = Uuid::new_v4();
    let mut cue_one = cue_with_parameter(
        32,
        cue_one_uid,
        "wrapped white on",
        fixture_ref.clone(),
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        PartialTransition::default(),
    );
    cue_one.trigger = CueTriggerType::AfterDelay(Duration::from_secs(1));
    let mut cue_two = cue_with_parameter(
        33,
        cue_two_uid,
        "wrapped white off",
        fixture_ref,
        Attribute::White,
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(414))),
            ..Default::default()
        },
    );
    cue_two.trigger = CueTriggerType::FollowPrevious;

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_one).unwrap();
        cue_data_provider.add(cue_two.clone()).unwrap();
    }

    let mut sequence = build_sequence(
        "rematerialized wrapped htp timing",
        vec![cue_one_uid.into(), cue_two_uid.into()],
    );
    sequence.wrap = true;
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.next_at_playback_position(Some(Duration::ZERO));
    let off_complete_clock = InstanceClock {
        position: Duration::from_secs(1),
        ..Default::default()
    };
    let off_complete =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&off_complete_clock));
    assert_eq!(
        *off_complete
            .absolute
            .get(&parameter)
            .expect("off cue should assert white"),
        0.0
    );
    let msequence_entity = app.world_mut().spawn(msequence).id();

    app.add_systems(Update, rematerialize_sequences_after_cue_definition_change);

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue_two).unwrap();
    }

    app.update();

    let mut msequence = app
        .world_mut()
        .entity_mut(msequence_entity)
        .take::<MaterializedSequence>()
        .expect("materialized sequence should still exist");
    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    msequence.next_at_playback_position(Some(Duration::from_secs(1)));
    let caught_up_clock = InstanceClock {
        position: Duration::from_millis(1001),
        ..Default::default()
    };
    let caught_up =
        render_sequence_layer_at_clock(&mut app, &mut msequence, Some(&caught_up_clock));
    app.world_mut()
        .entity_mut(msequence_entity)
        .insert(msequence);

    let value = *caught_up
        .absolute
        .get(&parameter)
        .expect("rematerialized off cue should still assert white");
    assert!(
        value > 250.0,
        "rematerialized HTP off cue should keep implicit timing metadata, got {value}"
    );
}

/// Verifies cue rematerialization preserves source-local transition anchors.
#[test]
fn cue_definition_change_preserves_clocked_transition_anchors() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 602, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        30,
        cue_uid,
        "clocked",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 100.0 },
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(200))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_millis(300))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue.clone()).unwrap();
    }

    let sequence = build_sequence("clocked rematerialize", vec![cue_uid.into()]);
    let mut msequence = materialize_sequence(&mut app, &sequence);
    let original_start_time = Instant::now() - Duration::from_secs(10);
    let original_start_position = Duration::from_millis(750);
    let original_release_position = Duration::from_millis(1200);
    msequence.mcues[0].set_activation_time(original_start_time);
    msequence.mcues[0].set_start_position(original_start_position);
    msequence.mcues[0].release_at_playback_position(Some(original_release_position));
    let msequence_entity = app.world_mut().spawn(msequence).id();

    app.add_systems(Update, rematerialize_sequences_after_cue_definition_change);

    let updated_cue = cue_with_parameter(
        30,
        cue_uid,
        "clocked",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 150.0 },
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(400))),
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_millis(600))),
            ..Default::default()
        },
    );
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(updated_cue).unwrap();
    }

    app.update();

    let msequence = app
        .world()
        .get::<MaterializedSequence>(msequence_entity)
        .expect("materialized sequence should still exist");
    let mcue = &msequence.mcues[0];
    assert_eq!(mcue.activation_time, original_start_time);
    assert_eq!(mcue.start_position, original_start_position);
    assert_eq!(mcue.release_position, Some(original_release_position));

    let transition = mcue
        .values
        .absolute
        .get(&parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("updated materialized value should keep its transition");
    assert_eq!(transition.delay_in, Duration::from_millis(400));
    assert_eq!(transition.fade_in, Duration::from_millis(500));
    assert_eq!(transition.fade_out, Duration::from_millis(600));
    assert_eq!(transition.start_position, original_start_position);
    assert_eq!(transition.release_position, Some(original_release_position));
}

/// Verifies cue rematerialization leaves unreleased cues without source-local release anchors.
#[test]
fn cue_definition_change_preserves_absent_release_position() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameter) =
        add_single_parameter_fixture(app.world_mut(), 603, Attribute::Intensity);
    let cue_uid = Uuid::new_v4();
    let cue = cue_with_parameter(
        31,
        cue_uid,
        "legacy released",
        fixture_ref.clone(),
        Attribute::Intensity,
        ParameterValue::Absolute { value: 100.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_millis(300))),
            ..Default::default()
        },
    );

    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(cue.clone()).unwrap();
    }

    let sequence = build_sequence("legacy rematerialize", vec![cue_uid.into()]);
    let mut msequence = materialize_sequence(&mut app, &sequence);
    msequence.mcues[0].release_position = None;
    let msequence_entity = app.world_mut().spawn(msequence).id();

    app.add_systems(Update, rematerialize_sequences_after_cue_definition_change);

    let updated_cue = cue_with_parameter(
        31,
        cue_uid,
        "legacy released",
        fixture_ref,
        Attribute::Intensity,
        ParameterValue::Absolute { value: 150.0 },
        PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_millis(600))),
            ..Default::default()
        },
    );
    {
        let mut cue_data_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_data_provider.add(updated_cue).unwrap();
    }

    app.update();

    let msequence = app
        .world()
        .get::<MaterializedSequence>(msequence_entity)
        .expect("materialized sequence should still exist");
    let mcue = &msequence.mcues[0];
    assert_eq!(mcue.release_position, None);

    let transition = mcue
        .values
        .absolute
        .get(&parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("updated materialized value should keep its transition");
    assert_eq!(transition.fade_out, Duration::from_millis(600));
    assert_eq!(transition.release_position, None);
}
