// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Builds a color-only effect with distinct endpoints and variable widths.
fn color_fx() -> StepFx {
    StepFx {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::new_v4(),
            label: "Color test".into(),
        },
        color_lane: Some(FxColorLane {
            steps: [
                ColorPathRgb {
                    red: 1.0,
                    green: 0.0,
                    blue: 0.0,
                },
                ColorPathRgb {
                    red: 0.0,
                    green: 0.0,
                    blue: 1.0,
                },
            ]
            .into_iter()
            .enumerate()
            .map(|(index, target)| FxColorStep {
                uid: Uuid::new_v4(),
                target,
                blueprint_uid: None,
                width_beats: (index + 1) as f32,
                transition: StepFxTransition::default(),
                curve: CurveType::Linear(Linear {}),
            })
            .collect(),
        }),
        ..Default::default()
    }
}

/// Ensures colors share scalar phase, direction, width, and shaping semantics exactly.
#[test]
fn color_components_match_independent_scalar_sampling() {
    for direction in [
        FxDirection::Forward,
        FxDirection::Reverse,
        FxDirection::Bounce,
    ] {
        let mut color = color_fx();
        color.direction = direction;
        for curve in [CurveType::Linear(Linear {}), CurveType::Snap(Snap {})] {
            color.color_lane.as_mut().unwrap().steps[0].curve = curve;
            color.color_lane.as_mut().unwrap().steps[0].transition =
                StepFxTransition::new(0.2.into(), 0.8.into());
            let mut scalar = color.clone();
            scalar.lanes = vec![FxLane {
                attribute: Attribute::Red,
                timing_override: None,
                phase_override: None,
                relative: None,
                absolute: Some(FxTrack {
                    steps: color
                        .color_lane
                        .as_ref()
                        .unwrap()
                        .steps
                        .iter()
                        .map(|step| FxStep {
                            uid: step.uid,
                            target: ParameterValue::AbsolutePercent {
                                value: step.target.red.into(),
                            },
                            blueprint_uid: None,
                            width_beats: step.width_beats,
                            transition: step.transition.clone(),
                            curve: step.curve.clone(),
                        })
                        .collect(),
                }),
            }];
            scalar.color_lane = None;
            for index in 0..4 {
                for tick in 0..40 {
                    let elapsed = Duration::from_millis(tick * 97);
                    let sampled = color.sample_color(elapsed, index, 4, 0.0, None).unwrap();
                    let expected = scalar.sample_for_selection_index(elapsed, index, 4)[0]
                        .absolute
                        .unwrap();
                    let ParameterValue::AbsolutePercent { value } = expected else {
                        panic!("expected percentage")
                    };
                    assert!((sampled.red - value.as_f32()).abs() < 0.0001);
                    assert!((sampled.red + sampled.blue - 1.0).abs() < 0.0001);
                }
            }
        }
    }
}

/// Rejects overlapping ownership while allowing non-color lanes and validates persistence.
#[test]
fn color_validation_and_round_trip() {
    let mut fx = color_fx();
    assert!(fx.validate().is_empty());
    let serialized = serde_json::to_string(&fx).unwrap();
    assert_eq!(serde_json::from_str::<StepFx>(&serialized).unwrap(), fx);
    fx.lanes.push(FxLane {
        attribute: Attribute::Red,
        timing_override: None,
        phase_override: None,
        absolute: Some(FxTrack {
            steps: vec![FxStep::new(
                ParameterValue::AbsolutePercent { value: 1.0.into() },
                1.0,
                1.0.into(),
                CurveType::Linear(Linear {}),
            )],
        }),
        relative: None,
    });
    assert!(fx.validate().iter().any(|issue| issue.path == "color_lane"));
    fx.lanes[0].attribute = Attribute::Intensity;
    assert!(fx.validate().is_empty());
    fx.color_lane.as_mut().unwrap().steps[0].target.green = f32::NAN;
    assert!(!fx.validate().is_empty());
}

/// Live Blueprint changes alter playback without rewriting the stored fallback or identity.
#[test]
fn color_blueprint_reference_remains_live_and_remappable() {
    let mut fx = color_fx();
    let uid = Uuid::new_v4();
    let replacement = Uuid::new_v4();
    let mut provider = DataProvider::<Blueprint>::default();
    let mut blueprint = Blueprint {
        identifiers: Identifiers {
            id: 1,
            uid,
            label: "Color".into(),
        },
        values: [Attribute::Red, Attribute::Green, Attribute::Blue]
            .into_iter()
            .map(|attribute| {
                (
                    attribute,
                    ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.25.into() }),
                )
            })
            .collect(),
        ..Default::default()
    };
    provider.add(blueprint.clone()).unwrap();
    let step = &mut fx.color_lane.as_mut().unwrap().steps[0];
    step.blueprint_uid = Some(uid);
    assert_eq!(resolved_color(step, Some(&provider)).green, 0.25);
    blueprint.values.insert(
        Attribute::Green,
        ValueSource::Inline(ParameterValue::AbsolutePercent { value: 0.75.into() }),
    );
    provider.add(blueprint).unwrap();
    assert_eq!(resolved_color(step, Some(&provider)).green, 0.75);
    assert_eq!(step.target.green, 0.0);
    assert_eq!(fx.blueprint_references().count(), 3);
    fx.remap_blueprint_references(&HashMap::from([(uid, replacement)]));
    assert_eq!(
        fx.color_lane.as_ref().unwrap().steps[0].blueprint_uid,
        Some(replacement)
    );
    assert_eq!(
        resolved_color(&fx.color_lane.as_ref().unwrap().steps[0], Some(&provider)).red,
        1.0
    );
}
