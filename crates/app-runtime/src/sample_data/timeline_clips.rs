// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clips adapted from the reference default show for the sample timelines.
//!
//! Selections address the sample groups by ID (3-10 are the bstrip rows, 15 the matrix
//! strobes) so the effects follow the sample rig instead of per-fixture UIDs.

use nightfall::prelude::Axis;
use nightfall_clips::ClipOptions;

use super::*;

/// Pastel rainbow wash on every bstrip; one cycle spans four bars at the lo-fi tempo.
pub(super) const PASTEL_RAINBOW_CLIP_UID: Uuid =
    uuid::uuid!("93d19fe8-b2f3-4672-9b4a-2f02d3f2da49");
/// Shuffled RGB twinkle layered over the bstrips.
pub(super) const SPARKLES_FX_CLIP_UID: Uuid = uuid::uuid!("04ded175-ddf4-4716-9ff3-b0e0abf8b5d2");
/// Intensity lift that makes the sparkle twinkle visible on dark pixels.
pub(super) const SPARKLES_INT_CLIP_UID: Uuid = uuid::uuid!("d77584c1-c80e-46bc-bc91-ff85fe0511a8");
/// One white flash on the matrix strobes, restarted by the timeline on each snare.
pub(super) const SNAP_CLIP_UID: Uuid = uuid::uuid!("d8b7d72c-11d5-4c37-81a6-bd4ce1ddb69d");
/// Row-by-row white cascade across the pixel tapes, timed in 168 BPM eighth notes.
pub(super) const SYNTH_FILL_CLIP_UID: Uuid = uuid::uuid!("386e41a8-4b97-4d4d-8173-cb4b68be7fca");

/// Fast pastel rainbow the lo-fi groove restarts every two beats.
pub(super) const PASTEL_PULSE_CLIP_UID: Uuid = uuid::uuid!("12cd4b41-5de9-4401-92a9-ec9e1d226155");
/// White flash across every bstrip, layered over the rainbow.
pub(super) const BSTRIP_FLASH_CLIP_UID: Uuid = uuid::uuid!("a528607d-e238-4100-a6dc-1db2578f5838");
/// White flash on the top two pixel tape tiers.
pub(super) const BSTRIP_FLASH_TOP_CLIP_UID: Uuid =
    uuid::uuid!("5b0f2d3e-6c1a-4e8b-9f47-2d81c6a3e910");
/// White flash on the bottom two pixel tape tiers.
pub(super) const BSTRIP_FLASH_BOTTOM_CLIP_UID: Uuid =
    uuid::uuid!("e3a7c914-8b52-4f06-a1d9-7c4e05b2f8a6");

/// Cycle length of the pastel rainbow: four bars at 108 BPM.
pub(super) const PASTEL_RAINBOW_CYCLE: Duration = Duration::from_micros(8_888_889);
/// Cycle length of the pastel rainbow pulse: two beats at 108 BPM.
pub(super) const PASTEL_PULSE_CYCLE: Duration = Duration::from_micros(1_111_111);

/// Group ID range covering every bstrip row.
const BSTRIP_GROUPS: (u32, u32) = (3, 10);
/// Group ID of the six matrix strobes.
const MATRIX_STROBE_GROUP: u32 = 15;
/// Group ID pairs for each pixel tape tier, bottom to top.
const TIER_GROUPS: [(u32, u32); 4] = [(3, 4), (5, 6), (7, 8), (9, 10)];
/// Spacing between synth fill steps: one eighth note at 168 BPM.
const SYNTH_STEP: Duration = Duration::from_micros(178_571);

/// Seed the effects, sequences, and clips the sample timelines trigger.
pub(super) fn add_timeline_clips(world: &mut World) {
    add_pastel_rainbows(world);
    add_bstrip_flashes(world);
    add_sparkles(world);
    add_snap(world);
    add_synth_fill(world);
}

/// Build a selection over an inclusive range of group IDs.
fn groups(start: u32, end: u32) -> SelectionExpr {
    SelectionExpr::Group(GroupRefExpr::RangeById { start, end })
}

/// Build an inline absolute percentage value source.
fn percent(value: f32) -> ValueSource {
    ValueSource::Inline(ParameterValue::AbsolutePercent {
        value: value.into(),
    })
}

/// Build a fixed-duration transition mode.
fn fixed(duration: Duration) -> Option<TransitionMode> {
    Some(TransitionMode::Fixed(duration))
}

/// Build a cue that applies `values` to `selection` with the given trigger.
fn cue(
    uid: &str,
    id: u32,
    label: &str,
    trigger: CueTriggerType,
    selection: SelectionExpr,
    values: &[(Attribute, ValueSource)],
) -> Cue {
    Cue {
        identifiers: Identifiers {
            uid: Uuid::from_str(uid).unwrap(),
            id,
            label: label.to_owned(),
        },
        trigger,
        instructions: vec![BoundCueInstruction {
            selection: selection.into(),
            cue_instruction: CueInstruction {
                values: values.iter().cloned().collect(),
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Store the cues and sequence for a sequence-backed clip, then spawn the clip.
fn add_sequence_clip(world: &mut World, cues: Vec<Cue>, sequence: Sequence, clip: Clip) {
    let mut system_state: SystemState<(ResMut<DataProvider<Cue>>, ResMut<DataProvider<Sequence>>)> =
        SystemState::new(world);
    let (mut cue_data_provider, mut seq_data_provider) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    for cue in cues {
        cue_data_provider
            .add(cue)
            .expect("sample data should not have duplicate IDs");
    }
    seq_data_provider
        .add(sequence)
        .expect("sample data should not have duplicate IDs");
    world.spawn_instance(clip);
}

/// Build one step-FX lane whose absolute targets each occupy an equal share of the cycle.
fn rainbow_lane(attribute: Attribute, targets: [f32; 6]) -> FxLane {
    FxLane {
        attribute,
        timing_override: None,
        phase_override: None,
        absolute: Some(FxTrack {
            steps: targets
                .into_iter()
                .map(|value| FxStep {
                    uid: Uuid::new_v4(),
                    target: ParameterValue::AbsolutePercent {
                        value: value.into(),
                    },
                    blueprint_uid: None,
                    width_beats: 1.0 / 6.0,
                    transition: 1.0.into(),
                    curve: CurveType::Linear(Linear {}),
                })
                .collect(),
        }),
        relative: None,
    }
}

/// Seed the pastel rainbow at both of its tempos: clip 405 cycles over four lo-fi bars,
/// and clip 406 cycles every two lo-fi beats so the timeline can restart it on each
/// segment of the groove.
fn add_pastel_rainbows(world: &mut World) {
    add_pastel_rainbow(
        world,
        Identifiers {
            id: 405,
            label: "Pastel Rainbow".to_owned(),
            uid: Uuid::from_str("d46dbfe6-a5f9-4354-a1cf-ba27be08cd17").unwrap(),
        },
        PASTEL_RAINBOW_CLIP_UID,
        PASTEL_RAINBOW_CYCLE,
    );
    add_pastel_rainbow(
        world,
        Identifiers {
            id: 406,
            label: "Pastel Rainbow Pulse".to_owned(),
            uid: Uuid::from_str("7cf5696d-e039-4eca-b517-1506bb91cf86").unwrap(),
        },
        PASTEL_PULSE_CLIP_UID,
        PASTEL_PULSE_CYCLE,
    );
}

/// Seed a six-hue rainbow step FX on every bstrip, with a 25% channel floor that keeps
/// each color pastel, and a clip with the same ID and label that plays it.
fn add_pastel_rainbow(
    world: &mut World,
    identifiers: Identifiers,
    clip_uid: Uuid,
    cycle: Duration,
) {
    let step_fx_uid = identifiers.uid;
    let clip_identifiers = Identifiers {
        uid: clip_uid,
        ..identifiers.clone()
    };
    let mut intensity = rainbow_lane(Attribute::Intensity, [1.0; 6]);
    if let Some(track) = intensity.absolute.as_mut() {
        track.steps.truncate(1);
        track.steps[0].width_beats = 1.0;
    }
    world.spawn(StepFx {
        identifiers,
        timing: StepFxTiming {
            beat_duration: cycle,
        },
        selection: groups(BSTRIP_GROUPS.0, BSTRIP_GROUPS.1).into(),
        phase: StepFxPhase::default(),
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![
            intensity,
            rainbow_lane(Attribute::Red, [1.0, 1.0, 0.25, 0.25, 0.25, 1.0]),
            rainbow_lane(Attribute::Green, [0.25, 1.0, 1.0, 1.0, 0.25, 0.25]),
            rainbow_lane(Attribute::Blue, [0.25, 0.25, 0.25, 1.0, 1.0, 1.0]),
        ],
    });
    world.spawn_instance(Clip {
        identifiers: clip_identifiers,
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });
}

/// Seed clips 407-409: a brief white flash over the rainbow on all bstrips, on the top two
/// tiers, and on the bottom two tiers. Each ends itself after its fade so the timeline
/// can restart it for every hit.
fn add_bstrip_flashes(world: &mut World) {
    let flashes = [
        (
            407,
            "Bstrip Flash",
            BSTRIP_FLASH_CLIP_UID,
            groups(BSTRIP_GROUPS.0, BSTRIP_GROUPS.1),
            [
                "9df93bf1-1282-40c3-a9c0-784fbf423785",
                "a63f8d34-ae43-484d-999a-b2e0db996e0f",
                "bc223c3d-d71d-473e-8425-fb4d1146813a",
            ],
        ),
        (
            408,
            "Bstrip Flash Top",
            BSTRIP_FLASH_TOP_CLIP_UID,
            groups(TIER_GROUPS[2].0, TIER_GROUPS[3].1),
            [
                "b7e92331-6a23-4722-98d8-ffd7474cfce7",
                "0589f524-4ab2-48f8-bf77-26d0a571fa60",
                "9efe58b4-f90e-426f-95fa-c346c4430d66",
            ],
        ),
        (
            409,
            "Bstrip Flash Bottom",
            BSTRIP_FLASH_BOTTOM_CLIP_UID,
            groups(TIER_GROUPS[0].0, TIER_GROUPS[1].1),
            [
                "69b55ac0-60c0-44a3-8b6a-733bae2cc6ec",
                "2cea615d-02eb-472d-8313-e8d55dba3e8f",
                "bef25d64-4d33-4c35-8478-0c39e2af4864",
            ],
        ),
    ];
    for (id, label, clip_uid, selection, [on_uid, off_uid, sequence_uid]) in flashes {
        let on = cue(
            on_uid,
            1,
            "White",
            CueTriggerType::Manual,
            selection.clone(),
            &[
                (Attribute::Intensity, percent(1.0)),
                (Attribute::Red, percent(1.0)),
                (Attribute::Green, percent(1.0)),
                (Attribute::Blue, percent(1.0)),
            ],
        );
        let mut off = cue(
            off_uid,
            2,
            "Fade",
            CueTriggerType::FollowPrevious,
            selection,
            &[(Attribute::Intensity, percent(0.0))],
        );
        off.transitions = PartialTransition {
            delay_in: fixed(Duration::from_millis(40)),
            fade_in: fixed(Duration::from_millis(90)),
            ..Default::default()
        };
        let sequence = Sequence {
            identifiers: Identifiers {
                uid: Uuid::from_str(sequence_uid).unwrap(),
                id,
                label: label.to_owned(),
            },
            steps: vec![on.identifiers.uid.into(), off.identifiers.uid.into()],
            ..Default::default()
        };
        let clip = Clip {
            identifiers: Identifiers {
                id,
                label: label.to_owned(),
                uid: clip_uid,
            },
            source: Some(Source::Sequence(sequence.identifiers.uid)),
            priority: Priority(2),
            options: ClipOptions {
                auto_release: true,
                deactivate_on_sequence_end: true,
            },
        };
        add_sequence_clip(world, vec![on, off], sequence, clip);
    }
}

/// Seed clips 33 and 34: a shuffled RGB sine twinkle and the intensity lift that reveals it.
///
/// The timeline bounds the sparkle with stop actions, so the intensity sequence holds its
/// single cue until stopped.
fn add_sparkles(world: &mut World) {
    let fx_uid = Uuid::from_str("130131a3-6525-44f7-9757-8650ab0fc81f").unwrap();
    let waveform = |phase_start: f32| FxWaveform {
        params: FxWaveformParams {
            kind: WaveformKind::Sin,
            min: 0.0,
            max: 255.0,
            duty_cycle: 1.0,
        },
        phase_range: (phase_start, phase_start + 2.0 * std::f32::consts::PI),
        rate: Duration::from_secs(1),
        width: Percentage::from(1.0),
        is_relative: false,
    };
    world
        .resource_mut::<DataProvider<Fx>>()
        .add(Fx {
            identifiers: Identifiers {
                id: 7,
                label: "Sparkles".to_owned(),
                uid: fx_uid,
            },
            selection: SpatialSelection {
                source: groups(BSTRIP_GROUPS.0, BSTRIP_GROUPS.1),
                clauses: vec![SpatialClause::Shuffle {
                    axis: Axis::X,
                    seed: 18,
                }],
                union: Vec::new(),
            },
            attributes: HashMap::from([
                (Attribute::Red, waveform(0.0)),
                (Attribute::Green, waveform(0.0)),
                (Attribute::Blue, waveform(5.534_360_4)),
            ]),
        })
        .expect("sample data should not have duplicate IDs");
    world.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 33,
            label: "Sparkles FX".to_owned(),
            uid: SPARKLES_FX_CLIP_UID,
        },
        source: Some(Source::Fx(fx_uid)),
        priority: Priority(1),
        ..Default::default()
    });

    let lift = cue(
        "cb09c53f-8ff3-4d8c-9b77-85c602908f1d",
        1,
        "Sparkle Lift",
        CueTriggerType::Manual,
        groups(BSTRIP_GROUPS.0, BSTRIP_GROUPS.1),
        &[(
            Attribute::Intensity,
            ValueSource::Inline(ParameterValue::RelativePercent { offset: 1.0.into() }),
        )],
    );
    let sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("f6cdb32d-f027-4708-a724-28212974e45c").unwrap(),
            id: 9,
            label: "Sparkles Intensity".to_owned(),
        },
        steps: vec![lift.identifiers.uid.into()],
        ..Default::default()
    };
    let clip = Clip {
        identifiers: Identifiers {
            id: 34,
            label: "Sparkles Intensity".to_owned(),
            uid: SPARKLES_INT_CLIP_UID,
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        priority: Priority(1),
        ..Default::default()
    };
    add_sequence_clip(world, vec![lift], sequence, clip);
}

/// Seed clip 29, a single matrix-strobe flash that ends itself after its fade.
fn add_snap(world: &mut World) {
    let strobes = || groups(MATRIX_STROBE_GROUP, MATRIX_STROBE_GROUP);
    let flash = cue(
        "c0b1b593-6ba4-4501-adc0-84ea828d903f",
        1,
        "Flash",
        CueTriggerType::Manual,
        strobes(),
        &[(Attribute::White, percent(1.0))],
    );
    let mut fade = cue(
        "21a6c212-2324-4957-83c5-d2bd4b7be12c",
        2,
        "Fade",
        CueTriggerType::FollowPrevious,
        strobes(),
        &[(Attribute::White, percent(0.0))],
    );
    fade.transitions = PartialTransition {
        delay_in: fixed(Duration::from_millis(100)),
        fade_in: fixed(Duration::from_millis(414)),
        ..Default::default()
    };
    let mut sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("1ca634c6-e34d-4331-b85f-9c731ea16a5d").unwrap(),
            id: 16,
            label: "Snap".to_owned(),
        },
        steps: vec![flash.identifiers.uid.into(), fade.identifiers.uid.into()],
        ..Default::default()
    };
    sequence.setup_cue.instructions = vec![BoundCueInstruction {
        selection: strobes().into(),
        cue_instruction: CueInstruction {
            values: HashMap::from([
                (Attribute::Intensity, percent(0.75)),
                (Attribute::Tilt, percent(-0.4)),
            ]),
            ..Default::default()
        },
    }];
    let clip = Clip {
        identifiers: Identifiers {
            id: 29,
            label: "Snap".to_owned(),
            uid: SNAP_CLIP_UID,
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
        ..Default::default()
    };
    add_sequence_clip(world, vec![flash, fade], sequence, clip);
}

/// Seed clip 403, a "do-do-dah-duh" white cascade across the pixel tape tiers.
///
/// Tracking is disabled so each step lights only its own tier, and the clip ends itself
/// one step after the final hit.
fn add_synth_fill(world: &mut World) {
    let white = [
        (Attribute::Intensity, percent(1.0)),
        (Attribute::Red, percent(1.0)),
        (Attribute::Green, percent(1.0)),
        (Attribute::Blue, percent(1.0)),
    ];
    let tier = |index: usize| groups(TIER_GROUPS[index].0, TIER_GROUPS[index].1);
    let after_step = CueTriggerType::AfterDelay(SYNTH_STEP);
    let mut blank = cue(
        "f28567c7-3e04-4889-854c-5d48cebd5938",
        5,
        "Rest",
        after_step,
        tier(0),
        &[],
    );
    blank.instructions.clear();
    let steps = vec![
        cue(
            "290fe782-ae49-4d29-9008-783e00381ce9",
            1,
            "Do (top)",
            CueTriggerType::AfterDelay(Duration::ZERO),
            tier(3),
            &white,
        ),
        cue(
            "9c8c756f-e320-4342-b317-ca64985d943c",
            2,
            "Do (tier 2)",
            after_step,
            tier(1),
            &white,
        ),
        cue(
            "a5c6441f-a139-4bcb-bbc6-6a0a1cda7688",
            3,
            "Dah (tier 3)",
            after_step,
            tier(2),
            &white,
        ),
        cue(
            "38f6b6bf-c17e-4908-bc53-bb4ba04fa24c",
            4,
            "Duh (bottom)",
            after_step,
            tier(0),
            &white,
        ),
        blank,
        cue(
            "ae78b0ea-736c-40be-a9ea-7f96a765d242",
            6,
            "Duh (bottom)",
            CueTriggerType::FollowPrevious,
            tier(0),
            &white,
        ),
    ];
    let no_tracking = TrackingMode::Flags(TrackingFlags::from(0));
    let mut sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("c748303b-b06c-4cbe-9bb2-49f0bdc547ce").unwrap(),
            id: 403,
            label: "Synth Fill".to_owned(),
        },
        steps: steps.iter().map(|cue| cue.identifiers.uid.into()).collect(),
        tracking_mode: no_tracking,
        ..Default::default()
    };
    sequence.release_cue.trigger = CueTriggerType::FollowPrevious;
    sequence.release_cue.transitions.delay_in = fixed(SYNTH_STEP);
    let clip = Clip {
        identifiers: Identifiers {
            id: 403,
            label: "Synth Fill".to_owned(),
            uid: SYNTH_FILL_CLIP_UID,
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        priority: Priority(2),
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    };
    add_sequence_clip(world, steps, sequence, clip);
}
