// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Seed the LED-strip waveform effects and their clips.
pub(super) fn add_bstrip_fx(world: &mut World) {
    let mut system_state: SystemState<(
        Commands,
        ResMut<FixtureDataProviderExt>,
        ResMut<DataProvider<Fx>>,
    )> = SystemState::new(world);
    let (mut commands, fixture_data_provider, mut fx_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    #[rustfmt::skip]
    let fixture_rows: [[u32; 10]; 4] = [
        [325, 324, 323, 322, 321, 311, 312, 313, 314, 315],
        [345, 344, 343, 342, 341, 331, 332, 333, 334, 335],
        [365, 364, 363, 362, 361, 351, 352, 353, 354, 355],
        [385, 384, 383, 382, 381, 371, 372, 373, 374, 375],
    ];
    // Convert fixture IDs to FixtureRefs for all elements in the fixtures,
    // preserving row structure for spatial clauses
    let selection_rows: Vec<Vec<FixtureRef>> = fixture_rows
        .iter()
        .map(|row| {
            row.iter()
                .flat_map(|fixture_id| {
                    let fixture = fixture_data_provider
                        .inner
                        .from_id(*fixture_id)
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
                .collect()
        })
        .collect();

    // Flatten selection_rows to get a single list of FixtureRefs for the Resolved selection
    let selection_elements: Vec<FixtureRef> = selection_rows.into_iter().flatten().collect();

    let bstrip_selection = SelectionExpr::Resolved(selection_elements.clone());

    let waveform = FxWaveform {
        params: FxWaveformParams {
            kind: WaveformKind::Sin,
            min: 0.0,
            max: 255.0,
            duty_cycle: 1.0,
        },
        phase_range: (0.0, 2.0 * std::f32::consts::PI),
        rate: Duration::from_secs(4),
        width: Percentage::from(1.0),
        is_relative: false,
    };
    fx_data_provider
        .add(Fx {
            identifiers: Identifiers {
                id: 3,
                label: "fx3".to_owned(),
                uid: Uuid::from_str("b72e2314-1e75-48ee-a8b1-3595943aada1").unwrap(),
            },
            selection: bstrip_selection.clone().into(),
            attributes: HashMap::from([(Attribute::Red, waveform.to_owned())]),
        })
        .expect("sample data should not have duplicate IDs");
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 6,
            label: "fx3".to_owned(),
            uid: Uuid::from_str("324d1219-7c36-4c7f-a01e-29dbad6c3b3c").unwrap(),
        },
        source: Some(Source::Fx(
            Uuid::from_str("b72e2314-1e75-48ee-a8b1-3595943aada1").unwrap(),
        )),
        ..Default::default()
    });
    let _ = fx_data_provider.add(Fx {
        identifiers: Identifiers {
            id: 4,
            label: "fx4".to_owned(),
            uid: Uuid::from_str("0547658e-1f84-4313-a9e3-b3092b8048bf").unwrap(),
        },
        selection: bstrip_selection.clone().into(),
        attributes: HashMap::from([(Attribute::Blue, waveform.to_owned())]),
    });
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 7,
            label: "fx4".to_owned(),
            uid: Uuid::from_str("fddef9fd-9a9c-4f31-95da-d432ad079f17").unwrap(),
        },
        source: Some(Source::Fx(
            Uuid::from_str("0547658e-1f84-4313-a9e3-b3092b8048bf").unwrap(),
        )),
        ..Default::default()
    });

    let waveform = FxWaveform {
        params: FxWaveformParams {
            kind: WaveformKind::Sin,
            min: 10.0,
            max: 70.0,
            duty_cycle: 1.0,
        },
        phase_range: (0.0, 2.0 * std::f32::consts::PI),
        rate: Duration::from_secs(2),
        width: Percentage::from(1.0),
        is_relative: false,
    };
    let _ = fx_data_provider.add(Fx {
        identifiers: Identifiers {
            id: 5,
            label: "fx5".to_owned(),
            uid: Uuid::from_str("a8733b39-c02f-4198-ad15-22e461586a1e").unwrap(),
        },
        selection: bstrip_selection.clone().into(),
        attributes: HashMap::from([(Attribute::Green, waveform)]),
    });
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 8,
            label: "fx5".to_owned(),
            uid: Uuid::from_str("fdef00a2-46e8-4808-b1a3-3fecb2923042").unwrap(),
        },
        source: Some(Source::Fx(
            Uuid::from_str("a8733b39-c02f-4198-ad15-22e461586a1e").unwrap(),
        )),
        ..Default::default()
    });

    system_state.apply(world);
}

/// Seed step effects that demonstrate spatial behavior in the visualizer.
pub(super) fn add_visualizer_demo_fx(world: &mut World) {
    let mut system_state: SystemState<Commands> = SystemState::new(world);
    let mut commands = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    // 1. Rainbow cycle StepFx for all bstrips (groups 3-10: bstrip 1-4, left and right)
    let bstrip_selection = SelectionExpr::Group(GroupRefExpr::RangeById { start: 3, end: 10 });

    // Rainbow uses 3 sine waves offset by 120° for R, G, B
    let rainbow_step_fx = StepFx {
        identifiers: Identifiers {
            id: 100,
            label: "Rainbow Cycle".to_owned(),
            uid: Uuid::from_str("f1000001-0000-0000-0000-000000000001").unwrap(),
        },
        timing: StepFxTiming {
            beat_duration: Duration::from_secs(8),
        },
        selection: bstrip_selection.clone().into(),
        phase: StepFxPhase::default(),
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![
            FxLane {
                attribute: Attribute::Red,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.334,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Green,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.334,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Blue,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.334,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
        ],
    };
    commands.spawn(rainbow_step_fx);
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 26,
            label: "Rainbow Cycle".to_owned(),
            uid: Uuid::from_str("6b6c3181-d29b-4d53-8f4c-c05c59f07601").unwrap(),
        },
        source: Some(Source::StepFx(
            Uuid::from_str("f1000001-0000-0000-0000-000000000001").unwrap(),
        )),
        ..Default::default()
    });

    // 2. Pan/Tilt circle effect for moving heads (groups 13-14: Spots Front + Spots Rear)
    let moving_head_selection =
        SelectionExpr::Group(GroupRefExpr::RangeById { start: 13, end: 14 });

    // Circle motion: Pan and Tilt with 90° phase offset
    // Both use 4 steps at 25% width each, hitting targets at t=0.25, 0.50, 0.75, 1.00
    // Pan (cosine): max → center → min → center → max
    // Tilt (sine):  center → max → center → min → center (90° behind Pan)
    let circle_step_fx = StepFx {
        identifiers: Identifiers {
            id: 101,
            label: "Circle Motion".to_owned(),
            uid: Uuid::from_str("f1000001-0000-0000-0000-000000000002").unwrap(),
        },
        timing: StepFxTiming {
            beat_duration: Duration::from_secs(4),
        },
        selection: moving_head_selection.clone().into(),
        phase: StepFxPhase {
            waypoints: vec![0.0, 1.0],
            ..Default::default()
        },
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![
            // Pan (cosine): starts at +50, targets define where we arrive
            // t=0.25→0(center), t=0.50→-50(min), t=0.75→0(center), t=1.00→+50(max)
            FxLane {
                attribute: Attribute::Pan,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: 0.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: -50.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: 0.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: 50.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
            // Tilt (sine, 90° offset): starts at 0(center), targets define where we arrive
            // t=0.25→+50(max), t=0.50→0(center), t=0.75→-50(min), t=1.00→0(center)
            FxLane {
                attribute: Attribute::Tilt,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: 50.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: 0.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: -50.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::Absolute { value: 0.0 },
                            blueprint_uid: None,
                            width_beats: 0.25,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
        ],
    };
    commands.spawn(circle_step_fx);
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 27,
            label: "Circle Motion".to_owned(),
            uid: Uuid::from_str("ac08f795-9e9c-4fae-b714-0810b0cebecb").unwrap(),
        },
        source: Some(Source::StepFx(
            Uuid::from_str("f1000001-0000-0000-0000-000000000002").unwrap(),
        )),
        ..Default::default()
    });

    // 3. White bounce chase for bstrips (groups 3-10)
    // Chase effect: intensity pulses through selection with phase spread
    let chase_step_fx = StepFx {
        identifiers: Identifiers {
            id: 102,
            label: "White Bounce".to_owned(),
            uid: Uuid::from_str("f1000001-0000-0000-0000-000000000003").unwrap(),
        },
        timing: StepFxTiming {
            beat_duration: Duration::from_millis(6000),
        },
        selection: bstrip_selection.clone().into(),
        phase: StepFxPhase::default(),
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![
            FxLane {
                attribute: Attribute::VirtualIntensity,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.15,
                            transition: 0.5.into(),
                            curve: CurveType::Bezier(Bezier::EASE_OUT),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.85,
                            transition: 0.2.into(),
                            curve: CurveType::Bezier(Bezier::EASE_IN),
                        },
                    ],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Red,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Snap(Snap {}),
                    }],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Green,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Snap(Snap {}),
                    }],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Blue,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Snap(Snap {}),
                    }],
                }),
                relative: None,
            },
        ],
    };
    commands.spawn(chase_step_fx);
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 28,
            label: "White Bounce".to_owned(),
            uid: Uuid::from_str("f281d741-b4af-420f-a0de-f145c1293544").unwrap(),
        },
        source: Some(Source::StepFx(
            Uuid::from_str("f1000001-0000-0000-0000-000000000003").unwrap(),
        )),
        ..Default::default()
    });

    // 4. White bounce chase for bstrips - single bar at a time (no trail, groups 3-10)
    let single_bar_fx = StepFx {
        identifiers: Identifiers {
            id: 103,
            label: "White Bounce Single".to_owned(),
            uid: Uuid::from_str("f1000001-0000-0000-0000-000000000004").unwrap(),
        },
        timing: StepFxTiming {
            beat_duration: Duration::from_millis(8000),
        },
        selection: bstrip_selection.into(),
        phase: StepFxPhase {
            waypoints: vec![0.0, 1.0],
            ..Default::default()
        },
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![
            FxLane {
                attribute: Attribute::VirtualIntensity,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.025,
                            transition: 0.0.into(),
                            curve: CurveType::Snap(Snap {}),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.975,
                            transition: 0.0.into(),
                            curve: CurveType::Snap(Snap {}),
                        },
                    ],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Red,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Snap(Snap {}),
                    }],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Green,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Snap(Snap {}),
                    }],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Blue,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![FxStep {
                        uid: Uuid::new_v4(),
                        target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                        blueprint_uid: None,
                        width_beats: 1.0,
                        transition: 0.0.into(),
                        curve: CurveType::Snap(Snap {}),
                    }],
                }),
                relative: None,
            },
        ],
    };
    commands.spawn(single_bar_fx);

    // 5. Manual strobe pixel rainbow (fixture 601 RGB pixels only)
    let strobe_pixel_rainbow_fx = StepFx {
        identifiers: Identifiers {
            id: 601,
            label: "Strobe Pixel Rainbow".to_owned(),
            uid: Uuid::from_str("f1000001-0000-0000-0000-000000000005").unwrap(),
        },
        timing: StepFxTiming {
            beat_duration: Duration::from_secs(8),
        },
        selection: SelectionExpr::FixtureMap {
            fixtures: FixtureRangeExpr {
                start: 601,
                end: 601,
            },
            elements: ElementSelectorExpr::Range {
                start: 20,
                end: 115,
            },
        }
        .into(),
        phase: StepFxPhase::default(),
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![
            FxLane {
                attribute: Attribute::Red,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.334,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Green,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.334,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
            FxLane {
                attribute: Attribute::Blue,
                timing_override: None,
                phase_override: None,
                absolute: Some(FxTrack {
                    steps: vec![
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 0.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.333,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                        FxStep {
                            uid: Uuid::new_v4(),
                            target: ParameterValue::AbsolutePercent { value: 1.0.into() },
                            blueprint_uid: None,
                            width_beats: 0.334,
                            transition: 1.0.into(),
                            curve: CurveType::Bezier(Bezier::EASE),
                        },
                    ],
                }),
                relative: None,
            },
        ],
    };
    commands.spawn(strobe_pixel_rainbow_fx);

    system_state.apply(world);
}

#[allow(unused_mut, dead_code)]
/// Seed the baseline waveform effects and their clip bindings.
pub(super) fn add_fx(world: &mut World) {
    let mut system_state: SystemState<(ResMut<DataProvider<Fx>>, Commands)> =
        SystemState::new(world);
    let (mut fx_data_provider, mut commands) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");

    // fx 1 - Single fixture (Fixture 13)
    let fx_selection = SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 13,
        element_index: None,
    });

    let waveform = FxWaveform {
        params: FxWaveformParams {
            kind: WaveformKind::Sin,
            min: 10.0,
            max: 70.0,
            duty_cycle: 1.0,
        },
        phase_range: (0.0, 2.0 * std::f32::consts::PI),
        rate: Duration::from_secs(2),
        width: Percentage::from(1.0),
        is_relative: false,
    };
    let _ = fx_data_provider.add(Fx {
        identifiers: Identifiers {
            id: 1,
            label: "fx1".to_owned(),
            uid: Uuid::from_str("c4141177-09e4-474f-abe6-ebf68f30a745").unwrap(),
        },
        selection: fx_selection.clone().into(),
        attributes: HashMap::from([(Attribute::Red, waveform)]),
    });
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 4,
            label: "fx1".to_owned(),
            uid: Uuid::from_str("4e6e5de7-8d40-4508-86a5-73583daea8f9").unwrap(),
        },
        source: Some(Source::Fx(
            Uuid::from_str("c4141177-09e4-474f-abe6-ebf68f30a745").unwrap(),
        )),
        ..Default::default()
    });

    // fx 2
    let waveform = FxWaveform {
        params: FxWaveformParams {
            kind: WaveformKind::Sin,
            min: 10.0,
            max: 70.0,
            duty_cycle: 1.0,
        },
        phase_range: (0.0, 2.0 * std::f32::consts::PI),
        rate: Duration::from_secs(2),
        width: Percentage::from(1.0),
        is_relative: false,
    };
    let _ = fx_data_provider.add(Fx {
        identifiers: Identifiers {
            id: 2,
            label: "fx2".to_owned(),
            uid: Uuid::from_str("a2595aeb-abf8-4dda-9726-23121b1846b2").unwrap(),
        },
        selection: fx_selection.into(),
        attributes: HashMap::from([(Attribute::Blue, waveform)]),
    });
    commands.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 5,
            label: "fx2".to_owned(),
            uid: Uuid::from_str("eddc2d67-deb6-4aa3-af4d-74bc6a1bc9bb").unwrap(),
        },
        source: Some(Source::Fx(
            Uuid::from_str("a2595aeb-abf8-4dda-9726-23121b1846b2").unwrap(),
        )),
        ..Default::default()
    });

    system_state.apply(world);
}
