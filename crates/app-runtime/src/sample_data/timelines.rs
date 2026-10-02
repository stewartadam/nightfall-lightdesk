// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::timeline_clips::{
    BSTRIP_FLASH_BOTTOM_CLIP_UID, BSTRIP_FLASH_CLIP_UID, BSTRIP_FLASH_TOP_CLIP_UID,
    PASTEL_PULSE_CLIP_UID, PASTEL_RAINBOW_CLIP_UID, PASTEL_RAINBOW_CYCLE, SNAP_CLIP_UID,
    SPARKLES_FX_CLIP_UID, SPARKLES_INT_CLIP_UID, SYNTH_FILL_CLIP_UID,
};
use super::*;

/// Existing sample clip that circles the front moving heads.
const CIRCLE_MOTION_CLIP_UID: Uuid = uuid::uuid!("ac08f795-9e9c-4fae-b714-0810b0cebecb");
/// Gap between starting the sparkle intensity lift and its colour effect, matching the
/// reference show's trigger order.
const SPARKLE_FX_OFFSET: Duration = Duration::from_millis(10);
/// Length of one snap flash including its fade, used for the action's display width.
const SNAP_LENGTH: Duration = Duration::from_millis(514);
/// Length of one bstrip flash including its fade, used for the action's display width.
const FLASH_LENGTH: Duration = Duration::from_millis(130);
/// Length of one synth fill (six eighth notes at 168 BPM), used for display width.
const SYNTH_FILL_LENGTH: Duration = Duration::from_millis(1071);

/// Musical grid of a sample song, measured from its audio.
#[derive(Clone, Copy)]
struct SongGrid {
    /// Position of the first downbeat.
    downbeat: Duration,
    /// Tempo in beats per minute.
    bpm: f64,
}

impl SongGrid {
    /// Returns the timeline position of a 1-based bar and fractional 1-based beat (4/4).
    fn at(self, bar: u32, beat: f64) -> Duration {
        let beats = f64::from(bar - 1) * 4.0 + (beat - 1.0);
        self.downbeat + Duration::from_secs_f64(beats * 60.0 / self.bpm)
    }

    /// Returns the length of `beats` beats.
    fn beats(self, beats: f64) -> Duration {
        Duration::from_secs_f64(beats * 60.0 / self.bpm)
    }

    /// Returns the length of `bars` whole bars.
    fn bars(self, bars: u32) -> Duration {
        Duration::from_secs_f64(f64::from(bars) * 4.0 * 60.0 / self.bpm)
    }
}

/// lofi.mp3: 108 BPM, groove bars 1-6 and 9-14, breaks at bars 7-8 and 15-16.
const LOFI: SongGrid = SongGrid {
    downbeat: Duration::from_millis(75),
    bpm: 108.0,
};
/// rap.mp3: 168 BPM, section A bars 1-8, section B bars 9-16, final hit on bar 17.
const RAP: SongGrid = SongGrid {
    downbeat: Duration::from_millis(5),
    bpm: 168.0,
};

/// Builds timeline actions with sequential, track-unique IDs.
struct ActionList {
    /// Prefix that keeps action IDs readable in the timeline editor.
    prefix: &'static str,
    /// Actions in authoring order.
    actions: Vec<Action>,
}

impl ActionList {
    /// Creates an empty list whose IDs start with `prefix`.
    fn new(prefix: &'static str) -> Self {
        Self {
            prefix,
            actions: Vec::new(),
        }
    }

    /// Appends an action at `position`; `duration` only sets its width in the editor.
    fn push(&mut self, label: &str, position: Duration, duration: Duration, action: ActionKind) {
        self.actions.push(Action {
            id: format!("{}-{}", self.prefix, self.actions.len() + 1),
            label: label.to_owned(),
            position,
            duration,
            action,
        });
    }

    /// Appends a clip start shown spanning until `until`.
    fn start(&mut self, label: &str, clip: Uuid, at: Duration, until: Duration) {
        self.push(
            label,
            at,
            until.saturating_sub(at),
            ActionKind::StartClip(clip),
        );
    }

    /// Appends a clip stop.
    fn stop(&mut self, label: &str, clip: Uuid, at: Duration) {
        self.push(
            label,
            at,
            Duration::from_millis(250),
            ActionKind::StopClip(clip),
        );
    }

    /// Appends a sparkle (intensity lift plus colour twinkle) from `from` until `until`.
    fn sparkle(&mut self, from: Duration, until: Duration) {
        self.start("Sparkle lift", SPARKLES_INT_CLIP_UID, from, until);
        self.start(
            "Sparkle",
            SPARKLES_FX_CLIP_UID,
            from + SPARKLE_FX_OFFSET,
            until,
        );
        self.stop("Stop sparkle", SPARKLES_FX_CLIP_UID, until);
        self.stop("Stop sparkle lift", SPARKLES_INT_CLIP_UID, until);
    }

    /// Wraps the actions in an unmuted, expanded track.
    fn into_track(self, id: &str, label: &str) -> Track {
        Track {
            id: id.to_owned(),
            label: label.to_owned(),
            muted: false,
            solo: false,
            expanded: true,
            actions: self.actions,
            automation_lanes: Vec::new(),
        }
    }
}

/// Builds a section region with a UID derived from its timeline so reseeding is stable.
fn region(
    timeline_uid: Uuid,
    label: &str,
    start: Duration,
    end: Duration,
    color: &str,
) -> TimelineRegion {
    TimelineRegion {
        uid: Uuid::new_v5(
            &timeline_uid,
            format!("{label}@{}", start.as_millis()).as_bytes(),
        ),
        label: label.to_owned(),
        start,
        end,
        color: Some(color.to_owned()),
    }
}

/// Lo-fi lanes: a pastel wash that restarts with the groove, accents on the backbeat and
/// the phrase-ending notes, and sparkles in the breaks.
///
/// Each groove pair of bars plays three and a half two-beat segments before a two-note
/// figure on the second bar's fourth beat. The figure is a repeated note in bars 2, 6, 10,
/// and 14, and falls from high to low in bars 4 and 12.
fn lofi_tracks() -> Vec<Track> {
    let grooves = [1..=6, 9..=14];
    let breaks = [(7, 9), (15, 17)];

    let mut wash = ActionList::new("wash");
    for groove in grooves.clone() {
        let groove_end = LOFI.at(groove.end() + 1, 1.0);
        for bar in groove {
            for beat in [1.0, 3.0] {
                let at = LOFI.at(bar, beat);
                wash.start(
                    "Rainbow pulse",
                    PASTEL_PULSE_CLIP_UID,
                    at,
                    at + LOFI.beats(2.0),
                );
            }
        }
        wash.stop("Stop rainbow pulse", PASTEL_PULSE_CLIP_UID, groove_end);
    }
    for (from, until) in breaks {
        wash.start(
            "Pastel rainbow",
            PASTEL_RAINBOW_CLIP_UID,
            LOFI.at(from, 1.0),
            LOFI.at(until, 1.0),
        );
        wash.stop("Stop rainbow", PASTEL_RAINBOW_CLIP_UID, LOFI.at(until, 1.0));
    }

    let mut accents = ActionList::new("accents");
    for bar in grooves.into_iter().flatten() {
        let at = LOFI.at(bar, 3.0);
        accents.start("Snap", SNAP_CLIP_UID, at, at + SNAP_LENGTH);
        if bar % 2 == 1 {
            continue;
        }
        let (first, second) = if bar % 4 == 0 {
            (
                ("Flash high", BSTRIP_FLASH_TOP_CLIP_UID),
                ("Flash low", BSTRIP_FLASH_BOTTOM_CLIP_UID),
            )
        } else {
            (
                ("Flash", BSTRIP_FLASH_CLIP_UID),
                ("Flash", BSTRIP_FLASH_CLIP_UID),
            )
        };
        for ((label, clip), beat) in [(first, 4.25), (second, 4.5)] {
            let at = LOFI.at(bar, beat);
            accents.start(label, clip, at, at + FLASH_LENGTH);
        }
    }
    for (from, _) in breaks {
        // Four high notes on the first break bar, then eight low notes on the second.
        for beat in [1.0, 2.0, 3.0, 4.0] {
            let at = LOFI.at(from, beat);
            accents.start(
                "Flash high",
                BSTRIP_FLASH_TOP_CLIP_UID,
                at,
                at + FLASH_LENGTH,
            );
        }
        for eighth in 0..8 {
            let at = LOFI.at(from + 1, 1.0 + f64::from(eighth) / 2.0);
            accents.start(
                "Flash low",
                BSTRIP_FLASH_BOTTOM_CLIP_UID,
                at,
                at + FLASH_LENGTH,
            );
        }
    }

    let mut sparkles = ActionList::new("breaks");
    for (from, until) in breaks {
        sparkles.sparkle(LOFI.at(from, 1.0), LOFI.at(until, 1.0));
    }

    vec![
        wash.into_track("wash", "Wash"),
        accents.into_track("accents", "Accents"),
        sparkles.into_track("breaks", "Breaks"),
    ]
}

/// Lo-fi song sections.
fn lofi_regions(timeline_uid: Uuid) -> Vec<TimelineRegion> {
    [
        ("Groove", 1, 7),
        ("Break", 7, 9),
        ("Groove", 9, 15),
        ("Break", 15, 17),
    ]
    .into_iter()
    .map(|(label, from, until)| {
        let color = if label == "Break" {
            "#a855f7"
        } else {
            "#3b82f6"
        };
        region(
            timeline_uid,
            label,
            LOFI.at(from, 1.0),
            LOFI.at(until, 1.0),
            color,
        )
    })
    .collect()
}

/// Rap lanes: a faster wash with moving heads in section B, snare and synth hits, and
/// sparkle moments at the section change and the final hit.
fn rap_tracks() -> Vec<Track> {
    let end = RAP.at(17, 2.0);
    // One rainbow cycle per four rap bars instead of four lo-fi bars.
    let rainbow_rate = PASTEL_RAINBOW_CYCLE.as_secs_f32() / RAP.bars(4).as_secs_f32();

    let mut wash = ActionList::new("wash");
    wash.start(
        "Pastel rainbow",
        PASTEL_RAINBOW_CLIP_UID,
        RAP.at(1, 1.0),
        end,
    );
    wash.push(
        "Rainbow at 4 bars",
        RAP.at(1, 2.0),
        Duration::from_millis(250),
        ActionKind::SetClipRate {
            uid: PASTEL_RAINBOW_CLIP_UID,
            rate: rainbow_rate,
        },
    );
    wash.start("Circle motion", CIRCLE_MOTION_CLIP_UID, RAP.at(9, 1.0), end);
    wash.stop("Stop rainbow", PASTEL_RAINBOW_CLIP_UID, end);
    wash.stop("Stop circle motion", CIRCLE_MOTION_CLIP_UID, end);

    let mut hits = ActionList::new("hits");
    for bar in 1..=17 {
        hits.start(
            "Snap",
            SNAP_CLIP_UID,
            RAP.at(bar, 1.0),
            RAP.at(bar, 1.0) + SNAP_LENGTH,
        );
    }
    for bar in [4, 8, 12, 16] {
        let at = RAP.at(bar, 2.0);
        hits.start(
            "Synth fill",
            SYNTH_FILL_CLIP_UID,
            at,
            at + SYNTH_FILL_LENGTH,
        );
    }

    let mut moments = ActionList::new("moments");
    moments.sparkle(RAP.at(9, 1.0), RAP.at(11, 1.0));
    moments.sparkle(RAP.at(17, 1.0), RAP.at(19, 1.0));

    vec![
        wash.into_track("wash", "Wash"),
        hits.into_track("hits", "Hits"),
        moments.into_track("moments", "Moments"),
    ]
}

/// Rap song sections.
fn rap_regions(timeline_uid: Uuid) -> Vec<TimelineRegion> {
    vec![
        region(timeline_uid, "A", RAP.at(1, 1.0), RAP.at(9, 1.0), "#3b82f6"),
        region(
            timeline_uid,
            "B",
            RAP.at(9, 1.0),
            RAP.at(17, 1.0),
            "#f97316",
        ),
        region(
            timeline_uid,
            "Outro",
            RAP.at(17, 1.0),
            RAP.at(19, 1.0),
            "#a855f7",
        ),
    ]
}

/// Seed sample timecodes, timelines, and their materialized runtime entities.
pub(super) fn add_tc(world: &mut World) {
    let mut seeded_timecodes = Vec::new();

    let timecode1 = Timecode {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::from_str("62dac5b1-628d-45e2-82be-aebe3eb225a3").unwrap(),
            label: "Timecode 1".to_owned(),
        },
        rate: TimecodeRate::Fps30,
        source: TimecodeSource::Internal,
    };
    let tc_gen = TimecodeGenerator {
        timecode: timecode1.clone(),
        state: TimecodeState {
            timecode_id: timecode1.identifiers.id,
            is_active: false,
            current_time: Duration::ZERO,
            start_time: None,
            end_time: None,
        },
        ..Default::default()
    };
    world.spawn(tc_gen);
    seeded_timecodes.push(timecode1.clone());

    let timecode2 = Timecode {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::from_str("79855673-8249-4581-a53e-72bef78175c2").unwrap(),
            label: "Timecode 2".to_owned(),
        },
        rate: TimecodeRate::Fps30,
        source: TimecodeSource::Internal,
    };
    let tc_gen = TimecodeGenerator {
        timecode: timecode2.clone(),
        state: TimecodeState {
            timecode_id: 2,
            is_active: false,
            current_time: Duration::ZERO,
            start_time: None,
            end_time: None,
        },
        ..Default::default()
    };
    world.spawn(tc_gen);
    seeded_timecodes.push(timecode2.clone());

    let timeline1_uid = Uuid::from_str("098145c1-934b-4ed6-b200-78df6c6da180").unwrap();
    let timeline1 = Timeline {
        identifiers: Identifiers {
            id: 1,
            uid: timeline1_uid,
            label: "Lo-fi".to_owned(),
        },
        timecode_uid: timecode1.identifiers.uid,
        timecode_start: Duration::ZERO,
        audio_path: SAMPLE_AUDIO[0].relative_path.to_owned(),
        audio_enabled: true,
        end_time: None,
        trigger_mode: TimelineTriggerMode::FollowTimecode,
        seek_behavior: TimelineSeekBehavior::ReconstructState,
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        stop_behavior: TimelineStopBehavior::ResetAndReleaseOwnedActions,
        lookahead: TimelineLookaheadMode::Inherit,
        tracks: lofi_tracks(),
        markers: Vec::new(),
        regions: lofi_regions(timeline1_uid),
        loop_range: None,
        bpm: LOFI.bpm as f32,
        beats_per_bar: 4,
        use_beat_grid: true,
        beatgrid: None,
        scroll_mode: TimelineScrollMode::Free,
    };

    let timeline2_uid = Uuid::from_str("87db6c53-6c24-4243-894b-725cef5e6301").unwrap();
    let timeline2 = Timeline {
        identifiers: Identifiers {
            id: 2,
            uid: timeline2_uid,
            label: "Rap".to_string(),
        },
        timecode_uid: timecode2.identifiers.uid,
        timecode_start: Duration::from_secs(0),
        audio_path: SAMPLE_AUDIO[1].relative_path.to_owned(),
        audio_enabled: true,
        end_time: None,
        trigger_mode: TimelineTriggerMode::FollowTimecode,
        seek_behavior: TimelineSeekBehavior::ReconstructState,
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        stop_behavior: TimelineStopBehavior::ResetAndReleaseOwnedActions,
        lookahead: TimelineLookaheadMode::Inherit,
        markers: Vec::new(),
        regions: rap_regions(timeline2_uid),
        loop_range: None,
        bpm: RAP.bpm as f32,
        beats_per_bar: 4,
        use_beat_grid: true,
        beatgrid: None,
        scroll_mode: TimelineScrollMode::Free,
        tracks: rap_tracks(),
    };
    {
        let mut system_state: SystemState<(ResMut<DataProvider<Timeline>>,)> =
            SystemState::new(world);
        let (mut timeline_data_provider,) = system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");
        if let Err(err) = timeline_data_provider.add(timeline1.clone()) {
            tracing::warn!("Failed to store sample timeline 1 in provider: {}", err);
        }
        if let Err(err) = timeline_data_provider.add(timeline2.clone()) {
            tracing::warn!("Failed to store sample timeline 2 in provider: {}", err);
        }
    }

    world.spawn(MaterializedTimeline::new(timeline1));
    world.spawn(MaterializedTimeline::new(timeline2));

    let mut system_state: SystemState<(ResMut<DataProvider<Timecode>>,)> = SystemState::new(world);
    let (mut timecode_data_provider,) = system_state
        .get_mut(world)
        .expect("sample data system parameters should be available");
    timecode_data_provider.extend(seeded_timecodes);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that sample timeline seeding persists both timecodes and timelines.
    #[test]
    fn add_tc_seeds_timecode_and_timeline_data_providers() {
        let mut world = World::new();
        world.insert_resource(DataProvider::<Timecode>::default());
        world.insert_resource(DataProvider::<Timeline>::default());

        add_tc(&mut world);

        let timecode_count = world.resource::<DataProvider<Timecode>>().iter().count();
        let timeline_count = world.resource::<DataProvider<Timeline>>().iter().count();

        assert_eq!(timecode_count, 2);
        assert_eq!(timeline_count, 2);
    }
}
