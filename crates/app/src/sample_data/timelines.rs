// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

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

    let track1 = Track {
        id: "1".to_owned(),
        label: "FX Track".to_owned(),
        actions: vec![Action {
            id: "1".to_owned(),
            label: "Exec 5 (fx3)".to_owned(),
            action: ActionKind::StartClip(
                Uuid::from_str("324d1219-7c36-4c7f-a01e-29dbad6c3b3c").unwrap(),
            ),
            position: Duration::from_millis(3600),
            duration: Duration::from_secs(5),
        }],
        muted: false,
        solo: false,
        expanded: true,
        automation_lanes: vec![AutomationLane {
            id: "1".to_owned(),
            name: "Intensity".to_owned(),
            color: "White".to_owned(),
            points: vec![
                AutomationPoint {
                    position: Duration::ZERO,
                    value: 0.0,
                },
                AutomationPoint {
                    position: Duration::from_secs(4),
                    value: 1.0,
                },
            ],
            parameter_type: ParameterType::GlobalVariable("test".to_owned()),
        }],
    };

    let track2 = Track {
        id: "2".to_owned(),
        label: "Seq Track".to_owned(),
        actions: vec![
            Action {
                id: "1".to_owned(),
                label: "Start exec 1 (seq)".to_owned(),
                action: ActionKind::StartClip(
                    Uuid::from_str("cd19c920-ae7c-4d99-8ff4-31fade6dfa69").unwrap(),
                ),
                position: Duration::from_millis(75),
                duration: Duration::from_millis(750),
            },
            Action {
                id: "2".to_owned(),
                label: "Advance seq 1 cue 2".to_owned(),
                action: ActionKind::AdvanceSequence(
                    Uuid::from_str("cd19c920-ae7c-4d99-8ff4-31fade6dfa69").unwrap(),
                ),
                position: Duration::from_millis(1025),
                duration: Duration::from_millis(750),
            },
            Action {
                id: "3".to_owned(),
                label: "Advance seq 1 cue 3".to_owned(),
                action: ActionKind::AdvanceSequence(
                    Uuid::from_str("cd19c920-ae7c-4d99-8ff4-31fade6dfa69").unwrap(),
                ),
                position: Duration::from_millis(2025),
                duration: Duration::from_millis(750),
            },
            Action {
                id: "4".to_owned(),
                label: "Advance seq 1 cue 4".to_owned(),
                action: ActionKind::AdvanceSequence(
                    Uuid::from_str("cd19c920-ae7c-4d99-8ff4-31fade6dfa69").unwrap(),
                ),
                position: Duration::from_millis(3025),
                duration: Duration::from_millis(750),
            },
            Action {
                id: "5".to_owned(),
                label: "Stop Seq 1".to_owned(),
                action: ActionKind::StopClip(
                    Uuid::from_str("cd19c920-ae7c-4d99-8ff4-31fade6dfa69").unwrap(),
                ),
                position: Duration::from_millis(3600),
                duration: Duration::from_secs(1),
            },
        ],
        muted: false,
        solo: false,
        expanded: true,
        automation_lanes: vec![AutomationLane {
            id: "2".to_owned(),
            name: "Speed".to_owned(),
            color: "#3b82f6".to_owned(),
            points: vec![
                AutomationPoint {
                    position: Duration::from_millis(0),
                    value: 0.1,
                },
                AutomationPoint {
                    position: Duration::from_secs(2),
                    value: 0.75,
                },
                AutomationPoint {
                    position: Duration::from_secs(4),
                    value: 0.3,
                },
                AutomationPoint {
                    position: Duration::from_secs(5),
                    value: 1.0,
                },
            ],
            parameter_type: ParameterType::GlobalVariable("test".to_owned()),
        }],
    };

    let timeline1 = Timeline {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::from_str("098145c1-934b-4ed6-b200-78df6c6da180").unwrap(),
            label: "Cruise".to_owned(),
        },
        timecode_uid: timecode1.identifiers.uid,
        timecode_start: Duration::ZERO,
        audio_path: "demo-audio.mp3".to_string(),
        audio_enabled: true,
        end_time: None,
        trigger_mode: TimelineTriggerMode::FollowTimecode,
        seek_behavior: TimelineSeekBehavior::ReconstructState,
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        stop_behavior: TimelineStopBehavior::ResetAndReleaseOwnedActions,
        lookahead: TimelineLookaheadMode::Inherit,
        tracks: vec![track1, track2],
        markers: Vec::new(),
        regions: Vec::new(),
        loop_range: None,
        bpm: 120.0,
        beats_per_bar: 4,
        use_beat_grid: false,
        beatgrid: None,
        scroll_mode: TimelineScrollMode::Free,
    };

    // Create a sample timeline with some tracks
    let timeline2 = Timeline {
        identifiers: Identifiers {
            id: 2,
            uid: Uuid::from_str("87db6c53-6c24-4243-894b-725cef5e6301").unwrap(),
            label: "TENDR".to_string(),
        },
        timecode_uid: timecode2.identifiers.uid,
        timecode_start: Duration::from_secs(0),
        audio_path: "demo-audio2.mp3".to_string(),
        audio_enabled: true,
        end_time: None,
        trigger_mode: TimelineTriggerMode::FollowTimecode,
        seek_behavior: TimelineSeekBehavior::ReconstructState,
        nondeterministic_seek_behavior: TimelineNondeterministicSeekBehavior::Ignore,
        stop_behavior: TimelineStopBehavior::ResetAndReleaseOwnedActions,
        lookahead: TimelineLookaheadMode::Inherit,
        markers: Vec::new(),
        regions: Vec::new(),
        loop_range: None,
        bpm: 120.0,
        beats_per_bar: 4,
        use_beat_grid: false,
        beatgrid: None,
        scroll_mode: TimelineScrollMode::Free,
        tracks: vec![
            Track {
                id: "track-1".to_string(),
                label: "Main Show".to_string(),
                muted: false,
                solo: false,
                expanded: false,
                actions: vec![
                    Action {
                        id: "verse-1".to_string(),
                        label: "Verse".to_string(),
                        position: Duration::from_millis(1000),
                        duration: Duration::from_millis(5000),
                        action: ActionKind::StartClip(
                            Uuid::from_str("34a3af80-539c-4ddc-97d3-c2e50606cbe3").unwrap(),
                        ),
                    },
                    Action {
                        id: "strobe-2".to_string(),
                        label: "Strobe".to_string(),
                        position: Duration::from_millis(8000),
                        duration: Duration::from_millis(3000),
                        action: ActionKind::StartClip(
                            Uuid::from_str("34a3af80-539c-4ddc-97d3-c2e50606cbe3").unwrap(),
                        ),
                    },
                ],
                automation_lanes: vec![
                    AutomationLane {
                        id: "intensity-param-1".to_string(),
                        name: "Intensity".to_string(),
                        color: "#3b82f6".to_string(),
                        points: vec![
                            AutomationPoint {
                                position: Duration::from_millis(1000),
                                value: 0.2,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(3000),
                                value: 0.8,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(5500),
                                value: 0.5,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(8000),
                                value: 1.0,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(11000),
                                value: 0.3,
                            },
                        ],
                        parameter_type: ParameterType::GlobalVariable("intensity".to_string()),
                    },
                    AutomationLane {
                        id: "speed-param-1".to_string(),
                        name: "Speed".to_string(),
                        color: "#f97316".to_string(),
                        points: vec![
                            AutomationPoint {
                                position: Duration::from_millis(1000),
                                value: 0.5,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(4000),
                                value: 0.7,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(8000),
                                value: 0.9,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(10000),
                                value: 0.1,
                            },
                        ],
                        parameter_type: ParameterType::GlobalVariable("speed".to_string()),
                    },
                ],
            },
            Track {
                id: "track-2".to_string(),
                label: "Lights".to_string(),
                muted: false,
                solo: false,
                expanded: false,
                actions: vec![Action {
                    id: "color-bump-3".to_string(),
                    label: "Color Bump".to_string(),
                    position: Duration::from_millis(3000),
                    duration: Duration::from_millis(4000),
                    action: ActionKind::StartClip(
                        Uuid::from_str("34a3af80-539c-4ddc-97d3-c2e50606cbe3").unwrap(),
                    ),
                }],
                automation_lanes: vec![
                    AutomationLane {
                        id: "color-param-2".to_string(),
                        name: "Color".to_string(),
                        color: "#a855f7".to_string(),
                        points: vec![
                            AutomationPoint {
                                position: Duration::from_millis(3000),
                                value: 0.0,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(5000),
                                value: 0.5,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(7000),
                                value: 1.0,
                            },
                        ],
                        parameter_type: ParameterType::GlobalVariable("color_hue".to_string()),
                    },
                    AutomationLane {
                        id: "size-param-2".to_string(),
                        name: "Size".to_string(),
                        color: "#10b981".to_string(),
                        points: vec![
                            AutomationPoint {
                                position: Duration::from_millis(3000),
                                value: 0.2,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(4500),
                                value: 0.8,
                            },
                            AutomationPoint {
                                position: Duration::from_millis(7000),
                                value: 0.4,
                            },
                        ],
                        parameter_type: ParameterType::GlobalVariable("size".to_string()),
                    },
                ],
            },
        ],
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
