// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Seed the half-scale absolute cue sequence and its clip.
#[allow(unused_mut, dead_code)]
pub(super) fn add_abs_128_cue(world: &mut World) {
    let mut system_state: SystemState<(
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Cue>>,
        ResMut<DataProvider<Sequence>>,
    )> = SystemState::new(world);
    let (mut fixture_data_provider, mut cue_data_provider, mut seq_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    let selection_elements: Vec<FixtureRef> = vec![
        // the fixtures whose elements we will select
        311, 312, 313, 314, 315, 321, 322, 323, 324, 325, 331, 332, 333, 334, 335, 341, 342, 343,
        344, 345, 351, 352, 353, 354, 355, 361, 362, 363, 364, 365, 371, 372, 373, 374, 375, 381,
        382, 383, 384, 385,
    ]
    .into_iter()
    .flat_map(|fixture_id| {
        // create an elementref for the elements on the particular fixture
        let fixture = fixture_data_provider
            .inner
            .from_id(fixture_id)
            .expect("failed to obtain fixture");

        fixture
            .elements
            .iter()
            .enumerate()
            .map(|(index, _)| FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(index as u32 + 1),
            })
            .collect::<Vec<_>>()
    })
    .collect();

    let selection = SelectionExpr::Resolved(selection_elements.clone());

    let transition = PartialTransition {
        delay_in: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        delay_out: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        curve_in: Some(FadeCurve::Linear),
        curve_out: Some(FadeCurve::Linear),
    };

    let cue1 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("5011047c-c1bb-4564-b621-d0da95587776").unwrap(),
            id: 1,
            label: "cue 1".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue2 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("358919fa-b6b0-47ec-85c8-47298389bc41").unwrap(),
            id: 2,
            label: "cue 2".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue3 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("9de3fae8-77ac-4a60-82cb-cdd4dba72cbd").unwrap(),
            id: 3,
            label: "cue 3".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("9ae7c3c6-2d4d-415f-a99a-f115a8cf3f2e").unwrap(),
            id: 2,
            label: "sequence 2 (abs 128)".to_owned(),
        },
        steps: vec![
            cue1.identifiers.uid.into(),
            cue2.identifiers.uid.into(),
            cue3.identifiers.uid.into(),
        ],
        wrap: true,
        ..Default::default()
    };

    let clip = Clip {
        identifiers: Identifiers {
            uid: Uuid::from_str("25de4124-c9af-4c63-8358-b0444eacb4b2").unwrap(),
            id: 2,
            label: "128/0/0".to_owned(),
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        ..Default::default()
    };

    cue_data_provider
        .add(cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue2)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue3)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(sequence)
        .expect("sample data should not have duplicate IDs");
    world.spawn_instance(clip);
}

/// Seed the full-scale absolute cue sequence and its clip.
#[allow(unused_mut, dead_code)]
pub(super) fn add_abs_255_cue(world: &mut World) {
    let mut system_state: SystemState<(
        Commands,
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Cue>>,
        ResMut<DataProvider<Sequence>>,
    )> = SystemState::new(world);
    let (mut commands, mut fixture_data_provider, mut cue_data_provider, mut seq_data_provider) =
        system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");

    let selection_elements: Vec<FixtureRef> = vec![
        // the fixtures whose elements we will select
        311, 312, 313, 314, 315, 321, 322, 323, 324, 325, 331, 332, 333, 334, 335, 341, 342, 343,
        344, 345, 351, 352, 353, 354, 355, 361, 362, 363, 364, 365, 371, 372, 373, 374, 375, 381,
        382, 383, 384, 385,
    ]
    .into_iter()
    .flat_map(|fixture_id| {
        // create an elementref for the elements on the particular fixture
        let fixture = fixture_data_provider
            .inner
            .from_id(fixture_id)
            .expect("failed to obtain fixture");

        fixture
            .elements
            .iter()
            .enumerate()
            .map(|(index, _)| FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(index as u32 + 1),
            })
            .collect::<Vec<_>>()
    })
    .collect();

    let selection = SelectionExpr::Resolved(selection_elements.clone());

    let transition = PartialTransition {
        delay_in: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        delay_out: Some(TransitionMode::Fixed(Duration::from_secs(0))), // FIXME: see commands on layer.merge for issue description
        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        curve_in: Some(FadeCurve::Linear),
        curve_out: Some(FadeCurve::Linear),
    };

    let cue1 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("34a3af80-539c-4ddc-97d3-c2e50606cbe3").unwrap(),
            id: 1,
            label: "cue 1".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue2 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("25b2a0a0-b551-4b4a-a486-dfea0c6e464e").unwrap(),
            id: 2,
            label: "cue 2".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue3 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("742f5200-8272-4446-b42a-220b2129cbf7").unwrap(),
            id: 3,
            label: "cue 3".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue4 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("fae8fc00-2c4c-4c6c-acb7-f7f4562ecf2b").unwrap(),
            id: 4,
            label: "cue 4".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("93b6f333-e3bb-4a84-ba7b-a3f2a8a695cf").unwrap(),
            id: 1,
            label: "sequence 1 (abs 255)".to_owned(),
        },
        steps: vec![
            cue1.identifiers.uid.into(),
            cue2.identifiers.uid.into(),
            cue3.identifiers.uid.into(),
            cue4.identifiers.uid.into(),
        ],
        wrap: true,
        ..Default::default()
    };

    let clip = Clip {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::from_str("cd19c920-ae7c-4d99-8ff4-31fade6dfa69").unwrap(),
            label: "255/0/0".to_owned(),
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        ..Default::default()
    };

    cue_data_provider
        .add(cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue2)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue3)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue4)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(sequence)
        .expect("sample data should not have duplicate IDs");
    commands.spawn_instance(clip);

    system_state.apply(world);
}

/// Seed the first relative-value cue sequence and its clip.
#[allow(unused_mut, dead_code)]
pub(super) fn add_rel_cue(world: &mut World) {
    let mut system_state: SystemState<(
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Cue>>,
        ResMut<DataProvider<Sequence>>,
    )> = SystemState::new(world);
    let (mut fixture_data_provider, mut cue_data_provider, mut seq_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    let selection_elements: Vec<FixtureRef> = vec![
        // the fixtures whose elements we will select
        311, 312, 313, 314, 315, 321, 322, 323, 324, 325, 331, 332, 333, 334, 335, 341, 342, 343,
        344, 345, 351, 352, 353, 354, 355, 361, 362, 363, 364, 365, 371, 372, 373, 374, 375, 381,
        382, 383, 384, 385,
    ]
    .into_iter()
    .flat_map(|fixture_id| {
        // create an elementref for the elements on the particular fixture
        let fixture = fixture_data_provider
            .inner
            .from_id(fixture_id)
            .expect("failed to obtain fixture");

        fixture
            .elements
            .iter()
            .enumerate()
            .map(|(index, _)| FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(index as u32 + 1),
            })
            .collect::<Vec<_>>()
    })
    .collect();

    let selection = SelectionExpr::Resolved(selection_elements.clone());

    let transition = PartialTransition {
        delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        delay_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        curve_in: Some(FadeCurve::Linear),
        curve_out: Some(FadeCurve::Linear),
    };

    let cue1 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("eb7bba2e-b4bf-429f-b731-abb801e68abb").unwrap(),
            id: 11,
            ..Default::default()
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::RelativePercent {
                        offset: (-0.5).into(),
                    }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue2 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("69e0f75b-d2a9-4b07-b07d-7c83a96345ee").unwrap(),
            id: 12,
            ..Default::default()
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Green,
                    ValueSource::Inline(ParameterValue::RelativePercent {
                        offset: (-0.5).into(),
                    }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue3 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a308c48d-13ef-40ea-a3f4-b8fd65a63427").unwrap(),
            id: 13,
            ..Default::default()
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Blue,
                    ValueSource::Inline(ParameterValue::RelativePercent {
                        offset: (-0.5).into(),
                    }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("03b8d62b-e8d1-48b5-b5c5-aae4b1b5e5a9").unwrap(),
            id: 3,
            label: "sequence 3 (rel)".to_owned(),
        },
        steps: vec![
            cue1.identifiers.uid.into(),
            cue2.identifiers.uid.into(),
            cue3.identifiers.uid.into(),
        ],
        wrap: true,
        ..Default::default()
    };

    let clip = Clip {
        identifiers: Identifiers {
            id: 3,
            uid: Uuid::from_str("4bb63e10-eb99-4475-8b2e-093ede1bb247").unwrap(),
            label: "-128 cycle".to_owned(),
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        ..Default::default()
    };

    cue_data_provider
        .add(cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue2)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue3)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(sequence)
        .expect("sample data should not have duplicate IDs");
    world.spawn_instance(clip);
}

/// Seed the second relative-value cue sequence and its clip.
#[allow(unused_mut, dead_code)]
pub(super) fn add_rel_cue2(world: &mut World) {
    let mut system_state: SystemState<(
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Cue>>,
        ResMut<DataProvider<Sequence>>,
    )> = SystemState::new(world);
    let (mut fixture_data_provider, mut cue_data_provider, mut seq_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    let selection_elements: Vec<FixtureRef> = vec![
        // the fixtures whose elements we will select
        311, 312, 313, 314, 315, 321, 322, 323, 324, 325, 331, 332, 333, 334, 335, 341, 342, 343,
        344, 345, 351, 352, 353, 354, 355, 361, 362, 363, 364, 365, 371, 372, 373, 374, 375, 381,
        382, 383, 384, 385,
    ]
    .into_iter()
    .flat_map(|fixture_id| {
        // create an elementref for the elements on the particular fixture
        let fixture = fixture_data_provider
            .inner
            .from_id(fixture_id)
            .expect("failed to obtain fixture");

        fixture
            .elements
            .iter()
            .enumerate()
            .map(|(index, _)| FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(index as u32 + 1),
            })
            .collect::<Vec<_>>()
    })
    .collect();

    let selection = SelectionExpr::Resolved(selection_elements.clone());

    let transition = PartialTransition {
        delay_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        delay_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
        curve_in: Some(FadeCurve::Linear),
        curve_out: Some(FadeCurve::Linear),
    };

    let cue1 = Cue {
        identifiers: Identifiers {
            id: 100,
            ..Default::default()
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::RelativePercent {
                        offset: (-0.5).into(),
                    }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue2 = Cue {
        identifiers: Identifiers {
            id: 101,
            ..Default::default()
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Green,
                    ValueSource::Inline(ParameterValue::RelativePercent {
                        offset: (-0.5).into(),
                    }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let cue3 = Cue {
        identifiers: Identifiers {
            id: 102,
            ..Default::default()
        },
        trigger: CueTriggerType::Manual,
        transitions: transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Blue,
                    ValueSource::Inline(ParameterValue::RelativePercent {
                        offset: (-0.5).into(),
                    }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let sequence = Sequence {
        identifiers: Identifiers {
            id: 4,
            label: "sequence 4 (rel2)".to_owned(),
            ..Default::default()
        },
        steps: vec![
            cue1.identifiers.uid.into(),
            cue2.identifiers.uid.into(),
            cue3.identifiers.uid.into(),
        ],
        wrap: true,
        ..Default::default()
    };

    let clip = Clip {
        identifiers: Identifiers {
            uid: Uuid::from_str("eed8a692-3d8c-4007-b654-5ab597a12ec2").unwrap(),
            id: 9,
            label: "-128 cycle (2)".to_owned(),
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        ..Default::default()
    };

    cue_data_provider
        .add(cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue2)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue3)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(sequence)
        .expect("sample data should not have duplicate IDs");
    world.spawn_instance(clip);
}

/// Seed a cue sequence demonstrating per-fixture fanned transition timing.
#[allow(unused_mut, dead_code)]
pub(super) fn add_fanned_timing_cue(world: &mut World) {
    let mut system_state: SystemState<(
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Cue>>,
        ResMut<DataProvider<Sequence>>,
    )> = SystemState::new(world);
    let (fixture_data_provider, mut cue_data_provider, mut seq_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    let selection_elements: Vec<FixtureRef> = vec![601, 602, 603, 604, 605, 606]
        .into_iter()
        .filter_map(|fixture_id| fixture_data_provider.inner.from_id(fixture_id).ok())
        .flat_map(|fixture| {
            fixture
                .elements
                .iter()
                .enumerate()
                .map(|(index, _)| FixtureRef {
                    fixture_uid: fixture.identifiers.uid,
                    index: Some(index as u32 + 1),
                })
                .collect::<Vec<_>>()
        })
        .collect();

    let selection = SelectionExpr::Resolved(selection_elements);
    let fanned_transition = PartialTransition {
        delay_in: Some(TransitionMode::Interpolated {
            start: Duration::from_millis(0),
            end: Duration::from_secs(2),
        }),
        fade_in: Some(TransitionMode::Interpolated {
            start: Duration::from_millis(250),
            end: Duration::from_millis(2250),
        }),
        delay_out: Some(TransitionMode::Manual(vec![
            Duration::from_millis(0),
            Duration::from_secs(1),
            Duration::from_millis(0),
        ])),
        fade_out: Some(TransitionMode::Interpolated {
            start: Duration::from_millis(2500),
            end: Duration::from_millis(500),
        }),
        curve_in: Some(FadeCurve::Linear),
        curve_out: Some(FadeCurve::Linear),
    };

    let cue = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0005-0001-0001-000000000001").unwrap(),
            id: 30,
            label: "Fanned Timing".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                ]),
                transitions: fanned_transition.clone(),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let release_cue = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0005-0001-0001-000000000002").unwrap(),
            id: 31,
            label: "Fanned Timing Release".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        instructions: vec![BoundCueInstruction {
            selection: selection.into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                    ),
                    (
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.5.into() }),
                    ),
                ]),
                transitions: fanned_transition,
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0005-0001-0001-000000000010").unwrap(),
            id: 30,
            label: "Fanned Timing".to_owned(),
        },
        steps: vec![cue.identifiers.uid.into()],
        wrap: false,
        release_cue,
        ..Default::default()
    };

    let clip = Clip {
        identifiers: Identifiers {
            id: 30,
            uid: Uuid::from_str("a1000001-0005-0001-0001-000000000100").unwrap(),
            label: "Fanned Timing".to_owned(),
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        ..Default::default()
    };

    cue_data_provider
        .add(cue)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(sequence)
        .expect("sample data should not have duplicate IDs");
    world.spawn_instance(clip);
}

/// Adds RGB color fade sequences: each sequence has 2 cues:
/// - Cue 1: Sets color to 100% immediately
/// - Cue 2: Follows immediately and fades to 0% over 2 seconds
///
/// Sequences are assigned to clips 21 (red), 22 (green), 23 (blue)
pub(super) fn add_color_fade_sequences(world: &mut World) {
    let mut system_state: SystemState<(
        Commands,
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Cue>>,
        ResMut<DataProvider<Sequence>>,
    )> = SystemState::new(world);
    let (mut commands, fixture_data_provider, mut cue_data_provider, mut seq_data_provider) =
        system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");

    // Select fixture 601 (manual strobe)
    let selection_elements: Vec<FixtureRef> = {
        let fixture = fixture_data_provider
            .inner
            .from_id(601)
            .expect("failed to obtain fixture 601");

        fixture
            .elements
            .iter()
            .enumerate()
            .map(|(index, _)| FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(index as u32 + 1),
            })
            .collect()
    };

    let selection = SelectionExpr::Resolved(selection_elements);

    // Transition for cue 1: instant (no delay, no fade)
    let instant_transition = PartialTransition {
        delay_in: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        delay_out: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        curve_in: Some(FadeCurve::Linear),
        curve_out: Some(FadeCurve::Linear),
    };

    // Transition for cue 2: fade out over 2 seconds
    let fade_out_transition = PartialTransition {
        delay_in: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
        delay_out: Some(TransitionMode::Fixed(Duration::from_secs(0))),
        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
        curve_in: Some(FadeCurve::Linear),
        curve_out: Some(FadeCurve::Linear),
    };

    // Clip 21 demonstrates a red sequence that fades out after its initial cue.
    let red_cue1 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0001-0001-0001-000000000001").unwrap(),
            id: 1,
            label: "Red 100%".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: instant_transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let red_cue2 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0001-0001-0001-000000000002").unwrap(),
            id: 2,
            label: "Red Fade Out".to_owned(),
        },
        trigger: CueTriggerType::FollowPrevious,
        transitions: fade_out_transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let red_sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0001-0001-0001-000000000010").unwrap(),
            id: 21,
            label: "Red Fade".to_owned(),
        },
        steps: vec![
            red_cue1.identifiers.uid.into(),
            red_cue2.identifiers.uid.into(),
        ],
        wrap: false,
        ..Default::default()
    };

    let red_clip = Clip {
        identifiers: Identifiers {
            id: 21,
            uid: Uuid::from_str("a1000001-0001-0001-0001-000000000100").unwrap(),
            label: "Red Fade".to_owned(),
        },
        source: Some(Source::Sequence(red_sequence.identifiers.uid)),
        ..Default::default()
    };

    // Clip 22 demonstrates the same fade-out behavior on the green channel.
    let green_cue1 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0002-0001-0001-000000000001").unwrap(),
            id: 1,
            label: "Green 100%".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: instant_transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Green,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let green_cue2 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0002-0001-0001-000000000002").unwrap(),
            id: 2,
            label: "Green Fade Out".to_owned(),
        },
        trigger: CueTriggerType::FollowPrevious,
        transitions: fade_out_transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let green_sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0002-0001-0001-000000000010").unwrap(),
            id: 22,
            label: "Green Fade".to_owned(),
        },
        steps: vec![
            green_cue1.identifiers.uid.into(),
            green_cue2.identifiers.uid.into(),
        ],
        wrap: false,
        ..Default::default()
    };

    let green_clip = Clip {
        identifiers: Identifiers {
            id: 22,
            uid: Uuid::from_str("a1000001-0002-0001-0001-000000000100").unwrap(),
            label: "Green Fade".to_owned(),
        },
        source: Some(Source::Sequence(green_sequence.identifiers.uid)),
        ..Default::default()
    };

    // Clip 23 demonstrates the same fade-out behavior on the blue channel.
    let blue_cue1 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0003-0001-0001-000000000001").unwrap(),
            id: 1,
            label: "Blue 100%".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        transitions: instant_transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Blue,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let blue_cue2 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0003-0001-0001-000000000002").unwrap(),
            id: 2,
            label: "Blue Fade Out".to_owned(),
        },
        trigger: CueTriggerType::FollowPrevious,
        transitions: fade_out_transition.clone(),
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let blue_sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0003-0001-0001-000000000010").unwrap(),
            id: 23,
            label: "Blue Fade".to_owned(),
        },
        steps: vec![
            blue_cue1.identifiers.uid.into(),
            blue_cue2.identifiers.uid.into(),
        ],
        wrap: false,
        ..Default::default()
    };

    let blue_clip = Clip {
        identifiers: Identifiers {
            id: 23,
            uid: Uuid::from_str("a1000001-0003-0001-0001-000000000100").unwrap(),
            label: "Blue Fade".to_owned(),
        },
        source: Some(Source::Sequence(blue_sequence.identifiers.uid)),
        ..Default::default()
    };

    // Add all cues
    cue_data_provider
        .add(red_cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(red_cue2)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(green_cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(green_cue2)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(blue_cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(blue_cue2)
        .expect("sample data should not have duplicate IDs");

    // Add all sequences
    seq_data_provider
        .add(red_sequence)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(green_sequence)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(blue_sequence)
        .expect("sample data should not have duplicate IDs");

    // Spawn all clips
    commands.spawn_instance(red_clip);
    commands.spawn_instance(green_clip);
    commands.spawn_instance(blue_clip);

    system_state.apply(world);
}

/// Adds a sequence with nested cue parts for exercising part display, editing,
/// and sequence execution from the UI.
pub(super) fn add_cue_parts_sequence(world: &mut World) {
    let mut system_state: SystemState<(
        Commands,
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Cue>>,
        ResMut<DataProvider<Sequence>>,
    )> = SystemState::new(world);
    let (mut commands, fixture_data_provider, mut cue_data_provider, mut seq_data_provider) =
        system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");

    let selection_elements: Vec<FixtureRef> = {
        let fixture = fixture_data_provider
            .inner
            .from_id(601)
            .expect("failed to obtain fixture 601");

        fixture
            .elements
            .iter()
            .enumerate()
            .map(|(index, _)| FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(index as u32 + 1),
            })
            .collect()
    };

    let selection = SelectionExpr::Resolved(selection_elements);
    let fixed = |duration: Duration| TransitionMode::Fixed(duration);

    let cue1 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0004-0001-0001-000000000001").unwrap(),
            id: 1,
            label: "RGB Parts".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 1.0.into() }),
                )]),
                ..Default::default()
            },
        }],
        parts: vec![
            CuePart {
                identifiers: Identifiers {
                    uid: Uuid::from_str("a1000001-0004-0001-0001-000000000011").unwrap(),
                    id: 1,
                    label: "Green Layer".to_owned(),
                },
                instructions: vec![BoundCueInstruction {
                    selection: selection.clone().into(),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([(
                            Attribute::Green,
                            ValueSource::Inline(ParameterValue::AbsolutePercent {
                                value: 1.0.into(),
                            }),
                        )]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
            CuePart {
                identifiers: Identifiers {
                    uid: Uuid::from_str("a1000001-0004-0001-0001-000000000012").unwrap(),
                    id: 2,
                    label: "Blue Accent".to_owned(),
                },
                transitions: PartialTransition {
                    delay_in: Some(fixed(Duration::from_millis(250))),
                    fade_in: Some(fixed(Duration::from_millis(750))),
                    delay_out: Some(fixed(Duration::from_secs(0))),
                    fade_out: Some(fixed(Duration::from_millis(500))),
                    curve_in: Some(FadeCurve::EaseOut),
                    curve_out: Some(FadeCurve::Linear),
                },
                instructions: vec![BoundCueInstruction {
                    selection: selection.clone().into(),
                    cue_instruction: CueInstruction {
                        blueprint_application: None,
                        values: HashMap::from([
                            (
                                Attribute::Green,
                                ValueSource::Inline(ParameterValue::AbsolutePercent {
                                    value: 0.5.into(),
                                }),
                            ),
                            (
                                Attribute::Blue,
                                ValueSource::Inline(ParameterValue::AbsolutePercent {
                                    value: 1.0.into(),
                                }),
                            ),
                        ]),
                        ..Default::default()
                    },
                }],
                ..Default::default()
            },
        ],
        ..Default::default()
    };

    let cue2 = Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0004-0001-0001-000000000002").unwrap(),
            id: 2,
            label: "RGB Parts Blackout".to_owned(),
        },
        trigger: CueTriggerType::Manual,
        instructions: vec![BoundCueInstruction {
            selection: selection.clone().into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.0.into() }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("a1000001-0004-0001-0001-000000000010").unwrap(),
            id: 29,
            label: "Cue Parts Demo".to_owned(),
        },
        steps: vec![cue1.identifiers.uid.into(), cue2.identifiers.uid.into()],
        wrap: false,
        default_timing: Transition {
            delay_in: fixed(Duration::from_secs(0)),
            fade_in: fixed(Duration::from_millis(1500)),
            curve_in: FadeCurve::EaseInOut,
            delay_out: fixed(Duration::from_secs(0)),
            fade_out: fixed(Duration::from_millis(500)),
            curve_out: FadeCurve::Linear,
        },
        ..Default::default()
    };

    let clip = Clip {
        identifiers: Identifiers {
            id: 29,
            uid: Uuid::from_str("a1000001-0004-0001-0001-000000000100").unwrap(),
            label: "Cue Parts Demo".to_owned(),
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        ..Default::default()
    };

    cue_data_provider
        .add(cue1)
        .expect("sample data should not have duplicate IDs");
    cue_data_provider
        .add(cue2)
        .expect("sample data should not have duplicate IDs");
    seq_data_provider
        .add(sequence)
        .expect("sample data should not have duplicate IDs");
    commands.spawn_instance(clip);

    system_state.apply(world);
}
