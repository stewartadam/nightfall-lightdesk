// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clips adapted from the reference default show for the sample timelines.
//!
//! Selections address the sample groups by ID (3-10 are the bstrip rows, 15 the matrix
//! strobes) or the rotating wash elements by fixture map, so the effects follow the
//! sample rig instead of per-fixture UIDs.

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

/// Violet pulse on the matrix strobe pixels for the rap's quick bass notes.
pub(super) const STROBE_BASS_SHORT_CLIP_UID: Uuid =
    uuid::uuid!("00b0f9e6-473c-47cb-a339-c382ab109c1b");
/// Violet pulse with a long tail on the matrix strobe pixels for the rap's held bass notes.
pub(super) const STROBE_BASS_LONG_CLIP_UID: Uuid =
    uuid::uuid!("6088fc36-b2ae-4eed-8631-6d08c481bfaa");
/// White flash on one pixel tape tier each, ordered top tier first.
pub(super) const BSTRIP_ROW_FLASH_CLIP_UIDS: [Uuid; 4] = [
    uuid::uuid!("0c8e0159-e6e4-4a9e-a243-26b06991f7ea"),
    uuid::uuid!("e549e08a-4793-48b8-991a-06601ce1cafe"),
    uuid::uuid!("2dfad8bd-ac20-4960-ad87-d2a93611e863"),
    uuid::uuid!("b2df5344-41bd-468e-9ffd-349035365cb7"),
];
/// White dot that runs along the rotating wash LED strips, one step per rap eighth note.
pub(super) const WASH_HAT_RUN_CLIP_UID: Uuid = uuid::uuid!("81467c52-f96a-4202-a36a-8bd9da00ee41");
/// White pulse-and-fade of the rotating wash beams.
pub(super) const WASH_VOCAL_PULSE_CLIP_UID: Uuid =
    uuid::uuid!("a19716d7-33fb-4746-9ca1-8ada8ddcb4f9");
/// White flash on the rotating wash LED strips for the lo-fi's off-beat snare.
pub(super) const WASH_STRIP_SNARE_CLIP_UID: Uuid =
    uuid::uuid!("f1792a4a-6b04-41ac-b099-61faeea2a973");

/// Cycle length of the pastel rainbow: four bars at 108 BPM.
pub(super) const PASTEL_RAINBOW_CYCLE: Duration = Duration::from_micros(8_888_889);
/// Cycle length of the pastel rainbow pulse: two bars at 108 BPM. The lo-fi groove
/// restarts it every two beats, so each segment replays the first quarter of the cycle.
pub(super) const PASTEL_PULSE_CYCLE: Duration = Duration::from_micros(4_444_444);
/// Length of the sparkle's fade down: one bar at 168 BPM, so the rap's vocal sparkle
/// hands back to the rainbow on the next clap.
pub(super) const SPARKLE_FADE: Duration = Duration::from_micros(1_428_571);
/// Cycle length of the wash hat run: one bar (eight hi-hat eighth notes) at 168 BPM.
const HAT_RUN_CYCLE: Duration = Duration::from_micros(1_428_571);

/// Group ID range covering every bstrip row.
const BSTRIP_GROUPS: (u32, u32) = (3, 10);
/// Group ID of the six matrix strobes.
const MATRIX_STROBE_GROUP: u32 = 15;
/// Group ID pairs for each pixel tape tier, bottom to top.
const TIER_GROUPS: [(u32, u32); 4] = [(3, 4), (5, 6), (7, 8), (9, 10)];
/// Fixture IDs of the six rotating washes.
const ROTATING_WASHES: FixtureRangeExpr = FixtureRangeExpr {
    start: 1010,
    end: 1015,
};
/// Rotating wash elements for the control channel (master intensity) and the 12 beams.
const WASH_CONTROL_AND_BEAMS: ElementSelectorExpr =
    ElementSelectorExpr::Range { start: 1, end: 13 };
/// Rotating wash elements for the 12-pixel top strip followed by the bottom strip.
const WASH_STRIPS: ElementSelectorExpr = ElementSelectorExpr::Range { start: 14, end: 37 };
/// Pixels in each rotating wash LED strip.
const WASH_STRIP_PIXELS: u32 = 12;

/// Seed the effects, sequences, and clips the sample timelines trigger.
pub(super) fn add_timeline_clips(world: &mut World) {
    add_pastel_rainbows(world);
    add_flashes(world);
    add_sparkles(world);
    add_snap(world);
    add_wash_hat_run(world);
}

/// Build a selection over an inclusive range of group IDs.
fn groups(start: u32, end: u32) -> SelectionExpr {
    SelectionExpr::Group(GroupRefExpr::RangeById { start, end })
}

/// Build a selection over the given elements of every rotating wash.
fn washes(elements: ElementSelectorExpr) -> SelectionExpr {
    SelectionExpr::FixtureMap {
        fixtures: ROTATING_WASHES,
        elements,
    }
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
/// and clip 406 cycles over two lo-fi bars and is restarted by the timeline on each
/// two-beat segment of the groove.
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

/// A self-ending flash clip: one cue snaps `on` values in and holds them for `hold`, then
/// the flash fades out over `fade`.
struct Flash {
    /// Shared ID of the sequence and the clip.
    id: u32,
    /// Shared label of the sequence and the clip.
    label: &'static str,
    /// Clip UID the timelines start.
    clip_uid: Uuid,
    /// Fixtures or elements the flash lights.
    selection: SelectionExpr,
    /// Values the flash snaps to.
    on: Vec<(Attribute, ValueSource)>,
    /// Time the `on` look is held before the fade starts.
    hold: Duration,
    /// Length of the fade out.
    fade: Duration,
    /// Fade intensity to zero in a cue of its own, so the flash also fades when nothing
    /// plays underneath. Otherwise the release crossfades back to the underlying look, but
    /// a released element virtual dimmer drops at once, so on its own the flash would cut
    /// out without a fade.
    fade_to_black: bool,
    /// UIDs of the `on` cue and the sequence.
    uids: [&'static str; 2],
}

/// Full white on RGB pixels at full intensity.
fn white_rgb() -> Vec<(Attribute, ValueSource)> {
    vec![
        (Attribute::Intensity, percent(1.0)),
        (Attribute::Red, percent(1.0)),
        (Attribute::Green, percent(1.0)),
        (Attribute::Blue, percent(1.0)),
    ]
}

/// Seed the flash clips the timelines restart on each hit:
///
/// - 407-409: a brief white flash over the rainbow on all bstrips (held 150 ms), the top
///   two tiers, and the bottom two tiers (held 200 ms each).
/// - 410-411: a violet bass pulse on the matrix strobe pixels, short and long. The strobe
///   pixels have no white emitter, so these leave the snap's white segments alone.
/// - 412-415: a white flash on a single pixel tape tier, top tier first.
/// - 417: a white pulse-and-fade of the rotating wash beams, including the master dimmer
///   the beams render through.
/// - 418: a white flash on the rotating wash LED strips. The strips ignore the master
///   dimmer, and nothing plays under them in the lo-fi groove, so the flash fades to
///   black.
fn add_flashes(world: &mut World) {
    let tier = |index: usize| groups(TIER_GROUPS[index].0, TIER_GROUPS[index].1);
    let lofi_flash = |id, label, clip_uid, selection, hold_ms, uids| Flash {
        id,
        label,
        clip_uid,
        selection,
        on: white_rgb(),
        hold: Duration::from_millis(hold_ms),
        fade: Duration::from_millis(90),
        // The lo-fi breaks play these flashes on black.
        fade_to_black: true,
        uids,
    };
    let bass = |id, label, clip_uid, hold, fade, uids| Flash {
        id,
        label,
        clip_uid,
        selection: groups(MATRIX_STROBE_GROUP, MATRIX_STROBE_GROUP),
        on: vec![
            (Attribute::Red, percent(0.55)),
            (Attribute::Green, percent(0.0)),
            (Attribute::Blue, percent(1.0)),
        ],
        hold,
        fade,
        fade_to_black: false,
        uids,
    };
    let row_flash = |id, label, index: usize, uids| Flash {
        id,
        label,
        clip_uid: BSTRIP_ROW_FLASH_CLIP_UIDS[index],
        // Row flashes are indexed top first; tier groups are listed bottom first.
        selection: tier(TIER_GROUPS.len() - 1 - index),
        on: white_rgb(),
        hold: Duration::from_millis(60),
        fade: Duration::from_millis(250),
        fade_to_black: false,
        uids,
    };
    let flashes = [
        lofi_flash(
            407,
            "Bstrip Flash",
            BSTRIP_FLASH_CLIP_UID,
            groups(BSTRIP_GROUPS.0, BSTRIP_GROUPS.1),
            150,
            [
                "9df93bf1-1282-40c3-a9c0-784fbf423785",
                "bc223c3d-d71d-473e-8425-fb4d1146813a",
            ],
        ),
        lofi_flash(
            408,
            "Bstrip Flash Top",
            BSTRIP_FLASH_TOP_CLIP_UID,
            groups(TIER_GROUPS[2].0, TIER_GROUPS[3].1),
            200,
            [
                "b7e92331-6a23-4722-98d8-ffd7474cfce7",
                "9efe58b4-f90e-426f-95fa-c346c4430d66",
            ],
        ),
        lofi_flash(
            409,
            "Bstrip Flash Bottom",
            BSTRIP_FLASH_BOTTOM_CLIP_UID,
            groups(TIER_GROUPS[0].0, TIER_GROUPS[1].1),
            200,
            [
                "69b55ac0-60c0-44a3-8b6a-733bae2cc6ec",
                "bef25d64-4d33-4c35-8478-0c39e2af4864",
            ],
        ),
        bass(
            410,
            "Strobe Bass Short",
            STROBE_BASS_SHORT_CLIP_UID,
            Duration::from_millis(30),
            Duration::from_millis(150),
            [
                "a950a3b6-6eca-4151-95a4-eca207aaff47",
                "59eddb46-662b-42ab-834a-093563237b57",
            ],
        ),
        bass(
            411,
            "Strobe Bass Long",
            STROBE_BASS_LONG_CLIP_UID,
            Duration::from_millis(60),
            Duration::from_millis(600),
            [
                "69bf802a-7a3e-4940-b7de-2d7d9abd9381",
                "646a5bab-7a0c-4a4d-ab32-0c2c70d30ddd",
            ],
        ),
        row_flash(
            412,
            "Bstrip Row 1 Flash",
            0,
            [
                "93956bac-f7a1-4542-89ff-b5aec129e440",
                "4463e88e-f059-4110-8415-0beebc13baae",
            ],
        ),
        row_flash(
            413,
            "Bstrip Row 2 Flash",
            1,
            [
                "d2817af2-075c-4b8a-9e50-ad586b4b7653",
                "a341d5fe-50c1-425c-b2bd-9028bd49582d",
            ],
        ),
        row_flash(
            414,
            "Bstrip Row 3 Flash",
            2,
            [
                "2a43caba-5da4-4536-85b6-ed6050d98009",
                "7e98e1c5-22cd-4030-8130-3b71437d95de",
            ],
        ),
        row_flash(
            415,
            "Bstrip Row 4 Flash",
            3,
            [
                "5edef1bb-ac5e-404f-b7fe-1df766574400",
                "1896bec9-a1ab-46c1-b30e-e030849fbad2",
            ],
        ),
        Flash {
            id: 417,
            label: "Wash Vocal Pulse",
            clip_uid: WASH_VOCAL_PULSE_CLIP_UID,
            selection: washes(WASH_CONTROL_AND_BEAMS),
            on: vec![
                (Attribute::Intensity, percent(1.0)),
                (Attribute::White, percent(1.0)),
            ],
            hold: Duration::from_millis(80),
            fade: Duration::from_millis(650),
            fade_to_black: false,
            uids: [
                "cd0cdc43-ad9d-45b0-b47a-caa9393e2384",
                "6f3147c6-f8f6-4ae9-b459-372a4f61c31a",
            ],
        },
        Flash {
            id: 418,
            label: "Wash Strip Snare",
            clip_uid: WASH_STRIP_SNARE_CLIP_UID,
            selection: washes(WASH_STRIPS),
            on: vec![
                (Attribute::Intensity, percent(1.0)),
                (Attribute::White, percent(1.0)),
            ],
            hold: Duration::from_millis(60),
            fade: Duration::from_millis(250),
            fade_to_black: true,
            uids: [
                "6eb76e68-ccd3-41fb-af4a-7ce36a07cd3d",
                "d5cd5ee5-8a08-4731-819f-43bf3434199f",
            ],
        },
    ];
    for flash in flashes {
        add_flash(world, flash);
    }
}

/// Store the two cues and sequence of a flash, then spawn its self-ending clip.
fn add_flash(world: &mut World, flash: Flash) {
    let [on_uid, sequence_uid] = flash.uids;
    let sequence_uid = Uuid::from_str(sequence_uid).unwrap();
    let on = cue(
        on_uid,
        1,
        "On",
        CueTriggerType::Manual,
        flash.selection.clone(),
        &flash.on,
    );
    let second_uid = Uuid::new_v5(&sequence_uid, b"fade").to_string();
    let second = if flash.fade_to_black {
        let mut fade = cue(
            &second_uid,
            2,
            "Fade",
            CueTriggerType::FollowPrevious,
            flash.selection.clone(),
            &[(Attribute::Intensity, percent(0.0))],
        );
        fade.transitions = PartialTransition {
            delay_in: fixed(flash.hold),
            fade_in: fixed(flash.fade),
            ..Default::default()
        };
        fade
    } else {
        // Restates the flash look so the hold step reads as part of the flash.
        cue(
            &second_uid,
            2,
            "Hold",
            CueTriggerType::AfterDelay(flash.hold),
            flash.selection.clone(),
            &flash.on,
        )
    };
    let mut sequence = Sequence {
        identifiers: Identifiers {
            uid: sequence_uid,
            id: flash.id,
            label: flash.label.to_owned(),
        },
        steps: vec![on.identifiers.uid.into(), second.identifiers.uid.into()],
        ..Default::default()
    };
    if !flash.fade_to_black {
        sequence.release_cue.trigger = CueTriggerType::FollowPrevious;
        sequence.release_cue.transitions.fade_in = fixed(flash.fade);
    }
    let clip = Clip {
        identifiers: Identifiers {
            id: flash.id,
            label: flash.label.to_owned(),
            uid: flash.clip_uid,
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        priority: Priority(2),
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    };
    add_sequence_clip(world, vec![on, second], sequence, clip);
}

/// Seed clips 33 and 34: a shuffled RGB sine twinkle and the intensity that reveals it.
///
/// The intensity lifts at once, holds for 100 ms, then fades the bstrips down over
/// `SPARKLE_FADE` and ends itself. It plays at priority 2 so the fade can pull the bstrips
/// below the rainbow; synth flashes at the same priority still punch through it. The timeline stops the twinkle as the fade finishes, and the release hands the
/// bstrips back to whatever plays underneath.
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
        // Absolute so the fade cue can take it down; a relative lift stays applied on
        // top of an absolute fade.
        &[(Attribute::Intensity, percent(1.0))],
    );
    let mut fade = cue(
        "0a7a59c9-9f49-4767-a454-1ae37f177b55",
        2,
        "Sparkle Fade",
        CueTriggerType::FollowPrevious,
        groups(BSTRIP_GROUPS.0, BSTRIP_GROUPS.1),
        &[(Attribute::Intensity, percent(0.0))],
    );
    fade.transitions = PartialTransition {
        delay_in: fixed(Duration::from_millis(100)),
        fade_in: fixed(SPARKLE_FADE),
        ..Default::default()
    };
    let sequence = Sequence {
        identifiers: Identifiers {
            uid: Uuid::from_str("f6cdb32d-f027-4708-a724-28212974e45c").unwrap(),
            id: 9,
            label: "Sparkles Intensity".to_owned(),
        },
        steps: vec![lift.identifiers.uid.into(), fade.identifiers.uid.into()],
        ..Default::default()
    };
    let clip = Clip {
        identifiers: Identifiers {
            id: 34,
            label: "Sparkles Intensity".to_owned(),
            uid: SPARKLES_INT_CLIP_UID,
        },
        source: Some(Source::Sequence(sequence.identifiers.uid)),
        priority: Priority(2),
        options: ClipOptions {
            auto_release: true,
            deactivate_on_sequence_end: true,
        },
    };
    add_sequence_clip(world, vec![lift, fade], sequence, clip);
}

/// Build a selection over the tilt axis and white strobe segments of every matrix strobe,
/// leaving their RGB pixels to the bass pulses. The outer two strobes have 16 white
/// segments and the inner four have 20; elements 2-3 carry no light or tilt attributes.
fn strobe_tilt_and_whites() -> SelectionExpr {
    let map = |start, end, last_white| SelectionExpr::FixtureMap {
        fixtures: FixtureRangeExpr { start, end },
        elements: ElementSelectorExpr::Range {
            start: 1,
            end: last_white,
        },
    };
    let add = |lhs, rhs| SelectionExpr::Add {
        lhs: Box::new(lhs),
        rhs: Box::new(rhs),
    };
    add(add(map(601, 601, 19), map(602, 605, 23)), map(606, 606, 19))
}

/// Seed clip 29, a single flash on the matrix strobes' white segments that ends itself
/// after its fade.
fn add_snap(world: &mut World) {
    let strobes = strobe_tilt_and_whites;
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

/// Build one step-FX lane of snapped absolute targets that share the cycle equally.
fn snap_lane(attribute: Attribute, targets: &[f32]) -> FxLane {
    let width = 1.0 / targets.len() as f32;
    FxLane {
        attribute,
        timing_override: None,
        phase_override: None,
        absolute: Some(FxTrack {
            steps: targets
                .iter()
                .map(|&value| FxStep {
                    uid: Uuid::new_v4(),
                    target: ParameterValue::AbsolutePercent {
                        value: value.into(),
                    },
                    blueprint_uid: None,
                    width_beats: width,
                    transition: 0.0.into(),
                    curve: CurveType::Snap(Snap {}),
                })
                .collect(),
        }),
        relative: None,
    }
}

/// Seed clip 416, a white dot with a short tail that runs along every rotating wash LED
/// strip once per rap bar.
///
/// The grid lines the same pixel of every strip up in one column so all twelve strips run
/// together, and eight phase groups make the dot advance on each hi-hat eighth note. The
/// timeline starts it on a bar line so the steps land on the hats.
fn add_wash_hat_run(world: &mut World) {
    let step_fx_uid = Uuid::from_str("b18cf25a-125e-4f92-9a8a-3eee8d982edc").unwrap();
    world.spawn(StepFx {
        identifiers: Identifiers {
            id: 416,
            label: "Wash Hat Run".to_owned(),
            uid: step_fx_uid,
        },
        timing: StepFxTiming {
            beat_duration: HAT_RUN_CYCLE,
        },
        selection: SpatialSelection::pipeline(
            washes(WASH_STRIPS),
            vec![SpatialClause::Grid(GridSize::Width(WASH_STRIP_PIXELS))],
        ),
        phase: StepFxPhase {
            // Phase 45>405 degrees: the run starts one eighth of a bar in.
            waypoints: vec![0.125, 1.125],
            groups: PhaseGroups::Explicit(8),
        },
        direction: FxDirection::Forward,
        cycle_scale: Default::default(),
        lanes: vec![
            snap_lane(
                Attribute::Intensity,
                &[1.0, 0.45, 0.15, 0.0, 0.0, 0.0, 0.0, 0.0],
            ),
            snap_lane(Attribute::White, &[1.0]),
        ],
    });
    world.spawn_instance(Clip {
        identifiers: Identifiers {
            id: 416,
            label: "Wash Hat Run".to_owned(),
            uid: WASH_HAT_RUN_CLIP_UID,
        },
        source: Some(Source::StepFx(step_fx_uid)),
        ..Default::default()
    });
}
